<script setup lang="ts">
import { nextTick, ref } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import type { InputInstance } from 'element-plus'
import { importColumns, type ImportField, type ImportRow, type PurchaseImportModel } from './purchaseImportModel'

const props = defineProps<{ page: PurchaseImportModel; disabled: boolean }>()
const emit = defineEmits<{ remove: [row: ImportRow] }>()
const columns = importColumns.map(column => ({ ...column, numeric: 'numeric' in column }))
const editor = ref<InputInstance | null>(null)
function setEditor(instance: Element | ComponentPublicInstance | null, field: ImportField) {
  if (props.page.state.edit?.field === field || props.page.state.edit?.field === null && field === 'sourceOrderNo') editor.value = instance as InputInstance | null
}
async function begin(row: ImportRow, field: ImportField | null) {
  if (props.disabled || !props.page.startEdit(row, field)) return
  await nextTick()
  editor.value?.focus()
}
function editing(row: ImportRow, field: ImportField) {
  const edit = props.page.state.edit
  return edit?.id === row.id && (edit.field === null || edit.field === field)
}
function saveCell() { if (props.page.state.edit?.field != null) return props.page.saveEdit() }
function imageUrl(value: string | null) {
  return value && /^(https?:\/\/|\/(?!\/)|data:image\/(?:png|jpeg|webp);base64,)/i.test(value) ? value : undefined
}
</script>

<template>
  <el-table :data="page.state.rows" row-key="id" border stripe max-height="560" class="import-detail-table" :empty-text="page.state.loading ? '正在读取明细' : '暂无明细，请导入采购文件'">
    <el-table-column prop="rowNo" label="序号" width="64" fixed="left" align="center" />
    <el-table-column v-for="column in columns" :key="column.key" :prop="column.key" :label="column.label" :min-width="column.width" :align="column.numeric ? 'right' : 'left'">
      <template #default="{ row }">
        <el-input
          v-if="editing(row, column.key) && page.state.edit"
          :ref="(instance: Element | ComponentPublicInstance | null) => setEditor(instance, column.key)"
          v-model="page.state.edit.values[column.key]"
          :aria-label="`第${row.rowNo}行${column.label}`"
          :inputmode="column.numeric ? 'decimal' : 'text'"
          :disabled="page.state.saving"
          size="small"
          @keydown.enter.prevent="page.saveEdit()"
          @keydown.esc.prevent="page.cancelEdit()"
          @blur="saveCell"
        />
        <button
          v-else
          type="button"
          class="import-cell"
          :class="{ 'import-cell-number': column.numeric, 'import-cell-photo': column.key === 'photo' }"
          :disabled="disabled || !!page.state.edit || page.rowLocked(row)"
          :aria-label="`编辑第${row.rowNo}行${column.label}`"
          @click="begin(row, column.key)"
        >
          <template v-if="column.key === 'photo'">
            <el-image v-if="imageUrl(row.photo)" :src="imageUrl(row.photo)" fit="contain" class="import-photo" :alt="`第${row.rowNo}行商品照片`">
              <template #error><span class="unverified">待核实</span></template>
            </el-image>
            <span v-else class="unverified" :title="row.photo || '尚无可用照片'">待核实</span>
          </template>
          <span v-else :class="{ unverified: row[column.key] == null }">{{ row[column.key] ?? '待核实' }}</span>
        </button>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="112" fixed="right" align="center">
      <template #default="{ row }">
        <div class="import-row-actions">
          <template v-if="page.state.edit?.id === row.id">
            <el-tooltip content="保存" placement="top"><el-button type="primary" link :loading="page.state.saving" :aria-label="`保存第${row.rowNo}行`" @mousedown.prevent @click="page.saveEdit()"><el-icon><Check /></el-icon></el-button></el-tooltip>
            <el-tooltip content="取消" placement="top"><el-button link :disabled="page.state.saving" :aria-label="`取消编辑第${row.rowNo}行`" @mousedown.prevent @click="page.cancelEdit()"><el-icon><Close /></el-icon></el-button></el-tooltip>
          </template>
          <template v-else>
            <el-tooltip content="编辑整行" placement="top"><el-button type="primary" link :disabled="disabled || !!page.state.edit || page.rowLocked(row)" :aria-label="`编辑第${row.rowNo}行`" @click="begin(row, null)"><el-icon><EditPen /></el-icon></el-button></el-tooltip>
            <el-tooltip content="删除" placement="top"><el-button type="danger" link :disabled="disabled || !!page.state.edit || page.rowLocked(row)" :loading="page.state.deletingId === row.id" :aria-label="`删除第${row.rowNo}行`" @click="emit('remove', row)"><el-icon><Delete /></el-icon></el-button></el-tooltip>
          </template>
        </div>
      </template>
    </el-table-column>
  </el-table>
</template>

<style scoped lang="scss">
.import-detail-table {
  --el-table-header-bg-color: var(--el-fill-color-light);
  --el-table-header-text-color: var(--el-text-color-regular);
  font-size: 13px;
  :deep(.el-table__cell) { padding: 5px 0; }
  :deep(.cell) { padding: 0 8px; }
}
.import-cell { display: block; width: 100%; min-height: 30px; padding: 4px 6px; border: 1px solid transparent; border-radius: 3px; background: transparent; color: inherit; text-align: left; font: inherit; cursor: text; overflow-wrap: anywhere; }
.import-cell:hover:not(:disabled), .import-cell:focus-visible { border-color: var(--el-color-primary-light-5); outline: none; }
.import-cell:disabled { cursor: default; }
.import-cell-number { text-align: right; font-variant-numeric: tabular-nums; }
.import-cell-photo { text-align: center; }
.import-photo { display: block; width: 58px; height: 50px; margin: auto; }
.unverified { color: var(--el-text-color-secondary); font-size: 12px; }
.import-row-actions { display: flex; align-items: center; justify-content: center; gap: 14px; min-height: 30px; .el-button { margin: 0; font-size: 17px; } }
</style>
