<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useCountryStore } from '@/stores/country'
import FieldInput from '@/components/crud/FieldInput.vue'
import MoneyText from '@/components/MoneyText.vue'
import { CURRENCY_SOURCE } from '@/modules/master/options'
import { SUPPLIER_SOURCE } from '@/modules/shared/bizOptions'
import { todayIn } from '@/utils/format'

const supplyCommandIntent = createCommandIntent()


interface Sku {
  productId: number
  label: string
  baseUnit: string
  units: { unit: string; factorToBase: number; isPurchaseDefault: boolean }[]
}
interface Line {
  productId?: number
  unit?: string
  qty?: number
  unitPrice?: number
  taxRate?: number
  deliveryDate?: string | null
}
interface OrderModel {
  id?: number
  version?: number
  status?: string
  bookId?: number
  supplierId?: number
  currency?: string
  orderDate?: string
  expectedDate?: string | null
  paymentTerms?: string
  prepayRatio?: number
  termDays?: number
  remark?: string
  lines: Line[]
}

const emit = defineEmits<{ saved: [order: { id: number; status: string }] }>()
const country = useCountryStore()
const visible = ref(false)
const books = ref<Record<string, any>[]>([])
const saving = ref(false)
const formRef = ref<FormInstance>()
const skus = ref<Sku[]>([])
const suppliers = ref<{ id: number; settleCurrency: string; paymentTerms: string }[]>([])
const model = reactive<OrderModel>({ lines: [] })

const isEdit = computed(() => !!model.id)
const isConfirmedEdit = computed(() => model.status === 'CONFIRMED')

async function loadRefs() {
  const [s, p] = await Promise.all([
    allRecords<Sku>('/md/country-skus', { enabled: 'true' }),
    allRecords<{ id: number; settleCurrency: string; paymentTerms: string }>('/md/partners', { partnerType: 'SUPPLIER', status: 'ENABLED' }),
  ])
  skus.value = s
  suppliers.value = p
}

async function open(id?: number) {
  await loadRefs()
  supplyCommandIntent.reset()
  books.value = await http.get('/org/books')
  if (id) {
    const o = await http.get<OrderModel>(`/pur/orders/${id}`)
    Object.assign(model, {
      ...o,
      lines: o.lines.map((l) => ({ productId: l.productId, unit: l.unit, qty: l.qty, unitPrice: l.unitPrice, taxRate: l.taxRate, deliveryDate: l.deliveryDate })),
    })
  } else {
    for (const k of Object.keys(model)) delete (model as unknown as Record<string, unknown>)[k]
    Object.assign(model, { orderDate: todayIn(country.timezone), currency: undefined, prepayRatio: 0, lines: [{ taxRate: 0.13 }] })
  }
  visible.value = true
}

function onSupplierChange() {
  const s = suppliers.value.find((x) => x.id === model.supplierId)
  if (s && !isEdit.value) {
    model.currency = s.settleCurrency
    model.paymentTerms = s.paymentTerms
  }
}

const skuOf = (pid?: number) => skus.value.find((s) => s.productId === pid)

function onProductChange(l: Line) {
  const sku = skuOf(l.productId)
  l.unit = sku?.units.find((u) => u.isPurchaseDefault)?.unit ?? sku?.baseUnit
}

const factorOf = (l: Line) => skuOf(l.productId)?.units.find((u) => u.unit === l.unit)?.factorToBase ?? 1
const lineAmount = (l: Line) => (l.qty ?? 0) * (l.unitPrice ?? 0)
const total = computed(() => model.lines.reduce((s, l) => s + lineAmount(l), 0))
const totalBase = computed(() => model.lines.reduce((s, l) => s + (l.qty ?? 0) * factorOf(l), 0))

function payload(submit: boolean) {
  return { ...model, version: model.version, submit, lines: model.lines.filter((l) => l.productId) }
}

