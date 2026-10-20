/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 13 导入与导出任务。确认导入按文件哈希和幂等键去重，期初必须带截止日期。
 */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, findOr404 } from '../crud'
import { audit, handle, paginate, requireCountry, requirePerm, type Ctx } from '../utils'
import { bad, product, today } from '../services/common'
import { openingIn } from '../services/inventory'

const TEMPLATES: Record<string, string[]> = {
  OPENING_STOCK: ['cutoffDate', 'warehouseCode', 'productCode', 'qty', 'unitCost', 'batchNo'],
  OPENING_GL: ['cutoffDate', 'accountCode', 'direction', 'amount'],
  STOCK_LIMIT: ['warehouseCode', 'productCode', 'minQty', 'maxQty'],
}

function validate(ctx: Ctx, type: string, rows: Row[], cutoff: string) {
  const db = getDb()
  const errors: { rowNo: number; message: string }[] = []
  if (['OPENING_STOCK', 'OPENING_GL'].includes(type) && !cutoff) errors.push({ rowNo: 0, message: '期初导入必须填写截止日期' })
  rows.forEach((raw, i) => {
    const rowNo = i + 1
    if (type === 'OPENING_STOCK') {
      const wh = db.warehouses.find((w) => w.countryId === ctx.countryId && w.code === raw.warehouseCode)
      const p = db.products.find((x) => x.productCode === raw.productCode)
      if (!wh) errors.push({ rowNo, message: `仓库 ${raw.warehouseCode} 不属于当前国家` })
      if (!p) errors.push({ rowNo, message: `商品 ${raw.productCode} 不存在` })
      if (!(Number(raw.qty) > 0)) errors.push({ rowNo, message: '数量必须大于 0' })
      if (raw.batchNo && db.invBatches.some((b) => b.countryId === ctx.countryId && b.batchNo === raw.batchNo)) errors.push({ rowNo, message: `批次 ${raw.batchNo} 已存在，不能重复导入` })
    }
    if (type === 'OPENING_GL') {
      const book = db.books.find((b) => b.countryId === ctx.countryId)
      if (!book || !db.finAccounts.some((a) => a.bookId === book.id && a.code === raw.accountCode)) errors.push({ rowNo, message: `科目 ${raw.accountCode} 不存在` })
      if (!['DEBIT', 'CREDIT'].includes(raw.direction)) errors.push({ rowNo, message: '方向须为 DEBIT 或 CREDIT' })
    }
    if (type === 'STOCK_LIMIT') {
      if (!db.warehouses.some((w) => w.countryId === ctx.countryId && w.code === raw.warehouseCode)) errors.push({ rowNo, message: '仓库不存在' })
      if (raw.minQty != null && raw.maxQty != null && Number(raw.minQty) > Number(raw.maxQty)) errors.push({ rowNo, message: '下限不能高于上限' })
    }
  })
  return errors
}

const tpl = http.get(`${API}/sys/import-templates/:type`, handle((ctx, { params }) => {
  requirePerm(ctx, 'sys:import:confirm')
  const type = String(params.type)
  const columns = TEMPLATES[type]
  if (!columns) bad('不支持的导入类型')
  return { importType: type, columns, sample: columns.map((c) => `${c}`).join(',') }
}))

const create = http.post(`${API}/sys/imports`, handle((ctx, { body }) => {
  requirePerm(ctx, 'sys:import:confirm')
  const countryId = requireCountry(ctx)
  const type = body?.importType
  if (!TEMPLATES[type]) bad('不支持的导入类型')
  const hash = String(body?.fileHash || JSON.stringify(body?.rows ?? []))
  const prev = getDb().importBatches.find((b) => b.countryId === countryId && b.fileHash === hash && b.status === 'COMPLETED')
  if (prev) return { ...prev, message: '已导入', duplicate: true }
  const rows = body?.rows ?? []
  const errors = validate(ctx, type, rows, body?.cutoffDate)
  const batch = {
    id: nextId(), countryId, importType: type, fileHash: hash, cutoffDate: body?.cutoffDate || null,
    status: errors.length ? 'VALIDATION_FAILED' : 'VALIDATED', totalRows: rows.length, errorRows: errors.length,
    rows, errors, createdBy: ctx.user.id, createdAt: nowIso(),
  }
  getDb().importBatches.unshift(batch)
  return batch
}))

const detail = http.get(`${API}/sys/imports/:id`, handle((ctx, { params }) => findOr404(ctx, 'importBatches', Number(params.id))))

