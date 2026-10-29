<script setup lang="ts">
import { ref, nextTick } from 'vue'
import PurchaseImportGrid from './PurchaseImportGrid.vue'
import PurchaseImportTable from './PurchaseImportTable.vue'
import type { ImportRow, PurchaseImportModel } from './purchaseImportModel'
const props = defineProps<{ page: PurchaseImportModel; disabled: boolean; persist?: () => Promise<boolean> }>()
const emit = defineEmits<{ review: [row: ImportRow]; remove: [row: ImportRow] }>()
const grid = ref<InstanceType<typeof PurchaseImportGrid>>()
async function switchMode() {
  if (grid.value && !await grid.value.commit()) return
  await nextTick()
  const next = props.page.grid.view.mode === 'excel' ? 'table' : 'excel'
  if (props.page.grid.setMode(next)) await props.persist?.()
}
async function save() {
  if (grid.value && !await grid.value.commit()) return
  await nextTick()
  if (props.persist && !await props.persist()) return
  if (await props.page.grid.save()) { props.page.state.success = '明细已上传，请查看核对进度'; await props.page.startImageReview() }
}
</script>
<template>
  <div class="purchase-editor">
    <div class="editor-toolbar">
      <el-button type="primary" :disabled="disabled || !!page.state.edit" @click="switchMode">{{ page.grid.view.mode === 'excel' ? '完成编辑' : '切换到粘贴模板视图' }}</el-button>
      <el-button type="primary" :disabled="disabled || !!page.state.edit || !page.grid.hasChanges()" :loading="page.state.saving" @click="save">{{ page.grid.view.pending ? '重试上传' : '上传' }}</el-button>
      <span v-if="page.grid.hasChanges()" class="editor-status" role="status">当前内容为草稿，点击上传后提交校验</span>
      <span v-else-if="page.grid.view.mode === 'excel'" class="editor-hint">空白行自动扩展；仅零值占位行会舍弃；照片单元格支持粘贴单张图片</span>
    </div>
    <PurchaseImportGrid v-if="page.grid.view.mode === 'excel'" ref="grid" :page="page" :disabled="disabled" />
    <PurchaseImportTable v-else :page="page" :disabled="disabled || page.grid.view.pending" @review="emit('review', $event)" @remove="emit('remove', $event)" />
  </div>
</template>
<style scoped>
.purchase-editor { min-width: 0; width: 100%; }
.editor-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.editor-toolbar :deep(.el-button) { margin-left: 0; }
.editor-hint, .editor-status { font-size: 12px; color: var(--el-text-color-secondary); }
.editor-status { color: var(--el-color-warning-dark-2); }
</style>
