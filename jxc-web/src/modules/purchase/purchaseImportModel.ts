import { reactive } from 'vue'

export interface ImportHeader {
  bookId: number | null
  supplierId: number | null
  currency: string | null
  orderDate: string | null
  expectedDate: string | null
  paymentTerms: string
  prepayRatio: string | null
  termDays: number | null
}
export const importColumns = [
  { key: 'sourceOrderNo', label: '采购单号', width: 150 },
  { key: 'photo', label: '商品照片', width: 120 },
  { key: 'productSpec', label: '商品规格', width: 160 },
  { key: 'purchaseQty', label: '采购数量', width: 140, numeric: true },
  { key: 'saleUnitPrice', label: '单件售价', width: 140, numeric: true },
  { key: 'saleTotal', label: '售价合计', width: 150, numeric: true },
  { key: 'purchaseUnitPrice', label: '供应商单价（采购单价）', width: 200, numeric: true },
  { key: 'freight', label: '运费', width: 140, numeric: true },
  { key: 'landedUnitCost', label: '到货单位成本', width: 160, numeric: true },
  { key: 'usdUnitCost', label: '美元单位成本', width: 160, numeric: true },
  { key: 'usdTotal', label: '美元成本合计', width: 160, numeric: true },
] as const
export type ImportField = typeof importColumns[number]['key']
export type ImportValues = Record<ImportField, string | null>
export interface ImportImage { id: number; sha256: string; status: 'UNCONFIRMED' | 'CONFIRMED' | 'REJECTED'; publishStatus?: string; publishedProductId?: number | null; productImageId?: number | null }
export interface MatchInputs { suppliedProductCode: string | null; suppliedProductName: string | null; supplierProductCode: string | null }
export interface MatchCandidate { productId: number; product: { id: number; productCode: string; name: string; spec: string | null; units: { unit: string }[] }; visualScore: number | null; textEvidence: { reason: string }[]; visualEvidence: unknown[]; conflicts: string[] }
export interface MatchRun { format: 'MatchRunV1'; runId: string; inputRevision: number; status: string; text: { status: string; reason: string }; image: { status: string; reason: string; errors?: { reason: string }[] }; candidates: MatchCandidate[]; explanation: { status: string; message: string; candidateNotes?: { productId: number; message: string }[] } }
export type ImportRow = ImportValues & Partial<MatchInputs> & { matchTaskId?: string | null; matchResult?: MatchRun | null; id: number; version: number; rowNo: number; groupId?: number | null; targetOrderLineId?: number | null; sourceId?: number; sourceSheet?: string; sourceRow?: number; images?: ImportImage[]; batchVersion?: number; matchedProductId?: number | null; purchaseUnit?: string | null; decision?: string; readiness?: string; setupReasons?: string[]; productSnapshot?: Record<string, unknown> | null; productOperation?: { key: string; request: Record<string, unknown>; status: string } | null }
export interface ImportTask { id: string; kind?: string; phase?: string; attemptCount?: number; status: string; errorCode?: string | null; errorMessage?: string | null; result?: { sheets?: string[]; rowId?: number } }
export interface ImportSource { id: number; fileName: string; fileSha256: string; status: string; warnings?: { sourceRow?: number; message: string }[] }
export interface FeeReviewInput { sourceRowIds: number[]; scope: 'ORDER' | 'LINE' | null; amount: string | null; currency: string | null; reason: string; confirm: boolean }
export interface ImportSourceRef { rowId: number; rowNo: number; sourceId: number | null; sourceSheet: string | null; sourceRow: number | null; fileName: string | null; fileSha256: string | null; sourceStatus: string }
export interface FeeTodo extends Omit<FeeReviewInput, 'confirm'> { format: 'FeeTodoV1'; todoId: string; sourceRows: ImportSourceRef[]; status: 'PENDING'; reviewStatus: 'UNRESOLVED' | 'CONFIRMED' | 'STALE'; registeredReference: null; targetOrderId: number | null; targetDocNo: string | null; targetReferenceStatus: string }
export interface ImportSourceEvidence extends ImportSourceRef { currentValues: ImportValues; originalValues: Record<string, unknown> | null; formulaProvenance: Record<string, unknown> | null; targetOrderLineId: number | null }
export interface ImportDraftGroup { feeTodos?: FeeTodo[]; feeTodosVersion?: number; sourceBasisHash?: string; sourceEvidence?: ImportSourceEvidence[]; id: number; version: number; sourceOrderNo: string; header: ImportHeader & { taxRate?: string | null; priceTaxBasis?: string | null }; createStatus: string; verifyStatus: string; previewToken: string | null; orderId: number | null; docNo?: string; errorCode?: string | null; errorMessage?: string | null; errors: { rowId?: number; sourceSheet?: string; sourceRow?: number; message: string }[]; preview: { header: ImportHeader; totalAmount: string; taxAmount: string; totalQty?: string; lines: { lineNo: number; productId: number; productSpec: string | null; unit: string; qty: string; unitPrice: string; sourceUnitPrice: string; unitPriceDifference: string; amount: string; taxRate: string }[] } | null; createIntent?: { key: string; request: Record<string, unknown> } | null }
export interface ImportBatch { batchId: string; header: ImportHeader; rows: ImportRow[]; version?: number; status?: string; sources?: ImportSource[]; tasks?: ImportTask[]; groups?: ImportDraftGroup[] }
export interface ImportIssue { rowNo?: number; field?: string; message: string }
export interface PurchaseImportApi {
  upload(file: File, batchId: string | null, key: string): Promise<unknown>
  load(batchId: string): Promise<unknown>
  saveHeader(batchId: string, header: ImportHeader, versions: { id: number; version: number }[], batchVersion?: number): Promise<unknown>
  saveRow(batchId: string, row: ImportRow, values: ImportValues): Promise<unknown>
  deleteRow(batchId: string, row: ImportRow): Promise<unknown>
  retryTask?(taskId: string, key: string, sheet: string | null): Promise<unknown>
  associate?(batchId: string, row: ImportRow, imageId: number, association: 'CONFIRMED' | 'REJECTED'): Promise<unknown>
  publishPhotos?(batchId: string, row: ImportRow, imageIds: number[], key: string): Promise<unknown>
}
export const isBatchId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const dateValid = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const decimalValid = (value: string, quantity = false) => (quantity ? /^\d{1,16}(\.\d{1,4})?$/ : /^\d{1,20}(\.\d{1,10})?$/).test(value)

