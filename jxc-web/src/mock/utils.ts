/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpResponse, delay } from 'msw'
import { getDb, nextId, nowIso, restoreDb, saveDb, snapshotDb, type Row } from './db'

export const PLATFORM_PERMS = ['sys:country:view', 'sys:country:create', 'sys:country:activate', 'sys:template:publish']

export const FIELD_GROUPS = ['COST', 'CUSTOMER_PRICE', 'ORDER_TOTAL', 'BANK_INFO', 'PROFIT', 'CREDIT']
const ACCESS_RANK: Record<string, number> = { HIDDEN: 0, READ: 1, WRITE: 2 }

export interface PersistFailure {
  table: 'finEvents'
  id: number
  fields: { status: 'FAILED'; failReason: string }
}

export class MockError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data: unknown = null,
    public persistFailure?: PersistFailure,
  ) {
    super(message)
  }
}

export function ok(data: unknown = null) {
  return HttpResponse.json({ code: 'OK', message: '', data, traceId: crypto.randomUUID().slice(0, 8) })
}

export function fail(status: number, code: string, message: string, data: unknown = null) {
  return HttpResponse.json({ code, message, data, traceId: crypto.randomUUID().slice(0, 8) }, { status })
}

export interface Ctx {
  user: Row
  countryId: number | null
  request: Request
  url: URL
}

export function permMatch(perms: string[], code: string) {
  return perms.some((p) => p === '*' || p === code || (p.endsWith(':*') && code.startsWith(p.slice(0, -1))))
}

export function userCountries(user: Row): Row[] {
  const db = getDb()
  if (user.isPlatformAdmin) return db.countries.filter((c) => c.status !== 'DISABLED')
  const ids = new Set(db.userRoles.filter((ur) => ur.userId === user.id).map((ur) => ur.countryId))
  return db.countries.filter((c) => ids.has(c.id))
}

export function userPerms(user: Row, countryId: number | null): string[] {
  const db = getDb()
  const roleIds = db.userRoles.filter((ur) => ur.userId === user.id && ur.countryId === countryId).map((ur) => ur.roleId)
  const perms = new Set<string>()
  for (const r of db.roles.filter((r) => roleIds.includes(r.id) && r.status === 'ENABLED')) {
    for (const p of r.permissions) perms.add(p)
  }
  if (user.isPlatformAdmin) PLATFORM_PERMS.forEach((p) => perms.add(p))
  return [...perms]
}

export function userFieldGroups(user: Row, countryId: number | null) {
  const db = getDb()
  const roleIds = db.userRoles.filter((ur) => ur.userId === user.id && ur.countryId === countryId).map((ur) => ur.roleId)
  const result: Record<string, string> = {}
  for (const g of FIELD_GROUPS) result[g] = 'HIDDEN'
  for (const r of db.roles.filter((r) => roleIds.includes(r.id) && r.status === 'ENABLED')) {
    for (const [g, a] of Object.entries(r.fieldPolicies ?? {})) {
      if (ACCESS_RANK[a as string] > ACCESS_RANK[result[g]]) result[g] = a as string
    }
  }
  return result
}

export function hasPerm(ctx: Ctx, code?: string | string[]) {
  if (!code) return true
  const perms = userPerms(ctx.user, ctx.countryId)
  return (Array.isArray(code) ? code : [code]).some((c) => permMatch(perms, c))
}

export function requirePerm(ctx: Ctx, code?: string | string[]) {
  if (!hasPerm(ctx, code)) throw new MockError(403, 'SYS_FORBIDDEN', `没有权限：${code}`)
}

