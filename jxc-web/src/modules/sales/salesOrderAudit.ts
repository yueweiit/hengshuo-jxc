import type { AuditLog } from '@/components/AuditTimeline.vue'
import { auditCell, auditRecord, defaultAuditPresentation, type AuditCell, type AuditSnapshot } from '@/components/auditPresentation'
import { formatMoney, formatQty } from '@/utils/format'
import { statusDef } from '@/utils/status'

const actions: Record<string, string> = {
  CREATE: '创建销售订单', UPDATE: '修改销售订单', SUBMIT: '提交审批',
  WORKFLOW_APPROVED: '审批通过', WORKFLOW_REJECTED: '审批驳回',
  WORKFLOW_WITHDRAWN: '撤回审批', WORKFLOW_INVALIDATED: '审批失效',
  CANCEL_LINES: '取消未交数量', CLOSE: '关闭未交数量',
}
const fields = [
  ['docNo', '销售单号'], ['orderDate', '业务日期'], ['customerId', '客户编号'],
  ['paymentType', '付款方式'], ['approvalStatus', '审批状态'], ['fulfillmentStatus', '履约状态'],
  ['paymentStatus', '付款状态'], ['currency', '币种'], ['totalQty', '有效数量（基础）'],
  ['totalAmount', '有效金额'], ['openQty', '未出库数量（基础）'], ['remark', '备注'],
] as const
const columns = [
  { key: 'kind', label: '层级' }, { key: 'product', label: '商品' }, { key: 'warehouse', label: '发货仓' },
  { key: 'qty', label: '原销售数量', numeric: true }, { key: 'unit', label: '销售单位' },
  { key: 'baseQty', label: '原数量（基础）', numeric: true },
  { key: 'cancelledQty', label: '已取消（基础）', numeric: true },
  { key: 'outboundQty', label: '已出库（基础）', numeric: true },
  { key: 'openQty', label: '未出库（基础）', numeric: true },
  { key: 'price', label: '成交价', numeric: true }, { key: 'lineAmount', label: '原金额', numeric: true },
]
const quantities = new Set(['totalQty', 'qty', 'baseQty', 'cancelledQty', 'outboundQty', 'openQty'])
const states = new Set(['paymentType', 'approvalStatus', 'fulfillmentStatus', 'paymentStatus'])

function cell(value: unknown, key: string, currency?: unknown): AuditCell {
  if (value === undefined || value === null || value === '') return auditCell(value)
  if (states.has(key) && typeof value === 'string') return { text: statusDef(value, key === 'approvalStatus' ? 'approvalDoc' : undefined).label }
  if (quantities.has(key) || ['price', 'lineAmount', 'totalAmount'].includes(key)) {
    if (!['number', 'string'].includes(typeof value) || !String(value).trim() || !Number.isFinite(Number(value))) return { text: `数值格式无法识别：${String(value)}` }
    if (quantities.has(key)) return { text: formatQty(value as number | string) }
    return { text: typeof currency === 'string' && currency.trim() ? formatMoney(value as number | string, currency) : `${value}（币种未提供）` }
  }
  return auditCell(value)
}

function identity(value: Record<string, unknown>, kind: 'product' | 'warehouse') {
  const name = value[`${kind}Name`], code = kind === 'product' ? value.productCode : undefined
  if (typeof name === 'string' && name.trim()) return typeof code === 'string' && code.trim() ? `${code} · ${name}` : name
  if (typeof code === 'string' && code.trim()) return code
  const id = value[`${kind}Id`], label = kind === 'product' ? '商品' : '仓库'
  return id == null ? `${label}未提供` : `${label} #${id}`
}

function snapshot(value: Record<string, unknown>, notes: string[]): AuditSnapshot {
  const view: AuditSnapshot = {
    fields: fields.filter(([key]) => Object.hasOwn(value, key)).map(([key, label]) => ({ label, value: cell(value[key], key, value.currency) })),
    columns: [], rows: [],
  }
  if (!Array.isArray(value.lines) || !value.lines.every(auditRecord)) {
    notes.push(value.lines === undefined ? '当前记录未提供商品明细，不能推断为零行。' : '商品明细格式无法识别，请查看原始记录。')
    return view
  }
  view.columns = columns
  value.lines.forEach((line, index) => {
    const product = identity(line, 'product')
    const rows: { key: string; value: Record<string, unknown> }[] = [{ key: `line:${index}`, value: { ...line, kind: '商品', product, warehouse: '不适用' } }]
    if (Array.isArray(line.allocs) && line.allocs.every(auditRecord)) {
      line.allocs.forEach((alloc, i) => rows.push({ key: `alloc:${index}:${i}`, value: {
        ...alloc, kind: '分仓', product, warehouse: identity(alloc, 'warehouse'), baseQty: alloc.allocQty,
        qty: '不适用', unit: '不适用', price: '不适用', lineAmount: '不适用',
      } }))
    } else notes.push(line.allocs === undefined ? '当前记录未提供部分商品的分仓明细。' : '部分分仓明细格式无法识别，请查看原始记录。')
    for (const row of rows) {
      const values: Record<string, unknown> = row.value
      view.rows.push({ key: row.key, cells: columns.map(column => values[column.key] === '不适用' ? { text: '不适用' } : cell(values[column.key], column.key, value.currency)) })
    }
  })
  return view
}

/** Only historical values returned by the existing authorized query enter this view. */
export function salesOrderAudit(log: AuditLog) {
  const entry = defaultAuditPresentation(log)
  if (['ATTACHMENT_UPLOAD', 'ATTACHMENT_DELETE'].includes(log.action)) {
    if (entry.attachment) {
      const categories: Record<string, string> = { SALES_DOC: '销售单据', PAYMENT_PROOF: '收款凭证' }
      entry.attachment.category = entry.attachment.category === undefined ? undefined : categories[entry.attachment.category] ?? entry.attachment.category
    }
    return entry
  }
  const before = auditRecord(log.beforeValue) ? log.beforeValue : undefined
  const after = auditRecord(log.afterValue) ? log.afterValue : undefined
  entry.title = actions[log.action] ?? entry.title
  entry.changes = []
  entry.notes = []
  if (log.beforeValue != null && !before) entry.notes.push('操作前快照格式无法识别，请查看原始记录。')
  if (log.afterValue != null && !after) entry.notes.push('操作后快照格式无法识别，请查看原始记录。')
  if (!actions[log.action]) entry.notes.push(`原始动作：${log.action}`)
  if (!before && !after) entry.notes.push('当前记录未提供业务快照，可能因历史未留存或权限限制；不能还原字段变化。')
  else {
    if (!before && !entry.isCreate) entry.notes.push('操作前快照未提供，可能因历史未留存或权限限制；不表示原字段为空。')
    if (!after) entry.notes.push('操作后快照未提供，可能因历史未留存或权限限制。')
  }
  if (before) entry.previousSnapshot = snapshot(before, entry.notes)
  if (after) {
    entry.snapshot = snapshot(after, entry.notes)
    if (Array.isArray(after.lines) && after.lines.every(auditRecord)) entry.summary.push(`已记录 ${after.lines.length} 行商品；分仓行单独列示，数量为基础数量。`)
  }
  if (before && after) for (const [key, label] of fields) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) entry.changes.push({ label, from: cell(before[key], key, before.currency), to: cell(after[key], key, after.currency) })
  }
  entry.notes = [...new Set(entry.notes)]
  return entry
}
