import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ref, reactive, computed, watch, nextTick, compile, createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { ElBadge } from 'element-plus'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const file = new URL('../src/modules/purchase/PurchaseImportWorkspace.vue', import.meta.url)
const model = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
const draft = loadTsModule(new URL('../src/modules/purchase/purchaseImportDraft.ts', import.meta.url))
const { purchaseOrderSaveStatus } = loadTsModule(new URL('../src/modules/purchase/purchaseImportWorkflow.ts', import.meta.url))
const batchId = '11111111-2222-4333-8444-555555555555'
const header = { bookId: 1, supplierId: 2, currency: 'USD', orderDate: '2026-10-28', expectedDate: null, paymentTerms: '', prepayRatio: '0', termDays: null }
const row = { id: 10, version: 1, rowNo: 1, sourceOrderNo: 'NY-051', photo: null, productSpec: 'S', purchaseQty: '10', saleUnitPrice: null, saleTotal: null, purchaseUnitPrice: '53', freight: null, landedUnitCost: null, usdUnitCost: null, usdTotal: null }
async function workspace(confirm = async () => {}, dependencies = {}) {
  const navigations = [], requests = [], removed = [], savedHeaders = [], messages = []
  const country = reactive({ timezone: 'Asia/Shanghai', currentId: 101, epoch: 0, currency: 'MXN' })
  const user = reactive({ token: 'test', user: { id: 7 } })
  const records = new Map()
  const route = reactive({ query: { from: 'test' } })
  const state = loadVueScript(file, {
    ref, computed, watch, nextTick, onMounted() {}, onBeforeUnmount() {}, defineProps: () => ({ downloading: false, downloadError: '' }), defineEmits: () => () => {},
    useCountryStore: () => country, useUserStore: () => user,
    useRoute: () => route, useRouter: () => ({ async replace(target) { navigations.push(target) } }),
    todayIn: () => '2026-10-28', ...model, ...draft, purchaseOrderSaveStatus,
    createPurchaseImportDraftSession: page => draft.createPurchaseImportDraftSession(page, { read: async key => records.get(key), write: async (key, value) => { records.set(key, value) } }),
    ElMessageBox: { confirm },
    ElMessage: { success(value) { messages.push(value) } },
    http: { async get(path) { if(path==='/pur/order-imports/capabilities')return {draftCreationEnabled:true};assert.equal(path, '/org/books'); return [{ id: 5, name: '未启用账套', baseCurrency: 'MXN', status: 'DRAFT' }, { id: 1, name: '账套', baseCurrency: 'MXN', status: 'ACTIVE' }, { id: 3, name: '另一账套', baseCurrency: 'MXN', status: 'ACTIVE' }] } },
    allRecords: async path => path === '/md/partners' ? [{ id: 2, name: '供应商', settleCurrency: 'USD', paymentTerms: '月结' }, { id: 4, name: '另一供应商', settleCurrency: 'MXN', paymentTerms: '现结' }] : [{ code: 'MXN', name: '墨西哥比索', status: 'ENABLED' }, { code: 'USD', name: '美元', status: 'ENABLED' }],
    purchaseImportApi: {
      async upload(selected, fields) { requests.push([selected, fields]); return { batchId, header: { ...header }, rows: [{ ...row }] } },
      async deleteRow(_batch, selected) { removed.push(selected.id); return { deleted: true, id: selected.id } },
      async saveHeader(_batch, value) { savedHeaders.push(value); return { batchId, header: { ...value }, rows: [{ ...row }] } },
    },
    ...dependencies,
  }, ['page', 'state', 'books', 'suppliers', 'currencies', 'refsError', 'refsLoading', 'dialogVisible', 'selected', 'fileInput', 'disabled', 'importDisabled', 'headerLocked', 'route', 'loadReferences', 'loadRouteBatch', 'supplierChanged', 'selectFile', 'submitImport', 'saveHeader', 'remove', 'errorLabel', 'emit', 'scheduleTasks','creationEnabled','creationLoading','creationError','loadCreationCapability','saveOrders','purchaseOrderSaveStatus','pendingReview','previewVisible', 'clearAll', 'clearConfirming', 'localDraft', 'openLocalDraft','reviewVisible','reviewRow','reviewTab','review','pendingProductCount','reviewPreviewRow','preview','correctedBatch'])
  const initialDate = state.state.header.orderDate
  await state.localDraft.open(draft.purchaseImportDraftKey(7, 101, null))
  state.state.header.orderDate = initialDate
  return { state, navigations, requests, removed, savedHeaders, country, user, messages }
}

