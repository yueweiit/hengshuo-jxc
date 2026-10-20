import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { computed, reactive, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
const require = createRequire(import.meta.url)
const exports = {}
const source = readFileSync(new URL('../src/utils/format.ts', import.meta.url), 'utf8')
new Function('require', 'exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText)(require, exports)
test('country wall time converts to the native offset instant and unknown time is never invented', () => {
  assert.equal(typeof exports.countryDateTimeToIso, 'function')
  assert.equal(exports.countryDateTimeToIso('2026-10-16 10:30:00', 'America/Mexico_City'), '2026-10-16T16:30:00.000Z')
  assert.equal(exports.countryDateTimeToIso('2026-10-16 10:30:00', 'Asia/Shanghai'), '2026-10-16T02:30:00.000Z')
  assert.equal(exports.countryDateTimeToIso(null, 'America/Mexico_City'), undefined)
  assert.throws(() => exports.countryDateTimeToIso('2026-10-16', 'America/Mexico_City'))
  assert.throws(() => exports.countryDateTimeToIso('2026-02-30 10:30:00', 'America/Mexico_City'))
  assert.equal(exports.countryDateTimeInput('2026-10-16T16:30:00Z', 'America/Mexico_City'), '2026-10-16 10:30:00.000')
  assert.equal(exports.countryDateTimeInput(null, 'America/Mexico_City'), undefined)
})
test('the actual shipment form submits explicit planned instants in the country timezone and leaves absent ETA unknown', async () => {
  const calls = []
  const page = loadVueScript(new URL('../src/modules/logistics/ShipmentForm.vue', import.meta.url), {
    computed, reactive, ref, defineEmits: () => () => {}, defineExpose() {}, createCommandIntent: () => ({}), useCountryStore: () => ({ timezone: 'America/Mexico_City' }),
    countryDateTimeToIso: (...args) => exports.countryDateTimeToIso(...args), countryDateTimeInput: (...args) => exports.countryDateTimeInput(...args), ElMessage: { success() {}, warning() {} },
    http: { get: async () => [{ sourceLineId: 10, remainingQty: 5 }], postIdem: async (path, body) => { calls.push({ path, body }); return { id: 1 } } },
  }, ['open', 'save', 'sources', 'm'])
  await page.open(); page.sources.value[0].baseQty = 5; page.m.plannedEtd = '2026-10-16 10:30:00'; page.m.plannedEta = null; await page.save(false)
  assert.equal(calls[0].body.plannedEtd, '2026-10-16T16:30:00.000Z'); assert.equal(calls[0].body.plannedEta, undefined)
  const markup = readFileSync(new URL('../src/modules/logistics/ShipmentForm.vue', import.meta.url), 'utf8')
  for (const field of ['plannedEtd', 'plannedEta']) assert.match(markup, new RegExp(`v-model="m\\.${field}" type="datetime" value-format="YYYY-MM-DD HH:mm:ss.SSS"`))
  assert.match(markup, /country\.timezone/)
})

for (const [zone, wall] of [['America/Mexico_City', '2026-10-16 10:30:00.123'], ['Asia/Shanghai', '2026-10-17 00:30:00.123']]) {
  test(`all five original logistics dialogs preserve the instant through country wall time in ${zone}`, async () => {
    const calls = [], instant = '2026-10-16T16:30:00.123Z'
    const shipment = { id: 71, status: 'RELEASED', originLocation: 'Known origin', transportMode: 'SEA', destWarehouseId: 401, lines: [{ id: 1, intlQty: 5, pendingDeliveryQty: 2, onHoldQty: 0 }] }
    const page = loadVueScript(new URL('../src/modules/logistics/ShipmentDetail.vue', import.meta.url), {
      computed, reactive, ref, onMounted() {}, watch() {}, createCommandIntent: () => ({}), nowMs: () => Date.parse(instant), toIso: value => new Date(value).toISOString(),
      useCountryStore: () => ({ timezone: zone }), useRoute: () => ({ params: { id: 71 } }), useRouter: () => ({}), useUserStore: () => ({ hasPerm: () => true }),
      countryDateTimeToIso: (...args) => exports.countryDateTimeToIso(...args), countryDateTimeInput: (...args) => exports.countryDateTimeInput(...args),
      ElMessage: { success() {}, warning() {} }, http: { get: async path => path.endsWith('/related') ? {} : shipment, postIdem: async (path, body) => { calls.push({ path, body }); return {} } },
    }, ['sh', 'dispatch', 'node', 'correct', 'ts', 'dl', 'openDispatch', 'openNode', 'openCorrect', 'openTransship', 'openDelivery', 'submitDispatch', 'submitNode', 'submitCorrect', 'submitTransship', 'submitDelivery'])
    page.sh.value = shipment
    page.openDispatch(); assert.equal(page.dispatch.actualEtd, wall); await page.submitDispatch()
    page.openNode(); assert.equal(page.node.actualAt, wall); await page.submitNode()
    page.openCorrect({ id: 19, actualAt: instant, location: 'Known place' }); assert.equal(page.correct.actualAt, wall); page.correct.remark = 'Explicit correction'; await page.submitCorrect()
    page.openTransship(); assert.equal(page.ts.transshipAt, wall); page.ts.toContainerNo = 'NEW'; await page.submitTransship()
    page.openDelivery(); assert.equal(page.dl.plannedAt, wall); await page.submitDelivery()
    assert.equal(calls.length, 5)
    for (const [index, field] of ['actualEtd', 'actualAt', 'actualAt', 'transshipAt', 'plannedAt'].entries()) assert.equal(calls[index].body[field], instant)
    const markup = readFileSync(new URL('../src/modules/logistics/ShipmentDetail.vue', import.meta.url), 'utf8')
    for (const field of ['dispatch.actualEtd', 'node.actualAt', 'correct.actualAt', 'ts.transshipAt', 'dl.plannedAt']) assert.match(markup, new RegExp(`v-model="${field.replace('.', '\\.')}" type="datetime" value-format="YYYY-MM-DD HH:mm:ss.SSS"`))
    assert.match(markup, /country\.timezone/)
  })
}
