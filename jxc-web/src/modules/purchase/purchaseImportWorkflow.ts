import type { ImportRow, ImportValues, MatchInputs, ImportDraftGroup, FeeReviewInput, PurchaseImportApi } from '@/modules/purchase/purchaseImportModel'
import { importColumns, isBatchId, importRecord as record, importPositiveId as positiveId } from '@/modules/purchase/purchaseImportModel'
interface Dependencies {
  state: { batchId: string | null; rows: ImportRow[]; groups: ImportDraftGroup[]; tasks: import('./purchaseImportModel').ImportTask[]; version: number; success: string; edit: unknown }; api: PurchaseImportApi; busy: () => boolean; headerDirty: () => boolean; rowLocked: (row: ImportRow) => boolean
  failure: (error: unknown) => void; newKey: () => string; loadBatch: (id: string) => Promise<boolean>
  write: (flag: 'saving', request: () => Promise<unknown>, apply: (response: unknown) => void) => Promise<boolean>
  readRow: (value: unknown) => ImportRow; readGroup: (value: unknown) => ImportDraftGroup
  readBatch: (value: unknown) => Parameters<Dependencies['applyBatch']>[0]; applyBatch: (batch: import('./purchaseImportModel').ImportBatch) => void
}
export function createPurchaseImportWorkflow(deps: Dependencies) {
  const { state,api,busy,headerDirty,rowLocked,failure,newKey,loadBatch,write,readRow,readGroup,readBatch,applyBatch } = deps
  function applyReview(row: ImportRow, response: unknown) {
    const saved = readRow(response)
    if (saved.id !== row.id || saved.rowNo !== row.rowNo || saved.version <= row.version) throw new Error('后端返回的商品确认记录或版本不正确')
    state.rows.splice(state.rows.findIndex(item => item.id === row.id), 1, saved)
    if (saved.batchVersion !== undefined) state.version = saved.batchVersion
    state.success = saved.readiness === 'READY' ? '本行商品与单位已确认' : saved.readiness === 'NEEDS_SETUP' ? '已保存真实商品，请完成所需配置后重新核对' : '本行已保存为待确认'
  }
  async function decideProduct(row: ImportRow, input: Record<string, unknown>) {
    if (!api.decide || !state.batchId || busy() || state.edit || rowLocked(row)) return false
    return write('saving', () => api.decide!(state.batchId!, { ...row }, input), response => applyReview(row, response))
  }
  async function createProduct(row: ImportRow, input: Record<string, unknown>, key: string) {
    if (!api.createProduct || !state.batchId || busy() || state.edit || rowLocked(row)) return false
    const request = JSON.parse(JSON.stringify(input)) as Record<string, unknown>
    return write('saving', () => api.createProduct!(state.batchId!, { ...row }, request, key), response => applyReview(row, response))
  }
  const matchKeys = new Map<string, string>()
  async function saveMatchInputs(row: ImportRow, input: MatchInputs) {
    if (!state.batchId || busy() || state.edit || headerDirty() || rowLocked(row)) return false
    const normalized = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value?.trim() || null])) as unknown as MatchInputs
    if (Object.values(normalized).some(value => value !== null && value.length > 200)) { failure(new Error('补充文字最多200个字符')); return false }
    const values = Object.fromEntries(importColumns.map(column => [column.key, row[column.key]])) as ImportValues
    return write('saving', () => api.saveRow(state.batchId!, row, values, normalized), response => applyReview(row, response))
  }
  async function startMatches(rowIds: number[]) {
    if (!api.startMatches || !state.batchId || busy() || state.edit || headerDirty() || !rowIds.length || new Set(rowIds).size !== rowIds.length || rowIds.some(id => !state.rows.some(row => row.id === id && !rowLocked(row)))) return false
    const signature = JSON.stringify([state.batchId, state.version, rowIds])
    if (!matchKeys.has(signature)) matchKeys.set(signature, newKey())
    return write('saving', () => api.startMatches!(state.batchId!, state.version, rowIds, matchKeys.get(signature)!), response => {
      if (!record(response) || !Array.isArray(response.taskIds) || response.taskIds.length !== rowIds.length || response.taskIds.some(id => !isBatchId(id))) throw new Error('后端未确认候选任务')
      applyBatch(readBatch(response)); matchKeys.delete(signature); state.success = '候选任务已登记，请等待结果并人工核对'
    })
  }
  async function explainMatch(row: ImportRow) {
    if (!api.explain || !state.batchId || busy() || state.edit || headerDirty() || rowLocked(row) || !row.matchResult || row.matchResult.inputRevision !== row.version) return false
    const signature = JSON.stringify([row.id, row.version, row.matchResult.runId, 'EXPLAIN'])
    if (!matchKeys.has(signature)) matchKeys.set(signature, newKey())
    return write('saving', () => api.explain!(state.batchId!, row, matchKeys.get(signature)!), response => {
      if (!record(response) || !isBatchId(response.id) || response.status !== 'QUEUED') throw new Error('后端未确认解释任务')
      state.tasks.push({ id: response.id, kind: 'EXPLAIN', status: 'QUEUED', result: { rowId: row.id } }); matchKeys.delete(signature)
    })
  }
  async function previewDrafts() {
    if (!api.previews || !state.batchId || busy() || state.edit || headerDirty()) return false
    return write('saving', () => api.previews!(state.batchId!, state.version), response => applyBatch(readBatch(response)))
  }
  async function saveGroup(group: ImportDraftGroup, header: Record<string, unknown>, splitRowIds?: number[]) {
    if (!api.saveGroup || !state.batchId || busy() || state.edit) return false
    return write('saving', () => api.saveGroup!(state.batchId!, group, header, splitRowIds), response => applyBatch(readBatch(response)))
  }
  const creationIntents = new Map<number, { key: string; request: Record<string, unknown> }>()
  function applyCreation(group: ImportDraftGroup, response: unknown) {
    if (!record(response) || response.id !== group.id || typeof response.createStatus !== 'string' || !['CREATED', 'CREATING', 'UNKNOWN', 'FAILED', 'READY', 'DRAFT'].includes(response.createStatus) || (response.createStatus === 'CREATED' && !positiveId(response.orderId))) throw new Error('后端返回的采购创建结果不完整，请查询原请求结果')
    const index = state.groups.findIndex(item => item.id === group.id)
    if (index < 0) throw new Error('当前采购分组已变化，请重新读取')
    state.groups.splice(index, 1, { ...group, ...readGroup(response) } as ImportDraftGroup)
  }
  async function createDraft(group: ImportDraftGroup) {
    if (group.feeTodos?.some(todo => todo.reviewStatus !== 'CONFIRMED')) return false
    if (!api.createDraft || !state.batchId || busy() || state.edit || group.orderId || !['READY', 'FAILED', 'UNKNOWN'].includes(group.createStatus) || !group.previewToken) return false
    let intent = group.createIntent || creationIntents.get(group.id)
    if (!intent || (!group.createIntent && intent.request.previewToken !== group.previewToken)) intent = { key: newKey(), request: { groupVersion: group.version, previewToken: group.previewToken, confirm: true } }
    creationIntents.set(group.id, intent)
    const saved = await write('saving', () => api.createDraft!(state.batchId!, group, intent.request, intent.key), response => applyCreation(group, response))
    if (saved) await loadBatch(state.batchId!)
    return saved
  }
  async function refreshCreation(group: ImportDraftGroup) {
    if (!api.creation || !state.batchId || busy() || state.edit) return false
    return write('saving', () => api.creation!(state.batchId!, group), response => applyCreation(group, response))
  }
  async function saveFeeTodos(group: ImportDraftGroup, items: FeeReviewInput[]) {
    if (!api.saveFeeTodos || !state.batchId || busy() || state.edit || headerDirty()) return false
    return write('saving', () => api.saveFeeTodos!(state.batchId!, group, JSON.parse(JSON.stringify(items))), response => {
      const saved = readGroup(response)
      if (saved.id !== group.id || saved.version < group.version || !positiveId(saved.feeTodosVersion) || !positiveId(group.feeTodosVersion) || saved.feeTodosVersion <= group.feeTodosVersion) throw new Error('后端未确认费用核对版本，请刷新核对')
      const index = state.groups.findIndex(item => item.id === group.id)
      if (index < 0) throw new Error('当前分组已变化，请刷新核对')
      state.groups.splice(index, 1, saved); state.success = '费用核对已保存，仍待在原业务页面登记'
    })
  }

  function reset() { creationIntents.clear(); matchKeys.clear() }
  return { decideProduct,createProduct,saveMatchInputs,startMatches,explainMatch,previewDrafts,saveGroup,createDraft,refreshCreation,saveFeeTodos,reset }
}
