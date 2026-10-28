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
  }, ['page', 'state', 'books', 'suppliers', 'currencies', 'refsError', 'refsLoading', 'dialogVisible', 'selected', 'fileInput', 'disabled', 'route', 'loadReferences', 'supplierChanged', 'selectFile', 'submitImport', 'saveHeader', 'remove', 'errorLabel', 'emit'])
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
  app.component('PurchaseImportSources', { render: () => null })
  app.component('PurchaseImportProductReview', { render: () => null })
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
  const bindings = loadVueScript(source, { ref, watch, onBeforeUnmount() {}, defineProps: () => ({ page }), http: {} }, ['sheets', 'imageUrls', 'imageErrors', 'downloading', 'download', 'view', 'retry'])
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
  const bindings = loadVueScript(source, { ref, computed, watch, onBeforeUnmount() {}, defineProps: () => ({ page: state.page }), ElMessageBox: { async confirm() { throw 'cancel' } }, http: { async get() { throw new Error('目录连接失败') } } }, ['selectedRow', 'keyword', 'products', 'productId', 'unit', 'catalogLoading', 'catalogError', 'catalogLoaded', 'mode', 'fresh', 'choices', 'row', 'selectedProduct', 'readyCount', 'locked', 'search', 'confirmExisting', 'createNew'])
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
