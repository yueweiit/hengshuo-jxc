import { loadTsModule } from './contracts/load-ts-module.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compile, computed, createSSRApp, defineComponent, h, reactive, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { loadVueScript } from './contracts/load-vue-script.mjs'
const salesOrderActions = loadTsModule(new URL('../src/modules/sales/salesOrderActions.ts', import.meta.url))
const file = new URL('../src/modules/sales/SalesOrderDetail.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
const fixture = () => ({ id: 71, version: 5, totalQty: 20, openQty: 8, approvalStatus: 'APPROVED', fulfillmentStatus: 'PARTIAL_OUTBOUND', lines: [{ id: 11, productId: 501, unit: 'PCS', factor: 1, qty: 20, baseQty: 20, cancelledQty: 4, outboundQty: 8, openQty: 8, price: 21, priceVersionNo: 2, allocs: [{ id: 31, warehouseId: 401, allocQty: 20, cancelledQty: 4, outboundQty: 8, openQty: 8 }] }] })
function detail(beforeConfirm) {
  const calls = [], warnings = [], country = { epoch: 1, timezone: 'America/Mexico_City' }, route = { params: { id: '71' } }
  const possible = ['openCancel', 'saveCancellation', 'openAllocations', 'saveAllocations', 'allocationForm', 'cancelForm', 'submit', 'openOutbound', 'ob', 'canSubmit', 'canOutbound']
  const present = possible.filter(name => new RegExp(`(?:function|const|let)\\s+${name}\\b`).test(source))
  const page = loadVueScript(file, {
    ...salesOrderActions, computed, reactive, ref, watch() {}, onMounted() {}, createCommandIntent: () => ({ intent: 'stable' }),
    useRoute: () => route, useRouter: () => ({}), useCountryStore: () => country,
    useUserStore: () => ({ hasPerm: () => true, fieldAccess: () => 'WRITE' }),
    getCountryId: () => 101, getToken: () => 'fixture', todayIn: () => '2026-10-16',
    allRecords: async () => [{ id: 401, name: 'W1' }, { id: 402, name: 'W2' }],
    ElMessage: { warning: value => warnings.push(value), success() {} },
    BizError: class extends Error { constructor(code, message) { super(message); this.code = code } },
    confirmAction: async (_, action) => { beforeConfirm?.(country); await action(); return true },
    http: { get: async url => url.endsWith('/timeline') ? [] : fixture(), postIdem: async (url, body, intent) => { calls.push({ method: 'POST', url, body, intent }); return fixture() }, put: async (url, body) => { calls.push({ method: 'PUT', url, body }); return fixture() } },
  }, ['order', ...present])
  page.order.value = fixture()
  return { ...page, calls, warnings, country }
}

test('native cancel selects only requested owner open quantities with reason and current country date', async () => {
  const page = detail(); assert.equal(typeof page.openCancel, 'function', 'missing original cancel UI handler')
  page.openCancel(false); assert.equal(page.cancelForm.lines[0].openQty, 8)
  page.cancelForm.lines[0].qty = 3; page.cancelForm.reason = '合成未交取消'
  await page.saveCancellation()
  assert.equal(page.calls[0].url, '/sal/orders/71/cancel-lines')
  assert.deepEqual(page.calls[0].body, { bizDate: '2026-10-16', reason: '合成未交取消', lines: [{ lineId: 11, qty: 3 }] })
  assert.ok(page.calls[0].intent)
})
test('closing invokes the original close command without inventing line cancellations', async () => {
  const page = detail(); assert.equal(typeof page.openCancel, 'function', 'missing original close UI handler')
  page.openCancel(true); page.cancelForm.reason = '合成关闭余量'; await page.saveCancellation()
  assert.deepEqual(page.calls[0].body, { bizDate: '2026-10-16', reason: '合成关闭余量' })
  assert.equal(page.calls[0].url, '/sal/orders/71/close')
})
test('cancel rejects excess and requires a reason before sending any command', async () => {
  const page = detail(); assert.equal(typeof page.openCancel, 'function', 'missing native quantity guard')
  page.openCancel(false); page.cancelForm.lines[0].qty = 9; page.cancelForm.reason = 'too many'; await page.saveCancellation()
  page.cancelForm.lines[0].qty = 3; page.cancelForm.reason = ''; await page.saveCancellation()
  assert.equal(page.calls.length, 0); assert.ok(page.warnings.length >= 2)
})
test('allocation editor preserves source ids and price facts and sends only changed lines to existing owner API', async () => {
  const page = detail(); assert.equal(typeof page.openAllocations, 'function', 'missing original allocation UI handler')
  const original = JSON.stringify(page.order.value)
  await page.openAllocations(); assert.equal(page.allocationForm.bizDate, '2026-10-16'); page.allocationForm.bizDate = '2026-11-15'; page.allocationForm.lines[0].allocs[0].allocQty = 12
  page.allocationForm.lines[0].allocs.push({ warehouseId: 402, allocQty: 8 })
  await page.saveAllocations()
  assert.equal(page.calls[0].method, 'PUT'); assert.equal(page.calls[0].url, '/sal/orders/71/allocations')
  assert.equal(page.calls[0].body.version, 5)
  assert.equal(page.calls[0].body.bizDate, '2026-11-15')
  assert.equal(page.calls[0].body.lines[0].lineId, 11)
  assert.deepEqual(page.calls[0].body.lines[0].allocs.map(row => [row.id, row.warehouseId, row.allocQty]), [[31, 401, 12], [undefined, 402, 8]])
  assert.equal(JSON.stringify(page.order.value), original)
})
test('allocation date is required before the original versioned command is sent', async () => {
  const page = detail(); await page.openAllocations(); page.allocationForm.bizDate = ''
  page.allocationForm.lines[0].allocs[0].allocQty = 12; page.allocationForm.lines[0].allocs.push({ warehouseId: 402, allocQty: 8 })
  await page.saveAllocations(); assert.equal(page.calls.length, 0); assert.ok(page.warnings.some(value => value.includes('日期')))
})
test('allocation editor refuses nonconserving quantity and stale country context without an owner write', async () => {
  const page = detail(); assert.equal(typeof page.openAllocations, 'function', 'missing native allocation total guard')
  await page.openAllocations(); page.allocationForm.lines[0].allocs[0].allocQty = 12; await page.saveAllocations(); assert.equal(page.calls.length, 0)
  page.allocationForm.lines[0].allocs[0].allocQty = 19; page.allocationForm.lines[0].allocs.push({ warehouseId: 402, allocQty: 1 }); page.country.epoch++
  await page.saveAllocations(); assert.equal(page.calls.length, 0)
})

test('a context change while the confirmation is open cannot close another current order', async () => {
  const page = detail(country => { country.epoch++ }); page.openCancel(true); page.cancelForm.reason = 'context changed'
  await assert.rejects(page.saveCancellation(), /切换/); assert.equal(page.calls.length, 0)
})

test('展开分仓分列展示原量、取消量与有效量，保留完全取消后的零值', async () => {
  const fragment = source.match(/<div class="allocation-detail">[\s\S]*?<\/div>/)?.[0]
  assert.ok(fragment, '分仓应能展开查看')
  const line = { allocs: [{ id: 31, warehouseName: 'W1', allocQty: 12, cancelledQty: 4, outboundQty: 2, openQty: 6 }, { id: 32, warehouseName: 'W2', allocQty: 8, cancelledQty: 8, outboundQty: 0, openQty: 0 }, { id: 33, warehouseName: '历史缺失仓', allocQty: 5, cancelledQty: null }] }
  const before = JSON.stringify(line)
  const app = createSSRApp({ setup: () => ({ line }), render: compile(fragment) })
  // 仅替换表格框架；执行真实页面的每个单元格插槽与数量绑定。
  app.component('ElTable', defineComponent({ props: ['data'], setup: (props, { slots }) => () => h('table', props.data.map(row => h('tr', slots.default().map(column => h('td', [column.props.label, '：', column.children?.default ? column.children.default({ row }) : row[column.props.prop]]))))) }))
  app.component('ElTableColumn', defineComponent({ setup: () => () => null }))
  app.component('QtyText', defineComponent({ props: ['value'], setup: props => () => h('span', props.value == null ? '-' : String(props.value)) }))
  const html = (await renderToString(app)).replace(/<!--[\s\S]*?-->/g, '')
  assert.match(html, /W1[\s\S]*?原分仓量：<span>12<\/span>[\s\S]*?已取消：<span>4<\/span>[\s\S]*?有效分仓量：<span>8<\/span>/)
  assert.match(html, /W2[\s\S]*?有效分仓量：<span>0<\/span>/)
  assert.match(html, /历史缺失仓[\s\S]*?有效分仓量：<span>-<\/span>/)
  assert.equal(JSON.stringify(line), before)
})

for (const state of [
  { approvalStatus: 'DRAFT', fulfillmentStatus: 'CANCELLED', openQty: 0 },
  { approvalStatus: 'DRAFT', fulfillmentStatus: 'CLOSED', openQty: 0 },
  { approvalStatus: 'DRAFT', fulfillmentStatus: 'PENDING_PREPARE', openQty: 0 },
  { approvalStatus: 'APPROVED', fulfillmentStatus: 'CLOSED', openQty: 8 },
  { approvalStatus: 'APPROVED', fulfillmentStatus: 'OUTBOUNDED', openQty: 0 },
]) test(`停止供货或无未交数量的详情不能提交或打开出库分仓：${JSON.stringify(state)}`, async () => {
  const page = detail(); Object.assign(page.order.value, state)
  await page.submit(); await page.openOutbound(); await page.openAllocations()
  assert.equal(page.calls.length, 0)
  assert.equal(page.ob.visible, false); assert.equal(page.allocationForm.visible, false)
  assert.ok(page.warnings.length)
})
test('提交确认期间订单关闭则取消发送', async () => {
  const page = detail(() => { page.order.value.fulfillmentStatus = 'CLOSED' })
  page.order.value.approvalStatus = 'DRAFT'
  await assert.rejects(page.submit(), /关闭|供货|提交/)
  assert.equal(page.calls.length, 0)
})