export function validateImportHeader(header: ImportHeader, complete = true): string {
  if ((complete || header.bookId !== null) && !positiveId(header.bookId)) return '请选择有效账套'
  if ((complete || header.supplierId !== null) && !positiveId(header.supplierId)) return '请选择有效供应商'
  if ((complete || header.currency !== null) && (typeof header.currency !== 'string' || !/^[A-Z]{3}$/.test(header.currency))) return '请选择有效币种'
  if ((complete || header.orderDate !== null) && !dateValid(header.orderDate)) return '请填写有效下单日期'
  if (header.expectedDate !== null && header.expectedDate !== '' && !dateValid(header.expectedDate)) return '预计交货日期格式不正确'
  if (typeof header.paymentTerms !== 'string' || header.paymentTerms.length > 200) return '付款条件最多200个字符'
  if (header.prepayRatio !== null && header.prepayRatio !== '' && (!/^\d(\.\d{1,6})?$/.test(header.prepayRatio) || Number(header.prepayRatio) > 1)) return '预付比例应为0至1，最多6位小数'
  if (header.termDays !== null && (!Number.isInteger(header.termDays) || header.termDays < 0 || header.termDays > 2147483647)) return '账期天数应为非负整数'
  return ''
}

function normalizeValues(values: ImportValues): ImportValues {
  const result = {} as ImportValues
  for (const column of importColumns) {
    const value = values[column.key]
    if (value !== null && typeof value !== 'string') throw new Error(`${column.label}应为文本或精确小数字符串`)
    result[column.key] = value === null || value.trim() === '' ? null : value.trim()
  }
  if (!result.sourceOrderNo || result.sourceOrderNo.length > 100) throw new Error('采购单号不能为空且不能超过100个字符')
  for (const column of importColumns) {
    if (!('numeric' in column)) continue
    const value = result[column.key]
    if (column.key === 'purchaseQty' && (value === null || !decimalValid(value, true) || !/[1-9]/.test(value))) throw new Error('采购数量须大于0，最多4位小数和16位整数')
    if (value !== null && !decimalValid(value, column.key === 'purchaseQty')) throw new Error(`${column.label}须为非负数字，最多${column.key === 'purchaseQty' ? 4 : 10}位小数`)
  }
  return result
}

