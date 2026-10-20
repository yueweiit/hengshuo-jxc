import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, reactive, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

function shipmentPage(rows) {
  const calls = []
  const page = loadVueScript(new URL('../src/modules/logistics/ShipmentForm.vue', import.meta.url), {
    computed, reactive, ref, useCountryStore: () => ({ timezone: 'America/Mexico_City' }), countryDateTimeInput: value => value, defineEmits: () => () => {}, defineExpose() {}, createCommandIntent: () => ({}),
    http: { get: async (path, params) => { calls.push({ path, params }); return rows } },
  }, ['open', 'm', 'sources', 'totalQty', 'totalWeight', 'totalVolume'])
  return { ...page, calls }
}

test('unknown source dimensions remain unknown instead of being treated as zero or NaN', async () => {
  const page = shipmentPage([{ sourceLineId: 10, remainingQty: 5, unitWeight: null, unitVolume: null }, { sourceLineId: 11, remainingQty: 3 }])
  await page.open()
  page.sources.value[0].baseQty = 5
  page.sources.value[1].baseQty = 3
  assert.equal(page.totalQty.value, 8)
  assert.equal(page.totalWeight.value, null)
  assert.equal(page.totalVolume.value, null)
})
test('new shipment inputs preserve unknown box counts and do not guess an origin country or port', async () => {
  const page = shipmentPage([{ sourceLineId: 10, remainingQty: 5 }]); await page.open()
  assert.equal(page.m.originLocation, '')
  assert.equal(page.sources.value[0].boxes, null)
})

test('original node and transshipment dialogs leave unknown locations empty and box summaries remain unknown', async () => {
  const page = loadVueScript(new URL('../src/modules/logistics/ShipmentDetail.vue', import.meta.url), {
    computed, reactive, ref, watch() {}, onMounted() {}, useCountryStore: () => ({ timezone: 'America/Mexico_City' }), countryDateTimeInput: value => value, nowMs: () => 1, createCommandIntent: () => ({}),
    useRoute: () => ({ params: { id: 71 } }), useRouter: () => ({}), useUserStore: () => ({}),
  }, ['sh', 'openNode', 'node', 'openTransship', 'ts', 'summary'])
  page.sh.value = { status: 'IN_TRANSIT', transportMode: 'SEA', lines: [{ id: 1, boxes: null, intlQty: 5, pendingDeliveryQty: 0, onHoldQty: 0 }] }
  page.openNode(); assert.equal(page.node.location, '')
  page.openTransship(); assert.equal(page.ts.location, '')
  assert.deepEqual(page.summary({ columns: [{ property: '' }, { property: 'boxes' }, { property: 'intlQty' }] }), ['合计', '未维护', '5'])
})

test('native multi-product source dimensions aggregate existing base quantities and editing excludes its own plan', async () => {
  const page = shipmentPage([{ sourceLineId: 10, remainingQty: 5, productCode: 'P', poNo: 'PO-1', unitWeight: 1, unitVolume: 0.01 }, { sourceLineId: 11, remainingQty: 3, productCode: 'P2', poNo: 'PO-1', unitWeight: 2, unitVolume: 0.02 }])
  await page.open({ id: 701, lines: [{ sourceLineId: 10, baseQty: 2, boxes: 1 }] })
  assert.deepEqual(page.calls[0], { path: '/pur/shippable-sources', params: { excludeShipmentId: 701 } })
  page.sources.value[0].baseQty = 5
  page.sources.value[1].baseQty = 3
  assert.equal(page.totalQty.value, 8)
  assert.equal(page.totalWeight.value, 11)
  assert.equal(page.totalVolume.value, 0.11)
  assert.equal(page.sources.value[0].productCode, 'P')
  assert.equal(page.sources.value[1].productCode, 'P2')
})
