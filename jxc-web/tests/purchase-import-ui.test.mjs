import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, computed, watch, compile, createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const file = new URL('../src/modules/purchase/PurchaseImportWorkspace.vue', import.meta.url)
const model = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
const batchId = '11111111-2222-4333-8444-555555555555'
const header = { bookId: 1, supplierId: 2, currency: 'USD', orderDate: '2026-10-28', expectedDate: null, paymentTerms: '', prepayRatio: '0', termDays: null }
const row = { id: 10, version: 1, rowNo: 1, sourceOrderNo: 'NY-051', photo: null, productSpec: 'S', purchaseQty: '10', saleUnitPrice: null, saleTotal: null, purchaseUnitPrice: '53', freight: null, landedUnitCost: null, usdUnitCost: null, usdTotal: null }
function workspace(confirm = async () => {}) {
  const navigations = [], requests = [], removed = []
  const state = loadVueScript(file, {
    ref, computed, watch, onMounted() {}, onBeforeUnmount() {}, defineProps: () => ({ downloading: false, downloadError: '' }), defineEmits: () => () => {},
    useCountryStore: () => ({ timezone: 'Asia/Shanghai', currentId: 101, epoch: 0 }), useUserStore: () => ({ token: 'test' }),
    useRoute: () => ({ query: { from: 'test' } }), useRouter: () => ({ async replace(target) { navigations.push(target) } }),
    todayIn: () => '2026-10-28', ...model,
    ElMessageBox: { confirm },
    http: { async get(path) { assert.equal(path, '/org/books'); return [{ id: 1, name: '账套', baseCurrency: 'USD' }] } },
    allRecords: async path => path === '/md/partners' ? [{ id: 2, name: '供应商' }] : [{ code: 'USD' }],
    purchaseImportApi: {
      async upload(selected, fields) { requests.push([selected, fields]); return { batchId, header: { ...header }, rows: [{ ...row }] } },
      async deleteRow(_batch, selected) { removed.push(selected.id); return { deleted: true, id: selected.id } },
    },
  }, ['page', 'state', 'books', 'suppliers', 'currencies', 'refsError', 'refsLoading', 'dialogVisible', 'selected', 'fileInput', 'disabled', 'headerLocked', 'route', 'loadReferences', 'supplierChanged', 'selectFile', 'submitImport', 'saveHeader', 'remove', 'errorLabel', 'emit'])
  return { state, navigations, requests, removed }
}

async function render(state) {
  const template = readFileSync(file, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app = createSSRApp({ setup: () => ({ ...state, downloading: false, downloadError: '' }), render: compile(template) })
  // 测试真实工作区模板与操作；Element控件外观和明细表内部行为由构建及模型测试分别覆盖。
  const slot = defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('div', [ctx.slots.default?.(), ctx.slots.footer?.()]) })
  for (const name of ['ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElDatePicker', 'ElInput', 'ElInputNumber', 'ElIcon', 'ElAlert', 'Upload', 'Download', 'Refresh']) app.component(name, slot)
  app.component('ElButton', defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('button', ctx.attrs, ctx.slots.default?.()) }))
  app.component('ElDialog', defineComponent({ props: ['modelValue'], setup: (props, ctx) => () => props.modelValue ? h('aside', [ctx.slots.default?.(), ctx.slots.footer?.()]) : null }))
  app.component('PurchaseImportTable', { render: () => null })
  app.component('PurchaseImportGallery', { render: () => null })
  app.component('PurchaseImportSources', { render: () => null })
  app.component('PurchaseImportProductReview', { render: () => null })
  app.component('PurchaseImportDraftPreview', { render: () => null })
  app.component('PurchaseImportFeeTodos', { render: () => null })
  return renderToString(app)
}

