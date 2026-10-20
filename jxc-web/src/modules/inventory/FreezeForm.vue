<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import FieldInput from '@/components/crud/FieldInput.vue'
import { ALL_WAREHOUSE_SOURCE, PRODUCT_SOURCE } from '@/modules/shared/bizOptions'

const intent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const emit = defineEmits<{ saved: [] }>()
const visible = ref(false)
const saving = ref(false)
const batches = ref<Row[]>([])
const m = reactive<{ warehouseId?: number; productId?: number; batchId?: number; qty: number; reason: string }>({ qty: 0, reason: '' })

watch(() => [m.warehouseId, m.productId], async ([w, p]) => {
  batches.value = w && p ? await http.get<Row[]>(`/inv/stocks/${w}/${p}/batches`) : []
  if (!batches.value.some((b) => b.batchId === m.batchId)) m.batchId = undefined
})

function open(init: { warehouseId?: number; productId?: number; batchId?: number } = {}) {
  intent.reset()
  Object.assign(m, { warehouseId: undefined, productId: undefined, batchId: undefined, qty: 0, reason: '' }, init)
  visible.value = true
}

async function save() {
  if (!m.warehouseId || !m.productId) return ElMessage.warning('请选择仓库和商品')
  if (!(m.qty > 0)) return ElMessage.warning('冻结数量必须大于 0')
  if (!m.reason.trim()) return ElMessage.warning('请填写冻结原因')
  saving.value = true
  try {
    const rows = await http.postIdem<Row[]>('/inv/freezes', m, intent)
    ElMessage.success(rows.length > 1 ? `已冻结，按先进先出分到 ${rows.length} 个批次` : '已冻结')
    visible.value = false
    emit('saved')
  } finally {
    saving.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <el-dialog v-model="visible" title="手工冻结" width="520px" append-to-body>
    <el-form label-width="90px">
      <el-form-item label="仓库" required>
        <FieldInput v-model="m.warehouseId" :field="{ prop: 'warehouseId', label: '仓库', type: 'select', options: ALL_WAREHOUSE_SOURCE }" />
      </el-form-item>
      <el-form-item label="商品" required>
        <FieldInput v-model="m.productId" :field="{ prop: 'productId', label: '商品', type: 'select', options: PRODUCT_SOURCE }" />
      </el-form-item>
      <el-form-item label="批次">
        <el-select v-model="m.batchId" clearable placeholder="不选则按先进先出" style="width: 100%">
          <el-option v-for="b in batches" :key="b.batchId" :label="`${b.batchNo}（可冻 ${b.onHandQty - b.frozenQty}）`" :value="b.batchId" />
        </el-select>
      </el-form-item>
      <el-form-item label="数量" required><el-input-number v-model="m.qty" :min="0" :controls="false" style="width: 100%" /></el-form-item>
      <el-form-item label="原因" required><el-input v-model="m.reason" type="textarea" :rows="2" placeholder="例如：客户投诉同批次质量问题，暂停销售" /></el-form-item>
    </el-form>
    <p class="muted">冻结只影响可售数量，不改变实物数量；解冻需要“解冻”权限。冻结数量不能超过可售数量。</p>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">冻结</el-button>
    </template>
  </el-dialog>
</template>
