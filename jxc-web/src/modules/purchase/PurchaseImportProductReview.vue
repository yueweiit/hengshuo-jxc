<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { http } from '@/api/http'
import type { PurchaseImportModel, ImportRow } from './purchaseImportModel'

const props = defineProps<{ page: PurchaseImportModel }>()
interface Product { id: number; productCode: string; name: string; spec: string; baseUnit: string; status: string; units: { unit: string }[] }
const selectedRow = ref<number | null>(null), keyword = ref(''), products = ref<Product[]>([]), productId = ref<number | null>(null), unit = ref('')
const catalogLoading = ref(false), catalogError = ref(''), catalogLoaded = ref(false), mode = ref('existing')
const fresh = ref({ productCode: '', name: '', baseUnit: '', spec: '' }), choices = ref<Record<number, { key: string; request: Record<string, unknown> }>>({})
const row = computed(() => props.page.state.rows.find(item => item.id === selectedRow.value))
const selectedProduct = computed(() => products.value.find(item => item.id === productId.value))
const readyCount = computed(() => props.page.state.rows.filter(item => item.readiness === 'READY').length)
const pickerLocked = computed(() => props.page.busy() || !!props.page.state.edit || props.page.headerDirty())
const locked = computed(() => pickerLocked.value || !!row.value && props.page.rowLocked(row.value))
let epoch = 0, active = true
function syncRow(value?: ImportRow) {
  productId.value = value?.matchedProductId ?? null; unit.value = value?.purchaseUnit ?? ''; mode.value = 'existing'
  fresh.value = { productCode: '', name: '', baseUnit: '', spec: value?.productSpec || '' }
  if (value?.productOperation) choices.value[value.id] = { key: value.productOperation.key, request: value.productOperation.request }
}
watch(() => selectedRow.value, () => { props.page.clearFeedback(); syncRow(row.value) })
watch(() => props.page.state.rows.map(item => item.id).join(','), () => { if (!props.page.state.rows.some(item => item.id === selectedRow.value)) { selectedRow.value = props.page.state.rows[0]?.id ?? null; syncRow(row.value) } }, { immediate: true })
watch(() => props.page.state.batchId, () => { ++epoch; catalogLoading.value = false; products.value = []; catalogLoaded.value = false; catalogError.value = ''; choices.value = {}; syncRow(row.value) })
async function search() {
  if (catalogLoading.value) return
  const context = ++epoch; catalogLoading.value = true; catalogError.value = ''
  try {
    const result = await http.get<{ records: Product[] }>('/md/products', { keyword: keyword.value.trim(), page: 1, size: 50 }, { silent: true })
    if (!active || context !== epoch) return
    if (!Array.isArray(result.records)) throw new Error('商品目录响应格式不正确')
    products.value = result.records; catalogLoaded.value = true
  } catch (error) { if (active && context === epoch) catalogError.value = error instanceof Error ? error.message : '商品目录读取失败，请重试' }
  finally { if (active && context === epoch) catalogLoading.value = false }
}
async function confirmExisting() {
  if (!row.value || locked.value) return
  if (!productId.value || !unit.value.trim()) { props.page.failure(new Error('请从真实商品目录选择商品并填写采购单位')); return }
  await props.page.decideProduct(row.value, { decision: 'EXISTING', productId: productId.value, unit: unit.value.trim() })
}
async function createNew() {
  const selected = row.value
  if (!selected || locked.value) return
  let intent = choices.value[selected.id]
  if (!intent) {
    if (!fresh.value.productCode.trim() || !fresh.value.name.trim() || !fresh.value.baseUnit.trim()) { props.page.failure(new Error('请完整填写新品编码、名称和基础单位')); return }
    try { await ElMessageBox.confirm('确认新增此商品并在本国启用？此操作建立商品资料，不增加库存。', '确认新增商品', { confirmButtonText: '确认新增', cancelButtonText: '返回核对', type: 'warning' }) }
    catch (error) { if (error !== 'cancel' && error !== 'close') props.page.failure(error); return }
    if (!active || row.value?.id !== selected.id || locked.value) return
    intent = { key: crypto.randomUUID(), request: { version: selected.version, confirmNew: true, product: { ...fresh.value }, unit: fresh.value.baseUnit.trim() } }
    choices.value[selected.id] = intent
  }
  const saved = await props.page.createProduct(selected, intent.request, intent.key)
  if (!saved && !props.page.state.partialResult && ['SYS_BAD_REQUEST', 'SYS_VERSION_CONFLICT', 'PUR_IMPORT_PRODUCT_EXISTS', 'PUR_IMPORT_BATCH_PRODUCT_EXISTS', 'SYS_FORBIDDEN'].includes(props.page.state.errorCode)) delete choices.value[selected.id]
}
onBeforeUnmount(() => { active = false; ++epoch })
</script>

