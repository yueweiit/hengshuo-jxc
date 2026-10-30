import type { AuditLog } from './AuditTimeline.vue'
import { statusDef } from '@/utils/status'
import { formatDateTime } from '@/utils/format'

export interface AuditSnapshot {
  fields: { label: string; value: AuditCell; reference?: string }[]
  columns: { key: string; label: string; numeric?: boolean }[]
  rows: { key: string; cells: AuditCell[] }[]
  emptyMessage?: string
}
export interface AuditCell { text: string; status?: string }
export interface AuditChange { label: string; from: AuditCell; to: AuditCell }
export type AuditPresentation = (log: AuditLog) => AuditDrawerEntry
export interface AuditDrawerEntry {
  title: string
  isCreate: boolean
  summary: string[]
  status?: string
  changes: AuditChange[]
  otherChanges?: AuditChange[]
  notes: string[]
  originalAction?: string
  kind?: 'attachment' | 'confirm' | 'create' | 'change'
  attachment?: { fileName: string; category?: string; id?: string; version?: string }
  snapshot?: AuditSnapshot
  previousSnapshot?: AuditSnapshot
  extraSnapshots?: { key: string; label: string; snapshot: AuditSnapshot }[]
}
export interface AuditDocumentContext { title: string; identifier: string; status?: string }

const ACTIONS: Record<string, string> = {
  CREATE: '创建记录', UPDATE: '修改记录', DELETE: '删除记录', CONFIRM: '确认单据',
  ATTACHMENT_UPLOAD: '上传附件', ATTACHMENT_DELETE: '删除附件',
  WORKFLOW_APPROVED: '审批通过', WORKFLOW_REJECTED: '审批驳回',
  新增: '创建记录', 修改: '修改记录', 删除: '删除记录',
}
const LABELS: Record<string, string> = {
  docNo: '单据编号', code: '编码', name: '名称', status: '单据状态', remark: '备注',
  bizDate: '业务日期', receiptDate: '收货日期', location: '收货地点',
}

export function auditRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Absence, explicit null and blank text are different historical facts. */
export function auditCell(value: unknown, key = ''): AuditCell {
  if (value === undefined) return { text: '未记录' }
  if (value === null) return { text: '未填写' }
  if (value === '') return { text: '空白' }
  if (key === 'status' && typeof value === 'string') return { text: statusDef(value).label, status: value }
  if (typeof value === 'object') return { text: '结构化内容（见原始记录）' }
  return { text: typeof value === 'boolean' ? (value ? '是' : '否') : String(value) }
}

export function defaultAuditPresentation(log: AuditLog): AuditDrawerEntry {
  const before = auditRecord(log.beforeValue) ? log.beforeValue : undefined
  const after = auditRecord(log.afterValue) ? log.afterValue : undefined
  const isCreate = log.action === 'CREATE' || log.action === '新增'
  const title = ACTIONS[log.action] ?? (/[^\x00-\x7f]/.test(log.action) ? log.action : '其他操作')
  const entry: AuditDrawerEntry = {
    title, isCreate, summary: [], changes: [], notes: [],
    kind: log.action === 'ATTACHMENT_UPLOAD' ? 'attachment' : log.action === 'CONFIRM' ? 'confirm' : isCreate ? 'create' : 'change',
  }
  if (title === '其他操作') entry.originalAction = log.action
  if (typeof after?.status === 'string') entry.status = after.status
  if (!before && !after) entry.notes.push('此记录未提供可展示的字段快照。')
  if ((!before && log.beforeValue != null) || (!after && log.afterValue != null)) entry.notes.push('字段快照格式无法识别，可查看原始记录。')
  if (!isCreate && !before && after && log.action !== 'ATTACHMENT_UPLOAD') entry.notes.push('修改前快照未记录，不代表原字段为空。')
  for (const [key, label] of Object.entries(LABELS)) {
    if (!Object.hasOwn(before ?? {}, key) && !Object.hasOwn(after ?? {}, key)) continue
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) {
      entry.changes.push({ label, from: auditCell(before?.[key], key), to: auditCell(after?.[key], key) })
    }
  }
  if (isCreate && after) {
    entry.snapshot = {
      fields: Object.entries(LABELS).filter(([key]) => Object.hasOwn(after, key)).map(([key, label]) => ({ label, value: auditCell(after[key], key) })),
      columns: [], rows: [],
    }
    entry.changes = []
  }
  if (log.action === 'ATTACHMENT_UPLOAD' && after) {
    const categories: Record<string, string> = { PURCHASE_DOC: '采购单据', CUSTOMS_DOC: '报关单据', EXPORT_DOC: '出口单据' }
    entry.attachment = {
      fileName: typeof after.fileName === 'string' && after.fileName ? after.fileName : '文件名未记录',
      category: typeof after.category === 'string' ? categories[after.category] ?? after.category : undefined,
      id: after.attachmentId == null ? undefined : String(after.attachmentId),
      version: after.versionNo == null ? undefined : String(after.versionNo),
    }
  }
  return entry
}

/** Context is the selected record itself; a related order number is never its identity. */
export function auditDocumentContext(row: { id: number } & Record<string, unknown>, title: string): AuditDocumentContext {
  const identifier = [row.docNo, row.code].find(value => (typeof value === 'string' && value.trim() !== '') || typeof value === 'number')
  return { title, identifier: identifier === undefined ? `记录 #${row.id}` : String(identifier), status: typeof row.status === 'string' ? row.status : undefined }
}

export function rawAuditRecord(log: AuditLog) {
  return JSON.stringify({ action: log.action, occurredAt: log.occurredAt, beforeValue: log.beforeValue, afterValue: log.afterValue }, null, 2)
}

interface AuditEvent { log: AuditLog; view: AuditDrawerEntry; time: string; fullTime: string }
interface AuditGroup { key: string; label: string; entries: AuditEvent[] }

export function groupAuditLogs(logs: AuditLog[], timezone: string, presentation?: AuditPresentation): AuditGroup[] {
  const groups = new Map<string, AuditGroup>()
  for (const log of logs) {
    let key = '时间未记录', label = key, time = key, fullTime = key
    if (log.occurredAt && !Number.isNaN(Date.parse(log.occurredAt))) {
      try {
        fullTime = formatDateTime(log.occurredAt, timezone, 'second')
        key = fullTime.slice(0, 10)
        time = fullTime.slice(11)
        const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, weekday: 'long' }).format(new Date(log.occurredAt))
        label = `${key.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1 年 $2 月 $3 日')} ${weekday}`
      } catch {
        key = label = time = '时区配置无法识别'
        fullTime = `时区：${timezone}；原时间：${log.occurredAt}`
      }
    } else if (log.occurredAt) {
      key = label = time = '时间格式无法识别'
      fullTime = log.occurredAt
    }
    let group = groups.get(key)
    if (!group) { group = { key, label, entries: [] }; groups.set(key, group) }
    // The API orders by full occurred_at and id. Keep that order, including equal-minute events.
    group.entries.push({ log, view: presentation ? presentation(log) : defaultAuditPresentation(log), time, fullTime: `${fullTime}（${timezone}）；原时间：${log.occurredAt}` })
  }
  return [...groups.values()]
}