async function render(state) {
  const template = readFileSync(file, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app = createSSRApp({ setup: () => ({ ...state, downloading: false, downloadError: '' }), render: compile(template) })
  // 测试真实工作区模板与操作；Element控件外观和明细表内部行为由构建及模型测试分别覆盖。
  const slot = defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('div', ctx.attrs, [ctx.slots.title?.(), ctx.slots.default?.(), ctx.slots.footer?.()]) })
  for (const name of ['ElForm', 'ElFormItem', 'ElSelect', 'ElDatePicker', 'ElInput', 'ElInputNumber', 'ElIcon', 'ElAlert', 'Upload', 'Download', 'Refresh']) app.component(name, slot)
  app.component('ElOption', defineComponent({ props: ['label', 'value', 'disabled'], setup: props => () => h('option', { value: props.value, disabled: props.disabled }, props.label) }))
  app.component('ElButton', defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('button', ctx.attrs, ctx.slots.default?.()) }))
  app.component('ElBadge', ElBadge)
  app.component('ElDialog', defineComponent({ props: ['modelValue'], setup: (props, ctx) => () => props.modelValue ? h('aside', [ctx.slots.title?.(), ctx.slots.default?.(), ctx.slots.footer?.()]) : null }))
  app.component('PurchaseImportTable', { render: () => null })
  app.component('PurchaseImportProgress', { render: () => null })
  app.component('PurchaseImportSources', { render: () => null })
  return renderToString(app)
}

test('基础信息直接提供税率和单价口径入口，填写后通过原保存基础信息操作提交', async () => {
  const { state, savedHeaders } = await workspace(); await state.loadReferences()
  Object.assign(state.state, { batchId, rows: [row] })
  Object.assign(state.state.header, { taxRate: '0.13', priceTaxBasis: 'EXCLUSIVE' })
  const html = await render(state)
  assert.match(html, /aria-label="税率"/)
  assert.match(html, /aria-label="单价口径"/)
  assert.match(html, /0\.13.*13%/)
  await state.saveHeader()
  assert.equal(savedHeaders.at(-1).taxRate, '0.13'); assert.equal(savedHeaders.at(-1).priceTaxBasis, 'EXCLUSIVE')
  state.previewVisible.value = true; state.reviewPreviewRow(state.state.rows[0])
  assert.equal(state.previewVisible.value, false); assert.equal(state.reviewVisible.value, true); assert.equal(state.reviewRow.value, row.id)
  assert.equal(state.reviewTab.value, 'product')
})

test('主页面提供保存入口并直接展示已生成采购单号与读回状态',async()=>{
  const {state}=await workspace();await state.loadReferences()
  Object.assign(state.page.state,{batchId,rows:[row],groups:[{id:8,sourceOrderNo:'NY-051',createStatus:'CREATED',orderId:708,docNo:'PO-SAVE-8',verifyStatus:'VERIFIED',errors:[]}]})
  const html=await render(state)
  assert.match(html,/>保存<\/button>/);assert.match(html,/PO-SAVE-8/);assert.match(html,/读回核对一致/)
})

test('成功反馈以全局消息展示三秒并消费，不再渲染明细区成功绿条', async () => {
  const { state, messages } = await workspace()
  state.state.success = '明细已保存'
  await nextTick(); await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(messages, [{ message: '明细已保存', duration: 3000 }])
  assert.equal(state.state.success, '')
  assert.doesNotMatch(await render(state), /明细已保存/)
})