/** 当前用户在当前国家的数据范围 */
export function scopeOf(ctx: Ctx) {
  const db = getDb()
  const now = Date.now()
  const scopes = db.dataScopes.filter((s) => s.userId === ctx.user.id && s.countryId === ctx.countryId &&
    (!s.effectiveFrom || Date.parse(s.effectiveFrom) <= now) && (!s.effectiveTo || Date.parse(s.effectiveTo) > now))
  const ids = (type: string) => scopes.filter((s) => s.scopeType === type).map((s) => s.scopeRefId as number)
  const all = scopes.some((s) => s.scopeType === 'COUNTRY_ALL')
  const entities = ids('ENTITY').filter((id) => db.entities.some((e) => e.id === id && e.countryId === ctx.countryId))
  const stores = [...new Set([...ids('STORE').filter((id) => db.stores.some((s) => s.id === id && s.countryId === ctx.countryId)),
    ...db.stores.filter((s) => s.countryId === ctx.countryId && entities.includes(s.entityId)).map((s) => s.id)])]
  const warehouses = [...new Set([...ids('WAREHOUSE').filter((id) => db.warehouses.some((w) => w.id === id && w.countryId === ctx.countryId)),
    ...db.warehouses.filter((w) => w.countryId === ctx.countryId && (entities.includes(w.entityId) || stores.includes(w.storeId))).map((w) => w.id)])]
  const books = [...new Set([...ids('BOOK').filter((id) => db.books.some((b) => b.id === id && b.countryId === ctx.countryId)),
    ...db.books.filter((b) => b.countryId === ctx.countryId && entities.includes(b.entityId)).map((b) => b.id)])]
  return {
    all,
    stores, warehouses, entities, books,
  }
}

export interface ScopeFields {
  storeField?: string
  warehouseField?: string
  entityField?: string
  bookField?: string
}

/** 功能授权与数据范围独立；没有有效数据授权时不能访问国家业务数据。 */
export function canDataAccess(ctx: Ctx, row: Row, f?: ScopeFields): boolean {
  if (ctx.countryId == null || (row.countryId != null && row.countryId !== ctx.countryId)) return false
  const s = scopeOf(ctx)
  if (s.all) return true
  const fields = f ?? { storeField: 'storeId', warehouseField: 'warehouseId', entityField: 'entityId', bookField: 'bookId' }
  const refs = [
    { key: fields.storeField, allowed: s.stores }, { key: fields.warehouseField, allowed: s.warehouses },
    { key: fields.entityField, allowed: s.entities }, { key: fields.bookField, allowed: s.books },
  ].filter((x) => x.key && row[x.key] != null)
  if (refs.some((x) => x.allowed.includes(row[x.key!]))) return true
  if (!f && Array.isArray(row.lines) && row.lines.some((line: Row) => Array.isArray(line.allocs))) {
    return row.lines.some((line: Row) => (line.allocs ?? []).some((a: Row) => s.warehouses.includes(a.warehouseId)))
  }
  if (refs.length) return false
  // 国家共享档案只向已经取得任一有效数据范围的用户开放。
  return s.stores.length + s.warehouses.length + s.entities.length + s.books.length > 0
}

export function inScope(ctx: Ctx, row: Row, f: ScopeFields = {}) {
  return canDataAccess(ctx, row, f)
}

export function requireDataAccess(ctx: Ctx, row: Row, fields?: ScopeFields) {
  if (!canDataAccess(ctx, row, fields)) notFound()
  return row
}

export function scopedRows<T extends Row>(ctx: Ctx, rows: T[], fields?: ScopeFields): T[] {
  return rows.filter((row) => canDataAccess(ctx, row, fields))
}

export function requireFieldAccess(ctx: Ctx, group: string, write = false) {
  const access = userFieldGroups(ctx.user, ctx.countryId)[group] ?? 'HIDDEN'
  if ((ACCESS_RANK[access] ?? 0) < (write ? 2 : 1)) throw new MockError(403, 'SYS_FORBIDDEN', `没有${group}字段${write ? '修改' : '查看'}权限`)
}

export function paginate<T>(list: T[], url: URL) {
  const page = Number(url.searchParams.get('page') ?? 1)
  const size = Number(url.searchParams.get('size') ?? 20)
  return { records: list.slice((page - 1) * size, page * size), total: list.length, page, size }
}

