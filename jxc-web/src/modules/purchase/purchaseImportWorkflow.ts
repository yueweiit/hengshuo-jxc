import { shallowRef, type ShallowRef } from 'vue'
import type { ImportRow, ImportValues, MatchInputs, ImportDraftGroup, FeeReviewInput, PurchaseImportApi } from '@/modules/purchase/purchaseImportModel'
import { importColumns, isBatchId, importRecord as record, importPositiveId as positiveId } from '@/modules/purchase/purchaseImportModel'
import { imageReviewProgress as reviewProgress, imageReviewRows } from '@/modules/purchase/purchaseImportProgress'
interface Dependencies {
  state: { batchId: string | null; rows: ImportRow[]; groups: ImportDraftGroup[]; tasks: import('./purchaseImportModel').ImportTask[]; version: number; success: string; error: string; imageReviewError: string; edit: unknown }; api: PurchaseImportApi; busy: () => boolean; reviewing?: () => boolean; headerDirty: () => boolean; rowLocked: (row: ImportRow) => boolean
  failure: (error: unknown) => void; newKey: () => string; loadBatch: (id: string) => Promise<boolean>
  saveHeader: () => Promise<boolean>
  write: (flag: 'saving', request: () => Promise<unknown>, apply: (response: unknown) => void) => Promise<boolean>
  readRow: (value: unknown) => ImportRow; readGroup: (value: unknown) => ImportDraftGroup
  readBatch: (value: unknown) => Parameters<Dependencies['applyBatch']>[0]; applyBatch: (batch: import('./purchaseImportModel').ImportBatch, preserveDraft?: boolean) => void
}
export function purchaseOrderSaveStatus(group: ImportDraftGroup) {
  if (group.orderId) return ({ VERIFIED:'已保存，读回核对一致', DIFFERENT:'已保存，采购单与确认内容有差异，请核对', READ_FAILED:'已保存，读回核对失败，请重试读取' } as Record<string,string>)[group.verifyStatus] ?? '已保存，读回待核实'
  return ({ READY:'待保存', DRAFT:'资料待核对', CREATING:'原保存请求处理中，请稍后重试', UNKNOWN:'原保存结果待核实，请继续原请求', FAILED:'保存失败，请继续原请求' } as Record<string,string>)[group.createStatus] ?? '保存结果待核实'
}
export function createPurchaseImportWorkflow(deps: Dependencies) {
  const { state,api,busy,headerDirty,rowLocked,failure,newKey,loadBatch,write,readRow,readGroup,readBatch,applyBatch } = deps
  const operationBusy = () => busy() || !!deps.reviewing?.()
  function applyReview(row: ImportRow, response: unknown) {
    const saved = readRow(response)
    if (saved.id !== row.id || saved.rowNo !== row.rowNo || saved.version <= row.version) throw new Error('后端返回的商品确认记录或版本不正确')
    state.rows.splice(state.rows.findIndex(item => item.id === row.id), 1, saved)
    if (saved.batchVersion !== undefined) state.version = saved.batchVersion
    state.success = saved.readiness === 'READY' ? '本行商品与单位已确认' : saved.readiness === 'NEEDS_SETUP' ? '已保存真实商品，请完成所需配置后重新核对' : '本行已保存为待确认'
  }
  async function decideProduct(row: ImportRow, input: Record<string, unknown>) {
    if (!api.decide || !state.batchId || operationBusy() || state.edit || rowLocked(row)) return false
    return write('saving', () => api.decide!(state.batchId!, { ...row }, input), response => applyReview(row, response))
  }
  async function createProduct(row: ImportRow, input: Record<string, unknown>, key: string) {
    if (!api.createProduct || !state.batchId || operationBusy() || state.edit || rowLocked(row)) return false
    const request = JSON.parse(JSON.stringify(input)) as Record<string, unknown>
    return write('saving', () => api.createProduct!(state.batchId!, { ...row }, request, key), response => applyReview(row, response))
  }
  const matchKeys = new Map<string, string>()
  const imageReviewProgress = () => reviewProgress(state)
  async function startImageReview() {
    if (!api.startMatches || busy() || state.edit) return false
    const tasks = new Map(state.tasks.map(task => [task.id,task]))
    const ids = imageReviewRows(state).filter(row => {
      if (row.readiness === 'READY') return false
      if (!row.matchTaskId) return true
      const task = tasks.get(row.matchTaskId)
      return task?.status === 'SUCCEEDED' && row.matchResult && row.matchResult.inputRevision !== row.version
        || task?.status === 'STALE' && task.errorCode === 'INPUT_CHANGED'
    }).map(row => row.id)
    if (!ids.length) return false
    const batch = state.batchId
    state.imageReviewError = ''
    const saved = await startMatches(ids, true)
    if (state.batchId === batch && !saved) state.imageReviewError = state.error || '核对任务尚未登记，请核对后重试'
    return saved
  }
  async function saveMatchInputs(row: ImportRow, input: MatchInputs) {
    if (!state.batchId || operationBusy() || state.edit || headerDirty() || rowLocked(row)) return false
    const normalized = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value?.trim() || null])) as unknown as MatchInputs
    if (Object.values(normalized).some(value => value !== null && value.length > 200)) { failure(new Error('补充文字最多200个字符')); return false }
    const values = Object.fromEntries(importColumns.map(column => [column.key, row[column.key]])) as ImportValues
    return write('saving', () => api.saveRow(state.batchId!, row, values, normalized), response => applyReview(row, response))
  }
  async function startMatches(rowIds: number[], useSavedInputs = false) {
    if (!api.startMatches || !state.batchId || busy() || state.edit || (!useSavedInputs && headerDirty()) || !rowIds.length || new Set(rowIds).size !== rowIds.length || rowIds.some(id => !state.rows.some(row => row.id === id && !rowLocked(row)))) return false
    if (state.tasks.some(task => ['MATCH', 'EXPLAIN'].includes(task.kind || '') && ['QUEUED', 'RUNNING'].includes(task.status) && rowIds.some(id => state.rows.find(row => row.id === id)?.matchTaskId === task.id || task.result?.rowId === id))) return false
    const signature = JSON.stringify([state.batchId, state.version, rowIds])
    if (!matchKeys.has(signature)) matchKeys.set(signature, newKey())
    return write('saving', () => api.startMatches!(state.batchId!, state.version, rowIds, matchKeys.get(signature)!), response => {
      if (!record(response) || !Array.isArray(response.taskIds) || response.taskIds.length !== rowIds.length || response.taskIds.some(id => !isBatchId(id))) throw new Error('后端未确认候选任务')
      applyBatch(readBatch(response), useSavedInputs); matchKeys.delete(signature); state.imageReviewError = ''; state.success = 'AI图文核对已登记，请查看导入进度'
    })
  }
  async function explainMatch(row: ImportRow) {
    if (!api.explain || !state.batchId || operationBusy() || state.edit || headerDirty() || rowLocked(row) || !row.matchResult || row.matchResult.inputRevision !== row.version) return false
    const signature = JSON.stringify([row.id, row.version, row.matchResult.runId, 'EXPLAIN'])
    if (!matchKeys.has(signature)) matchKeys.set(signature, newKey())
    return write('saving', () => api.explain!(state.batchId!, row, matchKeys.get(signature)!), response => {
      if (!record(response) || !isBatchId(response.id) || response.status !== 'QUEUED') throw new Error('后端未确认解释任务')
      state.tasks.push({ id: response.id, kind: 'EXPLAIN', status: 'QUEUED', result: { rowId: row.id } }); matchKeys.delete(signature)
    })
  }
  async function previewDrafts() {
    if (!api.previews || !state.batchId || operationBusy() || state.edit || headerDirty()) return false
    return write('saving', () => api.previews!(state.batchId!, state.version), response => applyBatch(readBatch(response)))
  }
  async function saveGroup(group: ImportDraftGroup, header: Record<string, unknown>, splitRowIds?: number[]) {
    if (!api.saveGroup || !state.batchId || operationBusy() || state.edit) return false
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
    if (!api.createDraft || !state.batchId || operationBusy() || state.edit || group.orderId || !['READY', 'FAILED', 'UNKNOWN'].includes(group.createStatus) || !group.previewToken) return false
    let intent = group.createIntent || creationIntents.get(group.id)
    if (!intent || (!group.createIntent && intent.request.previewToken !== group.previewToken)) intent = { key: newKey(), request: { groupVersion: group.version, previewToken: group.previewToken, confirm: true } }
    creationIntents.set(group.id, intent)
    const batch = state.batchId
    const saved = await write('saving', () => api.createDraft!(batch, group, intent.request, intent.key), response => applyCreation(group, response))
    return saved && state.batchId === batch ? await loadBatch(batch) : false
  }
  async function refreshCreation(group: ImportDraftGroup) {
    if (!api.creation || !state.batchId || operationBusy() || state.edit) return false
    return write('saving', () => api.creation!(state.batchId!, group), response => applyCreation(group, response))
  }
  async function saveFeeTodos(group: ImportDraftGroup, items: FeeReviewInput[]) {
    if (!api.saveFeeTodos || !state.batchId || operationBusy() || state.edit || headerDirty()) return false
    return write('saving', () => api.saveFeeTodos!(state.batchId!, group, JSON.parse(JSON.stringify(items))), response => {
      const saved = readGroup(response)
      if (saved.id !== group.id || saved.version < group.version || !positiveId(saved.feeTodosVersion) || !positiveId(group.feeTodosVersion) || saved.feeTodosVersion <= group.feeTodosVersion) throw new Error('后端未确认费用核对版本，请刷新核对')
      const index = state.groups.findIndex(item => item.id === group.id)
      if (index < 0) throw new Error('当前分组已变化，请刷新核对')
      state.groups.splice(index, 1, saved); state.success = '费用核对已保存，仍待在原业务页面登记'
    })
  }

  const saveRun: ShallowRef<object | null> = shallowRef(null)
  async function saveOrders() {
    if (saveRun.value || operationBusy()) return false
    if (!state.batchId || !state.rows.length) { failure(new Error('请先导入并核对采购明细')); return false }
    if (state.edit) { failure(new Error('请先保存或取消正在编辑的明细，再保存采购单')); return false }
    if (!api.previews || !api.createDraft || !api.creation) { failure(new Error('采购单保存或结果查询接口尚未接入')); return false }
    const batch = state.batchId, run = {}
    saveRun.value = run
    const current = () => saveRun.value === run && state.batchId === batch
    const unassigned = () => state.rows.some(row => !row.groupId && !row.targetOrderLineId)
    const originalIntent = (group: ImportDraftGroup) => !!group.createIntent || creationIntents.has(group.id)
    const stop = (message: string) => { if (current()) failure(new Error(message)); return false }
    async function savePreparedGroups() {
      if (!state.groups.length) return stop('没有可保存的采购分组，请核对采购单号与明细')
      for (const group of state.groups) {
        if (group.orderId) {
          if (group.verifyStatus !== 'VERIFIED') return stop(`${group.docNo || group.sourceOrderNo}：${purchaseOrderSaveStatus(group)}`)
          continue
        }
        if (group.createStatus === 'CREATING') return stop(`${group.sourceOrderNo}：${purchaseOrderSaveStatus(group)}`)
        if (['UNKNOWN','FAILED'].includes(group.createStatus) && !originalIntent(group)) return stop(`${group.sourceOrderNo}：原保存请求信息缺失，请查询原结果并核对`)
        if (group.errors.length || !group.previewToken || !group.preview) return stop(`${group.sourceOrderNo}：${group.errors.map(issue => issue.message).join('；') || '请核对完整预览后再保存'}`)
        if (group.feeTodos?.some(todo => todo.reviewStatus !== 'CONFIRMED')) return stop(`${group.sourceOrderNo}：请先核对费用来源、金额与币种`)
      }
      for (const id of state.groups.map(group => group.id)) {
        const group = state.groups.find(item => item.id === id)
        if (!group) return stop('采购分组已变化，请重新读取后核对')
        if (group.orderId) continue
        if (!await createDraft(group) || !current()) return false
        const created = state.groups.find(item => item.id === id)
        if (!created?.orderId) return stop(`${group.sourceOrderNo}：采购单创建结果尚未确认，请继续原保存请求`)
        if (!await refreshCreation(created) || !current()) return false
        const verified = state.groups.find(item => item.id === id)
        if (!verified || verified.verifyStatus !== 'VERIFIED') return stop(`${group.sourceOrderNo}：${verified ? purchaseOrderSaveStatus(verified) : '读回分组不存在'}`)
      }
      return true
    }
    try {
      if (headerDirty() && (!await deps.saveHeader() || !current())) return false
      for (const group of [...state.groups]) {
        if (!group.orderId && !originalIntent(group) && !['CREATING','UNKNOWN','FAILED'].includes(group.createStatus)) continue
        if (!await refreshCreation(group) || !current()) return false
      }
      const recovering = state.groups.some(group => !group.orderId && originalIntent(group))
      if (!recovering && (unassigned() || !state.groups.length || state.groups.some(group => !group.orderId))) {
        if (!await previewDrafts() || !current()) return false
      }
      if (!await savePreparedGroups() || !current()) return false
      // 原请求先完成，再为其后新增、尚未分组的来源建立预览，避免刷新原意图的凭证。
      if (unassigned()) {
        if (!await previewDrafts() || !current() || !await savePreparedGroups() || !current()) return false
      }
      if (unassigned()) return stop('仍有未归入采购单的明细，请核对来源分组')
      state.success = `已保存 ${state.groups.length} 张采购单草稿，已读回核对一致`
      return true
    } finally { if (saveRun.value === run) saveRun.value = null }
  }

  function reset() { saveRun.value = null; creationIntents.clear(); matchKeys.clear() }
  return { decideProduct,createProduct,saveMatchInputs,startMatches,startImageReview,imageReviewProgress,explainMatch,previewDrafts,saveGroup,createDraft,refreshCreation,saveFeeTodos,saveOrders,saveOrdersPending: () => saveRun.value !== null,reset }
}