test('相同操作再次成功仍提示一次，保存失败不弹成功消息', async () => {
  let fail = false
  const { state, messages } = await workspace(undefined, { purchaseImportApi: { async saveHeader(_id, value) { if (fail) throw new Error('保存失败'); return { batchId, header: { ...value }, rows: [{ ...row }] } } } })
  await state.loadReferences(); Object.assign(state.state, { batchId, header: { ...header }, rows: [{ ...row }] })
  await state.saveHeader(); state.state.header.paymentTerms = '第二次保存'; await state.saveHeader()
  fail = true; state.state.header.paymentTerms = '第三次保存失败'; await state.saveHeader()
  assert.deepEqual(messages.map(item => item.message), ['基础信息已保存', '基础信息已保存'])
  assert.equal(state.state.error, '保存失败')
})
test('保存能力读取失败保留原因且不建单，重试成功后主按钮调用统一保存',async()=>{
  let unavailable=true,calls=0
  const {state}=await workspace(async()=>{}, {http:{async get(path){if(path==='/pur/order-imports/capabilities'){if(unavailable)throw new Error('读取保存能力连接失败');return {draftCreationEnabled:true}}return [{id:1,name:'账套',baseCurrency:'MXN',status:'ACTIVE'}]}}})
  await state.loadReferences();Object.assign(state.page.state,{batchId,header:{...header},rows:[row]});state.page.saveOrders=async()=>{calls++;return true}
  await state.loadCreationCapability();assert.match(state.creationError.value,/连接失败/);assert.equal(await state.saveOrders(),false);assert.equal(calls,0)
  unavailable=false;await state.loadCreationCapability();assert.equal(await state.saveOrders(),true);assert.equal(calls,1)
})
test('预览仍有未保存修改时主保存返回核对，不创建使用旧资料的采购单',async()=>{
  const {state}=await workspace();await state.loadReferences();Object.assign(state.page.state,{batchId,header:{...header},rows:[row]});await state.loadCreationCapability()
  let calls=0;state.page.saveOrders=async()=>{calls++;return true};assert.ok(state.pendingReview,'缺少预览未保存修改的状态')
  state.pendingReview.value=true;assert.equal(await state.saveOrders(),false);assert.equal(calls,0);assert.match(state.page.state.error,/预览.*未保存/)
})
test('清空按钮取消或关闭确认框时保留页面数据，异常提示真实错误', async () => {
  for (const reason of ['cancel', 'close', new Error('确认框异常')]) {
    const { state } = await workspace(async () => { throw reason })
    await state.loadReferences(); state.selected.value = new File(['x'], '采购.xlsx')
    await state.clearAll()
    assert.equal(state.state.header.bookId, 1); assert.equal(state.selected.value.name, '采购.xlsx')
    assert.equal(state.state.error, reason instanceof Error ? reason.message : '')
  }
})

test('确认清空输入后异步选项读取不能重新填充默认值，仍可人工选择', async () => {
  let resolve
  const { state } = await workspace(undefined, { http: { get() { return new Promise(done => resolve = done) } } })
  const reading = state.loadReferences(); state.selected.value = new File(['x'], '采购.xlsx'); state.fileInput.value = { value: 'old.xlsx' }
  await state.clearAll(); resolve([{ id: 1, status: 'ACTIVE', baseCurrency: 'USD' }]); await reading
  assert.equal(state.state.header.bookId, null); assert.equal(state.state.header.supplierId, null); assert.equal(state.state.header.orderDate, null); assert.equal(state.selected.value, null); assert.equal(state.fileInput.value.value, '')
  state.state.header.supplierId = 2; state.supplierChanged(); assert.equal(state.state.header.currency, 'USD')
})

test('确认框等待期间切换国家或文件时不清空新上下文', async () => {
  for (const change of ['country', 'file']) {
    let resolve
    const { state, country } = await workspace(() => new Promise(done => resolve = done))
    state.state.header.paymentTerms = '原内容'; const confirming = state.clearAll()
    if (change === 'country') { country.epoch++; state.state.header.paymentTerms = '新国家内容' }
    else state.selected.value = new File(['new'], 'new.xlsx')
    resolve(); await confirming
    assert.notEqual(state.state.header.paymentTerms, '')
  }
})