test('工作区实际呈现三块区域，导入弹窗包含模板下载和三条注意事项', async () => {
  const { state } = workspace()
  const initial = await render(state)
  assert.equal((initial.match(/<section /g) || []).length, 3)
  assert.match(initial, /基础信息/)
  assert.match(initial, /导入文件/)
  assert.doesNotMatch(initial, /下载模板/)
  state.dialogVisible.value = true
  const opened = await render(state)
  assert.match(opened, /下载模板/)
  assert.equal((opened.match(/<li>/g) || []).length, 3)
  assert.match(opened, /accept="\.xlsx/)
})

test('选择文件和点击导入走真实状态模型，回填后关闭弹窗并保留刷新批次地址', async () => {
  const { state, navigations, requests } = workspace()
  await state.loadReferences()
  Object.assign(state.state.header, header)
  const selected = new File(['xlsx'], '采购.xlsx')
  state.selectFile({ target: { files: { item: () => selected } } })
  state.dialogVisible.value = true
  await state.submitImport()
  assert.equal(requests[0][0], selected)
  assert.equal(state.state.rows[0].id, 10)
  assert.equal(state.dialogVisible.value, false)
  assert.deepEqual(navigations, [{ query: { from: 'test', batchId } }])
})

test('用户取消删除不会请求删除接口', async () => {
  const { state, removed } = workspace(async () => { throw 'cancel' })
  state.state.batchId = batchId
  state.state.rows = [{ ...row }]
  await state.remove(state.state.rows[0])
  assert.equal(removed.length, 0)
  assert.equal(state.state.rows.length, 1)
})

test('真实来源组件呈现解析失败、工作表选择和逐规格原图确认', async () => {
  const { state } = workspace()
  const page = state.page
  Object.assign(page.state, { batchId, tasks: [{ id: batchId, status: 'FAILED', errorCode: 'SHEET_SELECTION_REQUIRED', errorMessage: '请选择采购表', result: { sheets: ['采购A', '采购B'] } }], sources: [{ id: 8, fileName: '采购.xlsx', fileSha256: 'a'.repeat(64), status: 'FAILED' }], rows: [{ ...row, sourceSheet: '采购A', sourceRow: 2, images: [{ id: 9, sha256: 'b'.repeat(64), status: 'UNCONFIRMED' }] }] })
  const source = new URL('../src/modules/purchase/PurchaseImportSources.vue', import.meta.url)
  const bindings = loadVueScript(source, { ref, watch, onBeforeUnmount() {}, defineProps: () => ({ page }), ElMessageBox: { async confirm() { throw 'cancel' } }, http: {} }, ['sheets', 'imageUrls', 'imageErrors', 'downloading', 'download', 'view', 'retry', 'publish'])
  let publications = 0
  page.publishPhotos = async () => { publications++; return true }
  page.state.rows[0].matchedProductId = 501
  await bindings.publish(page.state.rows[0], 9)
  assert.equal(publications, 0)
  const template = readFileSync(source, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app = createSSRApp({ setup: () => ({ ...bindings, page }), render: compile(template) })
  const slot = defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('div', ctx.attrs, ctx.slots.default?.()) })
  for (const name of ['ElSelect', 'ElOption', 'ElCollapse', 'ElCollapseItem', 'ElButton', 'ElImage']) app.component(name, slot)
  const html = await renderToString(app)
  assert.match(html, /请选择采购表/)
  assert.match(html, /采购工作表/)
  assert.match(html, /下载原文件/)
  assert.match(html, /原第2行/)
  assert.match(html, /归属待核实/)
  assert.match(html, /确认属于本行/)
})

