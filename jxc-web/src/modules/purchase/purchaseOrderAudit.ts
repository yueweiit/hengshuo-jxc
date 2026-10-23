import type { AuditLog } from '@/components/AuditTimeline.vue'
import { formatQty } from '@/utils/format'
import { statusDef } from '@/utils/status'

type Snapshot = Record<string, unknown>
export interface AuditCell { text: string; status?: string }
export interface AuditChange { label: string; from: AuditCell; to: AuditCell }
export interface AuditField { label: string; value: AuditCell; reference?: string }
export interface AuditColumn { key: string; label: string; numeric?: boolean }
export interface AuditProduct {
  key: number; productId?: string; name: string; code?: string
  currentName?: string; currentCode?: string; cells: Record<string, AuditCell>
}
export interface OrderAuditSnapshot {
  fields: AuditField[]; totals: AuditField[]; columns: AuditColumn[]
  secondaryColumns: AuditColumn[]; lines?: AuditProduct[]
}
export interface PurchaseAuditEntry {
  title: string; isCreate: boolean; summary: string[]; status?: string
  changes: AuditChange[]; other: AuditChange[]; notes: string[]; originalAction?: string
  snapshot?: OrderAuditSnapshot; added?: OrderAuditSnapshot; removed?: OrderAuditSnapshot; linesUnchanged?: number
}
const ACTIONS: Record<string, string> = {
  CREATE: '创建采购单', UPDATE: '修改采购单', submit: '提交采购单', 'cancel-lines': '部分取消',
  close: '关闭采购单', void: '作废采购单', WORKFLOW_APPROVED: '审批通过', WORKFLOW_REJECTED: '审批驳回',
  新增: '创建采购单', 创建采购单: '创建采购单', 修改: '修改采购单', '修改关键字段（需重新审批）': '修改采购单',
  提交: '提交采购单', 部分取消: '部分取消', 关闭: '关闭采购单', 作废: '作废采购单',
}
const LABELS: Record<string, string> = {
  docNo: '采购单号', supplierId: '供应商', supplierName: '供应商名称', currency: '币种',
  sourceCountry: '来源国家', orderDate: '下单日期', bizDate: '业务日期', expectedDate: '预计交期',
  paymentTerms: '付款条款', prepayRatio: '预付比例', termDays: '账期天数', remark: '备注', status: '单据状态',
  totalQty: '订购总数量', totalAmount: '采购总金额', taxAmount: '税额',
  qty: '采购数量', baseQty: '基础数量', unitPrice: '单价', amount: '金额', taxRate: '税率',
  deliveryDate: '交货日期', unit: '交易单位', baseUnit: '基础单位', factor: '换算系数',
  qualifiedQty: '合格数量', pendingInspectQty: '待检数量', damagedQty: '损坏数量',
  cancelledQty: '已取消数量', exportedQty: '已出口数量', shippedQty: '已发运数量', arrivedMxQty: '目的地实收数量',
  returnedQty: '已退货数量', domesticReturnedQty: '国内退货数量', overseasReturnedQty: '海外退货数量',
  openingShippedQty: '期初已发运数量', productId: '商品标识', productCode: '商品编码', productName: '商品名称',
  openingRef: '期初来源', cutoffDate: '期初截止日期',
}
const TECHNICAL = new Set(['id', 'countryId', 'bookId', 'entityId', 'version', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'approvalInstanceId', 'importRowId'])
const LINE_TECHNICAL = new Set([...TECHNICAL, 'orderId', 'lineNo'])
const MONEY = new Set(['unitPrice', 'amount', 'totalAmount', 'taxAmount'])
const QUANTITIES = new Set(['qty', 'baseQty', 'totalQty', 'qualifiedQty', 'pendingInspectQty', 'damagedQty', 'cancelledQty', 'exportedQty', 'shippedQty', 'arrivedMxQty', 'returnedQty', 'domesticReturnedQty', 'overseasReturnedQty', 'openingShippedQty'])
const NUMBERS = new Set([...MONEY, ...QUANTITIES, 'factor', 'taxRate', 'prepayRatio', 'termDays'])
const SUMMARY_KEYS = new Set(['docNo', 'supplierId', 'supplierName', 'currency', 'status'])
const own = (record: Snapshot, key: string) => Object.hasOwn(record, key)
const record = (value: unknown): value is Snapshot => typeof value === 'object' && value !== null && !Array.isArray(value)
const recorded = (value: unknown) => value !== undefined && value !== null && value !== ''

