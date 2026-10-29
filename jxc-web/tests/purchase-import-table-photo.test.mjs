import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { ref, computed, watch, nextTick, compile, createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const moduleAt = name => new URL(`../src/modules/purchase/${name}.ts`, import.meta.url)
function feature(name) {
  assert.ok(existsSync(moduleAt(name)), `缺少${name}的真实实现`)
  return loadTsModule(moduleAt(name))
}
const batchId = '11111111-2222-4333-8444-555555555555'
const header = { bookId: null, supplierId: null, currency: null, orderDate: null, expectedDate: null, paymentTerms: '', prepayRatio: null, termDays: null }
const row = { id: 1, version: 1, rowNo: 1, sourceOrderNo: 'PO', photo: null, productSpec: 'S', purchaseQty: '10.0000', saleUnitPrice: null, saleTotal: null, purchaseUnitPrice: '53.0606250000', freight: null, landedUnitCost: null, usdUnitCost: null, usdTotal: null, images: [{ id: 8, sha256: 'a'.repeat(64), status: 'UNCONFIRMED' }] }
const batch = () => ({ batchId, header: { ...header }, version: 2, status: 'REVIEW', rows: [structuredClone(row)] })
function setup(uploadPhoto) {
  let sequence = 0
  const { createPurchaseImportModel } = feature('purchaseImportModel')
  const page = createPurchaseImportModel({ load: async () => batch(), uploadPhoto, async saveGrid(input) { return { ...batch(), version: 3, rows: [{ ...row, ...input.rows[0].values, ...input.rows[0].matchInputs, version: 2 }] } } }, '2026-10-29', () => `11111111-2222-4333-8444-${String(++sequence).padStart(12, '0')}`)
  return page
}
const imageFile = () => new File(['fixture-image-bytes'], '商品.png', { type: 'image/png' })

test('数字按精确十进制四舍五入显示两位，补零、进位、大数和未知值分别保留语义', () => {
  const { formatImportDecimal } = feature('purchaseImportDisplay')
  for (const [value, expected] of [
    ['53.0606250000', '53.06'], ['10.0000', '10.00'], ['0', '0.00'],
    ['9.995', '10.00'], ['1.005', '1.01'], ['0.0049', '0.00'],
    ['99999999999999999999.995', '100000000000000000000.00'], [null, '待核实'],
  ]) assert.equal(formatImportDecimal(value), expected, String(value))
})

test('同一批次多行共用一张图片时只读取一次，清理释放已创建的URL', async () => {
  const { createPurchaseImportImages } = feature('purchaseImportImages')
  let reads = 0
  const cache = createPurchaseImportImages(async () => { reads++; return new Blob(['image'], { type: 'image/png' }) }, () => batchId)
  const [one, two] = await Promise.all([cache.load(8), cache.load(8)])
  assert.equal(one.status, 'ok'); assert.equal(two.status, 'ok')
  assert.equal(one.url, two.url); assert.equal(reads, 1)
  const url = one.url
  cache.reset()
  assert.deepEqual(cache.urls.value, {})
  await assert.rejects(fetch(url))
})

test('图片读取失败保留错误且可重试，切批次后忽略旧响应', async () => {
  const { createPurchaseImportImages } = feature('purchaseImportImages')
  let id = batchId, fail = true, finish
  const cache = createPurchaseImportImages(async () => {
    if (fail) throw new Error('原图读取超时')
    return new Promise(resolve => { finish = resolve })
  }, () => id)
  assert.equal((await cache.load(8)).status, 'error')
  assert.match(cache.errors.value[8], /超时/)
  fail = false
  const pending = cache.load(8)
  id = '22222222-2222-4333-8444-555555555555'
  cache.reset()
  finish(new Blob(['image'], { type: 'image/png' }))
  assert.equal((await pending).status, 'stale')
  assert.deepEqual(cache.urls.value, {})
  assert.deepEqual(cache.errors.value, {})
})

test('取消照片编辑不上传，普通字段保存不因两位显示改变原始数字', async () => {
  let uploads = 0
  const page = setup(async () => { uploads++; throw new Error('不应上传') })
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], 'photo')
  assert.equal(typeof page.selectPhoto, 'function', '照片编辑缺少文件选择能力')
  assert.equal(page.selectPhoto(imageFile()), true)
  page.cancelEdit()
  assert.equal(uploads, 0)
  page.startEdit(page.state.rows[0], 'productSpec')
  page.state.edit.values.productSpec = 'M'
  assert.equal(await page.saveEdit(), true)
  assert.equal(page.state.rows[0].purchaseUnitPrice, '53.0606250000')

})

