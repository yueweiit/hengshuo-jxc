import type { AuditCell, AuditChange, AuditEntry, AuditLog } from '@/components/AuditTimeline.vue'
import { formatQty } from '@/utils/format'
import { statusDef } from '@/utils/status'

type Snapshot = Record<string, unknown>
const ACTIONS: Record<string, string> = {
  CREATE: '创建采购单', UPDATE: '修改采购单', submit: '提交审批', 'cancel-lines': '部分取消',
  close: '关闭采购单', void: '作废采购单', WORKFLOW_APPROVED: '审批通过', WORKFLOW_REJECTED: '审批驳回',
  新增: '创建采购单', 创建采购单: '创建采购单', 修改: '修改采购单', '修改关键字段（需重新审批）': '修改采购单',
  提交: '提交审批', 部分取消: '部分取消', 关闭: '关闭采购单', 作废: '作废采购单',
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
function lineText(line: Snapshot, parent: Snapshot) {
  const pieces: string[] = []
  for (const [key, value] of Object.entries(line)) {
    if (LINE_TECHNICAL.has(key) || ['productId', 'productCode', 'productName'].includes(key)) continue
    for (const [path, leaf] of leaves(value, key)) pieces.push(`${LABELS[key] ? path.replace(key, LABELS[key]) : path}：${cell(leaf, key, line, parent).text}`)
  }
  return pieces.length ? pieces.join('；') : '未记录其他明细字段'
}

export function purchaseOrderAudit(log: AuditLog): AuditEntry {
  const before = log.beforeValue ?? {}, after = log.afterValue ?? {}
  const title = ACTIONS[log.action] ?? (/[^\x00-\x7f]/.test(log.action) ? log.action : '其他操作')
  const isCreate = title === '创建采购单'
  const entry: AuditEntry = { title, isCreate, summary: [], changes: [], other: [], notes: [] }
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
  entry.changes.push(...main.changes); entry.other.push(...main.other)
  const validLines = (value: unknown): value is Snapshot[] => Array.isArray(value) && value.every(record)
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
  const oldLines = validLines(before.lines) ? before.lines : [], newLines = validLines(after.lines) ? after.lines : []
  const { pairs, used } = matchLines(oldLines, newLines)
  let added = 0, removed = 0, modified = 0
  oldLines.forEach((line, index) => {
    const nextIndex = pairs.get(index)
    if (nextIndex === undefined) {
      removed++
      entry.changes.push({ label: `${lineLabel(line, index)} · 移除`, from: { text: lineText(line, before) }, to: { text: '已移除' } })
    } else {
      const next = newLines[nextIndex]!
      const diff = fields(line, next, before, after, LINE_TECHNICAL, `${lineLabel(next, nextIndex)} · `)
      if (diff.changes.length || diff.other.length) modified++
      entry.changes.push(...diff.changes); entry.other.push(...diff.other)
    }
  })
  newLines.forEach((line, index) => {
    if (used.has(index)) return
    added++
    const kind = isCreate ? '' : !own(before, 'lines') ? ' · 原明细未记录' : ' · 新增'
    entry.changes.push({ label: `${lineLabel(line, index)}${kind}`, from: { text: isCreate || !own(before, 'lines') ? '未记录' : '无此明细' }, to: { text: lineText(line, after) } })
  })
  if (!isCreate && (added || removed || modified)) entry.summary.push(`商品明细：${[modified && `修改 ${modified} 行`, added && `列入 ${added} 行`, removed && `移除 ${removed} 行`].filter(Boolean).join('，')}`)
  if (added && removed) entry.notes.push('历史明细无法唯一对应，已分别列出移除和新增。')
  if ([...oldLines, ...newLines].some(line => !recorded(line.productName) && !recorded(line.productCode))) entry.notes.push('部分商品历史名称未记录，使用商品标识定位。')
  return entry
}
