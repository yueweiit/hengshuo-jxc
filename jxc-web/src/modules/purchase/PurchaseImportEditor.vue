<script setup lang="ts">
import { ref, nextTick } from 'vue'
import PurchaseImportGrid from './PurchaseImportGrid.vue'
import PurchaseImportTable from './PurchaseImportTable.vue'
import type { ImportRow, PurchaseImportModel } from './purchaseImportModel'
const props = defineProps<{ page: PurchaseImportModel; disabled: boolean }>()
const emit = defineEmits<{ review: [row: ImportRow]; remove: [row: ImportRow] }>()
const grid = ref<InstanceType<typeof PurchaseImportGrid>>()
async function switchMode() {
  if (grid.value && !await grid.value.commit()) return
  await nextTick()
  const next = props.page.grid.view.mode === 'excel' ? 'table' : 'excel'
  if (props.page.grid.setMode(next) && next === 'excel' && !props.page.grid.rows().length) props.page.grid.addRow()
}
async function save() { if (grid.value && !await grid.value.commit()) return; await nextTick(); await props.page.grid.save() }
</script>
<template>
  <div class="purchase-editor">
    <div class="editor-toolbar">
      <el-button :disabled="disabled || !!page.state.edit" @click="switchMode">{{ page.grid.view.mode === 'excel' ? '完成编辑' : '编辑' }}</el-button>
      <el-button v-if="page.grid.view.mode === 'excel'" :disabled="disabled || page.grid.view.pending" @click="page.grid.addRow()">添加行</el-button>
      <el-button v-if="page.grid.hasChanges()" type="primary" :disabled="disabled" :loading="page.state.saving" @click="save">{{ page.grid.view.pending ? '重试保存表格' : '保存表格' }}</el-button>
      <span v-if="page.grid.hasChanges()" class="editor-status" role="status">表格修改尚未保存，切换视图会保留</span>
      <span v-else-if="page.grid.view.mode === 'excel'" class="editor-hint">可从Excel复制多行粘贴；列名固定，照片沿用原上传入口</span>
    </div>
    <PurchaseImportGrid v-if="page.grid.view.mode === 'excel'" ref="grid" :page="page" :disabled="disabled" />
    <PurchaseImportTable v-else :page="page" :disabled="disabled || page.grid.hasChanges()" @review="emit('review', $event)" @remove="emit('remove', $event)" />
  </div>
</template>
<style scoped>
.purchase-editor { min-width: 0; width: 100%; }
.editor-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.editor-toolbar :deep(.el-button) { margin-left: 0; }
.editor-hint, .editor-status { font-size: 12px; color: var(--el-text-color-secondary); }
.editor-status { color: var(--el-color-warning-dark-2); }
</style>
