import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, nextTick, reactive, ref, shallowReactive, watch, createSSRApp, defineComponent, h } from 'vue'
import * as Vue from 'vue'
import { compileTemplate } from '@vue/compiler-sfc'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { renderToString } from '@vue/server-renderer'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const { createPurchaseImportCatalogImages } = loadTsModule(new URL('../src/modules/purchase/purchaseImportCatalogImages.ts', import.meta.url))
const naming = loadTsModule(new URL('../src/modules/purchase/purchaseImportDisplay.ts', import.meta.url))

const file = new URL('../src/modules/purchase/PurchaseImportReviewDialog.vue', import.meta.url)
const image = (id, status = 'UNCONFIRMED') => ({ id, status, sha256: 'a'.repeat(64) })
const row = (id, values = {}) => ({ id, rowNo: id, version: 1, sourceOrderNo: '测试采购单', productSpec: '测试规格', readiness: 'UNRESOLVED', images: [], ...values })
function dialog(rows = [row(1)], options = {}) {
  const calls = []
  const page = {
    state: reactive({ batchId: '11111111-2222-4333-8444-555555555555', rows, tasks: [], edit: null, error: '', ...options.state }),
    images: { urls: ref({}), errors: ref({}), loading: ref({}), async load(id) { calls.push(['image', id]) } },
    busy: () => false, headerDirty: () => false, rowLocked: () => false, clearFeedback() {},
    failure(error) { this.state.error = error.message },
    async decideProduct(selected, input) { calls.push(['decide', selected.id, input]); return true },
    ...options.page,
  }
  const props = shallowReactive({ page, modelValue: true, rowId: null, ...options.props })
  const state = loadVueScript(file, {
    computed, ref, watch, onBeforeUnmount() {}, defineProps: () => props, defineEmits: () => () => {},
    useCountryStore: () => ({ current: { name: '测试国家' } }),
    createPurchaseImportCatalogImages,
    ...naming,
    http: { async get() { return { recognitionEnabled: true } } }, ElMessageBox: { async confirm() {} },
  }, ['activeTab', 'selectedRow', 'row', 'todoItems', 'todoRowCount', 'openTodo', 'readyCount', 'needsProductSetup', 'needsCountrySetup', 'matchInputs', 'fresh', 'mode', 'chooseCandidate', 'productId', 'unit', 'confirmExisting', 'choices', 'products', 'manualSelection', 'productOptions', 'saveInputs', 'candidateGroups', 'showCached', 'cachedCandidates', 'candidateScore', 'percent', 'locked', 'inputsDirty', 'matchEnabled', 'capabilityError', 'currentMatch', 'routeLabel', 'catalogImages', 'imageUrls', 'imageErrors', 'imageLoading', 'candidateCheck', 'imageCheckLabel', 'specCheckLabel'])
  return { ...state, page, props, calls }
}

function rankedRow(recommendedIds = []) {
  const approved = recommendedIds.includes(501), spec = approved ? 'S' : 'M', textScore = approved ? 1 : 0
  const candidate = { productId:501, product:{id:501,productCode:'SKU',name:'测试商品',spec,units:[{unit:'PCS'}]},visualScore:1,visualEvidence:[],textEvidence:[],conflicts:[] }
  const fields = [{field:'productCode',label:'商品编号',weight:40,source:null,target:'SKU',score:null},{field:'spec',label:'规格',weight:40,source:'S',target:spec,score:textScore},{field:'name',label:'商品名',weight:20,source:null,target:'测试商品',score:null}]
  return row(1, {productSpec:'S',matchTaskId:'test-run',matchResult:{format:'MatchRunV1',runId:'test-run',inputRevision:1,status:'OK',text:{status:'NO_INPUT',reason:'没有文字查询'},image:{status:'FOUND',reason:'照片候选'},explanation:{status:'NOT_REQUESTED',message:'缓存重算'},candidates:[candidate],ranking:{format:'CandidateRankingV1',policyVersion:'photo-first-text-40-40-20-v1',completePhotoGroup:true,status:approved?'RECOMMENDED':'NEEDS_REVIEW',reason:approved?'达到推荐门槛':'保留候选待人工核对',photoThreshold:0.8,textThreshold:0.8,weights:{productCode:40,spec:40,name:20},recommendedIds,highestPhotoIds:[501],scores:[{productId:501,photoScore:1,textScore,fields,reason:approved?'达到推荐门槛':'文字不足80%'}]}}})
}

test('缓存中的低文字候选不进入推荐下拉且不能作为推荐快捷选择', () => {
  const source = rankedRow(), d = dialog([source])
  assert.equal(d.productOptions.value.length, 0)
  d.chooseCandidate(source.matchResult.candidates[0])
  assert.equal(d.productId.value, null)
  assert.equal(d.row.value.matchResult.candidates.length, 1)
})

