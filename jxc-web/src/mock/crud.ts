/* eslint-disable @typescript-eslint/no-explicit-any */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Db, type Row } from './db'
import {
  MockError,
  audit,
  checkVersion,
  handle,
  inScope,
  matchKeyword,
  notFound,
  paginate,
  requireCountry,
  requirePerm,
  type Ctx,
  type ScopeFields,
  canDataAccess,
} from './utils'

export const API = '/api/v1'

export interface CrudOptions {
  /** 为 false 表示全局共享表（没有 country_id） */
  countryScoped?: boolean
  viewPerm?: string | string[]
  editPerm?: string | string[]
  keywordKeys?: string[]
  /** 按查询参数精确过滤的字段 */
  filterKeys?: string[]
  /** 国家内唯一的字段 */
  unique?: string[]
  scope?: ScopeFields
  auditType?: string
  out?: (row: Row, ctx: Ctx) => Row
  beforeCreate?: (row: Row, ctx: Ctx) => void
  beforeUpdate?: (row: Row, body: Row, ctx: Ctx) => void
  beforeToggle?: (row: Row, ctx: Ctx) => void
  /** 自定义列表过滤 */
  filter?: (row: Row, ctx: Ctx) => boolean
  /** 记录访问条件，在列表、详情及写接口上统一执行。 */
  canAccess?: (row: Row, ctx: Ctx) => boolean
}

const READONLY_FIELDS = ['id', 'countryId', 'createdAt', 'createdBy', 'version', 'status']

export function rows(table: keyof Db) {
  return getDb()[table] as Row[]
}

export function findOr404(ctx: Ctx, table: keyof Db, id: number, opts: CrudOptions = {}) {
  const row = rows(table).find((r) => r.id === id)
  if (!row) notFound()
  if (opts.countryScoped !== false && row.countryId !== ctx.countryId) notFound()
  if (opts.scope && !inScope(ctx, row, opts.scope)) notFound()
  if (opts.canAccess && !opts.canAccess(row, ctx)) notFound()
  return row
}

function assertUnique(table: keyof Db, row: Row, fields: string[] | undefined, countryScoped: boolean) {
  for (const f of fields ?? []) {
    const dup = rows(table).find(
      (r) => r.id !== row.id && r[f] === row[f] && (!countryScoped || r.countryId === row.countryId),
    )
    if (dup) throw new MockError(409, 'MD_DUPLICATE', `${f} “${row[f]}” 已存在`)
  }
}

export function crud(path: string, table: keyof Db, opts: CrudOptions = {}) {
  const scoped = opts.countryScoped !== false
  const out = (r: Row, ctx: Ctx) => (opts.out ? opts.out({ ...r }, ctx) : r)
  const requireEdit = (ctx: Ctx) => {
    if (!opts.editPerm) throw new MockError(403, 'SYS_FORBIDDEN', '此资源不提供通用写入操作')
    requirePerm(ctx, opts.editPerm)
  }

  const list = http.get(
    `${API}${path}`,
    handle((ctx) => {
      requirePerm(ctx, opts.viewPerm)
      if (scoped) requireCountry(ctx)
      const sp = ctx.url.searchParams
      const result = rows(table)
        .filter((r) => !scoped || r.countryId === ctx.countryId)
        .filter((r) => !opts.scope || inScope(ctx, r, opts.scope))
        .filter((r) => !opts.canAccess || opts.canAccess(r, ctx))
        .filter((r) => matchKeyword(r, sp.get('keyword'), opts.keywordKeys ?? ['code', 'name']))
        .filter((r) => (opts.filterKeys ?? ['status']).every((k) => !sp.get(k) || String(r[k]) === sp.get(k)))
        .filter((r) => !opts.filter || opts.filter(r, ctx))
        .map((r) => out(r, ctx))
      return paginate(result, ctx.url)
    }),
  )

  const get = http.get(
    `${API}${path}/:id`,
    handle((ctx, { params }) => {
      requirePerm(ctx, opts.viewPerm)
      return out(findOr404(ctx, table, Number(params.id), opts), ctx)
    }),
  )

  const create = http.post(
    `${API}${path}`,
    handle((ctx, { body }) => {
      requireEdit(ctx)
      const row: Row = {
        status: 'ENABLED',
        ...body,
        id: nextId(),
        version: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        createdBy: ctx.user.id,
      }
      if (scoped) row.countryId = requireCountry(ctx)
      opts.beforeCreate?.(row, ctx)
      if (opts.scope && !canDataAccess(ctx, row, opts.scope)) notFound()
      if (opts.canAccess && !opts.canAccess(row, ctx)) notFound()
      assertUnique(table, row, opts.unique, scoped)
      rows(table).unshift(row)
      if (opts.auditType) audit(ctx, '新增', opts.auditType, row.id, null, row)
      return out(row, ctx)
    }),
  )

  const update = http.put(
    `${API}${path}/:id`,
    handle((ctx, { params, body }) => {
      requireEdit(ctx)
      const row = findOr404(ctx, table, Number(params.id), opts)
      checkVersion(row, body)
      const before = structuredClone(row)
      opts.beforeUpdate?.(row, body, ctx)
      const patch = { ...body }
      for (const f of READONLY_FIELDS) delete patch[f]
      if (opts.scope && !canDataAccess(ctx, { ...row, ...patch }, opts.scope)) notFound()
      Object.assign(row, patch, { version: (row.version ?? 0) + 1, updatedAt: nowIso(), updatedBy: ctx.user.id })
      assertUnique(table, row, opts.unique, scoped)
      if (opts.auditType) audit(ctx, '修改', opts.auditType, row.id, before, row)
      return out(row, ctx)
    }),
  )

  const toggle = (action: 'disable' | 'enable') =>
    http.post(
      `${API}${path}/:id/${action}`,
      handle((ctx, { params }) => {
        requireEdit(ctx)
        const row = findOr404(ctx, table, Number(params.id), opts)
        opts.beforeToggle?.(row, ctx)
        const before = { status: row.status }
        row.status = action === 'disable' ? 'DISABLED' : 'ENABLED'
        row.version = (row.version ?? 0) + 1
        if (opts.auditType) audit(ctx, action === 'disable' ? '停用' : '启用', opts.auditType, row.id, before, { status: row.status })
        return out(row, ctx)
      }),
    )

  return {
    /** 需要在通用 :id 路由之前注册的自定义处理函数放在 extra 中 */
    handlers: (extra: ReturnType<typeof http.get>[] = []) => [...extra, list, create, toggle('disable'), toggle('enable'), get, update],
  }
}
