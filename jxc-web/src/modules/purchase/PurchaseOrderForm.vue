<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
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
  productCode?: string
  name?: string
  spec?: string
  categoryId?: number
  status?: string
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
const user = useUserStore()
const visible = ref(false)
const books = ref<Record<string, any>[]>([])
const saving = ref(false)
const formRef = ref<FormInstance>()
const skus = ref<Sku[]>([])
const suppliers = ref<{ id: number; settleCurrency: string; paymentTerms: string }[]>([])
const model = reactive<OrderModel>({ lines: [] })
const categories = ref<{ id: number; name: string }[]>([])
const entry = reactive({ step: 1, keyword: '', categoryId: undefined as number | undefined, onlyFilled: false, quantities: {} as Record<number, string>, error: '', errorProductId: undefined as number | undefined })
const scope = () => JSON.stringify([country.currentId, country.epoch, user.token])
let openRequest = 0, formScope = ''

const isEdit = computed(() => !!model.id)
const isConfirmedEdit = computed(() => model.status === 'CONFIRMED')

async function loadRefs(current: () => boolean = () => true) {
  const [s, p, c] = await Promise.all([
    allRecords<Sku>('/md/country-skus', { enabled: 'true' }),
    allRecords<{ id: number; settleCurrency: string; paymentTerms: string }>('/md/partners', { partnerType: 'SUPPLIER', status: 'ENABLED' }),
    allRecords<{ id: number; name: string }>('/md/categories'),
  ])
  if (!current()) return
  skus.value = s
  suppliers.value = p
  categories.value = c
}

async function open(id?: number) {
  const request = ++openRequest, context = scope()
  visible.value = false
  const current = () => request === openRequest && context === scope()
  await loadRefs(current)
  if (!current()) return
  supplyCommandIntent.reset()
  const availableBooks = await http.get<Record<string, any>[]>('/org/books')
  if (request !== openRequest || context !== scope()) return
  books.value = availableBooks
  if (id) {
    const o = await http.get<OrderModel>(`/pur/orders/${id}`)
    if (request !== openRequest || context !== scope()) return
    Object.assign(model, {
      ...o,
      lines: o.lines.map((l) => ({ productId: l.productId, unit: l.unit, qty: l.qty, unitPrice: l.unitPrice, taxRate: l.taxRate, deliveryDate: l.deliveryDate })),
    })
  } else {
    for (const k of Object.keys(model)) delete (model as unknown as Record<string, unknown>)[k]
    Object.assign(model, { orderDate: todayIn(country.timezone), currency: undefined, prepayRatio: 0, lines: [{ taxRate: 0.13 }] })
  }
  Object.assign(entry, { step: 1, keyword: '', categoryId: undefined, onlyFilled: false, quantities: {}, error: '', errorProductId: undefined })
  formScope = context
  saving.value = false
  visible.value = true
}

watch(scope, () => { ++openRequest; visible.value = false; saving.value = false }, { flush: 'sync' })

