<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { http } from '@/api/http'
import type { PurchaseImportModel, ImportRow, MatchCandidate } from './purchaseImportModel'

const props = defineProps<{ page: PurchaseImportModel }>()
interface Product { id: number; productCode: string; name: string; spec: string; baseUnit: string; status: string; units: { unit: string }[] }
const matchEnabled = ref(false), capabilityError = ref(''), candidateRun = ref<string | null>(null), candidateProduct = ref<MatchCandidate['product'] | null>(null)
const matchInputs = ref({ suppliedProductCode: '', suppliedProductName: '', supplierProductCode: '' })
const selectedRow = ref<number | null>(null), keyword = ref(''), products = ref<Product[]>([]), productId = ref<number | null>(null), unit = ref('')
const catalogLoading = ref(false), catalogError = ref(''), catalogLoaded = ref(false), mode = ref('existing')
const fresh = ref({ productCode: '', name: '', baseUnit: '', spec: '' }), choices = ref<Record<number, { key: string; request: Record<string, unknown> }>>({})
const row = computed(() => props.page.state.rows.find(item => item.id === selectedRow.value))
const selectedProduct = computed(() => candidateProduct.value?.id === productId.value ? candidateProduct.value : products.value.find(item => item.id === productId.value))
const readyCount = computed(() => props.page.state.rows.filter(item => item.readiness === 'READY').length)
const pickerLocked = computed(() => props.page.busy() || !!props.page.state.edit || props.page.headerDirty())
const locked = computed(() => pickerLocked.value || !!row.value && props.page.rowLocked(row.value))
const inputsDirty = computed(() => !!row.value && ['suppliedProductCode', 'suppliedProductName', 'supplierProductCode'].some(key => (matchInputs.value[key as keyof typeof matchInputs.value].trim() || null) !== (row.value![key as keyof ImportRow] || null)))
const currentMatch = computed(() => !!row.value?.matchResult && row.value.matchResult.inputRevision === row.value.version && row.value.matchResult.runId === row.value.matchTaskId)
let epoch = 0, active = true
function syncRow(value?: ImportRow) {
  candidateRun.value = null; candidateProduct.value = null
  matchInputs.value = { suppliedProductCode: value?.suppliedProductCode || '', suppliedProductName: value?.suppliedProductName || '', supplierProductCode: value?.supplierProductCode || '' }
  productId.value = value?.matchedProductId ?? null; unit.value = value?.purchaseUnit ?? ''; mode.value = 'existing'
  fresh.value = { productCode: '', name: '', baseUnit: '', spec: value?.productSpec || '' }
  if (value?.productOperation) choices.value[value.id] = { key: value.productOperation.key, request: value.productOperation.request }
}
watch(() => row.value?.version, () => syncRow(row.value))
watch(() => selectedRow.value, () => { props.page.clearFeedback(); syncRow(row.value) })
watch(() => props.page.state.rows.map(item => item.id).join(','), () => { if (!props.page.state.rows.some(item => item.id === selectedRow.value)) { selectedRow.value = props.page.state.rows[0]?.id ?? null; syncRow(row.value) } }, { immediate: true })
watch(() => props.page.state.batchId, () => { ++epoch; catalogLoading.value = false; products.value = []; catalogLoaded.value = false; catalogError.value = ''; choices.value = {}; syncRow(row.value) })
watch(() => props.page.state.batchId, async () => {
  const context = epoch; matchEnabled.value = false; capabilityError.value = ''
  try { const result = await http.get<{ recognitionEnabled: boolean }>('/pur/order-imports/capabilities', undefined, { silent: true }); if (active && context === epoch) { if (typeof result.recognitionEnabled !== 'boolean') throw new Error('候选识别开关响应不完整'); matchEnabled.value = result.recognitionEnabled } }
  catch (error) { if (active && context === epoch) capabilityError.value = error instanceof Error ? error.message : '候选识别状态读取失败' }
}, { immediate: true })
function chooseCandidate(candidate: MatchCandidate) {
  if (!row.value || !currentMatch.value || locked.value) return
  candidateProduct.value = candidate.product; productId.value = candidate.productId; candidateRun.value = row.value.matchResult!.runId
}
function manualSelection() { candidateRun.value = null; candidateProduct.value = null }
async function saveInputs() { if (row.value && await props.page.saveMatchInputs(row.value, { ...matchInputs.value })) syncRow(row.value) }
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
  await props.page.decideProduct(row.value, { decision: 'EXISTING', productId: productId.value, unit: unit.value.trim(), ...(candidateRun.value ? { runId: candidateRun.value } : {}) })
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
      <div class="match-panel">
        <div class="match-title"><strong>图文候选辅助核对</strong><span>候选不会自动确认商品，也不会自动判定新品。</span></div>
        <div class="match-inputs"><el-input v-model="matchInputs.suppliedProductCode" placeholder="系统商品编码（未知留空）" aria-label="补充系统商品编码" :disabled="locked" maxlength="200" /><el-input v-model="matchInputs.suppliedProductName" placeholder="商品名称（未知留空）" aria-label="补充商品名称" :disabled="locked" maxlength="200" /><el-input v-model="matchInputs.supplierProductCode" placeholder="供应商编码（未知留空）" aria-label="补充供应商编码" :disabled="locked" maxlength="200" /></div>
        <div class="match-actions"><el-button :disabled="locked || !inputsDirty" @click="saveInputs">保存补充文字</el-button><el-button :disabled="locked || !matchEnabled || inputsDirty" @click="page.startMatches([row.id])">识别本行候选</el-button><span v-if="!matchEnabled">当前环境尚未启用候选识别</span><span v-if="inputsDirty">请先保存补充文字</span></div>
        <p v-if="capabilityError" class="review-warning">{{ capabilityError }}</p>
        <div v-for="task in page.state.tasks.filter(item => ['MATCH', 'EXPLAIN'].includes(item.kind || '') && (item.id === row?.matchTaskId || item.result?.rowId === row?.id))" :key="task.id" class="match-task"><span>{{ task.kind === 'EXPLAIN' ? '解释' : '识别' }}任务：{{ task.status }}{{ task.errorMessage ? ` · ${task.errorMessage}` : '' }}</span><el-button v-if="task.kind === 'EXPLAIN' && ['FAILED', 'NEEDS_REAUTH'].includes(task.status)" :disabled="locked" @click="page.retryTask(task)">继续原解释任务</el-button></div>
        <template v-if="row.matchResult">
          <p v-if="!currentMatch" class="review-warning">此候选对应较早的输入或任务，请重新识别后再选择。</p>
          <p>文字：{{ routeLabel(row.matchResult.text.status) }} · {{ row.matchResult.text.reason }}</p><p>图片：{{ routeLabel(row.matchResult.image.status) }} · {{ row.matchResult.image.reason }}</p>
          <p v-for="(error, index) in row.matchResult.image.errors" :key="index" class="review-warning">{{ error.reason }}</p>
          <p v-if="!row.matchResult.candidates.length">当前没有可核实候选，请继续人工查找或核对新品。</p>
          <article v-for="candidate in row.matchResult.candidates" :key="candidate.productId" class="candidate-card">
            <div><strong>{{ candidate.product.productCode }} · {{ candidate.product.name }}</strong><span>规格：{{ candidate.product.spec || '待核实' }}</span></div>
            <p v-if="candidate.visualScore !== null">外观相似度 {{ candidate.visualScore.toFixed(4) }}（排序分数，非正确概率）</p><p v-for="(evidence, index) in candidate.textEvidence" :key="index">{{ evidence.reason }}</p>
            <p v-for="conflict in candidate.conflicts" :key="conflict" class="review-warning">{{ conflict }}</p>
            <el-button :disabled="locked || !currentMatch" @click="chooseCandidate(candidate)">选择此候选后核对单位</el-button>
          </article>
          <p>解释状态：{{ row.matchResult.explanation.status }} · {{ row.matchResult.explanation.message }}</p><p v-for="note in row.matchResult.explanation.candidateNotes" :key="note.productId">商品 {{ note.productId }}：{{ note.message }}</p>
          <el-button :disabled="locked || !matchEnabled || !currentMatch || inputsDirty" @click="page.explainMatch(row)">只重试候选解释</el-button>
        </template>
      </div>
      <el-radio-group v-model="mode" :disabled="locked"><el-radio-button value="existing">选择已有商品</el-radio-button><el-radio-button value="new">确认新品</el-radio-button></el-radio-group>
      <div v-if="mode === 'existing'" class="existing-review">
        <div class="catalog-search"><el-input v-model="keyword" placeholder="商品编码或名称" aria-label="检索真实商品" :disabled="locked" @keyup.enter="search" /><el-button :loading="catalogLoading" :disabled="locked" @click="search">查询商品</el-button></div>
        <el-alert v-if="catalogError" type="error" :closable="false" :title="catalogError" />
        <p v-if="catalogLoaded && !products.length && !catalogError" class="review-hint">当前检索没有商品，请核对编码、名称和规格。无结果不会自动创建新品。</p>
        <el-select v-model="productId" filterable placeholder="从查询结果选择真实商品" aria-label="已有商品" :disabled="locked" @change="manualSelection"><el-option v-for="item in products" :key="item.id" :value="item.id" :label="`${item.productCode} · ${item.name} · ${item.spec || '规格未填写'}${item.status === 'ENABLED' ? '' : ' · 已停用'}`" /></el-select>
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
.match-panel { margin: 16px 0; padding: 14px; background: var(--el-fill-color-extra-light); border: 1px solid var(--el-border-color-light); border-radius: 6px; font-size: 13px; line-height: 1.7; }
.match-title, .match-actions, .match-inputs, .candidate-card > div, .match-task { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.match-title span, .match-actions span { color: var(--el-text-color-secondary); }
.match-inputs { margin: 12px 0; .el-input { width: 260px; } }
.match-task { margin-top: 10px; }
.candidate-card { background: var(--el-bg-color); padding: 12px; margin: 10px 0; border-left: 3px solid var(--el-color-primary-light-5); p { margin: 6px 0; } }
.new-review { max-width: 600px; margin-top: 18px; }
</style>
