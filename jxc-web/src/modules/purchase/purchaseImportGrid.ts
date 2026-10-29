import { reactive } from 'vue'
import type { ImportBatch, ImportHeader, ImportRow, ImportValues, MatchInputs } from './purchaseImportModel'

export type GridField = keyof ImportValues | 'suppliedProductName'
export interface GridColumn { key: GridField; label: string; width: number; numeric?: boolean }
export interface GridSaveInput {
  batchId: string | null; batchVersion: number | null; header: ImportHeader | Record<string, never>
  rows: { clientId: string; id: number | null; version: number | null; values: ImportValues; matchInputs: MatchInputs }[]
}
interface GridDeps {
  state: { rows: ImportRow[]; batchId: string | null; version: number; header: ImportHeader }
  columns: readonly GridColumn[]
  normalize(values: ImportValues): ImportValues
  busy(): boolean; locked(row: ImportRow): boolean; editing(): boolean
  failure(error: unknown): void; feedback(): void; newKey(): string
  save(input: GridSaveInput, key: string, check: (value: unknown) => void): Promise<boolean>
  savePhoto(row: ImportRow, file: File, key: string, check: (value: unknown) => void): Promise<boolean>
  readBatch(value: unknown): ImportBatch; applyBatch(batch: ImportBatch): void
}
interface DraftPhoto { file: File; request?: { row: ImportRow; key: string } }
export interface GridDraftSnapshot {
  mode: 'table' | 'excel'; draft: ImportRow[] | null; pending: boolean
  photos: Record<string, DraftPhoto>; intent: { input: GridSaveInput; key: string } | null
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const names = (row: ImportRow): MatchInputs => ({ suppliedProductCode: row.suppliedProductCode ?? null, suppliedProductName: row.suppliedProductName ?? null, supplierProductCode: row.supplierProductCode ?? null })
const decimalKey = (value: string | null) => value == null ? null : value.replace(/^0+(?=\d)/, '').replace(/\.0*$/, '').replace(/(\.\d*?)0+$/, '$1')

/** 只负责采购表格草稿与字段适配；选择、键盘和剪贴板解析由RevoGrid提供。 */
export function createPurchaseImportGrid(deps: GridDeps) {
  const view = reactive({ mode: 'table' as 'table' | 'excel', draft: null as ImportRow[] | null, pending: false })
  const photos = reactive<Record<string, DraftPhoto>>({})
  const live = reactive({ cell: null as { id: number; field: GridField; text: string } | null })
  let temporaryId = 0, epoch = 0
  let uploading = false, checkpoint: () => Promise<boolean> = async () => true
  let intent: { input: GridSaveInput; key: string } | null = null
  const rows = () => view.draft ?? deps.state.rows
  const value = (row: ImportRow, field: GridField) => row[field] ?? null
  // 只看业务内容；格式产生的零不使空白占位行成为有效数据，已有来源行不在此删除。
  const hasContent = (row: ImportRow) => !!photos[row.id] || !!row.images?.length || deps.columns.some(col => {
    const text = value(row, col.key)?.trim()
    return !!text && (!col.numeric || !/^[+-]?(?:0+(?:\.0*)?|\.0+)$/.test(text))
  })
  const dataRows = () => rows().filter(row => row.id > 0 || hasContent(row))
  function compact() { if (view.draft) view.draft = view.draft.filter(row => row.id > 0 || hasContent(row)) }
  const hasChanges = () => {
    if (live.cell) {
      const row = rows().find(row => row.id === live.cell!.id)
      if (row && live.cell.text !== (value(row, live.cell.field) ?? '')) return true
    }
    const saved = new Map(deps.state.rows.map(row => [row.id, row]))
    return Object.keys(photos).length > 0 || rows().some(row => {
      const old = saved.get(row.id)
      return !old ? hasContent(row) : deps.columns.some(col => value(old, col.key) !== value(row, col.key))
    })
  }
  function setMode(mode: 'table' | 'excel') {
    if (deps.busy() || deps.editing()) return false
    view.mode = mode
    if (mode === 'excel') { ensureDraft(); ensureTail() } else compact()
    return true
  }
  function blank(rowNo: number): ImportRow {
    return { ...Object.fromEntries(deps.columns.map(col => [col.key, null])) as ImportValues, id: --temporaryId, version: 1, rowNo, images: [], suppliedProductName: null }
  }
  function ensureDraft() { if (!view.draft) view.draft = copy(deps.state.rows) }
  function ensureTail() {
    if (view.mode !== 'excel' || view.pending) return
    ensureDraft()
    let last = rows().length - 1
    while (last >= 0 && rows()[last]!.id < 0 && !hasContent(rows()[last]!)) last--
    const target = Math.min(10000, Math.max(rows().length, last + 21))
    const extra: ImportRow[] = []
    let rowNo = Math.max(0, ...rows().map(row => row.rowNo))
    for (let i = rows().length; i < target; i++) extra.push(blank(++rowNo))
    view.draft!.push(...extra)
  }
  function applyPaste(start: number, field: string, matrix: unknown[][]) {
    if (deps.busy() || view.pending || deps.editing()) return false
    try {
      const column = deps.columns.findIndex(col => col.key === field)
      if (!Number.isInteger(start) || start < 0 || start > rows().length || column < 0 || !matrix.length || matrix.length + start > 10000) throw new Error('粘贴位置或行数无效，最多10000行')
      if (matrix.some(line => !Array.isArray(line) || column + line.length > deps.columns.length)) throw new Error('粘贴内容超过固定列范围，请按表头顺序复制')
      const next = copy(rows())
      const originals = new Map(deps.state.rows.map(row => [row.id, row]))
      let nextRowNo = Math.max(0, ...next.map(row => row.rowNo)) + 1
      for (let offset = 0; offset < matrix.length; offset++) {
        const index = start + offset
        if (!next[index]) next[index] = blank(nextRowNo++)
        const row = next[index]!
        const original = originals.get(row.id)
        if (original && deps.locked(original)) throw new Error(`第${row.rowNo}行已关联采购草稿或结果待核实，不能编辑`)
        for (let cell = 0; cell < matrix[offset]!.length; cell++) {
          const col = deps.columns[column + cell]!, raw = matrix[offset]![cell]
          if (raw != null && typeof raw !== 'string') throw new Error(`${col.label}必须为文字或十进制字符串`)
          const text = raw == null || raw.trim() === '' ? null : raw.trim()
          if (col.key === 'photo') {
            if (text !== null && text !== value(row, 'photo')) throw new Error('商品照片请使用原照片上传与核对入口，不能粘贴文字替换')
          } else row[col.key] = text
        }
      }
      view.draft = next
      ensureTail()
      deps.feedback()
      return true
    } catch (error) { deps.failure(error); return false }
  }
  function validatePhoto(file: File) {
    if (!file.size || file.size > 10 * 1024 * 1024) { deps.failure(new Error('照片不能为空且不能超过10MiB')); return false }
    if (!/\.(png|jpe?g|gif)$/i.test(file.name) || !['image/png', 'image/jpeg', 'image/gif'].includes(file.type)) { deps.failure(new Error('请选择PNG、JPG或GIF照片')); return false }
    return true
  }
  function selectPhoto(id: number, file: File) {
    const row = rows().find(item => item.id === id)
    if (deps.busy() || view.pending || !row || deps.locked(row) || !validatePhoto(file)) return false
    ensureDraft(); photos[id] = { file }; ensureTail(); deps.feedback(); return true
  }
  const photo = (id: number) => photos[id]?.file ?? null
  function edit(id: number, field: string, text: unknown) {
    const index = rows().findIndex(row => row.id === id)
    return index >= 0 && applyPaste(index, field, [[text]])
  }
  function applyRange(data: Record<number, Record<string, unknown>>) {
    const indices = Object.keys(data).map(Number).sort((a, b) => a - b)
    if (!indices.length || indices.some(index => !Number.isInteger(index) || index < 0 || index >= rows().length)) { deps.failure(new Error('编辑区域已变化，请重新选择单元格')); return false }
    const first = indices[0]!, last = indices.at(-1)!
    const matrix = rows().slice(first, last + 1).map(row => deps.columns.map(col => value(row, col.key)))
    for (const index of indices) for (const [field, text] of Object.entries(data[index]!)) {
      const column = deps.columns.findIndex(col => col.key === field)
      if (column < 0) { deps.failure(new Error('编辑区域包含不可修改字段')); return false }
      matrix[index - first]![column] = text as string | null
    }
    return applyPaste(first, deps.columns[0]!.key, matrix)
  }
  function input(): GridSaveInput {
    const originals = new Map(deps.state.rows.map(row => [row.id, row]))
    const changed = rows().filter(row => {
      const old = originals.get(row.id)
      return old ? deps.columns.some(col => value(old, col.key) !== value(row, col.key)) : hasContent(row)
    })
    if (changed.some(row => (row.suppliedProductName?.length ?? 0) > 200)) throw new Error('商品名最多200个字符')
    return { batchId: deps.state.batchId, batchVersion: deps.state.batchId ? deps.state.version : null, header: {}, rows: changed.map(row => ({
      clientId: String(row.id), id: row.id > 0 ? row.id : null, version: row.id > 0 ? row.version : null, values: deps.normalize(row), matchInputs: names(row),
    })) }
  }
  async function save() {
    if (uploading || deps.busy() || deps.editing() || !hasChanges()) return false
    uploading = true
    const context = epoch
    try {
    if (!intent) { const payload = input(); if (payload.rows.length) intent = { input: payload, key: deps.newKey() } }
    view.pending = true
    if (!await checkpoint() || context !== epoch) return false
    const run = intent
    if (run && !await deps.save(run.input, run.key, raw => {
      if (context !== epoch) throw new Error('表格上下文已变化')
      const batch = deps.readBatch(raw)
      const savedRows = new Map(batch.rows.map(row => [row.id, row]))
      const originals = new Map(deps.state.rows.map(row => [row.id, row]))
      const additions = run.input.rows.filter(row => row.id === null)
      if (run.input.batchId && batch.batchId !== run.input.batchId || batch.rows.length !== deps.state.rows.length + additions.length || deps.state.rows.some(row => !savedRows.has(row.id))) throw new Error('后端返回的表格明细与保存请求不一致，草稿仍保留')
      const mapping = (raw as { gridSaved?: Record<string, number> }).gridSaved
      for (const changed of run.input.rows) {
        const id = changed.id ?? mapping?.[changed.clientId]
        const saved = id == null ? undefined : savedRows.get(id)
        if (!saved || changed.version !== null && saved.version <= changed.version) throw new Error('后端返回的保存记录或版本不完整')
        for (const col of deps.columns) {
          const expected = col.key === 'suppliedProductName' ? changed.matchInputs.suppliedProductName : changed.values[col.key]
          if (col.numeric ? decimalKey(value(saved, col.key)) !== decimalKey(expected) : value(saved, col.key) !== expected) throw new Error(`后端返回的${col.label}与草稿不一致`)
        }
        const old = id == null ? undefined : originals.get(id)
        if (old && ['sourceId', 'sourceSheet', 'sourceRow', 'sourceItemKey', 'images', 'targetOrderLineId'].some(key => JSON.stringify(old[key as keyof ImportRow]) !== JSON.stringify(saved[key as keyof ImportRow]))) throw new Error('后端返回的原图或来源关联发生变化，草稿仍保留')
      }
      for (const addition of additions) {
        const id = mapping?.[addition.clientId], pendingPhoto = photos[addition.clientId]
        if (id && pendingPhoto) { photos[id] = pendingPhoto; delete photos[addition.clientId] }
      }
      deps.applyBatch(batch)
      view.draft = null; intent = null
    })) return false
    if (context !== epoch) return false
    for (const [id, item] of Object.entries(photos)) {
      const current = deps.state.rows.find(row => row.id === Number(id))
      if (!current) throw new Error('照片所属明细不存在，草稿仍保留')
      if (!item.request) item.request = { row: copy(current), key: deps.newKey() }
      if (!await checkpoint() || context !== epoch) return false
      const request = item.request
      if (!await deps.savePhoto(request.row, item.file, request.key, raw => {
        if (context !== epoch) throw new Error('照片上下文已变化')
        const batch = deps.readBatch(raw), saved = batch.rows.find(row => row.id === request.row.id)
        if (batch.batchId !== deps.state.batchId || !saved || saved.version <= request.row.version || !saved.images?.some(image => image.status === 'CONFIRMED' && image.origin === 'MANUAL_UPLOAD' && !request.row.images?.some(old => old.id === image.id))) throw new Error('后端返回的照片保存结果不完整，草稿仍保留')
        deps.applyBatch(batch); delete photos[id]
      })) return false
      if (context !== epoch) return false
    }
    view.pending = false; ensureTail()
    return await checkpoint()
    } catch (error) { if (context === epoch) deps.failure(error); return false }
    finally { if (context === epoch) uploading = false }
  }
  function snapshot(): GridDraftSnapshot {
    const draft = view.draft ? copy(view.draft) : live.cell ? copy(rows()) : null
    const row = live.cell && draft?.find(row => row.id === live.cell!.id)
    if (row && live.cell) row[live.cell.field] = live.cell.text
    return { mode: view.mode, draft, pending: view.pending, photos: Object.fromEntries(Object.entries(photos).map(([id, item]) => [id, { file: item.file, ...(item.request ? { request: copy(item.request) } : {}) }])), intent: intent ? copy(intent) : null }
  }
  function trackEdit(id: number, field: string, text: string) { if (!view.pending && deps.columns.some(col => col.key === field && col.key !== 'photo')) live.cell = { id, field: field as GridField, text } }
  function restore(saved: GridDraftSnapshot) {
    if (!['table', 'excel'].includes(saved.mode) || saved.draft !== null && (!Array.isArray(saved.draft) || saved.draft.length > 10000) || typeof saved.pending !== 'boolean' || !saved.photos || typeof saved.photos !== 'object') throw new Error('本地表格草稿格式不正确')
    for (const row of saved.draft ?? []) if (!Number.isSafeInteger(row.id) || !row.id || deps.columns.some(col => row[col.key] != null && typeof row[col.key] !== 'string')) throw new Error('本地草稿明细格式不正确')
    for (const item of Object.values(saved.photos)) if (!(item.file instanceof Blob) || !item.file.size) throw new Error('本地照片草稿不完整')
    reset(); view.mode = saved.mode; view.draft = saved.draft ? copy(saved.draft) : null; view.pending = saved.pending
    Object.assign(photos, saved.photos); intent = saved.intent ? copy(saved.intent) : null
    temporaryId = Math.min(0, ...rows().map(row => row.id)); ensureTail()
  }
  function reset() { ++epoch; view.mode = 'table'; view.draft = null; view.pending = false; intent = null; temporaryId = 0; uploading = false; live.cell = null; for (const id of Object.keys(photos)) delete photos[id] }
  return { view, rows, dataRows, hasChanges, setMode, edit, applyPaste, applyRange, save, reset, selectPhoto, validatePhoto, photo, snapshot, restore, trackEdit, clearTrackedEdit: () => { live.cell = null }, setCheckpoint: (saveDraft: () => Promise<boolean>) => { checkpoint = saveDraft } }
}
