<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Loading } from '@element-plus/icons-vue'
import { http } from '@/api/http'
import { useCountryStore } from '@/stores/country'
import type { PurchaseImportModel, ImportRow, MatchCandidate, VisualMatchEvidence } from './purchaseImportModel'
import { createPurchaseImportCatalogImages } from './purchaseImportCatalogImages'
import PurchaseImportProductPhoto from './PurchaseImportProductPhoto.vue'

const props = defineProps<{ page: PurchaseImportModel; modelValue: boolean; rowId?: number | null; initialTab?: 'todos' | 'match' }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
interface Product { id: number; productCode: string; name: string; spec: string; baseUnit: string; status: string; units: { unit: string }[] }
type ReviewTab = 'todos' | 'product' | 'images' | 'match'
interface ReviewTodo { key: string; row: ImportRow; reason: string; tab: ReviewTab; imageId?: number }
const country = useCountryStore()
const photoScope = computed(() => props.page.state.batchId && country.currentId ? `${country.currentId}:${props.page.state.batchId}` : null)
const catalogImages = createPurchaseImportCatalogImages(
  (id, signal) => http.get(`/md/products/${id}/images`, undefined, { signal, silent: true }),
  (id, signal) => http.attachmentBlob(`/api/v1/md/product-images/${id}/content`, { signal, silent: true }),
  () => photoScope.value,
)
watch(photoScope, () => catalogImages.reset())
const activeTab = ref<ReviewTab>('todos'), focusedImage = ref<number | null>(null)
const matchEnabled = ref(false), capabilityError = ref(''), candidateRun = ref<string | null>(null), candidateProduct = ref<MatchCandidate['product'] | null>(null)
const manualCandidate = ref(false), showCached = ref(false)
const matchInputs = ref({ suppliedProductCode: '', suppliedProductName: '', supplierProductCode: '' })
const selectedRow = ref<number | null>(null), keyword = ref(''), products = ref<Product[]>([]), productId = ref<number | null>(null), unit = ref('')
const catalogLoading = ref(false), catalogError = ref(''), catalogLoaded = ref(false), mode = ref('existing')
const fresh = ref({ productCode: '', name: '', baseUnit: '', spec: '' }), choices = ref<Record<number, { key: string; request: Record<string, unknown> }>>({})
type NewProduct = typeof fresh.value
const newDrafts = new Map<number, { values: NewProduct; source: NewProduct }>()
let freshRow: number | null = null, freshSource: NewProduct = { ...fresh.value }
const row = computed(() => props.page.state.rows.find(item => item.id === selectedRow.value))
const selectedProduct = computed(() => candidateProduct.value?.id === productId.value ? candidateProduct.value : products.value.find(item => item.id === productId.value))
const { urls:imageUrls, errors:imageErrors, loading:imageLoading } = props.page.images
const readyCount = computed(() => props.page.state.rows.filter(item => item.readiness === 'READY').length)
const todoItems = computed(() => props.page.state.rows.flatMap(item => {
  const todos: ReviewTodo[] = []
  if (item.readiness !== 'READY') {
    const reasons = item.setupReasons?.length ? [...new Set(item.setupReasons)] : [item.readiness === 'NEEDS_SETUP' ? '商品配置待核实，请重新核对' : item.decision === 'DEFERRED' ? '本行已暂缓，商品与采购单位仍待确认' : '商品与采购单位待确认']
    reasons.forEach((reason, index) => todos.push({ key: `${item.id}-product-${index}`, row: item, reason, tab: 'product' }))
    if (item.matchResult) {
      const stale = !isCurrentMatch(item)
      if (item.matchResult.status === 'FAILED' || stale) todos.push({ key: `${item.id}-match`, row: item, reason: stale ? '候选结果已过期，可重新识别或继续人工核对' : '候选识别失败，可查看原因或继续人工核对', tab: 'match' })
    }
  }
  for (const image of item.images ?? []) if (image.status === 'UNCONFIRMED') todos.push({ key: `${item.id}-image-${image.id}`, row: item, reason: '原图归属待确认', tab: 'images', imageId: image.id })
  return todos
}))
const todoRowCount = computed(() => new Set(todoItems.value.map(item => item.row.id)).size)
const needsProductSetup = computed(() => row.value?.setupReasons?.some(reason => ['全局商品已停用', '商品未配置所选单位换算'].includes(reason)) === true)
const needsCountrySetup = computed(() => row.value?.setupReasons?.some(reason => ['商品尚未在本国启用', '全局商品已保存，等待本国启用'].includes(reason)) === true)
const pickerLocked = computed(() => props.page.busy() || !!props.page.state.edit || props.page.headerDirty())
const locked = computed(() => pickerLocked.value || !!row.value && props.page.rowLocked(row.value))
const inputsDirty = computed(() => !!row.value && ['suppliedProductCode', 'suppliedProductName', 'supplierProductCode'].some(key => (matchInputs.value[key as keyof typeof matchInputs.value].trim() || null) !== (row.value![key as keyof ImportRow] || null)))
function isCurrentMatch(item: ImportRow) { return !!item.matchResult && item.matchResult.inputRevision === item.version && item.matchResult.runId === item.matchTaskId }
const currentMatch = computed(() => !!row.value && isCurrentMatch(row.value))
const recommendedCandidates = computed(() => currentMatch.value ? row.value!.matchResult!.candidates.filter(candidate => row.value!.matchResult!.ranking?.recommendedIds.includes(candidate.productId)) : [])
const cachedCandidates = computed(() => (row.value?.matchResult?.candidates ?? []).filter(candidate => !recommendedCandidates.value.some(item => item.productId === candidate.productId)))
const candidateGroups = computed(() => [
  { title: '推荐候选', manual: false, candidates: recommendedCandidates.value },
  { title: '缓存候选 · 待人工核对', manual: true, candidates: showCached.value ? cachedCandidates.value : [] },
].filter(group => group.candidates.length))
const candidateScore = (id: number) => row.value?.matchResult?.ranking?.scores.find(score => score.productId === id)
const percent = (value: number | null | undefined) => value == null ? '无可比较数据' : `${(value * 100).toFixed(2)}%`
const productOptions = computed(() => {
  const options = new Map<number, { product: MatchCandidate['product']; candidate?: MatchCandidate; manual?: boolean }>()
  for (const candidate of recommendedCandidates.value) options.set(candidate.productId, { product: candidate.product, candidate })
  if (manualCandidate.value && candidateProduct.value) options.set(candidateProduct.value.id, { product: candidateProduct.value, candidate: row.value?.matchResult?.candidates.find(item => item.productId === candidateProduct.value!.id), manual: true })
  for (const product of products.value) if (!options.has(product.id)) options.set(product.id, { product })
  return [...options.values()]
})
const selectedCandidate = computed(() => currentMatch.value ? row.value?.matchResult?.candidates.find(candidate => candidate.productId === productId.value) : undefined)
function bestVisual(candidate: MatchCandidate) { return candidate.visualEvidence.reduce<VisualMatchEvidence | undefined>((best, evidence) => !best || evidence.score > best.score ? evidence : best, undefined) }
const sourceImages = computed(() => row.value?.images?.filter(image => image.status !== 'REJECTED') ?? [])
let epoch = 0, active = true
watch(() => props.rowId, id => { if (id) selectedRow.value = id })
watch(() => props.modelValue, opened => {
  if (opened) { activeTab.value = props.initialTab ?? 'todos'; focusedImage.value = null; if (props.rowId && props.page.state.rows.some(item => item.id === props.rowId)) selectedRow.value = props.rowId }
}, { immediate: true })
watch(() => [props.modelValue,activeTab.value,row.value?.id,row.value?.version], () => {
  if (props.modelValue && activeTab.value !== 'todos') for (const image of (activeTab.value === 'images' ? row.value?.images ?? [] : sourceImages.value)) void props.page.images.load(image.id)
})
function openTodo(todo: ReviewTodo) {
  if (pickerLocked.value) return
  selectedRow.value = todo.row.id; activeTab.value = todo.tab; focusedImage.value = todo.imageId ?? null
}
function syncRow(value?: ImportRow) {
  if (freshRow !== null) newDrafts.set(freshRow, { values: { ...fresh.value }, source: freshSource })
  candidateRun.value = null; candidateProduct.value = null; manualCandidate.value = false
  matchInputs.value = { suppliedProductCode: value?.suppliedProductCode || '', suppliedProductName: value?.suppliedProductName || '', supplierProductCode: value?.supplierProductCode || '' }
  productId.value = value?.matchedProductId ?? null; unit.value = value?.purchaseUnit ?? ''; mode.value = 'existing'
  const source: NewProduct = { productCode: value?.suppliedProductCode ?? '', name: value?.suppliedProductName ?? '', baseUnit: '', spec: value?.productSpec ?? '' }
  const draft = value ? newDrafts.get(value.id) : undefined
  fresh.value = { ...source }
  if (draft) for (const key of Object.keys(source) as (keyof NewProduct)[]) if (draft.values[key] !== draft.source[key]) fresh.value[key] = draft.values[key]
  freshRow = value?.id ?? null; freshSource = source
  if (value?.productOperation) choices.value[value.id] = { key: value.productOperation.key, request: value.productOperation.request }
}
watch(() => row.value?.version, () => syncRow(row.value))
watch(() => selectedRow.value, () => { props.page.clearFeedback(); showCached.value = false; syncRow(row.value) })
watch(() => props.page.state.rows.map(item => item.id).join(','), () => { if (!props.page.state.rows.some(item => item.id === selectedRow.value)) { selectedRow.value = props.page.state.rows[0]?.id ?? null; syncRow(row.value) } }, { immediate: true })
watch(() => props.page.state.batchId, () => { ++epoch; catalogLoading.value = false; products.value = []; catalogLoaded.value = false; catalogError.value = ''; choices.value = {}; newDrafts.clear(); freshRow = null; syncRow(row.value) })
watch(() => props.page.state.batchId, async () => {
  const context = epoch; matchEnabled.value = false; capabilityError.value = ''
  try { const result = await http.get<{ recognitionEnabled: boolean }>('/pur/order-imports/capabilities', undefined, { silent: true }); if (active && context === epoch) { if (typeof result.recognitionEnabled !== 'boolean') throw new Error('候选识别开关响应不完整'); matchEnabled.value = result.recognitionEnabled } }
  catch (error) { if (active && context === epoch) capabilityError.value = error instanceof Error ? error.message : '候选识别状态读取失败' }
}, { immediate: true })
function chooseCandidate(candidate: MatchCandidate, manual = false) {
  if (!row.value || !currentMatch.value || locked.value) return
  if (!manual && !recommendedCandidates.value.some(item => item.productId === candidate.productId)) return
  manualCandidate.value = manual
  candidateProduct.value = candidate.product; productId.value = candidate.productId; candidateRun.value = row.value.matchResult!.runId; activeTab.value = 'product'
}
function manualSelection() {
  const candidate = currentMatch.value ? row.value?.matchResult?.candidates.find(item => item.productId === productId.value) : undefined
  if (candidate) chooseCandidate(candidate, !recommendedCandidates.value.some(item => item.productId === candidate.productId))
  else { candidateRun.value = null; candidateProduct.value = null; manualCandidate.value = false }
}
async function saveInputs() {
  const selected = row.value, batch = props.page.state.batchId
  if (!selected || !await props.page.saveMatchInputs(selected, { ...matchInputs.value })) return
  if (batch !== props.page.state.batchId) return
  if (row.value?.id === selected.id) syncRow(row.value)
  if (selected.matchResult?.candidates.length && props.page.state.rows.some(item => item.id === selected.id)) {
    if (!await props.page.startMatches([selected.id])) props.page.failure(new Error('补充文字已保存，候选重算未完成，请重新核对本行'))
  }
}
const imageCheckLabel = (status: string) => ({ SAME: '照片同款', DIFFERENT: '照片不同款', UNCERTAIN: '照片尚不能确定', NO_INPUT: '缺少可用配对图' }[status] || status)
const specCheckLabel = (status: string) => ({ MATCH: '规格一致', CONFLICT: '规格冲突', MISSING: '规格缺失', NOT_CHECKED: '尚未核对规格' }[status] || status)
const candidateCheck = (productId: number) => row.value?.matchResult?.explanation.candidateChecks?.find(check => check.productId === productId)
const routeLabel = (status: string) => ({ FOUND: '已找到候选', NOT_FOUND: '未查到', NO_INPUT: '无输入', UNAVAILABLE: '暂不可用', FAILED: '执行失败' }[status] || status)
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
  await props.page.decideProduct(row.value, { decision: 'EXISTING', productId: productId.value, unit: unit.value.trim(), ...(candidateRun.value ? { runId: candidateRun.value, ...(manualCandidate.value ? { confirmCandidate: true } : {}) } : {}) })
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
onBeforeUnmount(() => { active = false; ++epoch; catalogImages.reset() })
</script>