<template>
  <div v-if="page.state.rows.length" class="product-review">
    <div class="review-heading"><h3>商品与单位确认</h3><span>已确认 {{ readyCount }} / {{ page.state.rows.length }} 行</span></div>
    <div class="review-picker"><el-select v-model="selectedRow" filterable aria-label="选择待核对采购行" :disabled="pickerLocked"><el-option v-for="item in page.state.rows" :key="item.id" :value="item.id" :label="`第${item.rowNo}行 · ${item.sourceOrderNo} · ${item.productSpec || '规格待核实'} · ${item.readiness === 'READY' ? '已确认' : item.readiness === 'NEEDS_SETUP' ? '待设置' : '待确认'}`" /></el-select></div>
    <template v-if="row">
      <div class="review-status"><strong>{{ row.readiness === 'READY' ? '商品和单位已确认' : row.readiness === 'NEEDS_SETUP' ? '商品已选定，仍需配置' : '等待人工确认' }}</strong><span v-if="row.matchedProductId">商品 ID：{{ row.matchedProductId }}</span><span v-if="row.purchaseUnit">采购单位：{{ row.purchaseUnit }}</span></div>
      <p v-for="reason in row.setupReasons" :key="reason" class="review-warning">{{ reason }}</p>
      <div class="review-links"><router-link to="/master/products">维护商品与单位</router-link><router-link to="/master/country-skus">设置本国经营</router-link></div>
      <el-radio-group v-model="mode" :disabled="locked"><el-radio-button value="existing">选择已有商品</el-radio-button><el-radio-button value="new">确认新品</el-radio-button></el-radio-group>
      <div v-if="mode === 'existing'" class="existing-review">
        <div class="catalog-search"><el-input v-model="keyword" placeholder="商品编码或名称" aria-label="检索真实商品" :disabled="locked" @keyup.enter="search" /><el-button :loading="catalogLoading" :disabled="locked" @click="search">查询商品</el-button></div>
        <el-alert v-if="catalogError" type="error" :closable="false" :title="catalogError" />
        <p v-if="catalogLoaded && !products.length && !catalogError" class="review-hint">当前检索没有商品，请核对编码、名称和规格。无结果不会自动创建新品。</p>
        <el-select v-model="productId" filterable placeholder="从查询结果选择真实商品" aria-label="已有商品" :disabled="locked"><el-option v-for="item in products" :key="item.id" :value="item.id" :label="`${item.productCode} · ${item.name} · ${item.spec || '规格未填写'}${item.status === 'ENABLED' ? '' : ' · 已停用'}`" /></el-select>
        <el-select v-model="unit" filterable allow-create default-first-option placeholder="选择采购单位，缺少时填写后核对" aria-label="确认采购单位" :disabled="locked"><el-option v-for="item in selectedProduct?.units" :key="item.unit" :value="item.unit" :label="item.unit" /></el-select>
        <el-button type="primary" :disabled="locked" @click="confirmExisting">确认商品与单位</el-button><el-button :disabled="locked" @click="page.decideProduct(row, { decision: 'DEFERRED' })">暂缓本行</el-button>
      </div>
      <div v-else class="new-review">
        <template v-if="choices[row.id] || row.productOperation"><p class="review-hint">已有新品操作，继续处理原请求。已成功建立的商品将保留。</p><el-button type="primary" :disabled="locked || row.readiness === 'READY'" @click="createNew">继续原新品操作</el-button></template>
        <el-form v-else :model="fresh" :disabled="locked" label-width="90px" @submit.prevent>
          <el-form-item label="商品编码" required><el-input v-model="fresh.productCode" /></el-form-item><el-form-item label="商品名称" required><el-input v-model="fresh.name" /></el-form-item><el-form-item label="基础单位" required><el-input v-model="fresh.baseUnit" /></el-form-item><el-form-item label="商品规格"><el-input v-model="fresh.spec" /></el-form-item><el-button type="primary" @click="createNew">核对并确认新增</el-button>
        </el-form>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.product-review { margin-top: 20px; border-top: 1px solid var(--el-border-color-light); padding-top: 18px; }
.review-heading { display: flex; gap: 16px; align-items: baseline; margin-bottom: 14px; h3 { margin: 0; font-size: 15px; } span { color: var(--el-text-color-secondary); font-size: 12px; } }
.review-picker .el-select { width: 100%; max-width: 760px; }
.review-status, .review-links { display: flex; flex-wrap: wrap; gap: 16px; margin: 12px 0; font-size: 13px; }
.review-warning { color: var(--el-color-warning-dark-2); font-size: 13px; }
.existing-review { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; align-items: center; > .el-select { width: 380px; } > .el-input { width: 240px; } }
.catalog-search { width: 100%; display: flex; gap: 12px; .el-input { max-width: 420px; } }
.review-hint { color: var(--el-text-color-secondary); font-size: 13px; line-height: 22px; }
.new-review { max-width: 600px; margin-top: 18px; }
</style>