test('已保存批次确认清空后移除地址参数并关闭预览和旧保存草稿', async () => {
  let message
  const { state, navigations } = await workspace(async text => { message = text }, { purchaseImportApi: {
    async clearBatch(id, version, key) { return { cleared: true, batchId: id, version, requestKey: key, cleanupPending: false, pendingFiles: 0, counts: { rows: 1, sources: 1, images: 1, tasks: 1, groups: 0, progress: 1 } } },
  } })
  Object.assign(state.state, { batchId, version: 2, header: { ...header }, rows: [{ ...row }] }); state.route.query.batchId = batchId
  state.pendingReview.value = true; state.previewVisible.value = true; state.dialogVisible.value = true
  state.selected.value = new File(['x'], '采购.xlsx'); state.fileInput.value = { value: '采购.xlsx' }
  await state.clearAll()
  assert.match(message, /已暂存的明细/); assert.match(message, /永久删除/); assert.match(message, /审计记录/)
  assert.equal(state.state.batchId, null); assert.equal(state.state.rows.length, 0); assert.equal(state.pendingReview.value, false); assert.equal(state.previewVisible.value, false); assert.equal(state.dialogVisible.value, false)
  assert.deepEqual(navigations.at(-1), { query: { from: 'test', batchId: undefined } })
  state.route.query.batchId = undefined; await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(state.state.header.orderDate, null); assert.equal(state.state.header.bookId, null)
})

test('清空移除批次地址导致工作区重新挂载时仍保持所有输入空白', async () => {
  let mounted, mountedMessages
  const { state, messages } = await workspace(undefined, { useRouter: () => ({ async replace() { const next = await workspace(); mounted = next.state; mountedMessages = next.messages; await mounted.loadReferences() } }), purchaseImportApi: {
    async clearBatch(id, version, key) { return { cleared: true, batchId: id, version, requestKey: key, cleanupPending: false, pendingFiles: 0, counts: { rows: 1, sources: 1, images: 1, tasks: 1, groups: 0, progress: 1 } } },
  } })
  Object.assign(state.state, { batchId, version: 2, header: { ...header }, rows: [{ ...row }] }); state.route.query.batchId = batchId
  await state.clearAll()
  assert.deepEqual(messages.map(item => item.message), ['当前导入数据和独占文件已清空']); assert.deepEqual(mountedMessages, [])
  assert.ok(mounted); assert.equal(mounted.state.header.orderDate, null); assert.equal(mounted.state.header.bookId, null); assert.equal(mounted.state.header.supplierId, null); assert.equal(mounted.state.header.currency, '')
  const fresh = await (await workspace()).state; await fresh.loadReferences(); assert.equal(fresh.state.header.orderDate, '2026-10-28'); assert.equal(fresh.state.header.bookId, 1)
})

test('基础选项读取失败不阻止导入文件和来源编辑，基础信息保存仍需有效选项', async () => {
  const { state, requests, removed } = await workspace(undefined, { allRecords: async () => { throw new Error('基础选项读取失败') } })
  await state.loadReferences()
  state.selected.value = new File(['xlsx'], '采购.xlsx')
  assert.equal(state.state.header.bookId, null)
  await state.submitImport()
  assert.equal(requests.length, 1)
  assert.equal(state.state.rows.length, 1)
  const output = await render(state)
  assert.match(output, /基础选项读取失败/)
  assert.equal(state.page.startEdit(state.state.rows[0], 'productSpec'), true)
  state.page.cancelEdit()
  await state.remove(state.state.rows[0])
  assert.deepEqual(removed, [10])
})

test('新建时跳过草稿账套预选首个可用项，供应商币种优先且已知付款条件跨上传保留', async () => {
  const { state } = await workspace(undefined, { purchaseImportApi: { async upload() { return { batchId, header: { ...header, bookId: null, supplierId: null, currency: null, orderDate: null, paymentTerms: '', prepayRatio: null }, rows: [{ ...row }] } } } })
  await state.loadReferences()
  assert.deepEqual({ ...state.state.header }, { bookId: 1, supplierId: 2, currency: 'USD', orderDate: '2026-10-28', expectedDate: null, paymentTerms: '月结', prepayRatio: null, termDays: null })
  assert.match(await render(state), /<option value="5" disabled>/)
  state.selected.value = new File(['xlsx'], '采购.xlsx')
  await state.submitImport()
  assert.equal(state.state.header.currency, 'USD')
  assert.equal(state.state.header.paymentTerms, '月结')
  assert.equal(state.state.header.bookId, 1)
  assert.equal(state.page.headerDirty(), true)
})