function readRow(value: unknown): ImportRow {
  if (!record(value) || !positiveId(value.id) || !positiveId(value.version) || !positiveId(value.rowNo)) throw new Error('后端返回的明细编号、版本或源行号不完整')
  if (value.images !== undefined && (!Array.isArray(value.images) || value.images.some(image => !record(image) || !positiveId(image.id) || typeof image.sha256 !== 'string' || !['UNCONFIRMED', 'CONFIRMED', 'REJECTED'].includes(String(image.status))))) throw new Error('后端返回的原图关联不完整')
  if (value.readiness !== undefined && !['UNRESOLVED', 'NEEDS_SETUP', 'READY'].includes(String(value.readiness))) throw new Error('后端返回的商品确认状态无效')
  if (value.matchResult !== undefined && value.matchResult !== null) {
    const run = value.matchResult
    const route = (v: unknown) => record(v) && ['FOUND', 'NOT_FOUND', 'NO_INPUT', 'UNAVAILABLE', 'FAILED'].includes(String(v.status)) && typeof v.reason === 'string'
    if (!record(run) || run.format !== 'MatchRunV1' || !isBatchId(run.runId) || !positiveId(run.inputRevision) || !['OK', 'PARTIAL', 'FAILED'].includes(String(run.status)) || !route(run.text) || !route(run.image) || !Array.isArray(run.candidates) || run.candidates.some(c => !record(c) || !positiveId(c.productId) || !record(c.product) || c.product.id !== c.productId || typeof c.product.productCode !== 'string' || typeof c.product.name !== 'string' || !Array.isArray(c.product.units) || !Array.isArray(c.textEvidence) || !Array.isArray(c.visualEvidence) || !Array.isArray(c.conflicts) || c.conflicts.some(v => typeof v !== 'string') || c.visualScore !== null && (typeof c.visualScore !== 'number' || !Number.isFinite(c.visualScore) || c.visualScore < -1.00001 || c.visualScore > 1.00001)) || !record(run.explanation) || !['READY', 'UNAVAILABLE', 'FAILED', 'NOT_REQUESTED'].includes(String(run.explanation.status)) || typeof run.explanation.message !== 'string') throw new Error('后端返回的候选证据不完整，请重新读取')
  }
  return { ...value, ...normalizeValues(value as ImportValues), id: value.id, version: value.version, rowNo: value.rowNo } as ImportRow
}
function readGroup(value: unknown): ImportDraftGroup {
  if (!record(value) || !positiveId(value.id) || !positiveId(value.version) || !record(value.header) || !Array.isArray(value.errors) || value.errors.some(error => !record(error) || typeof error.message !== 'string') || !['DRAFT', 'READY', 'CREATING', 'CREATED', 'FAILED', 'UNKNOWN'].includes(String(value.createStatus)) || !['NOT_CHECKED', 'VERIFIED', 'READ_FAILED', 'DIFFERENT'].includes(String(value.verifyStatus))) throw new Error('后端返回的采购分组不完整')
  if (value.createStatus === 'CREATED' && !positiveId(value.orderId)) throw new Error('已创建结果缺少真实采购单编号，请查询原请求')
  if (value.preview !== null && (!record(value.preview) || !Array.isArray(value.preview.lines) || !value.preview.lines.length)) throw new Error('采购预览明细不完整')
  if (value.createIntent != null && (!record(value.createIntent) || !isBatchId(value.createIntent.key) || !record(value.createIntent.request))) throw new Error('原创建请求信息不完整')
  if (value.feeTodos !== undefined && (!positiveId(value.feeTodosVersion) || typeof value.sourceBasisHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceBasisHash) || !Array.isArray(value.feeTodos) || value.feeTodos.some(todo => !record(todo) || todo.format !== 'FeeTodoV1' || !isBatchId(todo.todoId) || todo.status !== 'PENDING' || todo.registeredReference !== null || !['UNRESOLVED', 'CONFIRMED', 'STALE'].includes(String(todo.reviewStatus)) || !Array.isArray(todo.sourceRowIds) || todo.sourceRowIds.some(id => !positiveId(id)) || !Array.isArray(todo.sourceRows) || todo.sourceRows.some(ref => !record(ref) || !positiveId(ref.rowId)) || todo.amount !== null && (typeof todo.amount !== 'string' || !decimalValid(todo.amount)) || todo.currency !== null && (typeof todo.currency !== 'string' || !/^[A-Z]{3}$/.test(todo.currency)) || todo.scope !== null && !['ORDER', 'LINE'].includes(String(todo.scope))) || !Array.isArray(value.sourceEvidence) || value.sourceEvidence.some(ref => !record(ref) || !positiveId(ref.rowId) || !record(ref.currentValues)))) throw new Error('后端返回的费用待办或来源依据不完整')
  return value as unknown as ImportDraftGroup
}
function readBatch(value: unknown): ImportBatch {
  if (!record(value) || !isBatchId(value.batchId) || !record(value.header) || !Array.isArray(value.rows)) throw new Error('后端返回的导入批次不完整，请检查接口')
  const header = value.header as unknown as ImportHeader
  const message = validateImportHeader(header, false)
  if (message) throw new Error(`后端返回的基础信息不完整：${message}`)
  if (Array.isArray(value.groups)) value.groups = value.groups.map(readGroup)
  const rows = value.rows.map(readRow)
  if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.rowNo)).size !== rows.length) throw new Error('后端返回了重复的明细编号或源行号')
  if (value.version !== undefined && !positiveId(value.version)) throw new Error('后端返回的批次版本无效')
  if (value.status !== undefined && !['DRAFT', 'PARSING', 'REVIEW', 'COMPLETED', 'CANCELLED', 'FAILED'].includes(String(value.status))) throw new Error('后端返回的批次状态无效')
  for (const field of ['sources', 'tasks', 'groups']) if (value[field] !== undefined && !Array.isArray(value[field])) throw new Error('后端返回的来源、任务或分组不完整')
  if (Array.isArray(value.tasks) && value.tasks.some(task => !record(task) || !isBatchId(task.id) || !['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REAUTH', 'STALE'].includes(String(task.status)))) throw new Error('后端返回的任务状态无效')
  return { ...value, batchId: value.batchId, header: { ...header }, rows } as unknown as ImportBatch
}