test('整行上传失败保留文件和草稿，相同请求重试复用key并采用保存后的图片和版本', async () => {
  const requests = []; let fail = true
  const page = setup(async (...args) => {
    requests.push(args)
    if (fail) throw new Error('图片存储不可用')
    return { ...batch(), version: 4, rows: [{ ...row, ...args[3], version: args[1].version + 1, images: [{ id: 9, sha256: 'b'.repeat(64), status: 'CONFIRMED', origin: 'MANUAL_UPLOAD' }] }] }
  })
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], null)
  assert.equal(typeof page.selectPhoto, 'function', '照片编辑缺少文件选择能力')
  const file = imageFile()
  page.selectPhoto(file)
  page.state.edit.values.productSpec = 'M'
  assert.equal(await page.saveEdit(), true)
  assert.equal(requests.length, 0)
  assert.equal(await page.grid.save(), false)
  assert.match(page.state.error, /存储不可用/)
  assert.equal(page.grid.photo(1), file)
  assert.equal(page.grid.rows()[0].productSpec, 'M')
  assert.equal(page.state.rows[0].images[0].id, 8)
  fail = false
  assert.equal(await page.grid.save(), true)
  assert.equal(requests[0][4], requests[1][4])
  assert.equal(requests[1][3].purchaseUnitPrice, '53.0606250000')
  assert.equal(page.state.rows[0].images[0].id, 9)
  assert.equal(page.state.version, 4)
  assert.equal(page.state.edit, null)
})

test('非法文件不替换已选文件，未知上传结果锁定原请求直至核实', async () => {
  const keys = []
  const page = setup(async (...args) => { keys.push(args[4]); throw new Error('连接中断') })
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], null)
  assert.equal(typeof page.selectPhoto, 'function', '照片编辑缺少文件选择能力')
  const selected = imageFile()
  page.selectPhoto(selected)
  assert.equal(page.selectPhoto(new File(['text'], '商品.svg', { type: 'image/svg+xml' })), false)
  assert.equal(page.state.edit.photoFile, selected)
  await page.saveEdit()
  assert.equal(await page.grid.save(), false)
  assert.equal(page.grid.selectPhoto(1, imageFile()), false)
  assert.equal(page.startEdit(page.grid.rows()[0], null), false)
  assert.equal(await page.grid.save(), false)
  assert.equal(keys[0], keys[1])
})

test('上传成功响应缺少新照片时不能清除草稿或声称保存成功', async () => {
  const page = setup(async () => ({ ...batch(), rows: [{ ...row, version: 2 }] }))
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], 'photo'); page.selectPhoto(imageFile())
  assert.equal(await page.saveEdit(), true)
  assert.equal(await page.grid.save(), false)
  assert.ok(page.grid.photo(1))
  assert.match(page.state.error, /照片/)
  assert.equal(page.state.rows[0].images[0].id, 8)
})

async function renderPhoto(page, editing = false, disabled = false) {
  const source = new URL('../src/modules/purchase/PurchaseImportPhoto.vue', import.meta.url)
  assert.ok(existsSync(source), '缺少照片列上传/预览组件')
  const props = { page, row: page.state.rows[0], editing, disabled }
  const state = loadVueScript(source, { ref, computed, watch, onBeforeUnmount() {}, defineProps: () => props, defineEmits: () => () => {} }, ['input', 'selectedUrl', 'legacyFailed', 'photos', 'first', 'thumbnail', 'failed', 'legacy', 'preview', 'file', 'urls', 'errors', 'loading', 'choose'])
  const template = readFileSync(source, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app = createSSRApp({ setup: () => ({ ...state, ...props }), render: compile(template) })
  app.component('ElImage', defineComponent({ inheritAttrs: false, props: ['previewSrcList'], setup: (props, ctx) => () => h('img', { ...ctx.attrs, 'data-preview-count': props.previewSrcList?.length ?? 0 }) }))
  app.component('ElButton', defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('button', ctx.attrs, ctx.slots.default?.()) }))
  return { html: await renderToString(app), state }
}

test('真实照片模板显示受权原图、待核实状态和上传控件，排除的照片不参与预览', async () => {
  const page = setup(); await page.loadBatch(batchId)
  page.state.rows[0].images.push({ id: 9, sha256: 'b'.repeat(64), status: 'REJECTED' })
  page.images.urls.value[8] = 'blob:original'; page.images.urls.value[9] = 'blob:rejected'
  page.startEdit(page.state.rows[0], null)
  const { html } = await renderPhoto(page, true)
  assert.match(html, /src="blob:original"/)
  assert.match(html, /归属待核实/)
  assert.match(html, /type="file"/)
  assert.match(html, /选择替换照片/)
  assert.doesNotMatch(html, /type="text"|blob:rejected/)
})