test('供应商币种不可用时回退当前国家已启用币种', async () => {
  const { state } = await workspace(undefined, { allRecords: async path => path === '/md/partners' ? [{ id: 2, name: '供应商', settleCurrency: 'EUR' }] : [{ code: 'MXN', name: '墨西哥比索', status: 'ENABLED' }] })
  await state.loadReferences()
  assert.equal(state.state.header.supplierId, 2)
  assert.equal(state.state.header.currency, 'MXN')
})

test('没有可用币种依据时保留空值，不虚构美元选项或结算币种', async () => {
  const { state } = await workspace(undefined, { allRecords: async path => path === '/md/partners' ? [{ id: 2, name: '供应商', settleCurrency: 'EUR' }] : [] })
  await state.loadReferences()
  assert.equal(state.state.header.currency, '')
  assert.deepEqual(state.currencies.value, [])
  assert.equal(state.refsError.value, '')
})

test('账套供应商和币种可以切换，重新读取不覆盖人工修改', async () => {
  const { state } = await workspace()
  await state.loadReferences()
  Object.assign(state.state.header, { bookId: 3, supplierId: 4, currency: 'USD', paymentTerms: '人工约定', orderDate: '2026-10-01' })
  state.supplierChanged()
  await state.loadReferences()
  assert.equal(state.state.header.bookId, 3)
  assert.equal(state.state.header.supplierId, 4)
  assert.equal(state.state.header.currency, 'USD')
  assert.equal(state.state.header.paymentTerms, '人工约定')
  assert.equal(state.state.header.orderDate, '2026-10-01')
})

test('基础选项晚返回只补空字段，不覆盖等待期间填写的基础信息', async () => {
  let finish
  const books = new Promise(resolve => { finish = resolve })
  const { state } = await workspace(undefined, { http: { get: () => books } })
  const loading = state.loadReferences()
  Object.assign(state.state.header, { bookId: 3, supplierId: 4, currency: 'MXN', paymentTerms: '人工约定' })
  finish([{ id: 1, name: '账套', baseCurrency: 'MXN', status: 'ACTIVE' }, { id: 3, name: '另一账套', baseCurrency: 'MXN', status: 'ACTIVE' }])
  await loading
  assert.equal(state.state.header.bookId, 3)
  assert.equal(state.state.header.supplierId, 4)
  assert.equal(state.state.header.currency, 'MXN')
  assert.equal(state.state.header.paymentTerms, '人工约定')
})

test('打开旧批次时不预填空字段，返回新建页才使用当前默认值', async () => {
  const oldHeader = { bookId: null, supplierId: null, currency: null, orderDate: null, expectedDate: null, paymentTerms: '', prepayRatio: null, termDays: null }
  const { state } = await workspace(undefined, { purchaseImportApi: { async load() { return { batchId, header: oldHeader, rows: [{ ...row }] } } } })
  await state.loadReferences()
  state.route.query.batchId = batchId
  await nextTick(); await new Promise(resolve => setTimeout(resolve, 0))
  await state.loadReferences()
  assert.equal(state.state.header.bookId, null)
  await state.loadRouteBatch()
  await state.loadReferences()
  assert.deepEqual({ ...state.state.header }, oldHeader)
  delete state.route.query.batchId
  await nextTick(); await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(state.state.header.bookId, 1)
  assert.equal(state.state.header.supplierId, 2)
  assert.equal(state.state.header.currency, 'USD')
  assert.equal(state.state.header.orderDate, '2026-10-28')
})

test('国家账号切换重置默认信息，旧上下文延迟响应不能回填', async () => {
  let finish, reads = 0
  const staleBooks = new Promise(resolve => { finish = resolve })
  const { state, country, user } = await workspace(undefined, { http: { get: () => ++reads === 1 ? staleBooks : Promise.resolve([{ id: 3, name: '新国家账套', baseCurrency: 'MXN', status: 'ACTIVE' }]) } })
  const oldLoading = state.loadReferences()
  Object.assign(state.state.header, { bookId: 1, supplierId: 4, currency: 'MXN', paymentTerms: '旧国家人工值' })
  country.currentId = 202
  await state.loadReferences()
  finish([{ id: 1, name: '旧国家账套', baseCurrency: 'MXN', status: 'ACTIVE' }])
  await oldLoading
  assert.equal(state.state.header.bookId, 3)
  assert.equal(state.state.header.supplierId, 2)
  assert.equal(state.state.header.currency, 'USD')
  assert.equal(state.state.header.paymentTerms, '月结')
  state.state.header.currency = 'MXN'
  user.token = 'another-account'
  await state.loadReferences()
  assert.equal(state.state.header.currency, 'USD')
})

