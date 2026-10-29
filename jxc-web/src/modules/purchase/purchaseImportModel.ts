import { reactive } from 'vue'
import { createPurchaseImportWorkflow } from '@/modules/purchase/purchaseImportWorkflow'
import { createPurchaseImportImages } from '@/modules/purchase/purchaseImportImages'
import { createPurchaseImportGrid, type GridField, type GridSaveInput } from '@/modules/purchase/purchaseImportGrid'
import { readImportTask, imageReviewProgress, type ImportProgress, type ImportUpload } from '@/modules/purchase/purchaseImportProgress'
import { reviewProposalCurrent, type ReviewProposal, type SourceReviewSheet } from '@/modules/purchase/purchaseImportReview'

export interface ImportHeader {
  bookId: number | null
  supplierId: number | null
  currency: string | null
  orderDate: string | null
  expectedDate: string | null
  paymentTerms: string
  prepayRatio: string | null
  termDays: number | null
  taxRate?: string | null
  priceTaxBasis?: 'EXCLUSIVE' | null
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
export const importTableColumns = [importColumns[0], { key: 'suppliedProductName', label: '商品名', width: 180 }, ...importColumns.slice(1)] as const
export type ImportEditField = GridField
export type ImportField = typeof importColumns[number]['key']
export type ImportValues = Record<ImportField, string | null>
export interface ImportImage { id: number; sha256: string; status: 'UNCONFIRMED' | 'CONFIRMED' | 'REJECTED'; origin?: 'MANUAL_UPLOAD' | 'XLSX'; publishStatus?: string; publishedProductId?: number | null; productImageId?: number | null }
export interface MatchInputs { suppliedProductCode: string | null; suppliedProductName: string | null; supplierProductCode: string | null }
export interface VisualMatchEvidence { queryAssetId: number; imageId: number; featureId: number; score: number }
export interface CandidateCheck { productId: number; imageMatch: 'SAME' | 'DIFFERENT' | 'UNCERTAIN' | 'NO_INPUT'; imageReason: string; specMatch: 'MATCH' | 'CONFLICT' | 'MISSING' | 'NOT_CHECKED'; specReason: string }
export interface MatchCandidate { productId: number; product: { id: number; productCode: string; name: string; spec: string | null; status?: string; units: { unit: string }[] }; visualScore: number | null; textEvidence: { reason: string }[]; visualEvidence: VisualMatchEvidence[]; conflicts: string[] }
export interface CandidateTextField { field: 'productCode' | 'spec' | 'name'; label: string; weight: number; source: string | null; target: string | null; score: number | null }
export interface CandidateScore { productId: number; photoScore: number | null; textScore: number | null; fields: CandidateTextField[]; reason: string }
export interface CandidateRanking { format: 'CandidateRankingV1'; policyVersion: string; status: 'RECOMMENDED' | 'NEEDS_REVIEW'; reason: string; completePhotoGroup: boolean; photoThreshold: number; textThreshold: number | null; weights: { productCode: number; spec: number; name: number }; highestPhotoIds: number[]; recommendedIds: number[]; scores: CandidateScore[] }
export interface ProductNameSuggestion { status: 'READY' | 'NEEDS_REVIEW' | 'NO_INPUT'; category: string | null; baseName: string | null; name: string | null; productSpec: string | null; reason: string; sourceKeys: string[] }
export interface MatchRun { format: 'MatchRunV1'; runId: string; inputRevision: number; status: string; ranking?: CandidateRanking; cacheReused?: boolean; text: { status: string; reason: string }; image: { status: string; reason: string; errors?: { reason: string }[] }; candidates: MatchCandidate[]; explanation: { status: string; message: string; candidateNotes?: { productId: number; message: string }[]; candidateChecks?: CandidateCheck[]; productNameSuggestion?: ProductNameSuggestion } }
export type ImportRow = ImportValues & Partial<MatchInputs> & { matchTaskId?: string | null; matchResult?: MatchRun | null; id: number; version: number; rowNo: number; groupId?: number | null; targetOrderLineId?: number | null; sourceId?: number; sourceSheet?: string; sourceRow?: number; sourceItemKey?: string; images?: ImportImage[]; batchVersion?: number; matchedProductId?: number | null; purchaseUnit?: string | null; decision?: string; readiness?: string; setupReasons?: string[]; productSnapshot?: Record<string, unknown> | null; productOperation?: { key: string; request: Record<string, unknown>; status: string } | null }
export interface SupplierMapping { format: string; fileSha256: string; sheet: string; needsReview: boolean; reasons: string[]; ignoredRows: { sourceRow:number; reason:string }[]; lines: { sourceRow:number; cells: Record<string,string | string[] | null> }[] }
export interface MappingOverrides { mapping:SupplierMapping; specLabels:Record<string,string>; confirm:boolean }
export interface SourceMappingPreview { mapping:SupplierMapping; sourceCells:{sheet:string;cell:string;value:string}[]; batchVersion:number }
export interface ImportTask { id: string; sourceId?: number | null; fileName?: string | null; kind?: string; phase?: string; progress?: ImportProgress | null; attemptCount?: number; status: string; errorCode?: string | null; errorMessage?: string | null; result?: { sheets?: string[]; rowId?: number; mapping?: SupplierMapping; sourceCells?: { sheet: string; cell: string; value: string }[]; rows?: number; images?: number; reviewRows?: number; unstagedCandidates?: number } }
export interface ImportSource { sheets?: SourceReviewSheet[]; id: number; fileName: string; fileSha256: string; parserVersion?:string; correctedFrom?:{batchId:string;sourceId:number;batchVersion:number}; status: string; origin?: 'MANUAL_UPLOAD' | 'XLSX'; warnings?: { sourceRow?: number; message: string }[] }
export interface FeeReviewInput { sourceRowIds: number[]; scope: 'ORDER' | 'LINE' | null; amount: string | null; currency: string | null; reason: string; confirm: boolean }
export interface ImportSourceRef { rowId: number; rowNo: number; sourceId: number | null; sourceSheet: string | null; sourceRow: number | null; fileName: string | null; fileSha256: string | null; sourceStatus: string }
export interface FeeTodo extends Omit<FeeReviewInput, 'confirm'> { format: 'FeeTodoV1'; todoId: string; sourceRows: ImportSourceRef[]; status: 'PENDING'; reviewStatus: 'UNRESOLVED' | 'CONFIRMED' | 'STALE'; registeredReference: null; targetOrderId: number | null; targetDocNo: string | null; targetReferenceStatus: string }
export interface ImportSourceEvidence extends ImportSourceRef { currentValues: ImportValues; originalValues: Record<string, unknown> | null; formulaProvenance: Record<string, unknown> | null; targetOrderLineId: number | null }
export interface ImportDraftGroup { feeTodos?: FeeTodo[]; feeTodosVersion?: number; sourceBasisHash?: string; sourceEvidence?: ImportSourceEvidence[]; id: number; version: number; sourceOrderNo: string; header: ImportHeader; createStatus: string; verifyStatus: string; previewToken: string | null; orderId: number | null; docNo?: string; errorCode?: string | null; errorMessage?: string | null; errors: { rowId?: number | null; sourceSheet?: string | null; sourceRow?: number | null; field?: string; message: string }[]; preview: { header: ImportHeader; totalAmount: string; taxAmount: string; totalQty?: string; lines: { lineNo: number; productId: number; productSpec: string | null; unit: string; qty: string; unitPrice: string; sourceUnitPrice: string; unitPriceDifference: string; amount: string; taxRate: string }[] } | null; createIntent?: { key: string; request: Record<string, unknown> } | null }
export interface ImportBatch { batchId: string; header: ImportHeader; rows: ImportRow[]; version?: number; status?: string; sources?: ImportSource[]; tasks?: ImportTask[]; groups?: ImportDraftGroup[] }
export interface ImportIssue { rowNo?: number; field?: string; message: string }
export interface PurchaseImportApi {
  sourceMapping?(batchId:string,sourceId:number):Promise<unknown>
  correctSource?(batchId:string,sourceId:number,batchVersion:number,input:MappingOverrides,key:string):Promise<unknown>
  saveGrid?(input: GridSaveInput, key: string): Promise<unknown>
  confirmReview?(batchId: string, input: Omit<ReviewProposal, 'batchId'>, key: string): Promise<unknown>
  upload(file: File, batchId: string | null, key: string, progress?: (loaded: number, total: number | null) => void): Promise<unknown>
  readTask?(id: string): Promise<unknown>
  load(batchId: string): Promise<unknown>
  saveHeader(batchId: string, header: ImportHeader, versions: { id: number; version: number }[], batchVersion?: number): Promise<unknown>
  saveRow(batchId: string, row: ImportRow, values: ImportValues, matchInputs?: MatchInputs): Promise<unknown>
  uploadPhoto?(batchId: string, row: ImportRow, file: File, values: ImportValues, key: string, matchInputs?: MatchInputs): Promise<unknown>
  readImage?(batchId: string, imageId: number, signal: AbortSignal): Promise<Blob>
  deleteRow(batchId: string, row: ImportRow): Promise<unknown>
  clearBatch?(batchId: string, version: number, key: string): Promise<unknown>
  clearStatus?(batchId: string): Promise<unknown>
  retryTask?(taskId: string, key: string, sheet: string | null, mappingOverrides?: MappingOverrides): Promise<unknown>
  associate?(batchId: string, row: ImportRow, imageId: number, association: 'CONFIRMED' | 'REJECTED'): Promise<unknown>
  decide?(batchId: string, row: ImportRow, input: Record<string, unknown>): Promise<unknown>
  createProduct?(batchId: string, row: ImportRow, input: Record<string, unknown>, key: string): Promise<unknown>
  startMatches?(batchId: string, batchVersion: number, rowIds: number[], key: string): Promise<unknown>
  explain?(batchId: string, row: ImportRow, key: string): Promise<unknown>
  previews?(batchId: string, batchVersion: number): Promise<unknown>
  saveGroup?(batchId: string, group: ImportDraftGroup, header: Record<string, unknown>, splitRowIds?: number[]): Promise<unknown>
  createDraft?(batchId: string, group: ImportDraftGroup, request: Record<string, unknown>, key: string): Promise<unknown>
  saveFeeTodos?(batchId: string, group: ImportDraftGroup, items: FeeReviewInput[]): Promise<unknown>
  creation?(batchId: string, group: ImportDraftGroup): Promise<unknown>
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
  if (header.taxRate != null && header.taxRate !== '' && (typeof header.taxRate !== 'string' || !/^\d(\.\d{1,6})?$/.test(header.taxRate) || Number(header.taxRate) > 1)) return '税率应为0至1，最多6位小数'
  if (header.priceTaxBasis != null && header.priceTaxBasis !== 'EXCLUSIVE') return '请核对单价口径，当前仅支持未含税单价'
  return ''
}

function normalizeValues(values: ImportValues): ImportValues {
  const result = {} as ImportValues
  for (const column of importColumns) {
    const value = values[column.key]
    if (value !== null && typeof value !== 'string') throw new Error(`${column.label}应为文本或精确小数字符串`)
    result[column.key] = value === null || value.trim() === '' ? null : value.trim()
  }
  if (result.sourceOrderNo !== null && result.sourceOrderNo.length > 100) throw new Error('采购单号不能超过100个字符')
  for (const column of importColumns) {
    if (!('numeric' in column)) continue
    const value = result[column.key]
    if (column.key === 'purchaseQty' && value !== null && (!decimalValid(value, true) || !/[1-9]/.test(value))) throw new Error('采购数量须大于0，最多4位小数和16位整数')
    if (value !== null && !decimalValid(value, column.key === 'purchaseQty')) throw new Error(`${column.label}须为非负数字，最多${column.key === 'purchaseQty' ? 4 : 10}位小数`)
  }
  return result
}

function validRanking(value: unknown, candidates: Record<string, unknown>[]) {
  if (!record(value)) return false
  // 已保存批次仍可能携带旧评分；只读兼容，重新匹配后统一使用新版。
  const automatic = value.policyVersion === 'photo-best-or-first-text-v2'
  const score = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
  const ids = (v: unknown) => Array.isArray(v) && new Set(v).size === v.length && v.every(id => candidates.some(c => c.productId === id))
  if (value.format !== 'CandidateRankingV1' || !automatic && value.policyVersion !== 'photo-first-text-40-40-20-v1' || !['RECOMMENDED', 'NEEDS_REVIEW'].includes(String(value.status)) || typeof value.reason !== 'string' || value.photoThreshold !== 0.8 || value.textThreshold !== (automatic ? null : 0.8) || !record(value.weights) || value.weights.productCode !== 40 || value.weights.spec !== 40 || value.weights.name !== 20 || !ids(value.highestPhotoIds) || !ids(value.recommendedIds) || !Array.isArray(value.scores)) return false
  const highest = value.highestPhotoIds as number[], recommended = value.recommendedIds as number[], scores = value.scores
  if (typeof value.completePhotoGroup !== 'boolean' || recommended.length > 1 || !automatic && recommended.length && !value.completePhotoGroup || (value.status === 'RECOMMENDED') !== (recommended.length === 1) || scores.length !== candidates.length || new Set(scores.map(s => record(s) ? s.productId : null)).size !== candidates.length) return false
  if (automatic) {
    const photos = candidates.filter(c => typeof c.visualScore === 'number' && c.visualScore > 0.8)
    const top = photos.reduce<Record<string, unknown> | undefined>((best, c) => !best || Number(c.visualScore) > Number(best.visualScore) ? c : best, undefined)
    const first = top ?? (candidates.every(c => c.visualScore === null) ? candidates.find(c => Array.isArray(c.textEvidence) && c.textEvidence.length) : undefined)
    if (recommended.length !== (first ? 1 : 0) || first && recommended[0] !== first.productId) return false
  }
  return scores.every(s => {
    if (!record(s) || !candidates.some(c => c.productId === s.productId && c.visualScore === s.photoScore) || s.textScore !== null && !score(s.textScore) || typeof s.reason !== 'string' || !Array.isArray(s.fields) || s.fields.length !== 3 || new Set(s.fields.map(f => record(f) ? f.field : null)).size !== 3) return false
    if (s.fields.some(f => !record(f) || !['productCode', 'spec', 'name'].includes(String(f.field)) || f.weight !== (value.weights as Record<string, unknown>)[String(f.field)] || typeof f.label !== 'string' || f.source !== null && typeof f.source !== 'string' || f.target !== null && typeof f.target !== 'string' || f.score !== null && !score(f.score))) return false
    return automatic || !recommended.includes(s.productId as number) || highest.includes(s.productId as number) && typeof s.photoScore === 'number' && s.photoScore >= 0.8 && typeof s.textScore === 'number' && s.textScore >= 0.8
  })
}
function readRow(value: unknown): ImportRow {
  if (!record(value) || !positiveId(value.id) || !positiveId(value.version) || !positiveId(value.rowNo)) throw new Error('后端返回的明细编号、版本或源行号不完整')
  if (value.images !== undefined && (!Array.isArray(value.images) || value.images.some(image => !record(image) || !positiveId(image.id) || typeof image.sha256 !== 'string' || !['UNCONFIRMED', 'CONFIRMED', 'REJECTED'].includes(String(image.status))))) throw new Error('后端返回的原图关联不完整')
  if (value.readiness !== undefined && !['UNRESOLVED', 'NEEDS_SETUP', 'READY'].includes(String(value.readiness))) throw new Error('后端返回的商品确认状态无效')
  if (value.matchResult !== undefined && value.matchResult !== null) {
    const run = value.matchResult
    const route = (v: unknown) => record(v) && ['FOUND', 'NOT_FOUND', 'NO_INPUT', 'UNAVAILABLE', 'FAILED'].includes(String(v.status)) && typeof v.reason === 'string'
    const visual = (v: unknown) => record(v) && positiveId(v.queryAssetId) && positiveId(v.imageId) && positiveId(v.featureId) && typeof v.score === 'number' && Number.isFinite(v.score) && v.score >= -1.00001 && v.score <= 1.00001
    if (!record(run) || run.format !== 'MatchRunV1' || !isBatchId(run.runId) || !positiveId(run.inputRevision) || !['OK', 'PARTIAL', 'FAILED'].includes(String(run.status)) || !route(run.text) || !route(run.image) || !Array.isArray(run.candidates) || run.candidates.some(c => !record(c) || !positiveId(c.productId) || !record(c.product) || c.product.id !== c.productId || typeof c.product.productCode !== 'string' || typeof c.product.name !== 'string' || !Array.isArray(c.product.units) || !Array.isArray(c.textEvidence) || !Array.isArray(c.visualEvidence) || c.visualEvidence.some(e => !visual(e)) || !Array.isArray(c.conflicts) || c.conflicts.some(v => typeof v !== 'string') || c.visualScore !== null && (typeof c.visualScore !== 'number' || !Number.isFinite(c.visualScore) || c.visualScore < -1.00001 || c.visualScore > 1.00001)) || !record(run.explanation) || !['READY', 'UNAVAILABLE', 'FAILED', 'NOT_REQUESTED'].includes(String(run.explanation.status)) || typeof run.explanation.message !== 'string') throw new Error('后端返回的候选证据不完整，请重新读取')
    if (run.ranking !== undefined && !validRanking(run.ranking, run.candidates as Record<string, unknown>[])) throw new Error('后端返回的候选加权评分不完整，请重新读取')
    if (run.explanation.productNameSuggestion !== undefined) {
      const name = run.explanation.productNameSuggestion
      if (!record(name) || !['READY','NEEDS_REVIEW','NO_INPUT'].includes(String(name.status)) || typeof name.reason !== 'string' || !name.reason.trim() || !Array.isArray(name.sourceKeys) || name.sourceKeys.some(key => typeof key !== 'string' || !/^SOURCE:\d+$/.test(key)) || new Set(name.sourceKeys).size !== name.sourceKeys.length || name.productSpec !== null && typeof name.productSpec !== 'string' || (name.status === 'READY' ? !name.sourceKeys.length || !['name','category','baseName'].every(key => typeof name[key] === 'string' && (name[key] as string).trim()) : name.name !== null || name.category !== null || name.baseName !== null)) throw new Error('后端返回的图片命名依据或状态不完整')
    }
    if (run.explanation.candidateChecks !== undefined) {
      const checks = run.explanation.candidateChecks
      const candidates = run.candidates as Record<string, unknown>[]
      if (!Array.isArray(checks) || checks.length !== candidates.length || new Set(checks.map(c => record(c) ? c.productId : null)).size !== checks.length || checks.some(c => !record(c) || !candidates.some(candidate => candidate.productId === c.productId) || !['SAME','DIFFERENT','UNCERTAIN','NO_INPUT'].includes(String(c.imageMatch)) || typeof c.imageReason !== 'string' || !c.imageReason.trim() || !['MATCH','CONFLICT','MISSING','NOT_CHECKED'].includes(String(c.specMatch)) || typeof c.specReason !== 'string' || !c.specReason.trim() || c.imageMatch !== 'SAME' && c.specMatch !== 'NOT_CHECKED' || c.imageMatch === 'SAME' && c.specMatch === 'NOT_CHECKED')) throw new Error('后端返回的图文核对结果不完整或顺序无效')
    }
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
  if (Array.isArray(value.tasks)) value.tasks = value.tasks.map(readImportTask)
  return { ...value, batchId: value.batchId, header: { ...header }, rows } as unknown as ImportBatch
}

/** 页面只有一个编辑草稿；网络、解析、持久化错误始终保留为明确错误状态。 */
let clearedNavigationContext: string | null = null
/** 只跨越本次地址更新造成的组件重建，不写入浏览器存储或公共路由。 */
export function rememberImportClearNavigation(context: string) { clearedNavigationContext = context; return () => { if (clearedNavigationContext === context) clearedNavigationContext = null } }
export function consumeImportClearNavigation(context: string) { const cleared = clearedNavigationContext === context; clearedNavigationContext = null; return cleared }
export function createPurchaseImportModel(api: PurchaseImportApi, today: string, newKey = () => crypto.randomUUID(), clearedOnEntry = false) {
  const emptyHeader = (): ImportHeader => ({ bookId: null, supplierId: null, currency: '', orderDate: clearedOnEntry ? null : today, expectedDate: null, paymentTerms: '', prepayRatio: null, termDays: null })
  const state = reactive({
    header: emptyHeader(), batchId: null as string | null, rows: [] as ImportRow[],
    edit: null as { id: number; field: ImportEditField | null; values: ImportValues & { suppliedProductName?: string | null }; photoFile: File | null } | null,
    loading: false, importing: false, saving: false, deletingId: null as number | null,
    partialResult: null as Record<string, unknown> | null, error: '', errorCode: '', errors: [] as ImportIssue[], success: '',
    version: 1, status: 'DRAFT', sources: [] as ImportSource[], tasks: [] as ImportTask[],
    activeTaskId: null as string | null, upload: null as ImportUpload | null, progressError: '', progressReading: false, progressReloadNeeded: false,
    imageReviewEnabled: !!api.startMatches, imageReviewError: '',
    groups: [] as ImportDraftGroup[],
    clearing: false, clearPending: false, clearedBatchId: null as string | null,
  })
  const images = createPurchaseImportImages((id, imageId, signal) => {
    if (!api.readImage) return Promise.reject(new Error('原图读取接口尚未接入'))
    return api.readImage(id, imageId, signal)
  }, () => state.batchId)
  let epoch = 0, readSequence = 0, progressSequence = 0, savedHeader = '', selectedFile: File | null = null, intentSignature = '', intentKey = ''
  let clearIntent: { id: string; version: number; key: string } | null = null
  const requestBusy = () => state.loading || state.importing || state.saving || state.clearing || state.clearPending || state.status === 'PARSING'
  const imageReviewBusy = () => state.tasks.some(task => ['MATCH', 'EXPLAIN'].includes(task.kind || '') && ['QUEUED', 'RUNNING'].includes(task.status)) || state.imageReviewEnabled && !state.imageReviewError && state.status === 'REVIEW' && state.tasks.some(task => (!task.kind || task.kind === 'PARSE') && task.status === 'SUCCEEDED') && imageReviewProgress(state).pending > 0
  const busy = () => requestBusy() || imageReviewBusy()
  const headerDirty = () => !state.clearPending && state.batchId !== null && JSON.stringify(state.header) !== savedHeader
  function failure(error: unknown) {
    state.success = ''
    state.error = error instanceof Error ? error.message : '操作失败，未收到有效响应，请重试'
    if (state.error === 'Network Error') state.error = '连接中断，未确认操作结果；请检查本地服务连接后使用原请求重试'
    state.errorCode = record(error) && typeof error.code === 'string' ? error.code : ''
    state.errors = []
    if (record(error) && record(error.data) && Array.isArray(error.data.errors)) {
      state.errors = error.data.errors.filter((issue): issue is ImportIssue => record(issue) && typeof issue.message === 'string' && issue.message.trim().length > 0)
    }
      if (record(error) && record(error.data) && record(error.data.partialResult)) {
      const partial = error.data.partialResult; state.partialResult = partial
      const row = state.rows.find(item => item.id === partial.rowId)
      if (row && positiveId(partial.productId) && positiveId(partial.rowVersion) && partial.rowVersion >= row.version) {
        row.matchedProductId = partial.productId; row.version = partial.rowVersion; row.readiness = 'NEEDS_SETUP'
      }
    }
  }
  function clearFeedback() { state.partialResult = null; state.error = ''; state.errorCode = ''; state.errors = []; state.success = '' }
  function applyBatch(batch: ImportBatch, preserveDraft = false) {
    const draft = preserveDraft && (state.batchId === null || headerDirty()) ? state.header : null
    savedHeader = JSON.stringify(batch.header)
    if (state.batchId !== batch.batchId) images.reset()
    state.batchId = batch.batchId
    state.header = draft ?? batch.header
    state.rows = batch.rows
    // 兼容旧header/rows响应；仅缺少新增元数据时采用历史REVIEW语义。
    state.version = batch.version === undefined ? 1 : batch.version
    state.status = batch.status === undefined ? 'REVIEW' : batch.status
    state.sources = batch.sources === undefined ? [] : batch.sources
    state.tasks = batch.tasks === undefined ? [] : batch.tasks
    if (!state.tasks.some(task => task.id === state.activeTaskId)) state.activeTaskId = state.tasks.filter(task => !task.kind || task.kind === 'PARSE').at(-1)?.id ?? null
    state.groups = batch.groups === undefined ? [] : batch.groups
    state.edit = null
  }
  async function write(flag: 'importing' | 'saving', request: () => Promise<unknown>, apply: (response: unknown) => void) {
    if (requestBusy()) return false
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
  const reviewKeys = new Map<string, string>()
  async function confirmReview(proposal: ReviewProposal) {
    if (busy()) return false
    if (grid.hasChanges()) { failure(new Error('请先上传草稿修改，再确认来源核对')); return false }
    if (!api.confirmReview || state.edit || !reviewProposalCurrent(proposal, state.batchId, state.version, state.rows, state.sources)) { failure(new Error('补充预览已失效，请按当前文件重新核对')); return false }
    try {
      for (const change of proposal.changes) {
        const row = state.rows.find(r => r.id === change.rowId)!
        normalizeValues({ ...Object.fromEntries(importColumns.map(c => [c.key, row[c.key]])), ...change.values } as ImportValues)
      }
    } catch (error) { failure(error); return false }
    const { batchId, ...input } = proposal, signature = JSON.stringify(proposal)
    if (!reviewKeys.has(signature)) reviewKeys.set(signature, newKey())
    const saved = await write('saving', () => api.confirmReview!(batchId, input, reviewKeys.get(signature)!), response => {
      applyBatch(readBatch(response), true); reviewKeys.delete(signature); state.success = proposal.interpretation ? `已保存原文含义确认${proposal.changes.length ? `并补充 ${proposal.changes.length} 条空白单号` : ''}，请继续核对剩余事项` : `已补充 ${proposal.changes.length} 条明细，请继续核对剩余事项`
    })
    if (saved) await workflow.startImageReview()
    return saved
  }
  async function loadBatch(id: string, preserveDraft = false) {
    if (grid.hasChanges()) { failure(new Error('请先上传草稿修改，重新读取会覆盖编辑草稿')); return false }
    if (state.importing || state.saving || state.clearing || state.clearPending || state.edit) return false
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
      if (context === epoch && sequence === readSequence && record(error) && error.code === 'NOT_FOUND' && api.clearStatus) {
        try {
          const receipt = readClear(await api.clearStatus(id), id)
          if (context !== epoch || sequence !== readSequence) return false
          applyClear(receipt)
          return true
        } catch (statusError) { if (context === epoch && sequence === readSequence) failure(statusError); return false }
      }
      if (context === epoch && sequence === readSequence) failure(error)
      return false
    } finally {
      if (context === epoch && sequence === readSequence) state.loading = false
    }
  }
  async function importFile(file: File) {
    if (grid.hasChanges()) { failure(new Error('请先上传草稿修改，再导入文件')); return false }
    if (busy()) return false
    if (state.edit) { failure(new Error('请先保存或取消正在编辑的明细')); return false }
    if (!/\.xlsx$/i.test(file.name) || !file.size) { failure(new Error('请选择非空的.xlsx模板文件')); return false }
    if (file.size > 100 * 1024 * 1024) { failure(new Error('采购文件不能超过100MiB')); return false }
    const signature = JSON.stringify([state.batchId])
    if (selectedFile !== file || signature !== intentSignature) { intentKey = newKey(); selectedFile = file; intentSignature = signature }
    const context = epoch
    state.upload = { fileName: file.name, loaded: 0, total: null, status: 'UPLOADING' }; state.progressError = ''
    const saved = await write('importing', () => api.upload(file, state.batchId, intentKey, (loaded, total) => {
      if (context !== epoch || !state.importing || !state.upload) return
      state.upload.loaded = loaded; state.upload.total = total
      if (total !== null && loaded >= total) state.upload.status = 'ACCEPTING'
    }), response => {
      const batch = readBatch(response)
      if (batch.rows.length === 0 && !(batch.status === 'PARSING' && batch.tasks?.some(task => ['QUEUED', 'RUNNING'].includes(task.status)))) throw new Error('后端返回的导入结果没有明细或有效解析任务，请核对文件')
      if (state.batchId !== null && batch.batchId !== state.batchId) throw new Error('后端返回的导入批次与当前批次不一致')
      applyBatch(batch, true)
      if (record(response) && isBatchId(response.taskId) && state.tasks.some(task => task.id === response.taskId)) state.activeTaskId = response.taskId
      state.upload = null
      selectedFile = null; intentKey = ''; intentSignature = ''
      if (batch.status !== 'PARSING') state.success = '文件明细已暂存，请核对无误'
    })
    if (!saved && context === epoch && state.upload) state.upload.status = /连接中断|Network Error|超时/.test(state.error) ? 'UNKNOWN' : 'ERROR'
    if (saved && context === epoch && state.status === 'REVIEW') await workflow.startImageReview()
    return saved && context === epoch
  }
  function rowLocked(row: ImportRow) { return !!row.targetOrderLineId || state.groups.some(group => group.id === row.groupId && ['CREATING', 'UNKNOWN'].includes(group.createStatus)) }
  function startEdit(row: ImportRow, field: ImportEditField | null) {
    if (grid.view.pending || grid.view.mode === 'excel') return false
    if (rowLocked(row)) { failure(new Error('本行已建单或创建结果待核实，不能修改来源')); return false }
    if (busy() || state.edit || !grid.rows().some(item => item.id === row.id)) return false
    clearFeedback()
    state.edit = { id: row.id, field, values: { ...Object.fromEntries(importColumns.map(column => [column.key, row[column.key]])) as ImportValues, suppliedProductName: row.suppliedProductName ?? null }, photoFile: null }
    return true
  }
  function selectPhoto(file: File) {
    if (busy() || !state.edit || state.edit.field !== null && state.edit.field !== 'photo') return false
    if (!grid.validatePhoto(file)) return false
    clearFeedback(); state.edit.photoFile = file
    return true
  }
  function cancelEdit() { if (!state.saving) { state.edit = null; clearFeedback() } }
  async function saveEdit() {
    if (busy() || !state.edit) return false
    const row = grid.rows().find(item => item.id === state.edit!.id)
    if (!row) { failure(new Error('待保存的记录已不存在，请刷新')); return false }
    const edit = state.edit
    if (edit.field === 'photo' && !edit.photoFile) { failure(new Error('请先选择照片，或取消编辑')); return false }
    state.edit = null
    if (!grid.applyRange({ [grid.rows().indexOf(row)]: edit.values })) { state.edit = edit; return false }
    if (edit.photoFile && !grid.selectPhoto(row.id, edit.photoFile)) { state.edit = edit; return false }
    state.success = '编辑已收妥为草稿，点击上传后提交'
    return true
  }
  async function saveHeader() {
    if (grid.hasChanges()) { failure(new Error('请先上传草稿修改，再保存基础信息')); return false }
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
    if (grid.hasChanges()) { failure(new Error('请先上传草稿修改，再删除明细')); return false }
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
    if (grid.hasChanges()) return false
    if (!state.batchId || state.edit || state.saving || state.importing || state.clearing || state.clearPending) return false
    const id = state.batchId, current = state.tasks.find(task => task.id === state.activeTaskId)
    // 历史任务或旧接口没有逐任务读取时，继续使用原批次恢复入口。
    if (current && api.readTask && (['QUEUED', 'RUNNING'].includes(current.status) || state.progressReloadNeeded)) {
      if (state.progressReading) return false
      const context = epoch, sequence = ++progressSequence; state.progressReading = true
      try {
        if (!state.progressReloadNeeded) {
          const task = readImportTask(await api.readTask(current.id))
          if (context !== epoch || state.batchId !== id || state.activeTaskId !== current.id || sequence !== progressSequence) return false
          if (task.id !== current.id || task.attemptCount !== undefined && current.attemptCount !== undefined && task.attemptCount < current.attemptCount) throw new Error('任务编号或尝试次数与当前进度不一致')
          state.tasks.splice(state.tasks.findIndex(item => item.id === current.id), 1, task)
          if (task.status === 'SUCCEEDED') state.progressReloadNeeded = true
          else if (['FAILED', 'CANCELLED', 'NEEDS_REAUTH', 'STALE'].includes(task.status)) state.status = 'FAILED'
        }
        if (state.progressReloadNeeded) {
          if (!await loadBatch(id, true)) { if (context === epoch) state.progressError = state.error || '明细读取失败，请重试'; return false }
          state.progressReloadNeeded = false
        }
        if (context === epoch) {
          state.progressError = ''
          if (state.status === 'REVIEW') await workflow.startImageReview()
        }
        return true
      } catch (error) { if (context === epoch && sequence === progressSequence) state.progressError = error instanceof Error ? error.message : '进度读取失败，请重试'; return false }
      finally { if (context === epoch && sequence === progressSequence) state.progressReading = false }
    }
    const pending = state.status === 'PARSING'
    const saved = await loadBatch(state.batchId, true)
    if (saved && pending && state.status === 'REVIEW') state.success = '文件明细已暂存，请核对无误'
    if (saved && state.status === 'REVIEW' && !state.imageReviewError) await workflow.startImageReview()
    return saved
  }
  const retryKeys = new Map<string, string>()
  async function sourceMapping(source: ImportSource): Promise<SourceMappingPreview | null> {
    if (!api.sourceMapping || !state.batchId || busy() || state.edit || grid.hasChanges()) return null
    const batch = state.batchId, context = epoch
    try {
      const value = await api.sourceMapping(batch,source.id)
      if (context !== epoch || state.batchId !== batch) return null
      if (!record(value) || !record(value.mapping) || value.mapping.format !== 'SupplierMappingV1' || value.mapping.fileSha256 !== source.fileSha256 || !Array.isArray(value.mapping.lines) || !value.mapping.lines.length || !Array.isArray(value.sourceCells) || value.batchVersion !== state.version) throw new Error('原格建议不完整或已过期，请重新读取')
      return value as unknown as SourceMappingPreview
    } catch(error) { if (context === epoch && state.batchId === batch) failure(error); return null }
  }
  async function correctSource(sourceId:number,batchVersion:number,input:MappingOverrides) {
    if (!api.correctSource || !state.batchId || busy() || state.edit || grid.hasChanges()) return false
    if (batchVersion !== state.version) { failure(new Error('原批次已变化，请重新核对原列')); return false }
    const batch = state.batchId, signature = JSON.stringify([batch,sourceId,batchVersion,input])
    if (!retryKeys.has(signature)) retryKeys.set(signature,newKey())
    return write('saving',()=>api.correctSource!(batch,sourceId,batchVersion,input,retryKeys.get(signature)!),response=>{
      const saved=readBatch(response)
      if (saved.batchId === batch || saved.status !== 'PARSING' || !record(response) || !isBatchId(response.taskId)) throw new Error('后端未确认新的纠正批次')
      applyBatch(saved,true);state.activeTaskId=response.taskId;retryKeys.delete(signature);state.success='已创建纠正批次，原批次保留；正在从原文件重新读取'
    })
  }
  async function retryTask(task: ImportTask, sheet: string | null = null, mappingOverrides?: MappingOverrides) {
    if (!api.retryTask || busy() || state.edit) return false
    ++progressSequence; state.progressReading = false
    const signature = JSON.stringify([task.id, sheet, mappingOverrides])
    if (!retryKeys.has(signature)) retryKeys.set(signature, newKey())
    return write('saving', () => api.retryTask!(task.id, retryKeys.get(signature)!, sheet, mappingOverrides), response => {
      if (!record(response) || response.id !== task.id || response.status !== 'QUEUED') throw new Error('后端未确认任务重试')
      const saved = state.tasks.find(item => item.id === task.id)
      if (!saved) throw new Error('当前批次任务已变化，请重新读取')
      saved.status = 'QUEUED'; saved.errorCode = null; saved.errorMessage = null
      if (!task.kind || task.kind === 'PARSE') { saved.progress = null; delete saved.result; state.activeTaskId = saved.id; state.progressError = ''; state.progressReloadNeeded = false }
      if (!task.kind || task.kind === 'PARSE') state.status = 'PARSING'
      retryKeys.delete(signature)
    })
  }
  async function associate(row: ImportRow, imageId: number, association: 'CONFIRMED' | 'REJECTED') {
    if (!api.associate || !state.batchId || busy() || state.edit) return false
    const saved = await write('saving', () => api.associate!(state.batchId!, row, imageId, association), response => {
      const saved = readRow(response)
      if (saved.id !== row.id || saved.version <= row.version) throw new Error('后端返回的图片确认版本无效')
      state.rows.splice(state.rows.findIndex(item => item.id === row.id), 1, saved)
      if (saved.batchVersion !== undefined) state.version = saved.batchVersion
    })
    if (saved) await workflow.startImageReview()
    return saved
  }
  const photoKeys = new Map<string, string>()
  async function publishPhotos(row: ImportRow, imageIds: number[]) {
    if (!api.publishPhotos || !state.batchId || busy() || state.edit || headerDirty()) return false
    if (!row.matchedProductId || imageIds.length === 0 || imageIds.some(id => !row.images?.some(image => image.id === id && image.status === 'CONFIRMED'))) { failure(new Error('请先确认真实商品和所选原图归属')); return false }
    const signature = JSON.stringify([state.batchId, row.id, row.version, imageIds])
    if (!photoKeys.has(signature)) photoKeys.set(signature, newKey())
    return write('saving', () => api.publishPhotos!(state.batchId!, row, imageIds, photoKeys.get(signature)!), response => { applyBatch(readBatch(response)); photoKeys.delete(signature); state.success = '商品照片已关联，特征和索引在后台处理' })
  }
  const grid = createPurchaseImportGrid({
    state, columns: importTableColumns, normalize: normalizeValues, busy, locked: rowLocked, editing: () => !!state.edit,
    failure, feedback: clearFeedback, newKey, readBatch, applyBatch: batch => applyBatch(batch, true),
    save: (input, key, check) => {
      if (!api.saveGrid) { failure(new Error('表格保存接口尚未接入')); return Promise.resolve(false) }
      return write('saving', () => api.saveGrid!(input, key), check)
    },
    savePhoto: (row, file, key, check) => {
      if (!api.uploadPhoto || !state.batchId) { failure(new Error('照片上传接口或批次尚未就绪')); return Promise.resolve(false) }
      return write('saving', () => api.uploadPhoto!(state.batchId!, row, file, normalizeValues(row), key, { suppliedProductName: row.suppliedProductName ?? null, suppliedProductCode: row.suppliedProductCode ?? null, supplierProductCode: row.supplierProductCode ?? null }), check)
    },
  })
  function exportLocalDraft() {
    const draft = grid.snapshot()
    if (state.edit) {
      draft.draft ??= JSON.parse(JSON.stringify(grid.rows())) as ImportRow[]
      const row = draft.draft.find(item => item.id === state.edit!.id)
      if (row) Object.assign(row, state.edit.values)
      if (state.edit.photoFile) draft.photos[state.edit.id] = { file: state.edit.photoFile }
    }
    return { schema: 1, batch: state.batchId ? JSON.parse(JSON.stringify({ batchId: state.batchId, version: state.version, status: state.status, header: state.header, rows: state.rows, sources: state.sources, tasks: state.tasks, groups: state.groups })) as ImportBatch : null,
      header: JSON.parse(JSON.stringify(state.header)) as ImportHeader, baselineHeader: savedHeader, grid: draft, clearIntent: clearIntent ? { ...clearIntent } : null, clearPending: state.clearPending, clearedBatchId: state.clearedBatchId }
  }
  function restoreLocalDraft(raw: unknown) {
    if (!record(raw) || raw.schema !== 1 || !record(raw.header) || !record(raw.grid)) throw new Error('本地采购草稿格式不正确，请保留数据后重试')
    if (typeof raw.baselineHeader !== 'string' || raw.batch !== null && !raw.baselineHeader) throw new Error('本地草稿缺少已读取的批次基线，请保留数据后重试')
    const batch = raw.batch === null ? null : readBatch({ ...(raw.batch as ImportBatch), header: JSON.parse(raw.baselineHeader) })
    grid.restore(raw.grid as unknown as ReturnType<typeof grid.snapshot>)
    if (batch) applyBatch(batch)
    state.header = { ...raw.header } as unknown as ImportHeader
    if (record(raw.clearIntent) && isBatchId(raw.clearIntent.id) && isBatchId(raw.clearIntent.key) && positiveId(raw.clearIntent.version)) clearIntent = raw.clearIntent as unknown as NonNullable<typeof clearIntent>
    state.clearPending = raw.clearPending === true
    state.clearedBatchId = isBatchId(raw.clearedBatchId) ? raw.clearedBatchId : null
  }
  const workflow = createPurchaseImportWorkflow({ state,api,busy: () => requestBusy() || grid.hasChanges(),reviewing: imageReviewBusy,headerDirty,rowLocked,failure,newKey,loadBatch,saveHeader,write,readRow,readGroup,readBatch,applyBatch })
  function clearBlockReason() {
    if (state.loading || state.importing || state.saving || state.clearing || state.status === 'PARSING' || state.tasks.some(task => ['QUEUED', 'RUNNING'].includes(task.status))) return '当前批次正在处理，请等待处理结束后清空'
    if (state.upload?.status === 'UNKNOWN') return '文件接收结果尚未确认，请先按原上传请求重试核实'
    if (state.status === 'COMPLETED' || state.rows.some(row => !!row.targetOrderLineId) || state.groups.some(group => !!group.orderId || ['CREATED', 'CREATING', 'UNKNOWN'].includes(group.createStatus))) return '当前批次已关联采购草稿或创建结果尚未核实，不能清空'
    return ''
  }
  const canClear = () => clearBlockReason() === ''
  function readClear(value: unknown, id: string) {
    if (!record(value) || value.cleared !== true || value.batchId !== id || !positiveId(value.version) || !isBatchId(value.requestKey) || typeof value.cleanupPending !== 'boolean' || !Number.isSafeInteger(value.pendingFiles) || Number(value.pendingFiles) < 0 || !record(value.counts) || ['rows', 'sources', 'images', 'tasks', 'groups', 'progress'].some(field => !Number.isSafeInteger(value.counts && (value.counts as Record<string, unknown>)[field]) || Number((value.counts as Record<string, unknown>)[field]) < 0) || !value.cleanupPending && value.pendingFiles !== 0) throw new Error('后端返回的清空回执不完整，请使用原请求重试核实')
    return value as unknown as { batchId: string; version: number; requestKey: string; cleanupPending: boolean }
  }
  function applyClear(receipt: ReturnType<typeof readClear>) {
    invalidate(); state.header.orderDate = null
    if (receipt.cleanupPending) {
      clearIntent = { id: receipt.batchId, version: receipt.version, key: receipt.requestKey }
      state.batchId = receipt.batchId; state.version = receipt.version; state.clearPending = true
      failure(new Error('暂存数据已清空，文件清理尚未完成，请点击重试清空'))
      state.errorCode = 'PUR_IMPORT_FILES_PENDING'
    } else { state.clearedBatchId = receipt.batchId; state.success = '当前导入数据和独占文件已清空' }
  }
  async function clearAll() {
    if (!canClear()) return false
    if (!state.batchId) { invalidate(); state.header.orderDate = null; state.success = '页面数据已清空'; return true }
    if (!api.clearBatch) { failure(new Error('批次清空接口尚未接入')); return false }
    if (!clearIntent) clearIntent = { id: state.batchId, version: state.version, key: newKey() }
    const intent = clearIntent, context = epoch
    state.clearing = true; clearFeedback()
    try {
      const response = await api.clearBatch(intent.id, intent.version, intent.key)
      if (context !== epoch) return false
      const receipt = readClear(response, intent.id)
      if (receipt.version !== intent.version || receipt.requestKey !== intent.key) throw new Error('后端清空回执与原请求不一致，请重试核实')
      applyClear(receipt)
      return !receipt.cleanupPending
    } catch (error) {
      if (context !== epoch) return false
      if (record(error) && error.code === 'PUR_IMPORT_FILES_PENDING') {
        try { const receipt = readClear(error.data, intent.id); if (receipt.version !== intent.version || receipt.requestKey !== intent.key) throw new Error('清空回执与原请求不一致'); applyClear(receipt); if (error instanceof Error) state.error = error.message }
        catch (invalid) { state.clearPending = true; failure(invalid) }
      } else {
        const rejected = record(error) && ['SYS_VERSION_CONFLICT', 'SYS_FORBIDDEN', 'NOT_FOUND', 'PUR_IMPORT_CLEAR_BUSY', 'PUR_IMPORT_CLEAR_LINKED', 'SYS_COUNTRY_REQUIRED', 'PUR_IMPORT_ASSET_SCOPE', 'PUR_IMPORT_ASSET_HELD'].includes(String(error.code))
        state.clearPending = !rejected
        if (rejected) clearIntent = null
        failure(error)
      }
      return false
    } finally { if (context === epoch) state.clearing = false }
  }
  function invalidate() {
    clearFeedback()
    grid.reset()
    workflow.reset()
    ++epoch; ++readSequence; ++progressSequence
    images.reset()
    state.activeTaskId = null; state.upload = null; state.progressError = ''; state.progressReading = false; state.progressReloadNeeded = false; state.imageReviewError = ''
    state.header = emptyHeader(); state.batchId = null; state.rows = []; state.edit = null
    state.loading = false; state.importing = false; state.saving = false; state.deletingId = null
    selectedFile = null; savedHeader = ''; intentKey = ''; intentSignature = ''
    state.version = 1; state.status = 'DRAFT'; state.sources = []; state.tasks = []; retryKeys.clear()
    state.groups = []; photoKeys.clear(); reviewKeys.clear()
    clearIntent = null; state.clearing = false; state.clearPending = false; state.clearedBatchId = null
  }
  return { ...workflow, state, grid, images, busy, imageReviewBusy, headerDirty, rowLocked, clearFeedback, failure, loadBatch, importFile, startEdit, selectPhoto, cancelEdit, saveEdit, saveHeader, removeRow, refreshTasks, retryTask, sourceMapping, correctSource, associate, publishPhotos, invalidate, canClear, clearAll, clearBlockReason, confirmReview, exportLocalDraft, restoreLocalDraft }

}
export type PurchaseImportModel = ReturnType<typeof createPurchaseImportModel>

export { record as importRecord, positiveId as importPositiveId }
