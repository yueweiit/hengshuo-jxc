import { reactive } from 'vue'

export interface ImportHeader {
  bookId: number | null
  supplierId: number | null
  currency: string
  orderDate: string
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
export type ImportRow = ImportValues & { id: number; version: number; rowNo: number }
export interface ImportBatch { batchId: string; header: ImportHeader; rows: ImportRow[] }
export interface ImportIssue { rowNo?: number; field?: string; message: string }
export interface PurchaseImportApi {
  upload(file: File, header: ImportHeader, batchId: string | null, key: string): Promise<unknown>
  load(batchId: string): Promise<unknown>
  saveHeader(batchId: string, header: ImportHeader, versions: { id: number; version: number }[]): Promise<unknown>
  saveRow(batchId: string, row: ImportRow, values: ImportValues): Promise<unknown>
  deleteRow(batchId: string, row: ImportRow): Promise<unknown>
}
export const isBatchId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const dateValid = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const decimalValid = (value: string, quantity = false) => (quantity ? /^\d{1,16}(\.\d{1,4})?$/ : /^\d{1,20}(\.\d{1,10})?$/).test(value)

export function validateImportHeader(header: ImportHeader): string {
  if (!positiveId(header.bookId)) return '请选择有效账套'
  if (!positiveId(header.supplierId)) return '请选择有效供应商'
  if (!/^[A-Z]{3}$/.test(header.currency)) return '请选择有效币种'
  if (!dateValid(header.orderDate)) return '请填写有效下单日期'
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
  return { ...normalizeValues(value as ImportValues), id: value.id, version: value.version, rowNo: value.rowNo }
}
function readBatch(value: unknown): ImportBatch {
  if (!record(value) || !isBatchId(value.batchId) || !record(value.header) || !Array.isArray(value.rows)) throw new Error('后端返回的导入批次不完整，请检查接口')
  const header = value.header as unknown as ImportHeader
  const message = validateImportHeader(header)
  if (message) throw new Error(`后端返回的基础信息不完整：${message}`)
  const rows = value.rows.map(readRow)
  if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.rowNo)).size !== rows.length) throw new Error('后端返回了重复的明细编号或源行号')
  return { batchId: value.batchId, header: { ...header }, rows }
}

/** 页面只有一个编辑草稿；网络、解析、持久化错误始终保留为明确错误状态。 */
export function createPurchaseImportModel(api: PurchaseImportApi, today: string, newKey = () => crypto.randomUUID()) {
  const emptyHeader = (): ImportHeader => ({ bookId: null, supplierId: null, currency: '', orderDate: today, expectedDate: null, paymentTerms: '', prepayRatio: '0', termDays: null })
  const state = reactive({
    header: emptyHeader(), batchId: null as string | null, rows: [] as ImportRow[],
    edit: null as { id: number; field: ImportField | null; values: ImportValues } | null,
    loading: false, importing: false, saving: false, deletingId: null as number | null,
    error: '', errors: [] as ImportIssue[], success: '',
  })
  let epoch = 0, readSequence = 0, savedHeader = '', selectedFile: File | null = null, intentSignature = '', intentKey = ''
  const busy = () => state.loading || state.importing || state.saving
  const headerDirty = () => state.batchId !== null && JSON.stringify(state.header) !== savedHeader
  function failure(error: unknown) {
    state.success = ''
    state.error = error instanceof Error ? error.message : '操作失败，未收到有效响应，请重试'
    state.errors = []
    if (record(error) && record(error.data) && Array.isArray(error.data.errors)) {
      state.errors = error.data.errors.filter((issue): issue is ImportIssue => record(issue) && typeof issue.message === 'string' && issue.message.trim().length > 0)
    }
  }
  function clearFeedback() { state.error = ''; state.errors = []; state.success = '' }
  function applyBatch(batch: ImportBatch) {
    state.batchId = batch.batchId
    state.header = batch.header
    state.rows = batch.rows
    state.edit = null
    savedHeader = JSON.stringify(state.header)
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
  async function loadBatch(id: string) {
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
      applyBatch(batch)
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
    const invalid = validateImportHeader(state.header)
    if (invalid) { failure(new Error(invalid)); return false }
    if (!/\.xlsx$/i.test(file.name) || !file.size) { failure(new Error('请选择非空的.xlsx模板文件')); return false }
    const header = { ...state.header }
    const signature = JSON.stringify([state.batchId, header])
    if (selectedFile !== file || signature !== intentSignature) { intentKey = newKey(); selectedFile = file; intentSignature = signature }
    return write('importing', () => api.upload(file, header, state.batchId, intentKey), response => {
      const batch = readBatch(response)
      if (batch.rows.length === 0) throw new Error('后端返回的导入结果没有明细，请核对文件')
      if (state.batchId !== null && batch.batchId !== state.batchId) throw new Error('后端返回的导入批次与当前批次不一致')
      applyBatch(batch)
      selectedFile = null; intentKey = ''; intentSignature = ''
      state.success = `已导入并保存${batch.rows.length}条明细，请核对无误`
    })
  }
  function startEdit(row: ImportRow, field: ImportField | null) {
    if (busy() || state.edit || !state.rows.some(item => item.id === row.id)) return false
    if (headerDirty()) { failure(new Error('请先保存基础信息')); return false }
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
      state.edit = null
      state.success = '明细已保存'
    })
  }
  async function saveHeader() {
    if (busy() || state.edit || !state.batchId) return false
    const invalid = validateImportHeader(state.header)
    if (invalid) { failure(new Error(invalid)); return false }
    const id = state.batchId
    return write('saving', () => api.saveHeader(id, { ...state.header }, state.rows.map(row => ({ id: row.id, version: row.version }))), response => {
      const batch = readBatch(response)
      if (batch.batchId !== id || batch.rows.length !== state.rows.length || batch.rows.some(row => !state.rows.some(old => old.id === row.id))) throw new Error('后端返回的基础信息保存结果与当前批次不一致')
      applyBatch(batch)
      state.success = '基础信息已保存'
    })
  }
  async function removeRow(row: ImportRow) {
    if (busy() || state.edit || !state.batchId) return false
    if (!state.rows.some(item => item.id === row.id && item.version === row.version)) { failure(new Error('删除目标已变化，请刷新核对')); return false }
    if (headerDirty()) { failure(new Error('请先保存基础信息')); return false }
    state.deletingId = row.id
    return write('saving', () => api.deleteRow(state.batchId!, { ...row }), response => {
      if (!record(response) || response.deleted !== true || response.id !== row.id) throw new Error('后端未确认删除成功，请刷新核对')
      state.rows = state.rows.filter(item => item.id !== row.id)
      state.success = '明细已删除'
    })
  }
  function invalidate() {
    ++epoch; ++readSequence
    state.header = emptyHeader(); state.batchId = null; state.rows = []; state.edit = null
    state.loading = false; state.importing = false; state.saving = false; state.deletingId = null
    selectedFile = null; savedHeader = ''; intentKey = ''; intentSignature = ''; clearFeedback()
  }
  return { state, busy, headerDirty, clearFeedback, failure, loadBatch, importFile, startEdit, cancelEdit, saveEdit, saveHeader, removeRow, invalidate }
}
export type PurchaseImportModel = ReturnType<typeof createPurchaseImportModel>