test('商品确认界面按真实目录状态显示，取消新品确认不创建商品', async () => {
  const { state } = workspace()
  Object.assign(state.page.state, { batchId, status: 'REVIEW', rows: [{ ...row, readiness: 'NEEDS_SETUP', matchedProductId: 501, setupReasons: ['商品尚未在本国启用'] }] })
  const source = new URL('../src/modules/purchase/PurchaseImportProductReview.vue', import.meta.url)
  const bindings = loadVueScript(source, { ref, computed, watch, onBeforeUnmount() {}, defineProps: () => ({ page: state.page }), ElMessageBox: { async confirm() { throw 'cancel' } }, http: { async get() { throw new Error('目录连接失败') } } }, ['selectedRow', 'keyword', 'products', 'productId', 'unit', 'catalogLoading', 'catalogError', 'catalogLoaded', 'mode', 'fresh', 'choices', 'row', 'selectedProduct', 'readyCount', 'pickerLocked', 'locked', 'search', 'confirmExisting', 'createNew', 'matchEnabled', 'capabilityError', 'candidateRun', 'candidateProduct', 'matchInputs', 'inputsDirty', 'currentMatch', 'chooseCandidate', 'manualSelection', 'saveInputs', 'routeLabel'])
  bindings.selectedRow.value = row.id
  bindings.products.value = [{ id: 501, productCode: 'SKU', name: '真实商品', spec: 'S', status: 'ENABLED', units: [{ unit: 'PCS' }] }]
  await bindings.search()
  assert.match(bindings.catalogError.value, /目录连接失败/)
  assert.equal(bindings.products.value.length, 1)
  Object.assign(bindings.fresh.value, { productCode: 'NEW', name: '新品', baseUnit: 'PCS' })
  await bindings.createNew()
  assert.deepEqual(bindings.choices.value, {})
  const template = readFileSync(source, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app = createSSRApp({ setup: () => ({ ...bindings, page: state.page }), render: compile(template) })
  const slot = defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('div', ctx.attrs, ctx.slots.default?.()) })
  for (const name of ['ElSelect', 'ElOption', 'ElButton', 'ElInput', 'ElRadioGroup', 'ElRadioButton', 'ElForm', 'ElFormItem', 'ElAlert', 'RouterLink']) app.component(name, slot)
  const html = await renderToString(app)
  assert.match(html, /商品已选定，仍需配置/)
  assert.match(html, /商品尚未在本国启用/)
  assert.match(html, /\/master\/products/)
})

test('接口适配器发送真实multipart和带版本的保存删除约定', async () => {
  const calls = []
  const httpUrl = new URL('../src/api/http.ts', import.meta.url)
  const cache = new Map([[httpUrl.href, { http: Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, async (...args) => { calls.push([method, ...args]); return { accepted: true } }])) }]])
  const { purchaseImportApi: api } = loadTsModule(new URL('../src/modules/purchase/purchaseImportApi.ts', import.meta.url), cache)
  const selected = new File(['xlsx'], '采购.xlsx')
  await api.upload(selected, header, batchId, 'intent-123')
  assert.equal(calls[0][1], '/pur/order-imports')
  assert.ok(calls[0][2] instanceof FormData)
  assert.equal(calls[0][2].get('file').name, '采购.xlsx')
  assert.equal(JSON.parse(calls[0][2].get('header')).currency, 'USD')
  assert.equal(calls[0][3].headers['Idempotency-Key'], 'intent-123')
  await api.load(batchId)
  await api.saveRow(batchId, row, { ...row, purchaseQty: '12' })
  await api.saveHeader(batchId, header, [{ id: 10, version: 1 }])
  await api.deleteRow(batchId, row)
  assert.equal(calls[1][1], `/pur/order-imports/${batchId}`)
  assert.equal(calls[2][2].version, 1)
  assert.deepEqual(calls[3][2].versions, [{ id: 10, version: 1 }])
  assert.equal(calls[4][1], `/pur/order-imports/${batchId}/rows/10`)
  assert.equal(calls[4][2].headers['If-Match'], '1')
})