/** Keep recorded decimal precision; currency-style rounding would hide four-place changes. */
function decimal(value: unknown) {
  return String(value).replace(/^(\-?)0+(?=\d)/, '$1').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace(/^-0$/, '0')
}
function equal(a: unknown, b: unknown, key: string) {
  const sameEmpty = (Array.isArray(a) && Array.isArray(b) && !a.length && !b.length)
    || (record(a) && record(b) && !Object.keys(a).length && !Object.keys(b).length)
  return Object.is(a, b) || sameEmpty || (NUMBERS.has(key) && recorded(a) && recorded(b) && decimal(a) === decimal(b))
}
function cell(value: unknown, key: string, source: Snapshot, parent: Snapshot): AuditCell {
  if (value === undefined) return { text: '未记录' }
  if (value === null) return { text: '未填写' }
  if (value === '') return { text: '空白' }
  if (key === 'status' && typeof value === 'string') return { text: statusDef(value).label, status: value }
  if (MONEY.has(key)) return { text: `${decimal(value)}${recorded(parent.currency) ? ` ${parent.currency}` : '（币种未记录）'}` }
  if (QUANTITIES.has(key)) {
    const unit = key === 'qty' ? source.unit : source.baseUnit
    return { text: formatQty(value as number | string, typeof unit === 'string' ? unit : undefined) }
  }
  if (key === 'supplierId') return { text: `供应商 #${value}` }
  if (Array.isArray(value)) return { text: value.length ? '列表' : '空列表' }
  if (record(value)) return { text: '空对象' }
  return { text: typeof value === 'boolean' ? (value ? '是' : '否') : String(value) }
}

/** Flatten only for display, preserving unknown leaf paths instead of dumping object JSON. */
function leaves(value: unknown, path: string, out = new Map<string, unknown>()) {
  const entries = Array.isArray(value) ? value.map((v, i) => [`[${i + 1}]`, v] as const) : record(value) ? Object.entries(value) : []
  if (!entries.length) out.set(path, value)
  else for (const [key, item] of entries) leaves(item, `${path}${key.startsWith('[') ? '' : '.'}${key}`, out)
  return out
}
function fields(before: Snapshot, after: Snapshot, oldParent: Snapshot, newParent: Snapshot, skip: Set<string>, prefix = '') {
  const changes: AuditChange[] = [], other: AuditChange[] = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (skip.has(key)) continue
    const from = leaves(before[key], key), to = leaves(after[key], key)
    for (const path of new Set([...from.keys(), ...to.keys()])) {
      const a = from.get(path), b = to.get(path)
      const currencyChanged = MONEY.has(key) && oldParent.currency !== newParent.currency && (recorded(a) || recorded(b))
      if (equal(a, b, key) && !currencyChanged) continue
      const change = {
        label: `${prefix}${LABELS[key] ? path.replace(key, LABELS[key]) : path}`,
        from: cell(a, key, before, oldParent), to: cell(b, key, after, newParent),
      }
      ;(LABELS[key] ? changes : other).push(change)
    }
  }
  return { changes, other }
}

function lineLabel(line: Snapshot, index: number) {
  const name = [line.productCode, line.productName].filter(recorded).join(' ')
  return `第 ${recorded(line.lineNo) ? line.lineNo : index + 1} 行／${name || (recorded(line.productId) ? `商品 #${line.productId}` : '商品标识未记录')}`
}
function identity(line: Snapshot) {
  const keys = ['productId', 'unit', 'baseUnit', 'factor']
  return keys.every(key => recorded(line[key])) ? JSON.stringify(keys.map(key => key === 'factor' ? decimal(line[key]) : String(line[key]))) : undefined
}
function uniqueIndex(lines: Snapshot[], key: (line: Snapshot) => string | undefined) {
  const index = new Map<string, number[]>()
  lines.forEach((line, i) => { const value = key(line); if (value !== undefined) index.set(value, [...(index.get(value) ?? []), i]) })
  return index
}
function matchLines(before: Snapshot[], after: Snapshot[]) {
  const pairs = new Map<number, number>(), used = new Set<number>()
  for (const key of [(line: Snapshot) => recorded(line.id) ? String(line.id) : undefined, identity]) {
    const from = uniqueIndex(before, key), to = uniqueIndex(after, key)
    for (const [value, oldIndices] of from) {
      const newIndices = to.get(value)
      if (oldIndices.length === 1 && newIndices?.length === 1 && !pairs.has(oldIndices[0]!) && !used.has(newIndices[0]!)) {
        pairs.set(oldIndices[0]!, newIndices[0]!); used.add(newIndices[0]!)
      }
    }
  }
  return { pairs, used }
}
const PRIMARY = ['lineNo', 'product', 'qty', 'unit', 'unitPrice', 'amount', 'taxRate', 'deliveryDate']
const SECONDARY = ['baseUnit', 'factor', 'baseQty', ...[...QUANTITIES].filter(k => !['qty', 'baseQty', 'totalQty'].includes(k))]
const validLines = (value: unknown): value is Snapshot[] => Array.isArray(value) && value.every(record)
function numericCell(value: unknown, key: string, line: Snapshot, parent: Snapshot): AuditCell {
  if (!recorded(value)) return cell(value, key, line, parent)
  const normalized = decimal(value)
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return { text: `无法识别的数值：${value}` }
  if (key === 'taxRate') return { text: `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(Number(normalized) * 100)}%` }
  const [whole = '', fraction = ''] = normalized.split('.')
  const digits = fraction.padEnd(key === 'unitPrice' ? 4 : MONEY.has(key) ? 2 : 0, '0')
  return { text: `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${digits ? `.${digits}` : ''}` }
}

