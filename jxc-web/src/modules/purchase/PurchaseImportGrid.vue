<script setup lang="ts">
import { computed, reactive, ref, watch, onBeforeUnmount } from 'vue'
import RevoGrid from '@revolist/vue3-datagrid'
import { TextEditor, type BeforeSaveDataDetails, type BeforeRangeSaveDataDetails, type ColumnDataSchemaModel, type ColumnRegular, type EditorCtr } from '@revolist/revogrid'
import { importTableColumns, type PurchaseImportModel } from './purchaseImportModel'

const props = defineProps<{ page: PurchaseImportModel; disabled: boolean }>()
const grid = ref<{ $el: HTMLRevoGridElement }>()
const photoInput = ref<HTMLInputElement>(), photoRow = ref<number | null>(null)
const photoUrls = reactive<Record<number, { file: File; url: string }>>({})
watch(() => props.page.grid.rows().map(row => [row.id, props.page.grid.photo(row.id)] as const), rows => {
  const current = new Map(rows)
  for (const [id, cached] of Object.entries(photoUrls)) if (current.get(Number(id)) !== cached.file) { URL.revokeObjectURL(cached.url); delete photoUrls[Number(id)] }
  for (const [id, file] of rows) if (file && !photoUrls[id]) photoUrls[id] = { file, url: URL.createObjectURL(file) }
}, { immediate: true, flush: 'sync' })
watch(() => props.page.grid.rows().flatMap(row => row.images ?? []), images => {
  for (const image of images) if (image.status !== 'REJECTED' && !props.page.images.errors.value[image.id]) void props.page.images.load(image.id)
}, { immediate: true })
const pasteListener = (event: Event) => { void paste(event as CustomEvent<{ parsed: string[][]; event: ClipboardEvent }>) }
watch(() => grid.value?.$el, (element, previous) => {
  previous?.removeEventListener('beforepasteapply', pasteListener, true)
  element?.addEventListener('beforepasteapply', pasteListener, true)
}, { flush: 'post' })
onBeforeUnmount(() => { grid.value?.$el.removeEventListener('beforepasteapply', pasteListener, true); Object.values(photoUrls).forEach(item => URL.revokeObjectURL(item.url)) })
let activeEditor: { editor: TextEditor; id: number; prop: string } | null = null
const textEditor: EditorCtr = (data, save) => {
  const editor = new TextEditor(data, save)
  activeEditor = { editor, id: Number(data.model.id), prop: String(data.prop) }
  return editor
}
const editors = { purchaseText: textEditor }
const columns = importTableColumns.map((col): ColumnRegular => ({
  prop: col.key, name: col.label, size: col.width, editor: 'purchaseText',
  readonly: col.key === 'photo' ? true : ({ model }: ColumnDataSchemaModel) => {
    const row = props.page.state.rows.find(row => row.id === Number(model.id))
    return props.disabled || props.page.grid.view.pending || !!row && props.page.rowLocked(row)
  },
  cellTemplate: col.key === 'photo' ? (h, { model }) => h('button', {
    type: 'button', 'aria-label': `第${model.id}行粘贴或选择照片`, onClick: () => choosePhoto(Number(model.id)),
    disabled: props.disabled || props.page.grid.view.pending,
    style: { border: '0', background: 'transparent', width: '100%', height: '100%', cursor: 'pointer', color: 'var(--el-color-primary)' },
  }, [model.photo ? h('img', { src: model.photo, alt: '商品照片', style: { maxWidth: '100%', height: '30px', objectFit: 'contain' } }) : h('span', {}, '粘贴/选择照片')]) : undefined,
}))
// RevoGrid只接收投影副本；真实原图、来源及业务状态仍由采购模型持有。
const source = computed(() => props.page.grid.rows().map(row => Object.fromEntries([
  ['id', row.id], ...importTableColumns.map(col => [col.key, col.key === 'photo' ? photoUrls[row.id]?.url ?? row.images?.map(image => props.page.images.urls.value[image.id]).find(Boolean) ?? (row.photo && /^(https?:\/\/|\/(?!\/)|data:image\/(?:png|jpeg|webp);base64,)/i.test(row.photo) ? row.photo : '') : row[col.key] ?? '']),
])))
function edit(event: CustomEvent<BeforeSaveDataDetails>) {
  const { model, prop, val } = event.detail
  if (!props.page.grid.edit(Number(model.id), String(prop), val == null ? null : String(val))) event.preventDefault()
  else { activeEditor = null; props.page.grid.clearTrackedEdit() }
}
function escape(event: KeyboardEvent) { if (event.key === 'Escape') { activeEditor = null; props.page.grid.clearTrackedEdit() } }
function track(event: Event) { if (activeEditor && event.target instanceof HTMLInputElement) props.page.grid.trackEdit(activeEditor.id, activeEditor.prop, event.target.value) }
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
function choosePhoto(id: number) {
  const row = props.page.grid.rows().find(row => row.id === id)
  if (props.disabled || props.page.grid.view.pending || !row || props.page.rowLocked(row)) return
  photoRow.value = id; photoInput.value?.click()
}
function selectedPhoto(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.item(0)
  if (file && photoRow.value !== null) props.page.grid.selectPhoto(photoRow.value, file)
  input.value = ''
}
async function pasteImage(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file)
  if (!files.length) return
  event.preventDefault(); event.stopPropagation()
  if (props.disabled || props.page.grid.view.pending) return
  if (files.length !== 1 || !['image/png', 'image/jpeg', 'image/gif'].includes(files[0]!.type)) { props.page.failure(new Error('请每次粘贴一张PNG、JPG或GIF图片')); return }
  if (!await commit()) return
  const focused = await grid.value?.$el.getFocused()
  if (!focused || focused.rowType !== 'rgRow' || focused.column?.prop !== 'photo') { props.page.failure(new Error('请先选择商品照片列的单元格，再粘贴图片')); return }
  const row = props.page.grid.rows()[focused.cell.y], file = files[0]!
  const name = /\.(png|jpe?g|gif)$/i.test(file.name) ? file.name : `粘贴照片.${file.type === 'image/jpeg' ? 'jpg' : file.type.slice(6)}`
  if (row) props.page.grid.selectPhoto(row.id, new File([file], name, { type: file.type }))
}
async function commit() {
  if (activeEditor) {
    const { editor, id, prop } = activeEditor
    if (!props.page.grid.edit(id, prop, editor.getValue() ?? null)) return false
    activeEditor = null
    props.page.grid.clearTrackedEdit()
  }
  return true
}
async function closeFocus() { if (!await commit()) return false; await grid.value?.$el.clearFocus(); return true }
defineExpose({ commit: closeFocus })
</script>

<template>
  <div class="purchase-excel-region" aria-label="采购明细Excel编辑视图" @keydown.capture="escape" @input.capture="track" @paste.capture="pasteImage">
    <input ref="photoInput" type="file" accept=".png,.jpg,.jpeg,.gif,image/png,image/jpeg,image/gif" hidden aria-label="选择草稿照片" @change="selectedPhoto" />
    <RevoGrid ref="grid" class="purchase-excel-grid" :columns="columns" :editors="editors" :source="source" :range="true" :row-headers="true" :apply-on-close="true" :readonly="disabled || page.grid.view.pending" :can-move-columns="false" :can-drag="false" :row-size="34" theme="compact" @beforeedit="edit" @beforerangeedit="rangeEdit" />
  </div>
</template>

<style scoped>
.purchase-excel-region { width: 100%; min-width: 0; overflow: hidden; border: 1px solid var(--el-border-color-light); }
.purchase-excel-grid { height: min(560px, 65vh); min-height: 260px; width: 100%; font-family: inherit; --rg-font-size: 13px; --rg-header-background-color: var(--el-fill-color-light); }
</style>
