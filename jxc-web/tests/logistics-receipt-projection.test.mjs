import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, reactive, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const full = (id = 71) => ({ id, version: 1, status: 'DRAFT', bizDate: '2026-10-16', deliveryNo: 'D-1', shipmentNo: 'S-1', warehouseName: 'W-1', lines: [{ id: 11, dispatchQty: 30, goodQty: 30, damagedQty: 0, pendingInspectQty: 0, shortQty: 0 }] })
function receipt(beforeConfirm, get) {
  const route = reactive({ params: { id: '71' } }), context = { country: 101, token: 'session-a' }, calls = []
  const page = loadVueScript(new URL('../src/modules/logistics/LgsReceiptForm.vue', import.meta.url), {
    computed, ref, watch() {}, onMounted() {}, nextTick: fn => fn(), createCommandIntent: () => ({}),
    useRoute: () => route, useRouter: () => ({}), useUserStore: () => ({ hasPerm: () => true }),
    getCountryId: () => context.country, getToken: () => context.token,
    BizError: class extends Error { constructor(code, message) { super(message); this.code = code } },
    ElMessage: { success() {}, error() {} }, ElMessageBox: { confirm: async () => beforeConfirm?.(context) },
    http: { get: async url => { calls.push(['GET', url]); return get ? get(url) : { ...full(), status: 'CONFIRMED', receivedByName: 'Receiver' } }, put: async url => { calls.push(['PUT', url]); return { id: 71, status: 'DRAFT', lines: full().lines } }, postIdem: async url => { calls.push(['POST', url]); return { id: 71, status: 'CONFIRMED', lines: full().lines } } },
  }, ['r', 'load', 'saveDraft', 'confirm'])
  page.r.value = full(); return { ...page, calls, route, context }
}
for (const operation of ['saveDraft', 'confirm']) test(`${operation} reloads the original owner projection instead of replacing labels with a raw command response`, async () => {
  const page = receipt(); await page[operation]()
  assert.equal(page.r.value.deliveryNo, 'D-1'); assert.equal(page.r.value.shipmentNo, 'S-1'); assert.equal(page.r.value.warehouseName, 'W-1')
  assert.ok(page.calls.some(([method, url]) => method === 'GET' && url === '/lgs/receipts/71'))
})
test('a context change during the confirmation cannot submit an old receipt command', async () => {
  const page = receipt(context => { context.country = 102 })
  await assert.rejects(page.confirm(), error => error.code === 'CONTEXT_CHANGED')
  assert.equal(page.calls.filter(([method]) => method === 'POST').length, 0)
})
test('a preceding receipt read cannot overwrite another current receipt', async () => {
  let firstResolve; const page = receipt(null, url => url.endsWith('/71') ? new Promise(resolve => { firstResolve = resolve }) : full(72))
  const first = page.load(); page.route.params.id = '72'; await page.load(); firstResolve(full(71)); await first
  assert.equal(page.r.value.id, 72)
})