<template>
  <el-dialog :model-value="modelValue" title="核对商品与原图" width="min(1100px, 94vw)" append-to-body @update:model-value="emit('update:modelValue', $event)">
    <div v-if="page.state.rows.length" class="product-review">
      <el-alert v-if="page.state.error" :title="page.state.error" type="error" :closable="false" />
      <div class="review-heading"><h3>导入核对</h3><span>商品与单位已确认 {{ readyCount }} / {{ page.state.rows.length }} 行</span></div>
      <div v-if="activeTab !== 'todos'" class="review-context">
        <div class="review-picker"><el-select v-model="selectedRow" filterable aria-label="选择待核对采购行" :disabled="pickerLocked"><el-option v-for="item in page.state.rows" :key="item.id" :value="item.id" :label="`第${item.rowNo}行 · ${item.sourceOrderNo} · ${item.productSpec || '规格待核实'} · ${item.readiness === 'READY' ? '已确认' : item.readiness === 'NEEDS_SETUP' ? '待设置' : '待确认'}`" /></el-select></div>
        <p v-if="row">来源：{{ row.sourceSheet || '来源表待核实' }} 原第{{ row.sourceRow ?? '待核实' }}行 · 数量格 {{ row.sourceItemKey || '原行' }} · 采购数量 {{ row.purchaseQty }} · 原采购单价 {{ row.purchaseUnitPrice }}</p>
      </div>
      <el-tabs v-model="activeTab" class="review-tabs">
        <el-tab-pane label="待确认事项" name="todos">
          <div class="todo-summary" role="status">待处理 {{ todoRowCount }} 行，共 {{ todoItems.length }} 项待办</div>
          <p class="review-hint">按事项进入对应标签页处理，确认成功后这里会更新。原图归属与商品就绪状态分别核对。</p>
          <el-table v-if="todoItems.length" :data="todoItems" row-key="key" max-height="400" class="review-todos" aria-label="待确认事项列表">
            <el-table-column label="采购行" min-width="190"><template #default="{ row: item }"><strong>第{{ item.row.rowNo }}行 · {{ item.row.sourceOrderNo }}</strong><div class="review-hint">{{ item.row.productSpec || '规格待核实' }}</div></template></el-table-column>
            <el-table-column prop="reason" label="待处理事项" min-width="240" />
            <el-table-column label="操作" width="130"><template #default="{ row: item }"><el-button link type="primary" :disabled="pickerLocked" :aria-label="`处理第${item.row.rowNo}行：${item.reason}`" @click="openTodo(item)">去处理</el-button></template></el-table-column>
          </el-table>
          <el-empty v-else description="当前没有待确认事项" :image-size="70" />
          <div class="todo-shortcuts"><span class="review-hint">也可直接进入：</span><el-button @click="activeTab = 'product'">商品与单位</el-button><el-button @click="activeTab = 'images'">原图核对</el-button><el-button @click="activeTab = 'match'">辅助识别</el-button></div>
        </el-tab-pane>
        <el-tab-pane label="商品与单位" name="product">
          <template v-if="row">
      <div v-if="activeTab === 'product'" class="product-source-photos">
        <span class="review-hint">本行导入原图</span>
        <div v-for="(image, index) in sourceImages" :key="image.id" class="source-photo">
          <el-image v-if="imageUrls[image.id]" :src="imageUrls[image.id]" :preview-src-list="[imageUrls[image.id]!]" preview-teleported fit="contain" :alt="`本行导入原图${index + 1}`" />
          <span v-else class="review-hint">{{ imageErrors[image.id] || (imageLoading[image.id] ? '原图加载中' : '原图待加载') }}</span>
          <el-button v-if="imageErrors[image.id]" link type="primary" @click="page.images.load(image.id)">重试加载原图</el-button>
        </div>
        <span v-if="!sourceImages.length" class="review-hint">本行没有可用原图</span>
      </div>
      <div class="review-status"><strong>{{ row.readiness === 'READY' ? '商品和单位已确认' : row.readiness === 'NEEDS_SETUP' ? '商品已选定，仍需配置' : '等待人工确认' }}</strong><span v-if="row.matchedProductId">商品 ID：{{ row.matchedProductId }}</span><span v-if="row.purchaseUnit">采购单位：{{ row.purchaseUnit }}</span></div>
      <p v-for="reason in row.setupReasons" :key="reason" class="review-warning">{{ reason }}</p>
      <div v-if="needsProductSetup || needsCountrySetup" class="review-links">
        <router-link v-if="needsProductSetup" to="/master/products" target="_blank" rel="noopener">商品资料与单位换算</router-link>
        <router-link v-if="needsCountrySetup" to="/master/country-skus" target="_blank" rel="noopener">在{{ country.current?.name || '当前国家' }}启用商品</router-link>
        <span class="review-hint">配置完成后，返回这里重新核对商品与单位。</span>
      </div>
      <el-radio-group v-model="mode" :disabled="locked"><el-radio-button value="existing">选择已有商品</el-radio-button><el-radio-button value="new">确认新品</el-radio-button></el-radio-group>
      <div v-if="mode === 'existing'" class="existing-review">
        <div class="catalog-search"><el-input v-model="keyword" placeholder="商品编码或名称" aria-label="检索真实商品" :disabled="locked" @keyup.enter="search" /><el-button :loading="catalogLoading" :disabled="locked" @click="search">查询商品</el-button></div>
        <el-alert v-if="catalogError" type="error" :closable="false" :title="catalogError" />
        <p v-if="catalogLoaded && !products.length && !catalogError" class="review-hint">当前检索没有商品，请核对编码、名称和规格。无结果不会自动创建新品。</p>
        <el-select v-model="productId" filterable placeholder="从识别候选或查询结果选择商品" aria-label="已有商品" :disabled="locked" @change="manualSelection">
          <el-option v-for="item in productOptions" :key="item.product.id" :value="item.product.id" :label="`${item.product.productCode} · ${item.product.name} · ${item.product.spec || '规格未填写'}`" class="review-product-option">
            <PurchaseImportProductPhoto :catalog="catalogImages" :image-id="item.candidate ? bestVisual(item.candidate)?.imageId : undefined" :product-id="item.product.id" :label="`${item.product.name}照片`" compact />
            <div class="product-option-text"><strong>{{ item.product.productCode }} · <span>{{ item.product.name }}</span></strong><span>规格：{{ item.product.spec || '规格未填写' }}{{ item.product.status && item.product.status !== 'ENABLED' ? ' · 已停用' : '' }}</span><span>{{ item.manual ? '人工选择的缓存参考' : item.candidate ? item.candidate.visualEvidence.length ? '图片匹配' : '文字匹配' : '目录查询' }}<template v-if="item.candidate?.visualScore != null"> · 外观相似度 {{ item.candidate.visualScore.toFixed(4) }}</template></span></div>
          </el-option>
        </el-select>
        <el-select v-model="unit" filterable allow-create default-first-option placeholder="选择采购单位，缺少时填写后核对" aria-label="确认采购单位" :disabled="locked"><el-option v-for="item in selectedProduct?.units" :key="item.unit" :value="item.unit" :label="item.unit" /></el-select>
        <p v-if="manualCandidate" class="review-warning">已人工选择缓存参考候选，请核对照片、商品资料和采购单位后再确认。</p>
        <el-button type="primary" :disabled="locked" @click="confirmExisting">{{ row.readiness === 'NEEDS_SETUP' ? '重新核对商品与单位' : '确认商品与单位' }}</el-button><el-button :disabled="locked" @click="page.decideProduct(row, { decision: 'DEFERRED' })">暂缓本行</el-button>
        <div v-if="selectedProduct" class="selected-product-photo"><PurchaseImportProductPhoto :catalog="catalogImages" :image-id="selectedCandidate ? bestVisual(selectedCandidate)?.imageId : undefined" :product-id="selectedProduct.id" :label="`已选商品${selectedProduct.name}照片`" /><span class="review-hint">{{ selectedCandidate?.visualEvidence.length ? '本次实际命中照片，可与上方原图对照' : '已选商品资料照片' }}</span></div>
      </div>
      <div v-else class="new-review">
        <template v-if="choices[row.id] || row.productOperation"><p class="review-hint">已有新品操作，继续处理原请求。已成功建立的商品将保留。</p><el-button type="primary" :disabled="locked || row.readiness === 'READY'" @click="createNew">继续原新品操作</el-button></template>
        <el-form v-else :model="fresh" :disabled="locked" label-width="90px" @submit.prevent>
          <p class="review-hint">已有编码、名称和规格已带入，请核对后确认；空白字段缺少原值，需要补充。基础单位须明确填写。</p>
          <el-form-item label="商品编码" required><el-input v-model="fresh.productCode" /></el-form-item><el-form-item label="商品名称" required><el-input v-model="fresh.name" /></el-form-item><el-form-item label="基础单位" required><el-input v-model="fresh.baseUnit" /></el-form-item><el-form-item label="商品规格"><el-input v-model="fresh.spec" /></el-form-item><el-button type="primary" @click="createNew">核对并确认新增</el-button>
        </el-form>
      </div>
          </template>
        </el-tab-pane>
        <el-tab-pane label="原图核对" name="images">
          <template v-if="row">
            <p class="review-hint">查看原图后确认它是否属于当前采购行。</p>
            <div v-if="row.images?.length" class="review-originals">
              <article v-for="(image, index) in row.images" :key="`${row.id}-${image.id}`" class="review-original" :class="{ 'is-focused': focusedImage === image.id }">
                <div v-loading="imageLoading[image.id] === true" class="original-image-frame" :aria-busy="imageLoading[image.id] === true" :aria-label="`第${row.rowNo}行原图${index + 1}`" element-loading-text="原图加载中">
                  <el-image v-if="imageUrls[image.id]" :src="imageUrls[image.id]" fit="contain" :preview-src-list="[imageUrls[image.id]!]" preview-teleported :alt="`第${row.rowNo}行原图${index + 1}`">
                    <template #placeholder><el-icon class="is-loading" aria-label="原图显示中"><Loading /></el-icon></template>
                    <template #error><span class="review-warning">原图显示失败，请核对图片文件。</span></template>
                  </el-image>
                  <span v-else-if="imageErrors[image.id]" class="review-warning" role="status">{{ imageErrors[image.id] }}</span>
                </div>
                <div class="original-actions">
                  <span class="review-hint">原图 {{ index + 1 }}</span>
                  <el-button v-if="imageErrors[image.id]" link type="primary" :disabled="imageLoading[image.id]" @click="page.images.load(image.id)">重试加载原图</el-button>
                  <el-button v-if="image.status !== 'CONFIRMED'" :disabled="locked || !imageUrls[image.id] || imageLoading[image.id]" @click="page.associate(row,image.id,'CONFIRMED')">确认原图属于本行</el-button><span v-else>原图归属已确认</span>
                </div>
              </article>
            </div>
            <el-empty v-else description="本行没有原图" :image-size="70" />
          </template>
        </el-tab-pane>
        <el-tab-pane label="辅助识别" name="match">
          <template v-if="row">
      <div class="match-panel">
        <div class="match-title"><strong>图文候选辅助核对</strong><span>候选不会自动确认商品，也不会自动判定新品。</span></div>
        <div class="match-inputs"><el-input v-model="matchInputs.suppliedProductCode" placeholder="系统商品编码（未知留空）" aria-label="补充系统商品编码" :disabled="locked" maxlength="200" /><el-input v-model="matchInputs.suppliedProductName" placeholder="商品名称（未知留空）" aria-label="补充商品名称" :disabled="locked" maxlength="200" /><el-input v-model="matchInputs.supplierProductCode" placeholder="供应商编码（未知留空）" aria-label="补充供应商编码" :disabled="locked" maxlength="200" /></div>
        <div class="match-actions"><el-button :disabled="locked || !inputsDirty" @click="saveInputs">保存补充文字</el-button><el-button :disabled="locked || !matchEnabled || inputsDirty" @click="page.startMatches([row.id])">重新核对本行</el-button><span v-if="!matchEnabled && !capabilityError">当前环境尚未启用候选识别</span><span v-if="inputsDirty">请先保存补充文字</span></div>
        <p v-if="capabilityError" class="review-warning">{{ capabilityError }}</p>
        <div v-for="task in page.state.tasks.filter(item => ['MATCH', 'EXPLAIN'].includes(item.kind || '') && (item.id === row?.matchTaskId || item.result?.rowId === row?.id))" :key="task.id" class="match-task"><span>{{ task.kind === 'EXPLAIN' ? '解释' : '识别' }}任务：{{ task.status }}{{ task.errorMessage ? ` · ${task.errorMessage}` : '' }}</span><el-button v-if="task.kind === 'EXPLAIN' && ['FAILED', 'NEEDS_REAUTH'].includes(task.status)" :disabled="locked" @click="page.retryTask(task)">继续原解释任务</el-button></div>
        <template v-if="row.matchResult">
          <p v-if="!currentMatch" class="review-warning">此候选对应较早的输入或任务，请重新识别后再选择。</p>
          <p>文字：{{ routeLabel(row.matchResult.text.status) }} · {{ row.matchResult.text.reason }}</p><p>图片：{{ routeLabel(row.matchResult.image.status) }} · {{ row.matchResult.image.reason }}</p>
          <p v-for="(error, index) in row.matchResult.image.errors" :key="index" class="review-warning">{{ error.reason }}</p>
          <p v-if="!row.matchResult.candidates.length">{{ row.matchResult.status === 'FAILED' ? '候选识别失败，请检查上述原因后重试，或继续人工查找。' : '当前没有可核实候选，请继续人工查找或核对新品。' }}</p>
          <p v-if="row.matchResult.ranking" :class="{ 'review-warning': !row.matchResult.ranking.recommendedIds.length }">{{ row.matchResult.ranking.reason }}</p>
          <p v-else class="review-warning">这是旧版缓存，尚无加权评分，请人工核对或重新核对本行。</p>
          <p class="review-hint">照片至少80%，只取最高分组；文字至少80%，编号40% · 规格40% · 商品名20%。{{ row.matchResult.cacheReused ? '本次已复用照片缓存并重新计算文字分。' : '' }}</p>
          <el-button v-if="cachedCandidates.length" link type="primary" @click="showCached = !showCached">{{ showCached ? '收起' : '查看' }}缓存候选（{{ cachedCandidates.length }}）</el-button>
          <section v-for="group in candidateGroups" :key="group.title" class="candidate-group">
          <h4>{{ group.title }}</h4>
          <article v-for="candidate in group.candidates" :key="candidate.productId" class="candidate-card">
            <div><strong>{{ candidate.product.productCode }} · {{ candidate.product.name }}</strong><span>规格：{{ candidate.product.spec || '待核实' }}</span></div>
            <div v-for="(evidence, index) in candidate.visualEvidence" :key="`${evidence.queryAssetId}-${evidence.imageId}-${index}`" class="candidate-comparison">
              <figure :data-query-image-id="evidence.queryAssetId"><figcaption>用于识别的导入原图</figcaption><div class="comparison-original">
                <el-image v-if="imageUrls[evidence.queryAssetId]" :src="imageUrls[evidence.queryAssetId]" :preview-src-list="[imageUrls[evidence.queryAssetId]!]" preview-teleported fit="contain" :alt="`用于识别的原图${evidence.queryAssetId}`" />
                <span v-else class="review-hint">{{ imageErrors[evidence.queryAssetId] || (imageLoading[evidence.queryAssetId] ? '原图加载中' : '对应原图不再关联，请重新核对') }}</span>
              </div><el-button v-if="imageErrors[evidence.queryAssetId]" link type="primary" @click="page.images.load(evidence.queryAssetId)">重试加载原图</el-button></figure>
              <figure><figcaption>本次实际命中照片</figcaption><PurchaseImportProductPhoto :catalog="catalogImages" :image-id="evidence.imageId" :label="`${candidate.product.name}实际命中照片${index + 1}`" /><span class="review-hint">外观相似度 {{ evidence.score.toFixed(4) }}</span></figure>
            </div>
            <div v-if="!candidate.visualEvidence.length" class="text-candidate-photo"><PurchaseImportProductPhoto :catalog="catalogImages" :product-id="candidate.productId" :label="`${candidate.product.name}资料照片`" /><span class="review-hint">文字匹配 · 商品资料照片</span></div>
            <p v-if="candidate.visualScore !== null">外观相似度 {{ candidate.visualScore.toFixed(4) }}（排序分数，非正确概率）</p><p v-for="(evidence, index) in candidate.textEvidence" :key="index">{{ evidence.reason }}</p>
            <p v-for="conflict in candidate.conflicts" :key="conflict" class="review-warning">{{ conflict }}</p>
            <template v-if="candidateScore(candidate.productId)">
              <p><strong>文字综合分 {{ percent(candidateScore(candidate.productId)!.textScore) }}</strong> · {{ candidateScore(candidate.productId)!.reason }}</p>
              <p v-for="field in candidateScore(candidate.productId)!.fields" :key="field.field" class="review-hint">{{ field.label }}（权重{{ field.weight }}%）：{{ field.source || '来源未提供' }} / {{ field.target || '档案未提供' }} · {{ percent(field.score) }}</p>
            </template>
            <details class="review-hint"><summary>AI辅助说明</summary>
            <div v-if="candidateCheck(candidate.productId)" class="candidate-check" :class="{ 'review-warning': candidateCheck(candidate.productId)?.specMatch === 'CONFLICT' || candidateCheck(candidate.productId)?.imageMatch === 'DIFFERENT' }">
              <strong>{{ imageCheckLabel(candidateCheck(candidate.productId)!.imageMatch) }} · {{ specCheckLabel(candidateCheck(candidate.productId)!.specMatch) }}</strong>
              <p>{{ candidateCheck(candidate.productId)!.imageReason }}</p><p>{{ candidateCheck(candidate.productId)!.specReason }}</p>
            </div>
            <p v-else class="review-hint">尚无图片与规格复核结论，请勿仅按外观分数确认。</p>
            </details>
            <el-button :disabled="locked || !currentMatch" @click="chooseCandidate(candidate, group.manual)">{{ group.manual ? '人工选择此缓存候选' : '选择此候选后核对单位' }}</el-button>
          </article>
          </section>
          <p class="review-hint">AI辅助说明：{{ row.matchResult.explanation.status }} · {{ row.matchResult.explanation.message }}。推荐结果以上方评分为准。</p><p v-for="note in row.matchResult.explanation.candidateNotes" :key="note.productId">商品 {{ note.productId }}：{{ note.message }}</p>
          <el-button :disabled="locked || !matchEnabled || !currentMatch || inputsDirty" @click="page.explainMatch(row)">重试AI辅助说明</el-button>
        </template>
      </div>
          </template>
        </el-tab-pane>
      </el-tabs>
    </div>
    <template #footer><el-button @click="emit('update:modelValue',false)">返回明细</el-button><template v-if="activeTab !== 'todos'"><el-button @click="activeTab = 'todos'">返回待确认事项</el-button><el-button :disabled="locked || !row || page.state.rows.indexOf(row) === page.state.rows.length-1" @click="selectedRow = page.state.rows[page.state.rows.findIndex(item => item.id === selectedRow)+1]?.id ?? null">下一行</el-button></template></template>
  </el-dialog>