test('核对锁定时照片继续显示，但预览与替换入口均不可操作', async () => {
  const page=setup();await page.loadBatch(batchId);page.images.urls.value[8]='blob:original'
  const {html}=await renderPhoto(page,false,true)
  assert.match(html,/src="blob:original"/);assert.match(html,/data-preview-count="0"/)
  assert.match(html,/disabled[^>]*>替换照片/)
})

test('真实照片模板区分无图和读取失败，未保存选图可取消且不发送请求', async () => {
  const page = setup(); await page.loadBatch(batchId)
  page.state.rows[0].images = []
  assert.match((await renderPhoto(page)).html, /未上传/)
  page.state.rows[0].images = [row.images[0]]
  await page.images.load(8)
  const failed = await renderPhoto(page)
  assert.match(failed.html, /接口尚未接入/)
  assert.match(failed.html, /重试加载/)
  assert.doesNotMatch(failed.html, />未上传</)
  page.cancelEdit()
})

test('多张照片中部分读取失败仍显示可用图片，并明确失败照片可重试', async () => {
  const page = setup(); await page.loadBatch(batchId)
  page.state.rows[0].images.push({ id: 9, sha256: 'b'.repeat(64), status: 'CONFIRMED' })
  page.images.errors.value[8] = '第一张照片读取失败'
  page.images.urls.value[9] = 'blob:second'
  const { html } = await renderPhoto(page)
  assert.match(html, /src="blob:second"/)
  assert.match(html, /第一张照片读取失败/)
  assert.match(html, /重试加载/)
})

async function renderDraftPreview(page) {
  const previewSource=new URL('../src/modules/purchase/PurchaseImportPreviewDrawer.vue',import.meta.url), emitted=[]
  const props={page,modelValue:true,books:[],suppliers:[],currencies:[],creationEnabled:true,creationLoading:false,creationError:''}
  const {purchaseOrderSaveStatus}=feature('purchaseImportWorkflow'),{formatImportDecimal}=feature('purchaseImportDisplay')
  const issues=feature('purchaseImportIssues')
  const bindings=loadVueScript(previewSource,{ref,computed,watch,defineProps:()=>props,defineEmits:()=>(...args)=>emitted.push(args),formatImportDecimal,purchaseOrderSaveStatus,...issues},['editingVersion','editing','header','split','locked','edit','save','productLabel','groupRows','status','purchaseOrderSaveStatus','pendingReview','reviewIssue','issueRowLabel'])
  const template=readFileSync(previewSource,'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app=createSSRApp({setup:()=>({...bindings,...props,formatImportDecimal,...issues}),render:compile(template)})
  const slot=defineComponent({inheritAttrs:false,setup:(_,ctx)=>()=>h('div',ctx.attrs,[ctx.slots.default?.(),ctx.slots.footer?.()])})
  for(const name of ['ElDrawer','ElAlert','ElButton','ElForm','ElFormItem','ElSelect','ElOption','ElInput','ElCheckbox','ElCollapse','ElCollapseItem','RouterLink'])app.component(name,slot)
  return {html:await renderToString(app),bindings,emitted}
}

test('预览汇总税率缺项并保留来源，行入口定位到原核对行，失效行明确报错', async () => {
  const page=setup();await page.loadBatch(batchId)
  page.state.rows=Array.from({length:60},(_,n)=>({...row,id:n+1,rowNo:n+1}))
  const errors=page.state.rows.map(item=>({rowId:item.id,sourceSheet:'采购',sourceRow:18,field:'taxRate',message:'本行税率待核实，请明确填写'}))
  page.state.groups=[{id:7,version:1,sourceOrderNo:'NY-051',header:{...header},createStatus:'DRAFT',orderId:null,preview:null,errors,feeTodos:[]}]
  const {html,bindings,emitted}=await renderDraftPreview(page)
  assert.match(html,/本行税率待核实，请明确填写（60行）/)
  assert.match(html,/<details/);assert.match(html,/查看第60行/);assert.match(html,/采购.*原第18行/)
  bindings.reviewIssue(errors[59]);assert.equal(emitted.at(-1)[0],'review');assert.equal(emitted.at(-1)[1].id,60)
  bindings.reviewIssue({...errors[0],rowId:999});assert.match(page.state.error,/明细.*变化/)
  assert.equal(page.state.groups[0].errors.length,60)
})
test('预览只展示费用结果并引导基础信息，表头修改仍上报未保存状态',async()=>{
  const page=setup();await page.loadBatch(batchId)
  page.state.groups=[{id:7,version:1,sourceOrderNo:'PO',header:{...header},createStatus:'READY',orderId:null,preview:null,errors:[],feeTodosVersion:1,feeTodos:[{sourceRowIds:[1],scope:null,amount:null,currency:null,reason:'待核对',reviewStatus:'UNRESOLVED'}]}]
  const {bindings,emitted,html}=await renderDraftPreview(page),group=page.state.groups[0]
  assert.equal(bindings.pendingReview.value,false)
  assert.match(html,/本次导入费用/);assert.match(html,/基础信息/)
  assert.doesNotMatch(html,/保存费用核对|aria-label="费用金额"|aria-label="费用原币"/)
  bindings.edit(group);await nextTick();assert.equal(emitted.at(-1)[1],true)
  bindings.editing.value=null;await nextTick();assert.equal(emitted.at(-1)[1],false)
})
async function renderImportTable(page) {
  const file = new URL('../src/modules/purchase/PurchaseImportTable.vue', import.meta.url)
  const { importTableColumns } = feature('purchaseImportModel'), display = feature('purchaseImportDisplay')
  const state = loadVueScript(file, { nextTick, ref, importTableColumns, ...display, defineProps: () => ({ page, disabled: false }), defineEmits: () => () => {} }, ['columns', 'editor', 'setEditor', 'begin', 'editing', 'saveCell', 'displayNumber'])
  const template = readFileSync(file, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1].replaceAll('(instance: Element | ComponentPublicInstance | null)', '(instance)')
  const app = createSSRApp({ setup: () => ({ ...state, ...display, page, disabled: false }), render: compile(template) })
  const slot = defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('div', ctx.attrs, ctx.slots.default?.()) })
  app.component('ElTableColumn', defineComponent({ setup: (_, ctx) => () => h('div', ctx.slots.default?.({ row: page.state.rows[0] })) }))
  for (const name of ['ElTable', 'ElInput', 'ElTooltip', 'ElButton', 'ElIcon', 'Check', 'Close', 'EditPen', 'Delete']) app.component(name, slot)
  app.component('PurchaseImportPhoto', { render: () => null })
  return renderToString(app)
}