async function save(submit: boolean) {
  if (saving.value) return
  await formRef.value?.validate()
  if (!model.lines.some((l) => l.productId && l.qty)) {
    ElMessage.warning('至少需要一行商品与数量')
    return
  }
  if (model.lines.some((l) => l.productId && (typeof l.unitPrice !== 'number' || !Number.isFinite(l.unitPrice)))) {
    ElMessage.warning('请填写每行采购单价；未知价格不能按零保存')
    return
  }
  saving.value = true
  try {
    let res: { id: number; status: string; needResubmit?: boolean; approvalMessage?: string }
    if (isEdit.value) {
      res = await http.put(`/pur/orders/${model.id}`, payload(false))
      if (res.needResubmit) {
        await ElMessageBox.alert('供应商、数量、单价或付款条件已修改，原审批失效，采购单已退回草稿，请重新提交。', '需要重新审批', { type: 'warning' })
      }
      if (submit && res.status === 'DRAFT') res = await http.postIdem(`/pur/orders/${model.id}/submit`, undefined, supplyCommandIntent)
    } else {
      res = await http.postIdem('/pur/orders', payload(submit), supplyCommandIntent)
    }
    ElMessage.success(res.approvalMessage ?? '已保存')
    visible.value = false
    emit('saved', res)
  } finally {
    saving.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <el-dialog v-model="visible" :title="isEdit ? '编辑采购单' : '新建采购单'" width="1080px" append-to-body destroy-on-close class="crud-dialog">
    <el-alert
      v-if="isConfirmedEdit"
      type="warning"
      :closable="false"
      show-icon
      title="这是已确认的采购单：修改供应商、数量、单价或付款条件会使原审批失效，单据退回草稿后需要重新提交。"
      class="mb"
    />
    <el-form ref="formRef" :model="model" label-width="96px">
      <el-row :gutter="12">
        <el-col :xs="24" :span="8"><el-form-item label="账套" prop="bookId" :rules="[{ required: true, message: '请选择账套' }]"><el-select v-model="model.bookId" :disabled="isEdit" placeholder="请选择账套"><el-option v-for="b in books" :key="b.id" :label="b.name + ' · ' + b.baseCurrency" :value="b.id" /></el-select></el-form-item></el-col>
        <el-col :xs="24" :span="8">
          <el-form-item label="供应商" prop="supplierId" :rules="[{ required: true, message: '请选择供应商' }]">
            <FieldInput v-model="model.supplierId" :field="{ prop: 'supplierId', label: '供应商', type: 'select', options: SUPPLIER_SOURCE }" @update:model-value="onSupplierChange" />
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="4">
          <el-form-item label="币种" prop="currency" :rules="[{ required: true, message: '请选择币种' }]">
            <FieldInput v-model="model.currency" :field="{ prop: 'currency', label: '币种', type: 'select', options: CURRENCY_SOURCE }" />
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="6">
          <el-form-item label="下单日期" prop="orderDate">
            <el-date-picker v-model="model.orderDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="6">
          <el-form-item label="预计交货">
            <el-date-picker v-model="model.expectedDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :xs="24" :span="12">
          <el-form-item label="付款条件"><el-input v-model="model.paymentTerms" /></el-form-item>
        </el-col>
        <el-col :xs="12" :span="6">
          <el-form-item label="预付比例">
            <el-input-number v-model="model.prepayRatio" :min="0" :max="100" controls-position="right" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="6">
          <el-form-item label="账期天数">
            <el-input-number v-model="model.termDays" :min="0" controls-position="right" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :span="24">
          <el-form-item label="备注"><el-input v-model="model.remark" /></el-form-item>
        </el-col>
      </el-row>
    </el-form>

    <div class="table-scroll">
      <el-table :data="model.lines" border size="small">
        <el-table-column type="index" label="#" width="44" />
        <el-table-column label="商品" min-width="220">
          <template #default="{ row }">
            <el-select v-model="row.productId" filterable placeholder="选择本国启用的 SKU" style="width: 100%" @change="onProductChange(row)">
              <el-option v-for="s in skus" :key="s.productId" :label="s.label" :value="s.productId" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="单位" width="110">
          <template #default="{ row }">
            <el-select v-model="row.unit" style="width: 100%">
              <el-option v-for="u in skuOf(row.productId)?.units ?? []" :key="u.unit" :label="`${u.unit}（×${u.factorToBase}）`" :value="u.unit" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="120">
          <template #default="{ row }"><el-input-number v-model="row.qty" :min="0" :controls="false" style="width: 100%" /></template>
        </el-table-column>
        <el-table-column label="基本单位数量" width="110" align="right">
          <template #default="{ row }"><span class="mono">{{ (row.qty ?? 0) * factorOf(row) }}</span></template>
        </el-table-column>
        <el-table-column :label="`单价（${model.currency ?? ''}）`" width="130">
          <template #default="{ row }"><el-input-number v-model="row.unitPrice" placeholder="请填写" :min="0" :precision="4" :controls="false" style="width: 100%" /></template>
        </el-table-column>
        <el-table-column label="税率" width="90">
          <template #default="{ row }"><el-input-number v-model="row.taxRate" :min="0" :max="1" :step="0.01" :precision="2" :controls="false" style="width: 100%" /></template>
        </el-table-column>
        <el-table-column label="金额" width="140" align="right">
          <template #default="{ row }"><MoneyText :value="lineAmount(row)" :currency="model.currency" /></template>
        </el-table-column>
        <el-table-column label="交货日期" width="150">
          <template #default="{ row }"><el-date-picker v-model="row.deliveryDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></template>
        </el-table-column>
        <el-table-column width="60">
          <template #default="{ $index }">
            <el-button link type="danger" :disabled="model.lines.length <= 1" @click="model.lines.splice($index, 1)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <div class="foot">
      <el-button link type="primary" @click="model.lines.push({ taxRate: 0.13 })"><el-icon><Plus /></el-icon>添加一行</el-button>
      <span>合计 <b class="mono">{{ totalBase }}</b> 件 · <MoneyText :value="total" :currency="model.currency" /></span>
    </div>
    <p class="muted">数量按基本单位统计；国内收货、出口、发运与目的地实收都按基本单位回写进度。审批要求和复核人员按当前国家的单据设置及审批规则执行。</p>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button :loading="saving" @click="save(false)">保存草稿</el-button>
      <el-button type="primary" :loading="saving" @click="save(true)">保存并提交</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mb {
  margin-bottom: 12px;
}

.foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 8px 0;
}
</style>