test('完整预览显示原价、舍入差额和已建结果，取消确认不建单', async () => {
  const { state } = workspace()
  let creates = 0
  const group = { id: 8, version: 2, sourceOrderNo: 'PO', header, createStatus: 'READY', verifyStatus: 'NOT_CHECKED', previewToken: batchId, orderId: null, errors: [], preview: { totalAmount: '531.2350', taxAmount: '69.0606', lines: [{ lineNo: 1, productId: 501, productSpec: 'S', qty: '10', unit: 'PCS', sourceUnitPrice: '53.1234567890', unitPrice: '53.1235', unitPriceDifference: '0.0000432110', taxRate: '0.13', amount: '531.2350' }] } }
  Object.assign(state.page.state, { batchId, groups: [group], rows: [row] })
  state.page.createDraft = async () => { creates++; return true }
  const source = new URL('../src/modules/purchase/PurchaseImportDraftPreview.vue', import.meta.url)
  const props = { page: state.page, books: [{ id: 1, name: '账套' }], suppliers: [{ id: 2, name: '供应商' }], currencies: [{ code: 'USD' }] }
  const bindings = loadVueScript(source, { ref, computed, watch, onBeforeUnmount() {}, defineProps: () => props, ElMessageBox: { async confirm() { throw 'cancel' } }, http: { async get() { return { draftCreationEnabled: true } } } }, ['editing', 'header', 'split', 'enabled', 'capabilityError', 'capabilityLoading', 'locked', 'edit', 'save', 'groupRows', 'status', 'create'])
  bindings.enabled.value = true
  await bindings.create(group)
  assert.equal(creates, 0)
  group.createStatus = 'CREATED'; group.orderId = 909; group.docNo = 'PO-909'; group.verifyStatus = 'READ_FAILED'; group.errorMessage = '读取权限不足'
  const template = readFileSync(source, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app = createSSRApp({ setup: () => ({ ...bindings, ...props }), render: compile(template) })
  const slot = defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('div', ctx.attrs, ctx.slots.default?.()) })
  for (const name of ['ElButton', 'ElAlert', 'RouterLink', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElDatePicker', 'ElInput', 'ElInputNumber']) app.component(name, slot)
  const html = await renderToString(app)
  assert.match(html, /53.1234567890/); assert.match(html, /53.1235/); assert.match(html, /0.0000432110/)
  assert.match(html, /PO-909/); assert.match(html, /已保存，读回待核实/); assert.match(html, /查询原创建结果/)
})


test('图库组件保留索引失败原因和独立重试，取消重建不发请求', async () => {
  const { state } = workspace()
  let rebuilds = 0
  Object.assign(state.page.state, { batchId, gallery: { status: 'FAILED', coverage: { photos: 1, readyPhotos: 1, features: 1 }, lastError: '索引服务不可用' }, tasks: [{ id: batchId, kind: 'IMAGE_PUBLISH', phase: 'INDEX', status: 'FAILED', errorMessage: '索引构建失败' }] })
  state.page.rebuildGallery = async () => { rebuilds++; return true }
  const source = new URL('../src/modules/purchase/PurchaseImportGallery.vue', import.meta.url)
  const bindings = loadVueScript(source, { watch() {}, onBeforeUnmount() {}, defineProps: () => ({ page: state.page }), ElMessageBox: { async confirm() { throw 'cancel' } } }, ['phase', 'status', 'rebuild'])
  await bindings.rebuild(); assert.equal(rebuilds, 0)
  const template = readFileSync(source, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app = createSSRApp({ setup: () => ({ ...bindings, page: state.page }), render: compile(template) })
  const slot = defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('div', ctx.attrs, ctx.slots.default?.()) })
  for (const name of ['ElButton', 'ElAlert']) app.component(name, slot)
  const html = await renderToString(app)
  assert.match(html, /最近一次图库构建失败/); assert.match(html, /索引构建失败/); assert.match(html, /继续原照片／索引任务/); assert.match(html, /仍可人工确认商品并创建采购草稿/)
})