test('来源名称为空时显示已核对商品名和来源，编辑仍为空且不产生待上传内容', async () => {
  const page = setup(); await page.loadBatch(batchId)
  for (const decision of ['EXISTING', 'NEW_REQUESTED']) {
    Object.assign(page.state.rows[0], { suppliedProductName: null, matchedProductId: 501, decision, readiness: 'READY', productSnapshot: { id: 501, name: '库存商品甲' } })
    const before = JSON.stringify(page.state.rows[0]), html = await renderImportTable(page)
    assert.match(html, /库存商品甲/); assert.match(html, /已核对商品/)
    assert.equal(JSON.stringify(page.state.rows[0]), before); assert.equal(page.grid.hasChanges(), false)
    assert.equal(page.startEdit(page.state.rows[0], 'suppliedProductName'), true)
    assert.equal(page.state.edit.values.suppliedProductName, null)
    page.cancelEdit()
  }
})

test('当前唯一推荐可先显示AI待确认名称，保留空来源、图片归属和最终商品选择', async () => {
  const page = setup(); await page.loadBatch(batchId)
  Object.assign(page.state.rows[0], { suppliedProductName: null, decision: 'UNRESOLVED', matchedProductId: null, matchTaskId: batchId,
    matchResult: { runId: batchId, inputRevision: 1, ranking: { status: 'RECOMMENDED', recommendedIds: [501] }, candidates: [{ productId: 501, product: { id: 501, name: '推荐商品甲' } }] } })
  const before = JSON.stringify(page.state.rows[0]), html = await renderImportTable(page)
  assert.match(html, /推荐商品甲/); assert.match(html, /AI推荐、待确认/)
  assert.equal(JSON.stringify(page.state.rows[0]), before); assert.equal(page.grid.hasChanges(), false)
  page.startEdit(page.state.rows[0], 'suppliedProductName'); assert.equal(page.state.edit.values.suppliedProductName, null)
})