export function matchKeyword(row: Row, keyword: string | null, keys: string[]) {
  if (!keyword) return true
  const k = keyword.toLowerCase()
  return keys.some((key) => String(row[key] ?? '').toLowerCase().includes(k))
}

export function audit(ctx: Ctx, action: string, resourceType: string, resourceId: number, before: Row | null, after: Row | null, reason?: string) {
  getDb().auditLogs.unshift({
    id: nextId(),
    countryId: ctx.countryId,
    userId: ctx.user.id,
    userName: ctx.user.displayName,
    action,
    resourceType,
    resourceId,
    beforeValue: before ? strip(before) : null,
    afterValue: after ? strip(after) : null,
    reason,
    occurredAt: nowIso(),
  })
}

function strip(row: Row) {
  const { password: _p, ...rest } = row
  return JSON.parse(JSON.stringify(rest))
}

function readCtx(request: Request, skipCountry = false): Ctx {
  const db = getDb()
  const url = new URL(request.url)
  const token = request.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
  const userId = db.sessions[token]
  const user = db.users.find((u) => u.id === userId)
  if (!user) throw new MockError(401, 'AUTH_REQUIRED', '登录已过期，请重新登录')
  if (user.status !== 'ENABLED') throw new MockError(401, 'AUTH_DISABLED', '账号已停用')
  const header = skipCountry ? null : request.headers.get('X-Country-Id')
  const countryId = header ? Number(header) : null
  if (countryId != null && !userCountries(user).some((c) => c.id === countryId)) {
    throw new MockError(403, 'SYS_FORBIDDEN', '没有该国家的授权')
  }
  return { user, countryId, request, url }
}

export function requireCountry(ctx: Ctx): number {
  if (ctx.countryId == null) throw new MockError(400, 'SYS_COUNTRY_REQUIRED', '请先选择国家')
  return ctx.countryId
}

type Resolver = (ctx: Ctx, info: { params: Record<string, string>; body: any }) => unknown | Promise<unknown>

/**
 * 包装处理函数：模拟延迟、解析上下文和请求体、统一异常与持久化。
 * auth=false 用于登录等匿名接口。
 */
export function handle(resolver: Resolver, opts: { auth?: boolean; skipCountry?: boolean } = {}) {
  return async ({ request, params }: { request: Request; params: Record<string, any> }) => {
    await delay(120)
    const snapshot = request.method !== 'GET' ? snapshotDb() : null
    try {
      let body: any = null
      if (request.method !== 'GET') {
        const type = request.headers.get('Content-Type') ?? ''
        if (type.includes('multipart/form-data')) body = await request.formData()
        else {
          const text = await request.text()
          body = text ? JSON.parse(text) : null
        }
      }
      const ctx =
        opts.auth === false
          ? ({ user: null, countryId: null, request, url: new URL(request.url) } as unknown as Ctx)
          : readCtx(request, opts.skipCountry)
      const data = await resolver(ctx, { params, body })
      // 查询也可能刷新待办或预警，统一持久化
      saveDb()
      if (data instanceof Response) return data
      return ok(data ?? null)
    } catch (e) {
      if (snapshot) restoreDb(snapshot)
      if (e instanceof MockError && e.persistFailure?.table === 'finEvents') {
        const marker = e.persistFailure
        const row = getDb().finEvents.find((r) => r.id === marker.id)
        if (row && marker.fields.status === 'FAILED') {
          Object.assign(row, { status: 'FAILED', failReason: String(marker.fields.failReason) })
          saveDb()
        }
      }
      if (e instanceof MockError) return fail(e.status, e.code, e.message, e.data)
      console.error('[mock]', e)
      return fail(500, 'SYS_ERROR', (e as Error).message)
    }
  }
}

export function notFound(): never {
  throw new MockError(404, 'NOT_FOUND', '记录不存在或不在你的数据范围内')
}

export function checkVersion(row: Row, body: Row) {
  if (body?.version != null && row.version != null && body.version !== row.version) {
    throw new MockError(409, 'SYS_VERSION_CONFLICT', '单据已被他人修改，请刷新后重试')
  }
}