test('合法无选项保持空白且与读取失败区分', async () => {
  const { state } = await workspace(undefined, { http: { async get() { return [{ id: 5, name: '未启用账套', baseCurrency: 'MXN', status: 'DRAFT' }] } }, allRecords: async () => [] })
  await state.loadReferences()
  assert.equal(state.state.header.bookId, null)
  assert.equal(state.state.header.supplierId, null)
  assert.equal(state.state.header.currency, '')
  assert.equal(state.refsError.value, '')
  assert.equal(state.disabled.value, false)
})

test('读取启用币种并显示美元中文名，切换USD后按原保存入口提交', async () => {
  const currencyQueries = []
  const { state, savedHeaders } = await workspace(undefined, { allRecords: async (path, query) => {
    if (path === '/md/partners') return [{ id: 2, name: '供应商', settleCurrency: 'MXN' }]
    currencyQueries.push(query)
    return [{ code: 'MXN', name: '墨西哥比索', status: 'ENABLED' }, { code: 'USD', name: '美元', status: 'ENABLED' }]
  } })
  await state.loadReferences()
  assert.deepEqual(currencyQueries, [{ status: 'ENABLED' }])
  assert.match(await render(state), /USD · 美元/)
  state.selected.value = new File(['xlsx'], '采购.xlsx')
  await state.submitImport()
  state.state.header.currency = 'USD'
  await state.saveHeader()
  assert.equal(savedHeaders.length, 1)
  assert.equal(savedHeaders[0].currency, 'USD')
  assert.equal(state.page.headerDirty(), false)
})