test('候选卡显示规格冲突和原始分数，选择后仍需人工确认单位', async () => {
  const { state } = workspace()
  const candidate = { productId: 501, product: { id: 501, productCode: 'SKU', name: '真实商品', spec: 'M', units: [{ unit: 'PCS' }] }, visualScore: 0.987, textEvidence: [], visualEvidence: [{}], conflicts: ['原行规格与候选商品规格不同'] }
  Object.assign(state.page.state, { batchId, status: 'REVIEW', rows: [{ ...row, readiness: 'UNRESOLVED', matchTaskId: batchId, matchResult: { runId: batchId, inputRevision: 1, text: { status: 'NO_INPUT', reason: '没有商品编码或名称' }, image: { status: 'FOUND', reason: '正式图库外观候选' }, candidates: [candidate], explanation: { status: 'UNAVAILABLE', message: '解释服务不可用，原始结果已保留' } } }] })
  state.page.headerDirty = () => false
  const calls = []; state.page.decideProduct = async (_row, input) => { calls.push(input); return true }
  const source = new URL('../src/modules/purchase/PurchaseImportProductReview.vue', import.meta.url)
  const names = ['selectedRow', 'keyword', 'products', 'productId', 'unit', 'catalogLoading', 'catalogError', 'catalogLoaded', 'mode', 'fresh', 'choices', 'row', 'selectedProduct', 'readyCount', 'pickerLocked', 'locked', 'search', 'confirmExisting', 'createNew', 'matchEnabled', 'capabilityError', 'candidateRun', 'candidateProduct', 'matchInputs', 'inputsDirty', 'currentMatch', 'chooseCandidate', 'manualSelection', 'saveInputs', 'routeLabel']
  const bindings = loadVueScript(source, { ref, computed, watch, onBeforeUnmount() {}, defineProps: () => ({ page: state.page }), ElMessageBox: {}, http: { async get() { return { recognitionEnabled: true } } } }, names)
  bindings.selectedRow.value = row.id; bindings.chooseCandidate(candidate)
  assert.equal(calls.length, 0); assert.equal(bindings.unit.value, '')
  bindings.unit.value = 'PCS'; await bindings.confirmExisting()
  assert.deepEqual(calls[0], { decision: 'EXISTING', productId: 501, unit: 'PCS', runId: batchId })
  const template = readFileSync(source, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app = createSSRApp({ setup: () => ({ ...bindings, page: state.page }), render: compile(template) })
  const slot = defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('div', ctx.attrs, ctx.slots.default?.()) })
  for (const name of ['ElSelect', 'ElOption', 'ElButton', 'ElInput', 'ElRadioGroup', 'ElRadioButton', 'ElForm', 'ElFormItem', 'ElAlert', 'RouterLink']) app.component(name, slot)
  const html = await renderToString(app)
  assert.match(html, /0.9870/); assert.match(html, /非正确概率/); assert.match(html, /规格不同/); assert.match(html, /解释服务不可用/)
})


test('费用待办区分未知与零，展示来源且保存失败保留编辑', async () => {
  const { state } = workspace(); state.page.headerDirty = () => false
  const g = { id: 8, version: 4, feeTodosVersion: 1, sourceOrderNo: 'PO', feeTodos: [{ todoId: batchId, sourceRowIds: [10], sourceRows: [{ rowId: 10, sourceId: 7, sourceSheet: '采购', sourceRow: 2, rowNo: 1 }], amount: null, currency: null, scope: null, reason: '运费归属待核实', status: 'PENDING', reviewStatus: 'UNRESOLVED', targetOrderId: null }], sourceEvidence: [{ rowId: 10, rowNo: 1, sourceId: 7, sourceSheet: '采购', sourceRow: 2, fileName: '采购.xlsx', fileSha256: 'a'.repeat(64), currentValues: { ...row, freight: '0.0000000000' }, originalValues: { H: '0' }, formulaProvenance: { formulas: { I: 'G2+H2' } } }] }
  state.page.state.groups = [g]; state.page.state.batchId = batchId
  state.page.saveFeeTodos = async () => false
  const source = new URL('../src/modules/purchase/PurchaseImportFeeTodos.vue', import.meta.url)
  const props = { page: state.page, currencies: [{ code: 'USD' }] }
  const bindings = loadVueScript(source, { ref, computed, defineProps: () => props }, ['editor', 'locked', 'open', 'add', 'remove', 'save', 'reviewLabel', 'scopeLabel', 'valueText'])
  bindings.open(g); await bindings.save(); assert.equal(bindings.editor.value.group.id, 8)
  bindings.editor.value = null
  const template = readFileSync(source, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app = createSSRApp({ setup: () => ({ ...bindings, ...props }), render: compile(template) })
  const slot = defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('div', ctx.attrs, ctx.slots.default?.()) })
  for (const name of ['ElButton', 'ElInput', 'ElSelect', 'ElOption', 'ElCheckbox', 'RouterLink']) app.component(name, slot)
  const html = await renderToString(app)
  assert.match(html, /待核实/); assert.match(html, /待登记/); assert.match(html, /0.0000000000/); assert.match(html, /G2\+H2/); assert.match(html, /import-source-7/)
})
