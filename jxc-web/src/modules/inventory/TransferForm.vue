<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useCountryStore } from '@/stores/country'
import FieldInput from '@/components/crud/FieldInput.vue'
import { ALL_WAREHOUSE_SOURCE } from '@/modules/shared/bizOptions'
import { todayIn } from '@/utils/format'

const intent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const emit = defineEmits<{ saved: [t: Row] }>()
const country = useCountryStore()
const visible = ref(false)
const saving = ref(false)
const stock = ref<Row[]>([])
const m = reactive<Row>({ lines: [] })

watch(() => m.fromWarehouseId, async (w) => {
  const selectedCountry = country.currentId
  stock.value = w ? (await allRecords<Row>('/inv/stocks', { warehouseId: w }, () => { if (selectedCountry !== country.currentId || w !== m.fromWarehouseId) throw new Error('仓库或国家已切换') })).filter((s) => s.onHandQty > 0) : []
})

const stockOf = (pid: number) => stock.value.find((s) => s.productId === pid)

function open(existing?: Row) {
  intent.reset()
  for (const k of Object.keys(m)) delete m[k]
  Object.assign(m, existing
    ? { ...existing, lines: existing.lines.map((l: Row) => ({ productId: l.productId, qty: l.qty, batchId: l.batchId })) }
    : { plannedDate: todayIn(country.timezone), remark: '', lines: [{ productId: undefined, qty: 0 }] })
  visible.value = true
}

async function save(submit: boolean) {
  const lines = m.lines.filter((l: Row) => l.productId && l.qty > 0)
  if (!m.fromWarehouseId || !m.toWarehouseId) return ElMessage.warning('请选择调出仓和调入仓')
  if (!lines.length) return ElMessage.warning('请至少填写一行商品和数量')
  const over = lines.find((l: Row) => l.qty > (stockOf(l.productId)?.availableQty ?? 0))
  if (over) return ElMessage.warning(`${stockOf(over.productId)?.productCode ?? '商品'} 调出仓可售不足`)
  saving.value = true
  try {
    let t: Row
    if (m.id) {
      t = await http.putIdem<Row>(`/inv/transfers/${m.id}`, { ...m, version: m.version, lines }, intent)
      Object.assign(m, t)
      if (submit) t = await http.postIdem<Row>(`/inv/transfers/${m.id}/submit`, {}, intent)
    } else {
      t = await http.postIdem<Row>('/inv/transfers', { ...m, lines, submit }, intent)
    }
    ElMessage.success(submit ? (t.status === 'APPROVED' ? '已提交，无需审批，可以调出' : '已提交审批') : '已保存草稿')
    visible.value = false
    emit('saved', t)
  } finally {
    saving.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <el-dialog v-model="visible" :title="m.id ? `编辑调拨单 ${m.docNo}` : '新建调拨单'" width="760px" append-to-body destroy-on-close>
    <el-form label-width="90px">
      <el-row :gutter="12">
        <el-col :xs="24" :span="12">
          <el-form-item label="调出仓" required>
            <FieldInput v-model="m.fromWarehouseId" :field="{ prop: 'fromWarehouseId', label: '调出仓', type: 'select', options: ALL_WAREHOUSE_SOURCE }" />
          </el-form-item>
        </el-col>
        <el-col :xs="24" :span="12">
          <el-form-item label="调入仓" required>
            <FieldInput v-model="m.toWarehouseId" :field="{ prop: 'toWarehouseId', label: '调入仓', type: 'select', options: ALL_WAREHOUSE_SOURCE }" />
          </el-form-item>
        </el-col>
        <el-col :xs="24" :span="12">
          <el-form-item label="计划日期"><el-date-picker v-model="m.plannedDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item>
        </el-col>
        <el-col :xs="24" :span="12"><el-form-item label="备注"><el-input v-model="m.remark" /></el-form-item></el-col>
      </el-row>
    </el-form>
    <el-table :data="m.lines" border size="small">
      <el-table-column label="商品" min-width="240">
        <template #default="{ row }">
          <el-select v-model="row.productId" filterable :placeholder="m.fromWarehouseId ? '选择调出仓有库存的商品' : '请先选择调出仓'" style="width: 100%">
            <el-option v-for="s in stock" :key="s.productId" :label="`${s.productCode} ${s.productName}`" :value="s.productId" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="调出仓可售" width="100" align="right">
        <template #default="{ row }">{{ row.productId ? stockOf(row.productId)?.availableQty ?? 0 : '-' }}</template>
      </el-table-column>
      <el-table-column label="数量" width="130">
        <template #default="{ row }"><el-input-number v-model="row.qty" :min="0" :max="stockOf(row.productId)?.availableQty" :controls="false" style="width: 100%" /></template>
      </el-table-column>
      <el-table-column width="60">
        <template #default="{ $index }"><el-button link type="danger" @click="m.lines.splice($index, 1)">删除</el-button></template>
      </el-table-column>
    </el-table>
    <el-button link type="primary" class="mt" @click="m.lines.push({ productId: undefined, qty: 0 })"><el-icon><Plus /></el-icon>添加一行</el-button>
    <p class="muted">提交后按审批规则流转；审批通过后由调出仓调出（扣减实物、形成调拨在途），调入仓实收后增加库存，批次沿用调出批次。</p>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button :loading="saving" @click="save(false)">保存草稿</el-button>
      <el-button type="primary" :loading="saving" @click="save(true)">保存并提交</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mt {
  margin-top: 8px;
}
</style>