test('工作区实际呈现三块区域，导入弹窗包含模板下载和三条注意事项', async () => {
  const { state } = await workspace()
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

test('选择文件和点击导入走真实状态模型，保留弹窗核对进度及刷新批次地址', async () => {
  const { state, navigations, requests } = await workspace()
  await state.loadReferences()
  Object.assign(state.state.header, header)
  const selected = new File(['xlsx'], '采购.xlsx')
  state.selectFile({ target: { files: { item: () => selected } } })
  state.dialogVisible.value = true
  await state.submitImport()
  assert.equal(requests[0][0], selected)
  assert.equal(state.state.rows[0].id, 10)
  assert.equal(state.dialogVisible.value, true)
  assert.deepEqual(navigations, [{ query: { from: 'test', batchId } }])
})

test('用户取消删除不会请求删除接口', async () => {
  const { state, removed } = await workspace(async () => { throw 'cancel' })
  state.state.batchId = batchId
  state.state.rows = [{ ...row }]
  await state.remove(state.state.rows[0])
  assert.equal(removed.length, 0)
  assert.equal(state.state.rows.length, 1)
})

test('真实来源组件呈现解析失败、工作表选择和逐规格原图确认', async () => {
  const { state } = await workspace()
  const page = state.page
  Object.assign(page.state, { batchId, tasks: [{ id: batchId, status: 'FAILED', errorCode: 'SHEET_SELECTION_REQUIRED', errorMessage: '请选择采购表', result: { sheets: ['采购A', '采购B'] } }], sources: [{ id: 8, fileName: '采购.xlsx', fileSha256: 'a'.repeat(64), status: 'FAILED' }], rows: [{ ...row, sourceSheet: '采购A', sourceRow: 2, images: [{ id: 9, sha256: 'b'.repeat(64), status: 'UNCONFIRMED' }] }] })
  const source = new URL('../src/modules/purchase/PurchaseImportSources.vue', import.meta.url)
  const bindings = loadVueScript(source, { ref, watch, onBeforeUnmount() {}, defineProps: () => ({ page }), defineEmits: () => () => {}, ElMessageBox: { async confirm() { throw 'cancel' } }, http: {} }, ['sheets', 'imageUrls', 'imageErrors', 'downloading', 'download', 'view', 'retry', 'publish'])
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

test('接口适配器发送真实multipart和带版本的保存删除约定', async () => {
  const calls = []
  const httpUrl = new URL('../src/api/http.ts', import.meta.url)
  const cache = new Map([[httpUrl.href, { http: Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, async (...args) => { calls.push([method, ...args]); return { accepted: true } }])) }]])
  const { purchaseImportApi: api } = loadTsModule(new URL('../src/modules/purchase/purchaseImportApi.ts', import.meta.url), cache)
  const selected = new File(['xlsx'], '采购.xlsx')
  await api.upload(selected, batchId, 'intent-123')
  assert.equal(calls[0][1], '/pur/order-imports')
  assert.ok(calls[0][2] instanceof FormData)
  assert.equal(calls[0][2].get('file').name, '采购.xlsx')
  assert.equal(calls[0][2].has('header'), false)
  assert.equal(calls[0][2].get('batchId'), batchId)
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
  await api.clearBatch(batchId, 2, batchId)
  await api.clearStatus(batchId)
  assert.equal(calls[5][0], 'delete'); assert.equal(calls[5][1], `/pur/order-imports/${batchId}`)
  assert.deepEqual(calls[5][2].headers, { 'If-Match': '2', 'Idempotency-Key': batchId })
  assert.equal(calls[6][1], `/pur/order-imports/${batchId}/clear-status`)
})

test('本地编辑使任务读取暂缓时仍会接续轮询，网络错误明确保留', async () => {
  const timers = []
  const { state } = await workspace(async () => {}, { setTimeout(callback) { timers.push(callback); return timers.length }, clearTimeout() {}, watch() {} })
  state.page.headerDirty = () => false
  Object.assign(state.page.state, { batchId, status: 'REVIEW', tasks: [{ id: batchId, kind: 'MATCH', status: 'RUNNING' }], edit: { id: 10, field: null, values: row } })
  state.page.refreshTasks = async () => false
  state.scheduleTasks(); await timers.shift()()
  assert.equal(timers.length, 1)
  state.page.state.edit = null
  state.page.refreshTasks = async () => { state.page.failure(new Error('网络读取失败')); return false }
  await timers.shift()()
  assert.equal(timers.length, 1); assert.match(state.page.state.error, /网络读取失败/)
})


test('红色新品待确认入口按未确认行显示角标，点击只打开原窗口不重启任务',async()=>{
  let requests=0
  const {state}=await workspace(undefined,{purchaseImportApi:{async load(){return {batchId,version:1,header,rows:[{...row,readiness:'UNRESOLVED'},{...row,id:11,rowNo:2,readiness:'READY'},{...row,id:12,rowNo:3,readiness:'UNRESOLVED'},{...row,id:13,rowNo:4,readiness:'UNRESOLVED',targetOrderLineId:99}]}},async startMatches(){requests++;throw new Error('仅打开窗口不能创建任务')}}})
  await state.page.loadBatch(batchId)
  assert.equal(state.reviewVisible.value,false)
  let html=await render(state)
  assert.match(html,/<button[^>]*type="danger"[^>]*aria-label="待确定是否为新商品，2行待确认"[^>]*>待确定是否为新商品<\/button>/)
  assert.doesNotMatch(html,/>AI图文核对<\/button>|>核对商品<\/button>|>核对助手<\/button>|>预览采购草稿<\/button>/)
  state.review(undefined,'match');assert.equal(state.reviewVisible.value,true);assert.equal(state.reviewTab.value,'match');assert.equal(state.reviewRow.value,10);assert.equal(requests,0)
  state.state.rows[0].readiness='READY';await nextTick();html=await render(state);assert.match(html,/待确定是否为新商品，1行待确认/)
  state.state.rows[2].readiness='READY';await nextTick();html=await render(state);assert.match(html,/待确定是否为新商品，0行待确认/);assert.match(html,/el-badge__content[^>]*>(?:<!--.*?-->)*0(?:<!--.*?-->)*<\/sup>/)
})
