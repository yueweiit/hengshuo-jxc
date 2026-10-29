<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import RevoGrid from '@revolist/vue3-datagrid'
import { TextEditor, type BeforeSaveDataDetails, type BeforeRangeSaveDataDetails, type ColumnDataSchemaModel, type EditorCtr } from '@revolist/revogrid'
import { importTableColumns, type PurchaseImportModel } from './purchaseImportModel'

const props = defineProps<{ page: PurchaseImportModel; disabled: boolean }>()
const grid = ref<{ $el: HTMLRevoGridElement }>()
const pasteListener = (event: Event) => { void paste(event as CustomEvent<{ parsed: string[][]; event: ClipboardEvent }>) }
watch(() => grid.value?.$el, (element, previous) => {
  previous?.removeEventListener('beforepasteapply', pasteListener, true)
  element?.addEventListener('beforepasteapply', pasteListener, true)
}, { flush: 'post' })
onBeforeUnmount(() => grid.value?.$el.removeEventListener('beforepasteapply', pasteListener, true))
let activeEditor: { editor: TextEditor; id: number; prop: string } | null = null
const textEditor: EditorCtr = (data, save) => {
  const editor = new TextEditor(data, save)
  activeEditor = { editor, id: Number(data.model.id), prop: String(data.prop) }
  return editor
}
const editors = { purchaseText: textEditor }
const columns = importTableColumns.map(col => ({
  prop: col.key, name: col.label, size: col.width, editor: 'purchaseText',
  readonly: col.key === 'photo' ? true : ({ model }: ColumnDataSchemaModel) => {
    const row = props.page.state.rows.find(row => row.id === Number(model.id))
    return props.disabled || props.page.grid.view.pending || !!row && props.page.rowLocked(row)
  },
}))
// RevoGrid只接收投影副本；真实原图、来源及业务状态仍由采购模型持有。
const source = computed(() => props.page.grid.rows().map(row => Object.fromEntries([
  ['id', row.id], ...importTableColumns.map(col => [col.key, col.key === 'photo' ? (row.images?.length ? `${row.images.length}张照片` : row.photo ?? '') : row[col.key] ?? '']),
])))
function edit(event: CustomEvent<BeforeSaveDataDetails>) {
  const { model, prop, val } = event.detail
  if (!props.page.grid.edit(Number(model.id), String(prop), val == null ? null : String(val))) event.preventDefault()
  else activeEditor = null
}
function escape(event: KeyboardEvent) { if (event.key === 'Escape') activeEditor = null }
function rangeEdit(event: CustomEvent<BeforeRangeSaveDataDetails>) {
  if (!props.page.grid.applyRange(event.detail.data)) event.preventDefault()
}
async function paste(event: CustomEvent<{ parsed: string[][]; event: ClipboardEvent }>) {
  // 使用组件已经解析的剪贴板矩阵，在写入前一次性检查列边界与业务锁。
  event.preventDefault()
  event.detail.event?.preventDefault()
  if (!event.detail.event.clipboardData?.types.length) { props.page.failure(new Error('未读取到剪贴板内容，请从Excel重新复制后粘贴')); return }
  if (!await commit()) return
  const focused = await grid.value?.$el.getFocused()
  if (!focused || focused.rowType !== 'rgRow' || !focused.column) { props.page.failure(new Error('请先选择要粘贴的单元格')); return }
  props.page.grid.applyPaste(focused.cell.y, String(focused.column.prop), event.detail.parsed)
}
async function commit() {
  if (activeEditor) {
    const { editor, id, prop } = activeEditor
    if (!props.page.grid.edit(id, prop, editor.getValue() ?? null)) return false
    activeEditor = null
  }
  return true
}
async function closeFocus() { if (!await commit()) return false; await grid.value?.$el.clearFocus(); return true }
defineExpose({ commit: closeFocus })
</script>

<template>
  <div class="purchase-excel-region" aria-label="采购明细Excel编辑视图" @keydown.capture="escape">
    <RevoGrid ref="grid" class="purchase-excel-grid" :columns="columns" :editors="editors" :source="source" :range="true" :row-headers="true" :apply-on-close="true" :readonly="disabled || page.grid.view.pending" :can-move-columns="false" :can-drag="false" :row-size="34" theme="compact" @beforeedit="edit" @beforerangeedit="rangeEdit" />
  </div>
</template>

<style scoped>
.purchase-excel-region { width: 100%; min-width: 0; overflow: hidden; border: 1px solid var(--el-border-color-light); }
.purchase-excel-grid { height: min(560px, 65vh); min-height: 260px; width: 100%; font-family: inherit; --rg-font-size: 13px; --rg-header-background-color: var(--el-fill-color-light); }
</style>