</template>

<style scoped lang="scss">
.product-review { font-size:13px; }
.review-originals { display:flex; flex-wrap:wrap; gap:24px; margin:16px 0; }
.review-original { max-width:100%; }
.original-image-frame { position:relative; display:flex; align-items:center; justify-content:center; width:180px; height:180px; background:var(--el-fill-color-extra-light); border:1px solid var(--el-border-color-light); border-radius:4px; overflow:hidden; .el-image { width:100%; height:100%; } .review-warning { padding:12px; overflow-wrap:anywhere; } }
.review-original.is-focused .original-image-frame { outline:2px solid var(--el-color-primary); outline-offset:2px; }
.original-actions { display:flex; flex-direction:column; align-items:flex-start; gap:8px; margin-top:12px; }
.todo-summary { margin:10px 0; font-weight:600; }
.todo-shortcuts { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-top:18px; .el-button + .el-button { margin-left:0; } }
.review-context { margin-bottom:12px; p { color:var(--el-text-color-secondary); overflow-wrap:anywhere; } }
.review-heading { display: flex; gap: 16px; align-items: baseline; margin-bottom: 14px; h3 { margin: 0; font-size: 15px; } span { color: var(--el-text-color-secondary); font-size: 12px; } }
.review-picker .el-select { width: 100%; max-width: 760px; }
.review-status, .review-links { display: flex; flex-wrap: wrap; gap: 16px; margin: 12px 0; font-size: 13px; }
.review-warning { color: var(--el-color-warning-dark-2); font-size: 13px; }
.existing-review { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; align-items: center; > .el-select { width: min(380px, 100%); } > .el-input { width: 240px; } }
.catalog-search { width: 100%; display: flex; gap: 12px; .el-input { max-width: 420px; } }
.review-hint { color: var(--el-text-color-secondary); font-size: 13px; line-height: 22px; }
.match-panel { margin: 16px 0; padding: 14px; background: var(--el-fill-color-extra-light); border: 1px solid var(--el-border-color-light); border-radius: 6px; font-size: 13px; line-height: 1.7; }
.match-title, .match-actions, .match-inputs, .candidate-card > div, .match-task { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.match-title span, .match-actions span { color: var(--el-text-color-secondary); }
.match-inputs { margin: 12px 0; .el-input { width: 260px; } }
.match-task { margin-top: 10px; }
.candidate-check { display: block; padding: 10px 12px; border-left: 3px solid var(--el-border-color); background: var(--el-fill-color-light); }
.candidate-check p { margin: 4px 0 0; }
.candidate-card { background: var(--el-bg-color); padding: 12px; margin: 10px 0; border-left: 3px solid var(--el-color-primary-light-5); p { margin: 6px 0; } }
.new-review { max-width: 600px; margin-top: 18px; }
.review-product-option { display:flex; align-items:center; gap:12px; height:auto; min-height:82px; line-height:1.5; padding:10px 16px; max-width:min(540px, calc(100vw - 40px)); }
.product-option-text { display:flex; flex-direction:column; min-width:0; white-space:normal; overflow-wrap:anywhere; font-size:12px; > strong { font-size:13px; } > span { color:var(--el-text-color-secondary); } }
.product-source-photos { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin:12px 0; }
.source-photo { display:flex; flex-direction:column; max-width:136px; .el-image { width:88px; height:76px; } }
.selected-product-photo, .text-candidate-photo { display:flex; align-items:center; gap:12px; width:100%; }
.candidate-card > .candidate-comparison { display:flex; align-items:flex-start; gap:20px; flex-wrap:wrap; margin:12px 0; }
.candidate-comparison figure { margin:0; width:136px; max-width:100%; figcaption { margin-bottom:6px; font-size:12px; } }
.comparison-original { display:flex; align-items:center; justify-content:center; width:136px; max-width:100%; height:120px; background:var(--el-fill-color-extra-light); border:1px solid var(--el-border-color-light); border-radius:4px; overflow:hidden; .el-image { width:100%; height:100%; } }
</style>
