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
  const page = createPurchaseImportModel({ load: async () => batch(), uploadPhoto, async saveRow(_id, current, values) { return { ...current, ...values, version: current.version + 1 } } }, '2026-10-29', () => `11111111-2222-4333-8444-${String(++sequence).padStart(12, '0')}`)
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
    return { ...batch(), version: 3, rows: [{ ...row, ...args[3], version: 2, images: [{ id: 9, sha256: 'b'.repeat(64), status: 'CONFIRMED', origin: 'MANUAL_UPLOAD' }] }] }
  })
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], null)
  assert.equal(typeof page.selectPhoto, 'function', '照片编辑缺少文件选择能力')
  const file = imageFile()
  page.selectPhoto(file)
  page.state.edit.values.productSpec = 'M'
  assert.equal(await page.saveEdit(), false)
  assert.match(page.state.error, /存储不可用/)
  assert.equal(page.state.edit.photoFile, file)
  assert.equal(page.state.edit.values.productSpec, 'M')
  assert.equal(page.state.rows[0].images[0].id, 8)
  fail = false
  assert.equal(await page.saveEdit(), true)
  assert.equal(requests[0][4], requests[1][4])
  assert.equal(requests[1][3].purchaseUnitPrice, '53.0606250000')
  assert.equal(page.state.rows[0].images[0].id, 9)
  assert.equal(page.state.version, 3)
  assert.equal(page.state.edit, null)
})

test('文件或整行值变化后不复用旧上传key，非法文件不替换已选文件', async () => {
  const keys = []
  const page = setup(async (...args) => { keys.push(args[4]); throw new Error('连接中断') })
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], null)
  assert.equal(typeof page.selectPhoto, 'function', '照片编辑缺少文件选择能力')
  const selected = imageFile()
  page.selectPhoto(selected)
  await page.saveEdit()
  assert.equal(page.selectPhoto(new File(['text'], '商品.svg', { type: 'image/svg+xml' })), false)
  assert.equal(page.state.edit.photoFile, selected)
  page.state.edit.values.productSpec = 'L'
  await page.saveEdit()
  assert.notEqual(keys[0], keys[1])
  page.selectPhoto(imageFile())
  await page.saveEdit()
  assert.notEqual(keys[1], keys[2])
})

test('上传成功响应缺少新照片时不能清除草稿或声称保存成功', async () => {
  const page = setup(async () => ({ ...batch(), rows: [{ ...row, version: 2 }] }))
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], 'photo'); page.selectPhoto(imageFile())
  assert.equal(await page.saveEdit(), false)
  assert.ok(page.state.edit?.photoFile)
  assert.match(page.state.error, /照片/)
  assert.equal(page.state.rows[0].images[0].id, 8)
})

async function renderPhoto(page, editing = false) {
  const source = new URL('../src/modules/purchase/PurchaseImportPhoto.vue', import.meta.url)
  assert.ok(existsSync(source), '缺少照片列上传/预览组件')
  const props = { page, row: page.state.rows[0], editing, disabled: false }
  const state = loadVueScript(source, { ref, computed, watch, onBeforeUnmount() {}, defineProps: () => props, defineEmits: () => () => {} }, ['input', 'selectedUrl', 'legacyFailed', 'photos', 'first', 'legacy', 'preview', 'file', 'urls', 'errors', 'loading', 'choose'])
  const template = readFileSync(source, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app = createSSRApp({ setup: () => ({ ...state, ...props }), render: compile(template) })
  app.component('ElImage', defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('img', ctx.attrs) }))
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

test('表格实际输出两位数字，编辑其他字段时原数值仍是十位精度', async () => {
  const page = setup(); await page.loadBatch(batchId)
  const file = new URL('../src/modules/purchase/PurchaseImportTable.vue', import.meta.url)
  const { importColumns } = feature('purchaseImportModel'), { formatImportDecimal } = feature('purchaseImportDisplay')
  const state = loadVueScript(file, { nextTick, ref, importColumns, formatImportDecimal, defineProps: () => ({ page, disabled: false }), defineEmits: () => () => {} }, ['columns', 'editor', 'setEditor', 'begin', 'editing', 'saveCell'])
  const template = readFileSync(file, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1].replaceAll('(instance: Element | ComponentPublicInstance | null)', '(instance)')
  const app = createSSRApp({ setup: () => ({ ...state, formatImportDecimal, page, disabled: false }), render: compile(template) })
  const slot = defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('div', ctx.attrs, ctx.slots.default?.()) })
  app.component('ElTableColumn', defineComponent({ setup: (_, ctx) => () => h('div', ctx.slots.default?.({ row: page.state.rows[0] })) }))
  for (const name of ['ElTable', 'ElInput', 'ElTooltip', 'ElButton', 'ElIcon', 'Check', 'Close', 'EditPen', 'Delete']) app.component(name, slot)
  app.component('PurchaseImportPhoto', { render: () => null })
  const html = await renderToString(app)
  assert.match(html, />53\.06</); assert.match(html, />10\.00</)
  assert.doesNotMatch(html, /53\.0606250000/)
  assert.equal(page.state.rows[0].purchaseUnitPrice, '53.0606250000')
})

test('照片适配器发送文件、行版本、原数值及重试key，并通过受权接口读取原图', async () => {
  const calls = []
  const api = loadTsModule(moduleAt('purchaseImportApi'), new Map([[new URL('../src/api/http.ts', import.meta.url).href, { http: {
    async post(...args) { calls.push(['post', ...args]) }, async attachmentBlob(...args) { calls.push(['blob', ...args]); return new Blob() },
  } }]])).purchaseImportApi
  const file = imageFile(), key = '11111111-2222-4333-8444-555555555555'
  await api.uploadPhoto(batchId, row, file, row, key)
  assert.equal(calls[0][1], `/pur/order-imports/${batchId}/rows/1/image`)
  assert.equal(calls[0][2].get('file'), file)
  assert.equal(calls[0][2].get('version'), '1')
  assert.equal(JSON.parse(calls[0][2].get('values')).purchaseUnitPrice, '53.0606250000')
  assert.equal(calls[0][3].headers['Idempotency-Key'], key)
  await api.readImage(batchId, 8, new AbortController().signal)
  assert.equal(calls[1][1], `/api/v1/pur/order-imports/${batchId}/images/8/content`)
})
