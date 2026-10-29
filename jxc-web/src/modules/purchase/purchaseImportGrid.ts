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
  readBatch(value: unknown): ImportBatch; applyBatch(batch: ImportBatch): void
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const names = (row: ImportRow): MatchInputs => ({ suppliedProductCode: row.suppliedProductCode ?? null, suppliedProductName: row.suppliedProductName ?? null, supplierProductCode: row.supplierProductCode ?? null })
const decimalKey = (value: string | null) => value == null ? null : value.replace(/^0+(?=\d)/, '').replace(/\.0*$/, '').replace(/(\.\d*?)0+$/, '$1')

/** 只负责采购表格草稿与字段适配；选择、键盘和剪贴板解析由RevoGrid提供。 */
export function createPurchaseImportGrid(deps: GridDeps) {
  const view = reactive({ mode: 'table' as 'table' | 'excel', draft: null as ImportRow[] | null, pending: false })
  let temporaryId = 0, epoch = 0
  let intent: { input: GridSaveInput; key: string } | null = null
  const rows = () => view.draft ?? deps.state.rows
  const value = (row: ImportRow, field: GridField) => row[field] ?? null
  const hasChanges = () => {
    const saved = new Map(deps.state.rows.map(row => [row.id, row]))
    return rows().some(row => {
      const old = saved.get(row.id)
      return !old ? deps.columns.some(col => col.key !== 'photo' && value(row, col.key) !== null) : deps.columns.some(col => value(old, col.key) !== value(row, col.key))
    })
  }
  function setMode(mode: 'table' | 'excel') {
    if (deps.busy() || deps.editing()) return false
    view.mode = mode
    return true
  }
  function blank(rowNo: number): ImportRow {
    return { ...Object.fromEntries(deps.columns.map(col => [col.key, null])) as ImportValues, id: --temporaryId, version: 1, rowNo, images: [], suppliedProductName: null }
  }
  function ensureDraft() { if (!view.draft) view.draft = copy(deps.state.rows) }
  function addRow() {
    if (deps.busy() || view.pending) return false
    ensureDraft()
    view.draft!.push(blank(Math.max(0, ...rows().map(row => row.rowNo)) + 1))
    return true
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
        deps.normalize(row)
        if ((row.suppliedProductName?.length ?? 0) > 200) throw new Error('商品名最多200个字符')
      }
      view.draft = next
      deps.feedback()
      return true
    } catch (error) { deps.failure(error); return false }
  }
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
      return old ? deps.columns.some(col => value(old, col.key) !== value(row, col.key)) : deps.columns.some(col => col.key !== 'photo' && value(row, col.key) !== null)
    })
    return { batchId: deps.state.batchId, batchVersion: deps.state.batchId ? deps.state.version : null, header: {}, rows: changed.map(row => ({
      clientId: String(row.id), id: row.id > 0 ? row.id : null, version: row.id > 0 ? row.version : null, values: deps.normalize(row), matchInputs: names(row),
    })) }
  }
  async function save() {
    if (deps.busy() || deps.editing() || !hasChanges()) return false
    if (!intent) intent = { input: input(), key: deps.newKey() }
    const run = intent, context = epoch
    view.pending = true
    return deps.save(run.input, run.key, raw => {
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
      deps.applyBatch(batch)
      view.draft = null; intent = null; view.pending = false
    })
  }
  function reset() { ++epoch; view.mode = 'table'; view.draft = null; view.pending = false; intent = null; temporaryId = 0 }
  return { view, rows, hasChanges, setMode, edit, applyPaste, applyRange, addRow, save, reset }
}
