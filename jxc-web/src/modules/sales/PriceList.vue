<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'
import { todayIn } from '@/utils/format'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { PRICE_TYPES } from '@/modules/shared/bizOptions'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const user = useUserStore(), country = useCountryStore()
const page = ref<CrudPageExpose>()
const tab = ref('BASE')
const options = reactive({ products: [] as Row[], customers: [] as Row[], levels: [] as Row[] })
const form = reactive({ visible: false, saving: false, id: 0, version: undefined as number | undefined, productId: undefined as number | undefined, customerId: undefined as number | undefined, levelId: undefined as number | undefined, price: 0, minQty: 1, unit: '', taxMode: 'INCL', effectiveFrom: '', effectiveTo: '' })

const columns: ColumnDef[] = [
  { prop: 'productCode', label: 'SKU', width: 110 },
  { prop: 'productName', label: '商品', minWidth: 140 },
  { prop: 'customerName', label: '客户', minWidth: 140 },
  { prop: 'levelName', label: '等级', width: 100 },
  { prop: 'price', label: '价格', width: 120 },
  { prop: 'minQty', label: '起订量', type: 'qty', width: 90 },
  { prop: 'versionNo', label: '版本', width: 70 },
  { prop: 'effectiveFrom', label: '生效', type: 'date', width: 110 },
  { prop: 'status', label: '状态', type: 'status', width: 90 },
]
const searchFields: FieldDef[] = [
  { prop: 'status', label: '状态', type: 'select', options: [{ label: '生效', value: 'ACTIVE' }, { label: '已退役', value: 'RETIRED' }] },
]

function switchTab() {
  if (page.value) page.value.query.priceType = tab.value
  page.value?.search()
}

async function open(row?: Row) {
  supplyCommandIntent.reset()
  await loadReferences()
  Object.assign(form, { visible: true, id: row?.id ?? 0, version: row?.version, productId: row?.productId, customerId: row?.customerId, levelId: row?.levelId, price: row?.price ?? 0, minQty: row?.minQty ?? 1, unit: row?.unit ?? '', taxMode: row?.taxMode ?? 'INCL', effectiveFrom: row?.effectiveFrom ?? todayIn(country.timezone), effectiveTo: row?.effectiveTo ?? '' })
}

async function loadReferences() {
  const epoch = country.epoch
  const [products, customers, levels] = await Promise.all([
    user.hasPerm(['md:product:view', 'md:product:edit']) ? allRecords<Row>('/md/country-skus') : Promise.resolve([]),
    user.hasPerm(['md:customer:view', 'md:customer:edit']) ? allRecords<Row>('/md/customers') : Promise.resolve([]),
    user.hasPerm(['md:customer:view', 'md:customer:edit']) ? allRecords<Row>('/md/customer-levels') : Promise.resolve([]),
  ])
  if (epoch !== country.epoch) return
  options.products = products
  options.customers = customers
  options.levels = levels
}

onMounted(loadReferences)

async function save() {
  form.saving = true
  try {
    const body = { version: form.version, priceType: tab.value, productId: form.productId, customerId: form.customerId, levelId: form.levelId, price: form.price, unit: form.unit || options.products.find(p => p.productId === form.productId)?.baseUnit, minQty: form.minQty, taxMode: form.taxMode, currency: country.currency, effectiveFrom: form.effectiveFrom, effectiveTo: form.effectiveTo || null }
    if (form.id) await http.put(`/sal/prices/${form.id}`, body)
    else await http.postIdem('/sal/prices', body, supplyCommandIntent)
    ElMessage.success(form.id ? '已生成新版本，旧价退役' : '已新增价格')
    form.visible = false
    page.value?.reload()
  } finally {
    form.saving = false
  }
}
</script>

<template>
  <CrudPage ref="page" title="价格表" resource="/sal/prices" :columns="columns" :search-fields="searchFields" :default-query="{ priceType: 'BASE' }" :can-create="false" :can-toggle="false" :actions-width="100">
    <template #toolbar>
      <el-radio-group v-model="tab" @change="switchTab">
        <el-radio-button v-for="t in PRICE_TYPES" :key="String(t.value)" :value="t.value">{{ t.label }}</el-radio-button>
      </el-radio-group>
      <el-button v-if="user.hasPerm('sal:price:edit')" type="primary" @click="open()">新增</el-button>
    </template>
    <template #header><p class="muted">改价生成新版本，已经审批通过的订单继续使用下单时的价格快照。</p></template>
    <template #col-productCode="{ row }">{{ row.productCode || options.products.find(p => p.productId === row.productId)?.productCode || `商品 #${row.productId}` }}</template>
    <template #col-productName="{ row }">{{ row.productName || options.products.find(p => p.productId === row.productId)?.name || '-' }}</template>
    <template #col-customerName="{ row }">{{ row.customerName || options.customers.find(c => c.id === row.customerId)?.name || '-' }}</template>
    <template #col-levelName="{ row }">{{ row.levelName || options.levels.find(l => l.id === row.levelId)?.name || '-' }}</template>
    <template #col-price="{ row }"><MoneyText :value="row.price" :currency="row.currency" /></template>
    <template #row-actions="{ row }">
      <el-button v-if="row.status === 'ACTIVE' && user.hasPerm('sal:price:edit')" link type="primary" @click="open(row)">改价</el-button>
    </template>
  </CrudPage>
  <el-dialog v-model="form.visible" :title="form.id ? '价格新版本' : '新增价格'" width="480px">
    <el-form label-width="88px">
      <el-form-item label="商品">
        <el-select v-model="form.productId" filterable style="width: 100%" @change="form.unit = options.products.find(p => p.productId === form.productId)?.baseUnit || ''"><el-option v-for="p in options.products.filter(p => p.enabled && p.productStatus === 'ENABLED')" :key="p.productId" :label="p.label || p.productCode" :value="p.productId" /></el-select>
      </el-form-item>
      <el-form-item v-if="tab === 'CUSTOMER'" label="客户">
        <el-select v-model="form.customerId" filterable style="width: 100%"><el-option v-for="c in options.customers.filter(c => c.status === 'ENABLED')" :key="c.id" :label="c.name" :value="c.id" /></el-select>
      </el-form-item>
      <el-form-item v-if="tab === 'LEVEL'" label="等级">
        <el-select v-model="form.levelId" filterable style="width: 100%"><el-option v-for="c in options.levels.filter(c => c.status === 'ENABLED')" :key="c.id" :label="c.name" :value="c.id" /></el-select>
      </el-form-item>
      <el-form-item label="单位"><el-input v-model="form.unit" readonly /></el-form-item>
      <el-form-item label="币种"><span>{{ country.currency }}</span></el-form-item>
      <el-form-item label="价格"><el-input-number v-model="form.price" :min="0.01" :precision="2" /></el-form-item>
      <el-form-item label="起订量"><el-input-number v-model="form.minQty" :min="0.0001" :precision="4" /></el-form-item>
      <el-form-item label="税价"><el-select v-model="form.taxMode"><el-option label="含税" value="INCL" /><el-option label="未税" value="EXCL" /></el-select></el-form-item>
      <el-form-item label="生效日" required><el-date-picker v-model="form.effectiveFrom" type="date" value-format="YYYY-MM-DD" /></el-form-item>
      <el-form-item label="结束日"><el-date-picker v-model="form.effectiveTo" type="date" value-format="YYYY-MM-DD" clearable /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="form.visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">保存</el-button>
    </template>
  </el-dialog>
</template>