test('过期、歧义、缺失与未达标推荐不显示为AI商品名', async () => {
  const page = setup(); await page.loadBatch(batchId)
  const current = { runId: batchId, inputRevision: 1, ranking: { status: 'RECOMMENDED', recommendedIds: [501] }, candidates: [{ productId: 501, product: { id: 501, name: '推荐商品甲' } }] }
  for (const result of [{ ...current, inputRevision: 2 }, { ...current, runId: 'other' }, { ...current, ranking: { status: 'NEEDS_REVIEW', recommendedIds: [] } }, { ...current, ranking: { status: 'RECOMMENDED', recommendedIds: [501,502] } }, { ...current, candidates: [] }]) {
    Object.assign(page.state.rows[0], { suppliedProductName: null, matchTaskId: batchId, matchResult: result })
    assert.doesNotMatch(await renderImportTable(page), /推荐商品甲|AI推荐、待确认/)
  }
})

test('来源名称优先，未确认、错绑与不完整快照不能冒充已核对商品名', async () => {
  const page = setup(); await page.loadBatch(batchId)
  const base = { suppliedProductName: null, matchedProductId: 501, decision: 'EXISTING', readiness: 'READY', productSnapshot: { id: 501, name: '库存商品甲' } }
  for (const fields of [{ decision: 'UNRESOLVED' }, { decision: 'NEW' }, { matchedProductId: null }, { productSnapshot: { id: 999, name: '库存商品甲' } }, { productSnapshot: { id: 501 } }, { suppliedProductName: '原表名称' }]) {
    Object.assign(page.state.rows[0], base, fields)
    const html = await renderImportTable(page)
    assert.doesNotMatch(html, /库存商品甲|已核对商品/)
    if (fields.suppliedProductName) assert.match(html, /原表名称/)
  }
})

test('表格与完整预览输出两位数字，编辑和提交仍保留原精度', async () => {
  const page = setup(); await page.loadBatch(batchId)
  const html = await renderImportTable(page)
  assert.match(html, />53\.06</); assert.match(html, />10\.00</)
  assert.doesNotMatch(html, /53\.0606250000/)
  assert.equal(page.state.rows[0].purchaseUnitPrice, '53.0606250000')
  const previewLine={lineNo:1,productId:501,productSpec:'S',qty:'10.0000',unit:'PCS',sourceUnitPrice:'53.0606250000',unitPrice:'53.0606',unitPriceDifference:'-0.0000250000',taxRate:'0.0000000000',amount:'530.6060'}
  page.state.groups=[{id:7,version:1,sourceOrderNo:'PO',createStatus:'CREATED',orderId:8,header:{...header,taxRate:'0.0000000000'},preview:{lines:[previewLine],totalAmount:'530.6060',taxAmount:'0.0000'},errors:[],feeTodos:[],sourceEvidence:[]}]
  const {html:previewHtml}=await renderDraftPreview(page)
  assert.match(previewHtml,/>53\.06</);assert.match(previewHtml,/>10\.00 PCS</);assert.match(previewHtml,/>-0\.00</);assert.match(previewHtml,/货款 530\.61/)
  assert.equal(previewLine.sourceUnitPrice,'53.0606250000');assert.equal(previewLine.unitPriceDifference,'-0.0000250000')
})

test('照片适配器发送文件、行版本、原数值及重试key，并通过受权接口读取原图', async () => {
  const calls = []
  const api = loadTsModule(moduleAt('purchaseImportApi'), new Map([[new URL('../src/api/http.ts', import.meta.url).href, { http: {
    async post(...args) { calls.push(['post', ...args]) }, async attachmentBlob(...args) { calls.push(['blob', ...args]); return new Blob() },
  } }]])).purchaseImportApi
  const file = imageFile(), key = '11111111-2222-4333-8444-555555555555'
  await api.uploadPhoto(batchId, row, file, row, key, {suppliedProductName:'同次上传名称',suppliedProductCode:null,supplierProductCode:null})
  assert.equal(calls[0][1], `/pur/order-imports?batchId=${batchId}&imageRowId=1`)
  assert.equal(calls[0][2].get('file'), file)
  assert.equal(calls[0][2].get('version'), '1')
  assert.equal(JSON.parse(calls[0][2].get('values')).purchaseUnitPrice, '53.0606250000')
  assert.equal(JSON.parse(calls[0][2].get('matchInputs')).suppliedProductName, '同次上传名称')
  assert.equal(calls[0][3].headers['Idempotency-Key'], key)
  await api.readImage(batchId, 8, new AbortController().signal)
  assert.equal(calls[1][1], `/api/v1/pur/order-imports/${batchId}/images/8/content`)
})