/** Purchase events often occur in the same minute; keep seconds without changing shared date formatting. */
export function formatAuditTime(value: string, timeZone: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '日志时间无法识别'
  const text = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date)
  const zone = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(date).find(p => p.type === 'timeZoneName')!.value
  return `${text} ${zone}`
}
function snapshot(source: Snapshot, current: Snapshot): OrderAuditSnapshot {
  const fields: AuditField[] = [], totals: AuditField[] = []
  for (const key of Object.keys(LABELS)) {
    if (!own(source, key) || !['docNo', 'supplierId', 'supplierName', 'sourceCountry', 'orderDate', 'bizDate', 'expectedDate', 'paymentTerms', 'prepayRatio', 'termDays', 'remark', 'currency', 'status', 'openingRef', 'cutoffDate'].includes(key)) continue
    if (key === 'supplierId' && recorded(source.supplierName)) continue
    const field: AuditField = { label: LABELS[key]!, value: cell(source[key], key, source, source) }
    if (key === 'prepayRatio' && recorded(source[key])) field.value.text += '%'
    if (key === 'termDays' && recorded(source[key])) field.value.text += ' 天'
    if (key === 'supplierId' && recorded(source.supplierId) && String(source.supplierId) === String(current.supplierId) && recorded(current.supplierName)) field.reference = `当前名称：${current.supplierName}`
    fields.push(field)
  }
  for (const key of ['totalQty', 'totalAmount', 'taxAmount']) if (own(source, key)) {
    const value = MONEY.has(key) && recorded(source[key])
      ? { text: `${numericCell(source[key], key, source, source).text} ${recorded(source.currency) ? source.currency : '（币种未记录）'}` }
      : cell(source[key], key, source, source)
    totals.push({ label: LABELS[key]!, value })
  }
  const rawLines = validLines(source.lines) ? source.lines : undefined
  const columns = (keys: string[]) => keys.filter(k => k === 'lineNo' || k === 'product' || rawLines?.some(l => own(l, k)))
    .map(key => ({ key, label: key === 'lineNo' ? '行号' : key === 'product' ? '商品' : MONEY.has(key) ? `${LABELS[key]}（${recorded(source.currency) ? source.currency : '币种未记录'}）` : LABELS[key]!, numeric: NUMBERS.has(key) }))
  const currentLines = validLines(current.lines) ? current.lines : []
  const lines = rawLines?.map((line, index) => {
    const productId = recorded(line.productId) ? String(line.productId) : undefined
    const named = recorded(line.productName) || recorded(line.productCode)
    const references = productId ? currentLines.filter(l => String(l.productId) === productId) : []
    const reference = references[0]
    const cells: Record<string, AuditCell> = { lineNo: { text: String(line.lineNo ?? index + 1) } }
    for (const key of [...PRIMARY, ...SECONDARY]) if (!['product', 'lineNo'].includes(key)) {
      cells[key] = NUMBERS.has(key) ? numericCell(line[key], key, line, source) : cell(line[key], key, line, source)
    }
    return {
      key: index, productId, name: recorded(line.productName) ? String(line.productName) : productId ? `商品 #${productId}` : '商品标识未记录',
      code: recorded(line.productCode) ? String(line.productCode) : undefined,
      currentName: !named && recorded(reference?.productName) ? String(reference!.productName) : undefined,
      currentCode: !named && recorded(reference?.productCode) ? String(reference!.productCode) : undefined, cells,
    }
  })
  return { fields, totals, columns: columns(PRIMARY), secondaryColumns: columns(SECONDARY), lines }
}

