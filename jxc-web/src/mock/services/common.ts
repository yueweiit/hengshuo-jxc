/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, nextId, nowIso, type Row } from '../db'
import { MockError, userFieldGroups, type Ctx } from '../utils'

export const nameOf = (list: Row[], id: unknown, key = 'name') => list.find((r) => r.id === id)?.[key] ?? ''
export const userName = (id: unknown) => nameOf(getDb().users, id, 'displayName')

export function bad(message: string, code = 'SYS_BAD_REQUEST', data: unknown = null): never {
  throw new MockError(400, code, message, data)
}

export function conflict(message: string, code = 'SYS_STATE_INVALID', data: unknown = null): never {
  throw new MockError(409, code, message, data)
}

export function country(countryId: number) {
  return getDb().countries.find((c) => c.id === countryId)!
}

/** 国家本位币。销售、收款、退货默认用它，不把墨西哥比索写死到其他国家。 */
export function baseCcy(countryId: number) {
  return String(country(countryId)?.defaultCurrency || '')
}

/** 国家时区下的业务日期 */
export function today(countryId: number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: country(countryId).timezone }).format(new Date())
}

/** 单号：国家编码-类型-yyMMdd-流水，例如 MX-PO-261015-0001 */
export function docNo(countryId: number, type: string, date?: string | null) {
  const db = getDb()
  const d = (date || today(countryId)).slice(0, 10).replace(/-/g, '').slice(2)
  const key = `${countryId}:${type}:${d}`
  db.docSeqs[key] = (db.docSeqs[key] ?? 0) + 1
  return `${country(countryId).code}-${type}-${d}-${String(db.docSeqs[key]).padStart(4, '0')}`
}

export function product(id: number) {
  return getDb().products.find((p) => p.id === id)
}

export function productLabel(id: number) {
  const p = product(id)
  return p ? `${p.productCode} ${p.name}` : String(id)
}

/** 行输出时补充商品编码、名称、基础单位 */
export function withProduct<T extends Row>(row: T): T & Row {
  const p = product(row.productId)
  return { ...row, productCode: p?.productCode ?? '', productName: p?.name ?? '', baseUnit: p?.baseUnit ?? '' }
}

export function assertSkuEnabled(countryId: number, productId: number) {
  const db = getDb()
  const p = product(productId)
  if (!p) bad('商品不存在')
  const sku = db.countrySkus.find((s) => s.countryId === countryId && s.productId === productId)
  if (p.status !== 'ENABLED' || sku?.status !== 'ENABLED') bad(`商品 ${p.productCode} 未在本国启用，不能使用`, 'MD_SKU_DISABLED')
  return p
}

export function warehouseOf(countryId: number, id: number) {
  const wh = getDb().warehouses.find((w) => w.id === id && w.countryId === countryId)
  if (!wh) bad('仓库不属于当前国家')
  return wh
}

export function costVisible(ctx: Ctx) {
  return userFieldGroups(ctx.user, ctx.countryId).COST !== 'HIDDEN'
}

export function num(v: unknown) {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function round(v: number, digits = 2) {
  const f = 10 ** digits
  return Math.round((v + Number.EPSILON) * f) / f
}

export function sum<T>(list: T[], fn: (x: T) => number) {
  return list.reduce((s, x) => s + num(fn(x)), 0)
}

// ---------- 推送型待办（docs/13 第 4.2 节：dedup_key 去重，业务完成后自动关闭） ----------

export interface TodoInput {
  countryId: number
  todoType: string
  dedupKey: string
  title: string
  link: string
  perm?: string
  assigneeId?: number | null
}

export function openTodo(t: TodoInput) {
  const db = getDb()
  const exist = db.todos.find((x) => x.dedupKey === t.dedupKey && x.status === 'OPEN')
  if (exist) {
    Object.assign(exist, { title: t.title, link: t.link })
    return exist
  }
  const row = { id: nextId(), status: 'OPEN', createdAt: nowIso(), updatedAt: nowIso(), version: 1, assigneeId: null, ...t }
  db.todos.unshift(row)
  return row
}

export function closeTodo(dedupKey: string, result = '已处理') {
  for (const t of getDb().todos.filter((x) => x.dedupKey === dedupKey && x.status === 'OPEN')) {
    Object.assign(t, { status: 'DONE', result, closedAt: nowIso() })
  }
}

// ---------- 查询时触发的定时检查（延误、复查日期等），模拟后台任务 ----------

const periodic: ((countryId: number) => void)[] = []

export function onPeriodic(fn: (countryId: number) => void) {
  periodic.push(fn)
}

export function runPeriodic(countryId: number | null) {
  if (countryId == null) return
  for (const fn of periodic) fn(countryId)
}

export function systemCtx(countryId: number, userId = 1): Ctx {
  const user = getDb().users.find((u) => u.id === userId)!
  return { user, countryId, request: new Request('http://mock/'), url: new URL('http://mock/') }
}