test('人工从缓存选择仍核对单位并向后台明确标记人工确认', async () => {
  const source = rankedRow(), d = dialog([source])
  d.chooseCandidate(source.matchResult.candidates[0], true); d.unit.value = 'PCS'
  assert.equal(d.productOptions.value[0]?.product.name, '测试商品')
  await d.confirmExisting()
  assert.deepEqual(d.calls.filter(c => c[0] === 'decide'), [['decide', 1, { decision: 'EXISTING', productId: 501, unit: 'PCS', runId: 'test-run', confirmCandidate: true }]])
})

test('保存补充文字后沿原任务入口重算已保存候选', async () => {
  const source = rankedRow(), calls = []
  const d = dialog([source], { page: {
    async saveMatchInputs() { calls.push('save'); return true },
    async startMatches(ids) { calls.push(['rescore', ids]); return true },
  } })
  await d.saveInputs()
  assert.deepEqual(calls, ['save', ['rescore', [1]]])
})

test('缓存可直接展开但推荐候选仍沿原确认入口且不标记人工覆盖', async () => {
  const source = rankedRow([501]), cached = { ...source.matchResult.candidates[0], productId: 502, product: { ...source.matchResult.candidates[0].product, id: 502 } }
  source.matchResult.candidates.push(cached)
  const d = dialog([source])
  assert.equal(d.candidateGroups.value.length, 1)
  assert.equal(d.candidateGroups.value[0].manual, false)
  d.showCached.value = true
  assert.equal(d.candidateGroups.value[1].manual, true)
  assert.deepEqual(d.candidateGroups.value[1].candidates.map(c => c.productId), [502])
  d.chooseCandidate(source.matchResult.candidates[0]); d.unit.value = 'PCS'; await d.confirmExisting()
  assert.deepEqual(d.calls.at(-1), ['decide', 1, { decision: 'EXISTING', productId: 501, unit: 'PCS', runId: 'test-run' }])
})

test('文字保存期间切换批次不会给新批次登记旧行的重算任务', async () => {
  let finish, rescored = 0
  const d = dialog([rankedRow()], { page: {
    saveMatchInputs: () => new Promise(resolve => { finish = resolve }),
    async startMatches() { rescored++; return true },
  } })
  const saving = d.saveInputs()
  d.page.state.batchId = '22222222-2222-4333-8444-555555555555'
  finish(true); await saving
  assert.equal(rescored, 0)
})

