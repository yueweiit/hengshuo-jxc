import type { AuditLog } from '@/components/AuditTimeline.vue'
import { auditCell, auditRecord, defaultAuditPresentation, type AuditSnapshot } from '@/components/auditPresentation'

const actions: Record<string, string> = { CREATE: '创建实收单', UPDATE: '暂存实收数量', CONFIRM: '确认实收' }
const columns = [
  { key: 'productId', label: '商品' }, { key: 'dispatchQty', label: '派送', numeric: true },
  { key: 'goodQty', label: '合格', numeric: true }, { key: 'damagedQty', label: '破损', numeric: true },
  { key: 'pendingInspectQty', label: '待检', numeric: true }, { key: 'shortQty', label: '短缺', numeric: true },
]
function snapshot(value: Record<string, unknown>, notes: string[]): AuditSnapshot {
  const fields = ['docNo', 'bizDate', 'status'].map((key, index) => ({ label: ['实收单号', '业务日期', '当时状态'][index]!, value: auditCell(value[key], key) }))
  if (!Array.isArray(value.lines) || !value.lines.every(auditRecord)) {
    notes.push(value.lines === undefined ? '商品明细未记录，不能推断为空。' : '商品明细格式无法识别，请查看原始记录。')
    return { fields, columns: [], rows: [] }
  }
  if (value.lines.some(line => !line.productName || !line.baseUnit)) notes.push('原记录未完整包含商品历史名称和单位；仅展示已记录内容。')
  return { fields, columns, rows: value.lines.map((line, index) => ({
    key: String(index), cells: columns.map(column => column.key === 'productId'
      ? { text: line.productName ? String(line.productName) : line.productId == null ? '商品未记录' : `商品 #${line.productId}` }
      : auditCell(line[column.key])),
  })) }
}

export function receiptAudit(log: AuditLog) {
  const action = log.action.toUpperCase()
  const entry = defaultAuditPresentation({ ...log, action })
  entry.title = actions[action] ?? entry.title
  if (entry.attachment?.category === 'RECEIPT_PHOTO') entry.attachment.category = '现场照片'
  if (entry.attachment) return entry
  if (auditRecord(log.beforeValue) && Object.hasOwn(log.beforeValue, 'lines')) entry.previousSnapshot = snapshot(log.beforeValue, entry.notes)
  if (auditRecord(log.afterValue)) entry.snapshot = snapshot(log.afterValue, entry.notes)
  entry.notes = [...new Set(entry.notes)]
  return entry
}
