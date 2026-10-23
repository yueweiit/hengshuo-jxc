import type { AuditLog } from '@/components/AuditTimeline.vue'
import { auditCell, auditRecord, defaultAuditPresentation, type AuditDrawerEntry, type AuditSnapshot } from '@/components/auditPresentation'

const ACTIONS: Record<string, string> = { CREATE: '创建收货单', UPDATE: '修改收货单', CONFIRM: '确认收货', CONVERT: '待检转换', void: '作废收货单', VOID: '作废收货单' }
const QUANTITIES = ['qualifiedQty', 'pendingInspectQty', 'damagedQty', 'convertedQualifiedQty', 'convertedDamagedQty', 'exportedQty', 'shippedQty', 'returnedQty']
const CORE_COLUMNS = [
  { key: 'productId', label: '商品' }, { key: 'qualifiedQty', label: '合格', numeric: true },
  { key: 'pendingInspectQty', label: '待检', numeric: true }, { key: 'damagedQty', label: '破损', numeric: true },
]
const EXTRA_COLUMNS = [
  { key: 'convertedQualifiedQty', label: '已转合格', numeric: true }, { key: 'convertedDamagedQty', label: '已转破损', numeric: true },
  { key: 'exportedQty', label: '已出口', numeric: true }, { key: 'shippedQty', label: '已发运', numeric: true }, { key: 'returnedQty', label: '已退货', numeric: true },
]
const identity = (value: unknown, name: unknown, label: string) => {
  const code = value == null ? '标识未记录' : `#${value}`
  return { text: typeof name === 'string' && name ? `${name}（${code}）` : `${label} ${code}` }
}

function snapshot(value: Record<string, unknown>, notes: string[]): AuditSnapshot {
  const fields = [
    { label: '收货日期', value: auditCell(value.receiptDate) },
    { label: '供应商', value: identity(value.supplierId, value.supplierName, '供应商') },
    { label: '收货地点', value: auditCell(value.location) },
    { label: '当时状态', value: auditCell(value.status, 'status') },
  ]
  if (!Object.hasOwn(value, 'lines') || value.lines === undefined) {
    notes.push('商品明细未记录，不能推断为没有商品。')
    return { fields, columns: [], rows: [] }
  }
  if (!Array.isArray(value.lines) || !value.lines.every(auditRecord)) {
    notes.push('商品明细格式无法识别，内容保留在原始记录中。')
    return { fields, columns: [], rows: [] }
  }
  const lines = value.lines
  const columns = [...CORE_COLUMNS, ...EXTRA_COLUMNS.filter(column => lines.some(line => line[column.key] != null && String(line[column.key]) !== '0'))]
  if (!value.supplierName || lines.some(line => !line.productName || !line.baseUnit)) notes.push('原记录未完整包含供应商／商品历史名称和数量单位；仅展示已记录内容。')
  return {
    fields, columns,
    rows: lines.map((line, index) => ({
      key: `${index}`,
      cells: columns.map(column => {
        if (column.key === 'productId') return identity(line.productId, line.productName, '商品')
        const cell = auditCell(line[column.key])
        return { text: typeof line.baseUnit === 'string' && line.baseUnit && line[column.key] != null && line[column.key] !== '' ? `${cell.text} ${line.baseUnit}` : cell.text }
      }),
    })),
  }
}

/** Compare only recorded business values; regenerated database IDs are not a product change. */
function businessLines(value: unknown) {
  if (!Array.isArray(value) || !value.every(auditRecord)) return undefined
  return value.map(line => ['orderLineId', 'productId', 'productName', 'baseUnit', ...QUANTITIES].map(key => line[key] == null ? line[key] : String(line[key])))
}

export function domesticReceiptAudit(log: AuditLog): AuditDrawerEntry {
  const entry = defaultAuditPresentation(log)
  entry.title = ACTIONS[log.action] ?? entry.title
  if (ACTIONS[log.action]) entry.originalAction = undefined
  const before = auditRecord(log.beforeValue) ? log.beforeValue : undefined
  const after = auditRecord(log.afterValue) ? log.afterValue : undefined
  if (entry.isCreate && after) {
    entry.snapshot = snapshot(after, entry.notes)
    if (Array.isArray(after.lines) && after.lines.every(auditRecord)) {
      const quantities = after.lines.map(line => line.qualifiedQty)
      const summary = `登记 ${after.lines.length} 行商品`
      // A single recorded quantity needs no arithmetic or invented unit/precision.
      entry.summary.push(quantities.length === 1 && quantities[0] != null ? `${summary}，合格数量 ${quantities[0]}。` : `${summary}，数量见商品明细。`)
    }
  } else if (!entry.attachment) {
    const previousLines = businessLines(before?.lines), nextLines = businessLines(after?.lines)
    if (previousLines && nextLines && JSON.stringify(previousLines) !== JSON.stringify(nextLines)) {
      entry.previousSnapshot = snapshot(before!, entry.notes)
      entry.snapshot = snapshot(after!, entry.notes)
      entry.summary.push('商品明细发生变化，可展开核对操作前后的完整记录。')
    } else if (!!previousLines !== !!nextLines) {
      if (previousLines) entry.previousSnapshot = snapshot(before!, entry.notes)
      if (nextLines) entry.snapshot = snapshot(after!, entry.notes)
      const absent = previousLines ? after : before
      const side = previousLines ? '操作后' : '操作前'
      entry.notes.push(`${side}商品明细${absent?.lines === undefined ? '未记录' : '格式无法识别'}，无法确认商品增删；请核对原始记录。`)
    }
  }
  entry.notes = [...new Set(entry.notes)]
  return entry
}
