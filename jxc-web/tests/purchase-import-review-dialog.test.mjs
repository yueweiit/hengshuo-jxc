import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, nextTick, reactive, ref, shallowReactive, watch } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

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
    http: { async get() { return { recognitionEnabled: true } } }, ElMessageBox: { async confirm() {} },
  }, ['activeTab', 'selectedRow', 'row', 'todoItems', 'todoRowCount', 'openTodo', 'readyCount', 'needsProductSetup', 'needsCountrySetup', 'matchInputs', 'fresh', 'mode', 'chooseCandidate', 'productId', 'unit', 'confirmExisting', 'choices'])
  return { ...state, page, props, calls }
}

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
  d.chooseCandidate(candidate)
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