test('真实辅助识别模板把未推荐项保留在可直接展开的缓存区', async () => {
  const d = dialog([rankedRow()])
  const template = readFileSync(file, 'utf8').match(/<el-tab-pane label="辅助识别" name="match">([\s\S]*?)<\/el-tab-pane>/)[1]
  const compiled = compileTemplate({ source:template, filename:'PurchaseImportReviewDialog.vue', id:'ranking-test', compilerOptions:{ expressionPlugins:['typescript'] } })
  assert.deepEqual(compiled.errors,[])
  const exports = {}
  new Function('require','exports',ts.transpileModule(compiled.code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name=>{assert.equal(name,'vue');return Vue},exports)
  async function render() {
    const app = createSSRApp({ setup: () => ({ ...d }), render: exports.render })
    const slot = defineComponent({ inheritAttrs:false, setup:(_,ctx)=>()=>h('div',ctx.slots.default?.()) })
    for (const name of ['ElInput','ElButton','ElImage','PurchaseImportProductPhoto']) app.component(name,slot)
    return renderToString(app)
  }
  const collapsed = await render()
  assert.match(collapsed,/查看缓存候选（1）/); assert.doesNotMatch(collapsed,/测试商品/)
  d.showCached.value = true
  const expanded = await render()
  assert.match(expanded,/缓存候选 · 待人工核对/); assert.match(expanded,/测试商品/)
  assert.match(expanded,/文字综合分 0\.00%/); assert.match(expanded,/人工选择此缓存候选/)
})

test('核对窗口初次打开和重新打开均默认首页，并保留指定采购行', async () => {
  const d = dialog([row(1), row(2)], { props: { rowId: 2 } })
  assert.equal(d.activeTab.value, 'todos'); assert.equal(d.selectedRow.value, 2)
  d.activeTab.value = 'match'; d.props.modelValue = false; await nextTick()
  d.props.modelValue = true; await nextTick()
  assert.equal(d.activeTab.value, 'todos'); assert.equal(d.selectedRow.value, 2)
})

test('首页分别计算真实待办事项和行数，READY原图待确认不改变商品就绪数', () => {
  const d = dialog([row(1, { images: [image(11), image(12)] }), row(2, { readiness: 'READY', images: [image(21), image(22, 'REJECTED')] }), row(3, { readiness: 'READY' })])
  assert.equal(d.todoItems.value.length, 4); assert.equal(d.todoRowCount.value, 2)
  assert.equal(d.readyCount.value, 2)
  assert.equal(d.todoItems.value.filter(item => item.tab === 'images').length, 3)
  assert.equal(d.todoItems.value.some(item => item.row.id === 3), false)
})

test('真实配置原因逐项显示并决定维护入口，未知原因如实保留', async () => {
  const d = dialog([row(1, { readiness: 'NEEDS_SETUP', setupReasons: ['商品未配置所选单位换算', '商品尚未在本国启用', '服务端新增的待核实原因'] }), row(2)])
  assert.equal(d.needsProductSetup.value, true); assert.equal(d.needsCountrySetup.value, true)
  assert.ok(d.todoItems.value.some(item => item.reason === '服务端新增的待核实原因'))
  d.selectedRow.value = 2; await nextTick()
  assert.equal(d.needsProductSetup.value, false); assert.equal(d.needsCountrySetup.value, false)
})

test('点击原图待办同时定位采购行和原图标签，写入期间不切换行', async () => {
  const busy = ref(false)
  const d = dialog([row(1), row(2, { images: [image(21)] })], { page: { busy: () => busy.value } })
  const target = d.todoItems.value.find(item => item.tab === 'images')
  busy.value = true; d.openTodo(target); assert.equal(d.selectedRow.value, 1)
  busy.value = false; d.openTodo(target); await nextTick()
  assert.equal(d.selectedRow.value, 2); assert.equal(d.activeTab.value, 'images')
  assert.deepEqual(d.calls.filter(call => call[0] === 'image'), [['image', 21]])
})

test('确认商品后只移除商品待办，确认原图后再移除图片待办', () => {
  const d = dialog([row(1, { images: [image(11)] })])
  assert.equal(d.todoItems.value.length, 2)
  d.page.state.rows[0].readiness = 'READY'
  assert.equal(d.todoItems.value.length, 1); assert.equal(d.todoItems.value[0].tab, 'images')
  d.page.state.rows[0].images[0].status = 'CONFIRMED'
  assert.equal(d.todoItems.value.length, 0); assert.equal(d.todoRowCount.value, 0)
})

test('切换标签保留当前行补充文字与新品输入，选择真实候选返回商品页', async () => {
  const d = dialog()
  await nextTick()
  d.matchInputs.value.suppliedProductName = '人工补充'; d.fresh.value.name = '新品草稿'; d.mode.value = 'new'
  d.activeTab.value = 'images'; await nextTick(); d.activeTab.value = 'match'; await nextTick()
  assert.equal(d.matchInputs.value.suppliedProductName, '人工补充'); assert.equal(d.fresh.value.name, '新品草稿'); assert.equal(d.mode.value, 'new')
  const candidate = { productId: 501, product: { id: 501, productCode: 'TEST', name: '测试商品', units: [] } }
  d.page.state.rows[0].matchTaskId = 'test-run'; d.page.state.rows[0].matchResult = { inputRevision: 1, runId: 'test-run', candidates: [candidate] }
  d.chooseCandidate(candidate, true)
  assert.equal(d.activeTab.value, 'product'); assert.equal(d.productId.value, 501)
})

test('识别失败与过期进入辅助识别待办，已就绪商品不强制重新识别', () => {
  const d = dialog([row(1, { matchTaskId: 'a', matchResult: { status: 'FAILED', runId: 'a', inputRevision: 1 } }), row(2, { matchTaskId: 'b', matchResult: { status: 'OK', runId: 'b', inputRevision: 0 } }), row(3, { readiness: 'READY', matchResult: { status: 'FAILED' } })])
  const issues = d.todoItems.value.filter(item => item.tab === 'match')
  assert.equal(issues.length, 2); assert.match(issues[0].reason, /失败/); assert.match(issues[1].reason, /过期/)
  assert.equal(d.todoItems.value.some(item => item.row.id === 3), false)
})

test('配置后仍调用原商品确认接口重新核验，不在前端直接设为READY', async () => {
  const d = dialog([row(1, { matchedProductId: 501, purchaseUnit: '件', readiness: 'NEEDS_SETUP', setupReasons: ['商品尚未在本国启用'] })])
  await nextTick(); await d.confirmExisting()
  assert.deepEqual(d.calls.filter(call => call[0] === 'decide'), [['decide', 1, { decision: 'EXISTING', productId: 501, unit: '件' }]])
  assert.equal(d.page.state.rows[0].readiness, 'NEEDS_SETUP')
})

test('切页不丢失已经存在的新品原请求', async () => {
  const operation = { key: 'existing-request', request: { confirmNew: true, product: { name: '测试商品' } }, status: 'GLOBAL_DONE' }
  const d = dialog([row(1, { productOperation: operation })])
  await nextTick(); d.activeTab.value = 'match'; await nextTick(); d.activeTab.value = 'product'; await nextTick()
  assert.deepEqual(d.choices.value[1], { key: operation.key, request: operation.request })
})

test('新品带入已有正式编码名称和规格，不把采购单位或供应商编号当新品资料', async () => {
  const d = dialog([row(1, { suppliedProductCode: 'SKU-SOURCE', suppliedProductName: '原始商品名', purchaseUnit: '箱' }), row(2, { supplierProductCode: 'SUPPLIER-1' })])
  await nextTick()
  assert.deepEqual(d.fresh.value, { productCode: 'SKU-SOURCE', name: '原始商品名', baseUnit: '', spec: '测试规格' })
  d.selectedRow.value = 2; await nextTick()
  assert.deepEqual(d.fresh.value, { productCode: '', name: '', baseUnit: '', spec: '测试规格' })
})

test('新品人工草稿切行保留，来源更新只刷新未改字段，新批次不带走旧草稿', async () => {
  const d = dialog([row(1, { suppliedProductCode: 'SKU-1', suppliedProductName: '源名称' }), row(2)])
  await nextTick()
  d.fresh.value.name = '人工名称'; d.fresh.value.baseUnit = '件'
  d.selectedRow.value = 2; await nextTick(); d.selectedRow.value = 1; await nextTick()
  assert.equal(d.fresh.value.name, '人工名称'); assert.equal(d.fresh.value.baseUnit, '件')
  Object.assign(d.page.state.rows[0], { version: 2, suppliedProductCode: 'SKU-UPDATED', suppliedProductName: '更新源名称' })
  await nextTick()
  assert.equal(d.fresh.value.productCode, 'SKU-UPDATED'); assert.equal(d.fresh.value.name, '人工名称')
  d.page.state.batchId = '22222222-2222-4333-8444-555555555555'; await nextTick()
  assert.equal(d.fresh.value.name, '更新源名称'); assert.equal(d.fresh.value.baseUnit, '')
})

test('旧版缓存选择须标记人工确认，过期后人工目录选择不冒充识别结果', async () => {
  const candidate = { productId: 501, product: { id: 501, productCode: 'SKU-501', name: '候选商品', spec: '测试规格', units: [{ unit: '件' }] }, visualEvidence: [], textEvidence: [], visualScore: null, conflicts: [] }
  const d = dialog([row(1, { matchTaskId: 'current-run', matchResult: { inputRevision: 1, runId: 'current-run', candidates: [candidate] } })])
  await nextTick(); d.productId.value = 501; d.unit.value = '件'; d.manualSelection()
  await d.confirmExisting()
  assert.deepEqual(d.calls.at(-1), ['decide', 1, { decision: 'EXISTING', productId: 501, unit: '件', runId: 'current-run', confirmCandidate: true }])
  d.page.state.rows[0].version = 2; await nextTick()
  d.productId.value = 501; d.unit.value = '件'; d.manualSelection(); await d.confirmExisting()
  assert.deepEqual(d.calls.at(-1), ['decide', 1, { decision: 'EXISTING', productId: 501, unit: '件' }])
})

test('同版本AI命名到达后预填新品，人工改名不会被后续轮询覆盖', async () => {
  const source=rankedRow(),d=dialog([source]);d.page.state.rows[0].images=[image(7)];await nextTick()
  d.mode.value='new'
  d.page.state.rows[0].matchResult.explanation={status:'READY',message:'命名完成',productNameSuggestion:{status:'READY',category:'裤子',baseName:'黑色条纹裤子',productSpec:'S',name:'S码黑色条纹裤子',sourceKeys:['SOURCE:7'],reason:'来源图可辨认'}}
  await nextTick();assert.equal(d.fresh.value.name,'S码黑色条纹裤子')
  assert.equal(d.mode.value,'new')
  d.fresh.value.name='人工确认黑色条纹裤子'
  d.page.state.rows[0].matchResult.explanation.productNameSuggestion.name='S码条纹裤子';await nextTick()
  assert.equal(d.fresh.value.name,'人工确认黑色条纹裤子')
  assert.equal(d.page.state.rows[0].suppliedProductName,undefined)
})

test('不同物品按各自行规格和类别预填，切行不串用裤子名称',async()=>{
  const one=rankedRow(),two=row(2,{productSpec:null,matchTaskId:'second',images:[image(8)],matchResult:{runId:'second',inputRevision:1,candidates:[],explanation:{status:'READY',productNameSuggestion:{status:'READY',category:'杯垫',baseName:'蓝色圆形杯垫',name:'蓝色圆形杯垫',productSpec:null,sourceKeys:['SOURCE:8'],reason:'来源图是杯垫'}}}})
  const d=dialog([one,two]);d.selectedRow.value=2;await nextTick()
  assert.equal(d.fresh.value.name,'蓝色圆形杯垫');assert.equal(d.fresh.value.spec,'')
})