/** 页面只有一个编辑草稿；网络、解析、持久化错误始终保留为明确错误状态。 */
export function createPurchaseImportModel(api: PurchaseImportApi, today: string, newKey = () => crypto.randomUUID()) {
  const emptyHeader = (): ImportHeader => ({ bookId: null, supplierId: null, currency: '', orderDate: today, expectedDate: null, paymentTerms: '', prepayRatio: null, termDays: null })
  const state = reactive({
    header: emptyHeader(), batchId: null as string | null, rows: [] as ImportRow[],
    edit: null as { id: number; field: ImportField | null; values: ImportValues } | null,
    loading: false, importing: false, saving: false, deletingId: null as number | null,
    error: '', errorCode: '', errors: [] as ImportIssue[], success: '',
    version: 1, status: 'DRAFT', sources: [] as ImportSource[], tasks: [] as ImportTask[],
    groups: [] as ImportDraftGroup[],
  })
  let epoch = 0, readSequence = 0, savedHeader = '', selectedFile: File | null = null, intentSignature = '', intentKey = ''
  const busy = () => state.loading || state.importing || state.saving || state.status === 'PARSING'
  const headerDirty = () => state.batchId !== null && JSON.stringify(state.header) !== savedHeader
  function failure(error: unknown) {
    state.success = ''
    state.error = error instanceof Error ? error.message : '操作失败，未收到有效响应，请重试'
    if (state.error === 'Network Error') state.error = '连接中断，未确认操作结果；请检查本地服务连接后使用原请求重试'
    state.errorCode = record(error) && typeof error.code === 'string' ? error.code : ''
    state.errors = []
    if (record(error) && record(error.data) && Array.isArray(error.data.errors)) {
      state.errors = error.data.errors.filter((issue): issue is ImportIssue => record(issue) && typeof issue.message === 'string' && issue.message.trim().length > 0)
    }
  }
  function clearFeedback() { state.error = ''; state.errorCode = ''; state.errors = []; state.success = '' }
  function applyBatch(batch: ImportBatch, preserveDraft = false) {
    const draft = preserveDraft && (state.batchId === null || headerDirty()) ? state.header : null
    savedHeader = JSON.stringify(batch.header)
    state.batchId = batch.batchId
    state.header = draft ?? batch.header
    state.rows = batch.rows
    // 兼容旧header/rows响应；仅缺少新增元数据时采用历史REVIEW语义。
    state.version = batch.version === undefined ? 1 : batch.version
    state.status = batch.status === undefined ? 'REVIEW' : batch.status
    state.sources = batch.sources === undefined ? [] : batch.sources
    state.tasks = batch.tasks === undefined ? [] : batch.tasks
    state.groups = batch.groups === undefined ? [] : batch.groups
    state.edit = null
  }
  async function write(flag: 'importing' | 'saving', request: () => Promise<unknown>, apply: (response: unknown) => void) {
    if (busy()) return false
    const context = epoch
    clearFeedback()
    state[flag] = true
    try {
      const response = await request()
      if (context !== epoch) return false
      apply(response)
      return true
    } catch (error) {
      if (context === epoch) failure(error)
      return false
    } finally {
      if (context === epoch) { state[flag] = false; state.deletingId = null }
    }
  }
  async function loadBatch(id: string, preserveDraft = false) {
    if (state.importing || state.saving || state.edit) return false
    const context = epoch, sequence = ++readSequence
    clearFeedback()
    if (!isBatchId(id)) { state.loading = false; failure(new Error('批次编号格式不正确')); return false }
    state.loading = true
    try {
      const response = await api.load(id)
      if (context !== epoch || sequence !== readSequence) return false
      const batch = readBatch(response)
      if (batch.batchId !== id) throw new Error('后端返回的批次编号与请求不一致')
      if (preserveDraft && headerDirty() && savedHeader !== JSON.stringify(batch.header)) throw new Error('基础信息已被其他操作修改，请重新打开批次后核对；当前草稿已保留')
      applyBatch(batch, preserveDraft)
      return true
    } catch (error) {
      if (context === epoch && sequence === readSequence) failure(error)
      return false
    } finally {
      if (context === epoch && sequence === readSequence) state.loading = false
    }
  }
  async function importFile(file: File) {
    if (busy()) return false
    if (state.edit) { failure(new Error('请先保存或取消正在编辑的明细')); return false }
    if (!/\.xlsx$/i.test(file.name) || !file.size) { failure(new Error('请选择非空的.xlsx模板文件')); return false }
    if (file.size > 100 * 1024 * 1024) { failure(new Error('采购文件不能超过100MiB')); return false }
    const signature = JSON.stringify([state.batchId])
    if (selectedFile !== file || signature !== intentSignature) { intentKey = newKey(); selectedFile = file; intentSignature = signature }
    return write('importing', () => api.upload(file, state.batchId, intentKey), response => {
      const batch = readBatch(response)
      if (batch.rows.length === 0 && !(batch.status === 'PARSING' && batch.tasks?.some(task => ['QUEUED', 'RUNNING'].includes(task.status)))) throw new Error('后端返回的导入结果没有明细或有效解析任务，请核对文件')
      if (state.batchId !== null && batch.batchId !== state.batchId) throw new Error('后端返回的导入批次与当前批次不一致')
      applyBatch(batch, true)
      selectedFile = null; intentKey = ''; intentSignature = ''
      if (batch.status !== 'PARSING') state.success = `已导入暂存${batch.rows.length}条明细，请核对无误`
    })
  }
  function rowLocked(row: ImportRow) { return !!row.targetOrderLineId || state.groups.some(group => group.id === row.groupId && ['CREATING', 'UNKNOWN'].includes(group.createStatus)) }
  function startEdit(row: ImportRow, field: ImportField | null) {
    if (rowLocked(row)) { failure(new Error('本行已建单或创建结果待核实，不能修改来源')); return false }
    if (busy() || state.edit || !state.rows.some(item => item.id === row.id)) return false
    clearFeedback()
    state.edit = { id: row.id, field, values: Object.fromEntries(importColumns.map(column => [column.key, row[column.key]])) as ImportValues }
    return true
  }
  function cancelEdit() { if (!state.saving) { state.edit = null; clearFeedback() } }
  async function saveEdit() {
    if (busy() || !state.edit || !state.batchId) return false
    const row = state.rows.find(item => item.id === state.edit!.id)
    if (!row) { failure(new Error('待保存的记录已不存在，请刷新')); return false }
    let values: ImportValues
    try { values = normalizeValues(state.edit.values) } catch (error) { failure(error); return false }
    return write('saving', () => api.saveRow(state.batchId!, { ...row }, values), response => {
      const updated = readRow(response)
      if (updated.id !== row.id || updated.rowNo !== row.rowNo || updated.version <= row.version) throw new Error('后端返回的保存记录编号或版本不正确')
      state.rows.splice(state.rows.findIndex(item => item.id === row.id), 1, updated)
      if (updated.batchVersion !== undefined) state.version = updated.batchVersion
      state.edit = null
      state.success = '明细已保存'
    })
  }
  async function saveHeader() {
    if (busy() || state.edit || !state.batchId) return false
    const invalid = validateImportHeader(state.header)
    if (invalid) { failure(new Error(invalid)); return false }
    const id = state.batchId
    return write('saving', () => api.saveHeader(id, { ...state.header }, state.rows.map(row => ({ id: row.id, version: row.version })), state.version), response => {
      const batch = readBatch(response)
      if (batch.batchId !== id || batch.rows.length !== state.rows.length || batch.rows.some(row => !state.rows.some(old => old.id === row.id))) throw new Error('后端返回的基础信息保存结果与当前批次不一致')
      applyBatch(batch)
      state.success = '基础信息已保存'
    })
  }
  async function removeRow(row: ImportRow) {
    if (busy() || state.edit || !state.batchId || rowLocked(row)) return false
    if (!state.rows.some(item => item.id === row.id && item.version === row.version)) { failure(new Error('删除目标已变化，请刷新核对')); return false }
    state.deletingId = row.id
    return write('saving', () => api.deleteRow(state.batchId!, { ...row }), response => {
      if (!record(response) || response.deleted !== true || response.id !== row.id) throw new Error('后端未确认删除成功，请刷新核对')
      state.rows = state.rows.filter(item => item.id !== row.id)
      if (positiveId(response.batchVersion)) state.version = response.batchVersion
      state.success = '明细已删除'
    })
  }
  async function refreshTasks() {
    if (!state.batchId || state.edit || state.saving || state.importing) return false
    const pending = state.status === 'PARSING'
    const saved = await loadBatch(state.batchId, true)
    if (saved && pending && state.status === 'REVIEW') state.success = `已导入暂存${state.rows.length}条明细，请核对无误`
    return saved
  }
  const retryKeys = new Map<string, string>()
  async function retryTask(task: ImportTask, sheet: string | null = null) {
    if (!api.retryTask || busy() || state.edit) return false
    const signature = JSON.stringify([task.id, sheet])
    if (!retryKeys.has(signature)) retryKeys.set(signature, newKey())
    return write('saving', () => api.retryTask!(task.id, retryKeys.get(signature)!, sheet), response => {
      if (!record(response) || response.id !== task.id || response.status !== 'QUEUED') throw new Error('后端未确认任务重试')
      const saved = state.tasks.find(item => item.id === task.id)
      if (!saved) throw new Error('当前批次任务已变化，请重新读取')
      saved.status = 'QUEUED'; saved.errorCode = null; saved.errorMessage = null
      if (!task.kind || task.kind === 'PARSE') state.status = 'PARSING'
      retryKeys.delete(signature)
    })
  }
  async function associate(row: ImportRow, imageId: number, association: 'CONFIRMED' | 'REJECTED') {
    if (!api.associate || !state.batchId || busy() || state.edit) return false
    return write('saving', () => api.associate!(state.batchId!, row, imageId, association), response => {
      const saved = readRow(response)
      if (saved.id !== row.id || saved.version <= row.version) throw new Error('后端返回的图片确认版本无效')
      state.rows.splice(state.rows.findIndex(item => item.id === row.id), 1, saved)
      if (saved.batchVersion !== undefined) state.version = saved.batchVersion
    })
  }
  const photoKeys = new Map<string, string>()
  async function publishPhotos(row: ImportRow, imageIds: number[]) {
    if (!api.publishPhotos || !state.batchId || busy() || state.edit || headerDirty()) return false
    if (!row.matchedProductId || imageIds.length === 0 || imageIds.some(id => !row.images?.some(image => image.id === id && image.status === 'CONFIRMED'))) { failure(new Error('请先确认真实商品和所选原图归属')); return false }
    const signature = JSON.stringify([state.batchId, row.id, row.version, imageIds])
    if (!photoKeys.has(signature)) photoKeys.set(signature, newKey())
    return write('saving', () => api.publishPhotos!(state.batchId!, row, imageIds, photoKeys.get(signature)!), response => { applyBatch(readBatch(response)); photoKeys.delete(signature); state.success = '商品照片已关联，特征和索引在后台处理' })
  }
  function invalidate() {
    ++epoch; ++readSequence
    state.header = emptyHeader(); state.batchId = null; state.rows = []; state.edit = null
    state.loading = false; state.importing = false; state.saving = false; state.deletingId = null
    selectedFile = null; savedHeader = ''; intentKey = ''; intentSignature = ''; clearFeedback()
    state.version = 1; state.status = 'DRAFT'; state.sources = []; state.tasks = []; retryKeys.clear()
    state.groups = []; photoKeys.clear()
  }
  return { state, busy, headerDirty, rowLocked, clearFeedback, failure, loadBatch, importFile, startEdit, cancelEdit, saveEdit, saveHeader, removeRow, refreshTasks, retryTask, associate, publishPhotos, invalidate }
}
export type PurchaseImportModel = ReturnType<typeof createPurchaseImportModel>