const validQuantity = (value: unknown) => /^\d+(\.\d{1,4})?$/.test(String(value)) && Number.isFinite(Number(value)) && Number(value) <= 999999999999
function catalogRows() {
  const keyword = entry.keyword.trim().toLocaleLowerCase()
  return skus.value.filter(s => s.status !== 'DISABLED' && (!keyword || [s.productCode, s.name, s.label, s.spec].some(value => value?.toLocaleLowerCase().includes(keyword))) && (!entry.categoryId || s.categoryId === entry.categoryId) && (!entry.onlyFilled || validQuantity(entry.quantities[s.productId]) && Number(entry.quantities[s.productId]) > 0))
}
function entryError(message: string, field: string, productId?: number) {
  entry.error = message; entry.errorProductId = productId
  ElMessage.warning(message)
  if (typeof document !== 'undefined') requestAnimationFrame(() => {
    const control = document.querySelector<HTMLElement>(`.purchase-entry [data-entry-field="${field}"]${productId ? `[data-product="${productId}"]` : ''}`)
    const input = control?.querySelector<HTMLElement>('input,textarea') ?? control
    input?.focus(); input?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
  return false
}
function validateEntry() {
  entry.error = ''
  if (!model.bookId || !books.value.some(book => book.id === model.bookId)) return entryError('请选择有效账套', 'book')
  if (!model.supplierId) return entryError('请选择供应商', 'supplier')
  if (!model.currency || !model.orderDate) return entryError('请填写币种和下单日期', !model.currency ? 'currency' : 'date')
  if (model.prepayRatio != null && (!Number.isFinite(model.prepayRatio) || model.prepayRatio < 0 || model.prepayRatio > 1)) return entryError('预付比例应为 0 至 1', 'prepay')
  if (!model.lines.length) return entryError('至少需要一行商品与数量', 'qty')
  for (const line of model.lines) {
    if (!line.productId || !validQuantity(line.qty) || Number(line.qty) <= 0) return entryError('请填写大于 0 的数量，最多 4 位小数', 'qty', line.productId)
    if (!line.unit || !skuOf(line.productId)?.units.some(unit => unit.unit === line.unit)) return entryError('请选择已配置的采购单位', 'unit', line.productId)
    if (typeof line.unitPrice !== 'number' || !Number.isFinite(line.unitPrice) || line.unitPrice < 0) return entryError('请填写每行采购单价；未知价格不能按零保存', 'price', line.productId)
    if (line.taxRate != null && (!Number.isFinite(line.taxRate) || line.taxRate < 0 || line.taxRate > 1)) return entryError('税率应为 0 至 1', 'tax', line.productId)
  }
  return true
}
async function nextEntry() {
  entry.error = ''; entry.errorProductId = undefined
  if (entry.step === 1) {
    const invalid = skus.value.find(s => entry.quantities[s.productId]?.trim() && !validQuantity(entry.quantities[s.productId]))
    if (invalid) { entry.keyword = ''; entry.categoryId = undefined; entry.onlyFilled = false; return entryError('请填写有效数量，最多 4 位小数', 'qty', invalid.productId) }
    const selected = skus.value.filter(s => s.status !== 'DISABLED' && Number(entry.quantities[s.productId]) > 0)
    if (!selected.length) return entryError('请至少为一种商品填写数量', 'qty')
    const previous = new Map(model.lines.map(line => [line.productId, line]))
    model.lines = selected.map(s => ({ ...previous.get(s.productId), productId: s.productId, unit: previous.get(s.productId)?.unit ?? s.units.find(unit => unit.isPurchaseDefault)?.unit ?? s.baseUnit, qty: Number(entry.quantities[s.productId]), taxRate: previous.get(s.productId)?.taxRate ?? 0.13 }))
    entry.step = 2
  } else if (validateEntry()) entry.step = 3
}
function backEntry() {
  entry.error = ''
  if (entry.step === 2) for (const line of model.lines) if (line.productId) entry.quantities[line.productId] = line.qty == null ? '' : String(line.qty)
  entry.step = Math.max(1, entry.step - 1)
}
function removeEntryLine(index: number) {
  const line = model.lines[index]
  if (line?.productId) entry.quantities[line.productId] = ''
  model.lines.splice(index, 1)
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

function payload(submit: boolean) {
  return { ...model, version: model.version, submit, lines: model.lines.filter((l) => l.productId) }
}

async function save(submit: boolean) {
  if (saving.value) return
  if (!visible.value || formScope !== scope()) return ElMessage.warning('国家或登录状态已切换，请重新打开表单')
  const request = openRequest, context = formScope
  const current = () => request === openRequest && context === scope()
  saving.value = true
  try {
    if (!isEdit.value && !validateEntry()) { entry.step = 2; return }
    await formRef.value?.validate()
    if (!current() || !visible.value) return
    if (!model.lines.some((l) => l.productId && l.qty)) return ElMessage.warning('至少需要一行商品与数量')
    if (model.lines.some((l) => l.productId && (typeof l.unitPrice !== 'number' || !Number.isFinite(l.unitPrice)))) return ElMessage.warning('请填写每行采购单价；未知价格不能按零保存')
    let res: { id: number; status: string; needResubmit?: boolean; approvalMessage?: string }
    if (isEdit.value) {
      res = await http.put(`/pur/orders/${model.id}`, payload(false))
      if (!current() || !visible.value) return
      if (res.needResubmit) {
        await ElMessageBox.alert('供应商、数量、单价或付款条件已修改，原审批失效，采购单已退回草稿，请重新提交。', '需要重新审批', { type: 'warning' })
      }
      if (submit && res.status === 'DRAFT' && current() && visible.value) res = await http.postIdem(`/pur/orders/${model.id}/submit`, undefined, supplyCommandIntent)
    } else {
      res = await http.postIdem('/pur/orders', payload(submit), supplyCommandIntent)
    }
    if (!current() || !visible.value) return
    ElMessage.success(res.approvalMessage ?? '已保存')
    visible.value = false
    emit('saved', res)
  } finally {
    if (current()) saving.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <el-dialog v-model="visible" :title="isEdit ? '编辑采购单' : '新建采购单'" width="1180px" append-to-body destroy-on-close class="crud-dialog purchase-entry">
    <el-steps v-if="!isEdit" :active="entry.step - 1" align-center class="entry-steps"><el-step title="选择商品" /><el-step title="复核明细" /><el-step title="备注与提交" /></el-steps>
    <el-alert v-if="entry.error" :title="entry.error" type="error" :closable="false" show-icon class="mb" />
    <section v-if="!isEdit && entry.step === 1" class="catalog">
      <div class="catalog-filters">
        <el-input v-model="entry.keyword" clearable placeholder="商品编码 / 名称 / 规格" aria-label="商品关键词" />
        <el-select v-model="entry.categoryId" clearable placeholder="全部分类" aria-label="商品分类"><el-option v-for="c in categories" :key="c.id" :value="c.id" :label="c.name" /></el-select>
        <el-select v-model="entry.onlyFilled" aria-label="商品范围"><el-option :value="false" label="全部商品" /><el-option :value="true" label="已填数量" /></el-select>
        <el-button @click="entry.keyword = ''; entry.categoryId = undefined; entry.onlyFilled = false">重置筛选</el-button>
      </div>
      <p class="muted">直接填写采购数量，大于 0 的商品进入复核；空白或 0 不加入。</p>
      <el-table :data="catalogRows()" row-key="productId" border max-height="440" class="catalog-table">
        <el-table-column label="商品" min-width="240"><template #default="{ row }"><b>{{ row.name || row.label }}</b><div class="muted">{{ row.productCode }}</div></template></el-table-column>
        <el-table-column prop="spec" label="规格" min-width="140" />
        <el-table-column label="分类" min-width="140"><template #default="{ row }">{{ categories.find(c => c.id === row.categoryId)?.name || '未分类' }}</template></el-table-column>
        <el-table-column label="采购单位" width="110"><template #default="{ row }">{{ row.units.find((u: { isPurchaseDefault: boolean }) => u.isPurchaseDefault)?.unit || row.baseUnit }}</template></el-table-column>
        <el-table-column label="数量" width="150" align="right"><template #default="{ row }"><el-input v-model="entry.quantities[row.productId]" :data-product="row.productId" data-entry-field="qty" inputmode="decimal" placeholder="数量" :aria-label="`${row.name || row.label} 数量`" /></template></el-table-column>
      </el-table>
    </section>
    <el-alert
      v-if="isConfirmedEdit"
      type="warning"
      :closable="false"
      show-icon
      title="这是已确认的采购单：修改供应商、数量、单价或付款条件会使原审批失效，单据退回草稿后需要重新提交。"
      class="mb"
    />
    <el-form v-show="isEdit || entry.step === 2" ref="formRef" :model="model" :disabled="saving" label-width="96px">
      <el-row :gutter="12">
        <el-col :xs="24" :span="8"><el-form-item label="账套" prop="bookId" :rules="[{ required: true, message: '请选择账套' }]"><el-select v-model="model.bookId" data-entry-field="book" :disabled="isEdit" placeholder="请选择账套"><el-option v-for="b in books" :key="b.id" :label="b.name + ' · ' + b.baseCurrency" :value="b.id" /></el-select></el-form-item></el-col>
        <el-col :xs="24" :span="8">
          <el-form-item label="供应商" prop="supplierId" :rules="[{ required: true, message: '请选择供应商' }]">
            <div data-entry-field="supplier" style="width: 100%"><FieldInput v-model="model.supplierId" :field="{ prop: 'supplierId', label: '供应商', type: 'select', options: SUPPLIER_SOURCE }" @update:model-value="onSupplierChange" /></div>
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="4">
          <el-form-item label="币种" prop="currency" :rules="[{ required: true, message: '请选择币种' }]">
            <div data-entry-field="currency" style="width: 100%"><FieldInput v-model="model.currency" :field="{ prop: 'currency', label: '币种', type: 'select', options: CURRENCY_SOURCE }" /></div>
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="6">
          <el-form-item label="下单日期" prop="orderDate">
            <el-date-picker v-model="model.orderDate" data-entry-field="date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
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
            <el-input-number v-model="model.prepayRatio" data-entry-field="prepay" :min="0" :max="1" :step="0.01" :precision="6" controls-position="right" style="width: 100%" /><span class="muted">0～1，例如 0.3 表示 30%</span>
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="6">
          <el-form-item label="账期天数">
            <el-input-number v-model="model.termDays" :min="0" controls-position="right" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col v-if="isEdit" :span="24">
          <el-form-item label="备注"><el-input v-model="model.remark" /></el-form-item>
        </el-col>
      </el-row>
    </el-form>

    <div v-show="isEdit || entry.step === 2" class="table-scroll">
      <el-table :data="model.lines" border size="small">
        <el-table-column type="index" label="#" width="44" />
        <el-table-column label="商品" min-width="220">
          <template #default="{ row }">
            <el-select v-if="isEdit" v-model="row.productId" filterable placeholder="选择本国启用的 SKU" style="width: 100%" @change="onProductChange(row)">
              <el-option v-for="s in skus" :key="s.productId" :label="s.label" :value="s.productId" />
            </el-select>
            <template v-else><b>{{ skuOf(row.productId)?.name || skuOf(row.productId)?.label }}</b><div class="muted">{{ skuOf(row.productId)?.productCode }} · {{ skuOf(row.productId)?.spec }}</div></template>
          </template>
        </el-table-column>
        <el-table-column label="单位" width="110">
          <template #default="{ row }">
            <el-select v-model="row.unit" data-entry-field="unit" :data-product="row.productId" style="width: 100%">
              <el-option v-for="u in skuOf(row.productId)?.units ?? []" :key="u.unit" :label="`${u.unit}（×${u.factorToBase}）`" :value="u.unit" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="120">
          <template #default="{ row }"><el-input-number v-model="row.qty" data-entry-field="qty" :data-product="row.productId" :min="0" :precision="4" :controls="false" style="width: 100%" /></template>
        </el-table-column>
        <el-table-column label="基本单位数量" width="110" align="right">
          <template #default="{ row }"><span class="mono">{{ (row.qty ?? 0) * factorOf(row) }}</span></template>
        </el-table-column>
        <el-table-column :label="`单价（${model.currency ?? ''}）`" width="130">
          <template #default="{ row }"><el-input-number v-model="row.unitPrice" data-entry-field="price" :data-product="row.productId" placeholder="请填写" :min="0" :precision="4" :controls="false" style="width: 100%" /></template>
        </el-table-column>
        <el-table-column label="税率" width="90">
          <template #default="{ row }"><el-input-number v-model="row.taxRate" data-entry-field="tax" :data-product="row.productId" :min="0" :max="1" :step="0.01" :precision="6" :controls="false" style="width: 100%" /></template>
        </el-table-column>
        <el-table-column label="金额" width="140" align="right">
          <template #default="{ row }"><MoneyText :value="lineAmount(row)" :currency="model.currency" /></template>
        </el-table-column>
        <el-table-column label="交货日期" width="150">
          <template #default="{ row }"><el-date-picker v-model="row.deliveryDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></template>
        </el-table-column>
        <el-table-column width="60">
          <template #default="{ $index }">
            <el-button link type="danger" :disabled="isEdit && model.lines.length <= 1" @click="removeEntryLine($index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>
    <div v-show="isEdit || entry.step === 2" class="foot">
      <el-button v-if="isEdit" link type="primary" @click="model.lines.push({ taxRate: 0.13 })"><el-icon><Plus /></el-icon>添加一行</el-button>
      <span>本单 {{ model.lines.length }} 种商品 · 合计 <MoneyText :value="total" :currency="model.currency" /></span>
    </div>
    <section v-if="!isEdit && entry.step === 3" class="entry-notes"><p>已复核 {{ model.lines.length }} 种商品 · 合计 <MoneyText :value="total" :currency="model.currency" /></p><el-input v-model="model.remark" type="textarea" :rows="4" placeholder="填写订单备注（可选）" aria-label="订单备注" /><p class="muted">保存草稿可继续修改；保存并提交后按当前审批规则处理。</p></section>

    <template #footer>
      <el-button :disabled="saving" @click="visible = false">取消</el-button>
      <el-button v-if="!isEdit && entry.step > 1" :disabled="saving" @click="backEntry">{{ entry.step === 2 ? '返回商品目录' : '返回复核' }}</el-button>
      <el-button v-if="!isEdit && entry.step < 3" type="primary" @click="nextEntry">{{ entry.step === 1 ? '确认采购单' : '下一步：备注' }}</el-button>
      <template v-else><el-button :loading="saving" @click="save(false)">保存草稿</el-button><el-button type="primary" :loading="saving" @click="save(true)">保存并提交</el-button></template>
    </template>
  </el-dialog>
</template>

<style scoped>
.mb {
  margin-bottom: 12px;
}
.entry-steps { margin: 8px 0 24px; }
.catalog-filters { display: grid; grid-template-columns: minmax(180px, 2fr) 1fr 1fr auto; gap: 12px; }
.catalog-table :deep(.el-input__inner) { text-align: right; }
.catalog-table :deep(th), .catalog-table :deep(td) { padding: 12px 0; }
.entry-notes { min-height: 260px; }
@media (max-width: 640px) { .catalog-filters { grid-template-columns: 1fr 1fr; } .catalog-filters > :first-child { grid-column: 1 / -1; } }

.foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 8px 0;
}
</style>