export function purchaseOrderAudit(log: AuditLog, current: Snapshot = {}): PurchaseAuditEntry {
  const before = log.beforeValue ?? {}, after = log.afterValue ?? {}
  const title = ACTIONS[log.action] ?? (/[^\x00-\x7f]/.test(log.action) ? log.action : '其他操作')
  const isCreate = title === '创建采购单'
  const entry: PurchaseAuditEntry = { title, isCreate, summary: [], changes: [], other: [], notes: [] }
  if (log.afterValue) entry.snapshot = snapshot(after, current)
  if (title === '其他操作') entry.originalAction = log.action
  if (typeof after.status === 'string') entry.status = after.status
  if (!log.beforeValue && !log.afterValue) entry.notes.push('此记录未提供可展示的字段快照。')
  if (isCreate) {
    if (recorded(after.docNo)) entry.summary.push(`采购单号：${after.docNo}`)
    if (recorded(after.supplierName)) entry.summary.push(`供应商：${after.supplierName}`)
    else if (recorded(after.supplierId)) { entry.summary.push(`供应商：供应商 #${after.supplierId}`); entry.notes.push('供应商历史名称未记录。') }
    if (recorded(after.currency)) entry.summary.push(`币种：${after.currency}`)
    if (Array.isArray(after.lines)) entry.summary.push(`商品明细：${after.lines.length} 行`)
  }
  const main = fields(before, after, before, after, new Set([...TECHNICAL, 'lines', ...(isCreate ? SUMMARY_KEYS : [])]))
  const statusChange = main.changes.find(change => change.label === LABELS.status)
  if (!isCreate && statusChange) entry.summary.push(`${statusChange.from.text} → ${statusChange.to.text}`)
  if (!isCreate) entry.changes.push(...main.changes)
  entry.other.push(...main.other)
  if ((own(before, 'lines') && !validLines(before.lines)) || (own(after, 'lines') && !validLines(after.lines))) {
    const raw = fields({ lines: before.lines }, { lines: after.lines }, before, after, new Set())
    entry.other.push(...raw.other)
    entry.notes.push('商品明细格式无法识别，已在其他变更中保留字段内容。')
    return entry
  }
  // Missing lines mean no recorded snapshot, not an empty list or confirmed deletion.
  if (!own(after, 'lines') && own(before, 'lines')) {
    entry.notes.push('修改后的商品明细未记录，无法判断明细变化。')
    return entry
  }
  if (!isCreate && !own(before, 'lines') && own(after, 'lines')) entry.notes.push('操作前商品明细未记录，仅展示操作后快照，无法确认是否新增。')
  const oldLines = validLines(before.lines) ? before.lines : [], newLines = validLines(after.lines) ? after.lines : []
  const { pairs, used } = matchLines(oldLines, newLines)
  const addedLines: Snapshot[] = [], removedLines: Snapshot[] = []
  let modified = 0
  oldLines.forEach((line, index) => {
    const nextIndex = pairs.get(index)
    if (nextIndex === undefined) {
      removedLines.push(line)
      const unknown = fields(line, {}, before, {}, new Set([...LINE_TECHNICAL, ...Object.keys(LABELS)]), `${lineLabel(line, index)} · 移除 · `)
      entry.other.push(...unknown.other)
    } else {
      const next = newLines[nextIndex]!
      const diff = fields(line, next, before, after, LINE_TECHNICAL, `${lineLabel(next, nextIndex)} · `)
      if (diff.changes.length || diff.other.length) modified++
      entry.changes.push(...diff.changes); entry.other.push(...diff.other)
    }
  })
  newLines.forEach((line, index) => {
    if (used.has(index)) return
    addedLines.push(line)
    const unknown = fields({}, line, {}, after, new Set([...LINE_TECHNICAL, ...Object.keys(LABELS)]), `${lineLabel(line, index)} · `)
    entry.other.push(...unknown.other)
  })
  const added = addedLines.length, removed = removedLines.length
  if (!isCreate && own(before, 'lines') && added) entry.added = snapshot({ ...after, lines: addedLines }, current)
  if (removed) entry.removed = snapshot({ ...before, lines: removedLines }, current)
  if (!isCreate && own(before, 'lines') && own(after, 'lines') && !added && !removed && !modified) entry.linesUnchanged = newLines.length
  if (!isCreate && (added || removed || modified)) entry.summary.push(`商品明细：${[modified && `修改 ${modified} 行`, added && `列入 ${added} 行`, removed && `移除 ${removed} 行`].filter(Boolean).join('，')}`)
  if (added && removed) entry.notes.push('历史明细无法唯一对应，已分别列出移除和新增。')
  if ([...oldLines, ...newLines].some(line => !recorded(line.productName) && !recorded(line.productCode))) entry.notes.push('部分商品历史名称未记录，使用商品标识定位。')
  return entry
}