const confirm = http.post(`${API}/sys/imports/:id/confirm`, handle((ctx, { params }) => {
  requirePerm(ctx, 'sys:import:confirm')
  const key = ctx.request.headers.get('Idempotency-Key')
  const db = getDb()
  if (key && db.idempotency[key]) return { ...findOr404(ctx, 'importBatches', Number(db.idempotency[key])), duplicate: true }
  const batch = findOr404(ctx, 'importBatches', Number(params.id))
  if (batch.status === 'COMPLETED') return { ...batch, duplicate: true }
  if (batch.status !== 'VALIDATED') bad('请先通过预校验')
  const targets: number[] = []
  for (const raw of batch.rows as Row[]) {
    if (batch.importType === 'OPENING_STOCK') {
      const wh = db.warehouses.find((w) => w.countryId === ctx.countryId && w.code === raw.warehouseCode)!
      const p = product(db.products.find((x) => x.productCode === raw.productCode)!.id)!
      const batchNo = raw.batchNo || `OPEN-${batch.id}-${targets.length + 1}`
      const created = openingIn(ctx, {
        warehouseId: wh.id, productId: p.id, qty: Number(raw.qty), unitCost: Number(raw.unitCost), batchNo, bizDate: batch.cutoffDate,
        source: { type: 'OPENING', id: batch.id, lineId: nextId(), no: `IMP-${batch.id}` },
      })
      if (created) targets.push(created.id)
    }
    if (batch.importType === 'OPENING_GL') {
      const book = db.books.find((b) => b.countryId === ctx.countryId)!
      const acc = db.finAccounts.find((a) => a.bookId === book.id && a.code === raw.accountCode)!
      const row = { id: nextId(), bookId: book.id, accountId: acc.id, currency: book.baseCurrency, baseAmount: Number(raw.amount), direction: raw.direction, status: 'DRAFT', cutoffDate: batch.cutoffDate, importBatchId: batch.id }
      db.finOpenings.push(row)
      targets.push(row.id)
    }
    if (batch.importType === 'STOCK_LIMIT') {
      const wh = db.warehouses.find((w) => w.countryId === ctx.countryId && w.code === raw.warehouseCode)!
      const p = db.products.find((x) => x.productCode === raw.productCode)!
      db.stockLimits.push({ id: nextId(), countryId: ctx.countryId, warehouseId: wh.id, productId: p.id, minQty: Number(raw.minQty), maxQty: Number(raw.maxQty), alertEnabled: true, status: 'ACTIVE', versionNo: 1, createdAt: nowIso() })
    }
  }
  batch.status = 'COMPLETED'
  batch.targetIds = targets
  batch.confirmedBy = ctx.user.id
  batch.confirmedAt = nowIso()
  if (key) db.idempotency[key] = batch.id
  audit(ctx, '确认导入', 'import', batch.id, null, { importType: batch.importType, rows: batch.totalRows })
  return batch
}))

const jobs = http.get(`${API}/sys/jobs`, handle((ctx) => {
  requirePerm(ctx, 'sys:export:view')
  const countryId = requireCountry(ctx)
  return paginate(getDb().asyncJobs.filter((j) => j.countryId === countryId && j.createdBy === ctx.user.id), ctx.url)
}))

const jobCreate = http.post(`${API}/sys/jobs`, handle((ctx, { body }) => {
  requirePerm(ctx, 'sys:export:view')
  const job = {
    id: nextId(), countryId: requireCountry(ctx), jobType: body?.jobType || 'EXPORT', params: body?.params ?? {}, status: 'DONE', progress: 100,
    resultText: `导出任务 ${today(ctx.countryId!)}，筛选 ${JSON.stringify(body?.params ?? {})}`, createdBy: ctx.user.id, createdAt: nowIso(),
    expireAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  }
  getDb().asyncJobs.unshift(job)
  return job
}))

const download = http.get(`${API}/sys/jobs/:id/download`, handle((ctx, { params }) => {
  requirePerm(ctx, 'sys:export:view')
  const job = findOr404(ctx, 'asyncJobs', Number(params.id))
  if (job.createdBy !== ctx.user.id) bad('只能下载自己发起的任务', 'SYS_FORBIDDEN')
  return { filename: `export-${job.id}.txt`, content: job.resultText }
}))

export const impHandlers = [tpl, create, detail, confirm, jobs, jobCreate, download]
