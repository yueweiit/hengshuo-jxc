import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as vue from 'vue'
import { compile } from '@vue/compiler-dom'
import './support.mjs'
import { createCommandIntent } from '../src/api/command-intent.ts'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/cost/InboundCostList.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
const candidate = { billId: 90, billLineId: 91, docNo: 'AP-90', currency: 'CNY', baseCurrency: 'MXN', rate: 2.5, canonicalSourceId: 52, availableQty: 80, billQty: 80, billAmount: 800, billBaseAmount: 2000, lineAmount: 800, principalAmount: 2000, compatible: true, basisReason: '' }
const basis = (patch = {}) => ({ costId: 7, bookId: 6, version: 0, status: 'UNASSIGNED', qty: 30, assignedQty: 0, remainingQty: 30, srcCurrency: 'CNY', baseCurrency: 'MXN', rate: 2.5, basePurchaseAmount: 750, sourceNo: 'CST-7', basisStatus: 'WAITING', basisReason: '关联数量尚未覆盖成本数量', canEdit: true, lines: [], candidates: [candidate], ...patch })
function page({ ap = true, cost = 'WRITE', canEdit = true, get, put } = {}) {
  const calls = [], warnings = [], context = { token: 'session-A', countryId: 3 }, country = vue.reactive({ epoch: 1, timezone: 'America/Mexico_City' })
  const names = ['openAssignment', 'saveAssignment', 'addAssignmentLine', 'clearAssignmentLines', 'assignment', 'canEditAssignment', 'canReadAssignment', 'assignmentQty']
  const exposed = names.filter(name => new RegExp(`(?:function|const|let)\\s+${name}\\b`).test(source))
  const p = loadVueScript(file, {
    ref: vue.ref, reactive: vue.reactive, computed: vue.computed, onMounted() {}, watch() {}, useRoute: () => ({ query: {} }), useRouter: () => ({}),
    useCountryStore: () => country, useUserStore: () => ({ token: context.token, hasPerm: codes => (Array.isArray(codes) ? codes : [codes]).some(code => code === 'ap:bill:view' ? ap : code === 'cst:cost:confirm' ? canEdit : code === 'cst:cost:view'), fieldAccess: () => cost }),
    getToken: () => context.token, getCountryId: () => context.countryId, todayIn: () => '2026-10-16', createCommandIntent,
    ElMessage: { warning: x => warnings.push(x), success() {} }, ElMessageBox: { confirm: async () => {} },
    http: { get: async url => { calls.push({ method: 'GET', url }); return get ? get(url) : url.startsWith('/ap/cost-assignments/') ? structuredClone(basis(ap ? {} : { canEdit: false, lines: [], candidates: [] })) : { records: [], total: 0, counts: {} } }, putIdem: async (url, body, intent) => intent.run(`${context.token}:${context.countryId}`, `PUT ${url}`, body, async key => { calls.push({ method: 'PUT', url, body: structuredClone(body), key }); return put ? put(url, body) : basis({ version: 1, status: 'DRAFT', assignedQty: 30, remainingQty: 0, basisStatus: 'READY', basisReason: '', lines: [{ billId: 90, billLineId: 91, docNo: 'AP-90', baseQty: 30, principalAmount: null, currency: 'CNY', rate: 2.5, baseCurrency: 'MXN' }] }) }) },
  }, exposed)
  return { ...p, calls, warnings, context, country }
}
function ready(p) { assert.equal(typeof p.openAssignment, 'function', 'missing original cost-page explicit bill assignment handler') }

test('an eligible single bill remains unselected until the operator explicitly chooses it', async () => {
  const p = page(); ready(p); await p.openAssignment({ id: 7, poId: 52 })
  assert.equal(p.assignment.data.candidates.length, 1); assert.deepEqual(p.assignment.lines, [])
  p.addAssignmentLine(p.assignment.data.candidates[0]); assert.equal(p.assignment.lines[0].billLineId, 91); assert.equal(p.assignment.lines[0].baseQty, undefined)
  assert.equal(p.calls.filter(x => x.method === 'PUT').length, 0)
})
test('explicit save sends only native CAS/base quantities with a UUID and never confirms cost or generates a voucher', async () => {
  const p = page(); ready(p); await p.openAssignment({ id: 7, poId: 52 }); p.addAssignmentLine(p.assignment.data.candidates[0]); p.assignment.lines[0].baseQty = 30; await p.saveAssignment()
  const commands = p.calls.filter(x => x.method === 'PUT'); assert.equal(commands.length, 1); assert.equal(commands[0].url, '/ap/cost-assignments/7'); assert.deepEqual(commands[0].body, { version: 0, lines: [{ billLineId: 91, baseQty: 30 }] }); assert.match(commands[0].key, /^[0-9a-f-]{36}$/i)
  assert.equal(p.assignment.data.version, 1); assert.equal(p.assignment.data.lines[0].principalAmount, null)
  assert.ok(p.calls.every(x => !x.url.includes('/confirm') && !x.url.includes('/generate')))
  p.clearAssignmentLines(); await p.saveAssignment(); assert.deepEqual(p.calls.filter(x => x.method === 'PUT')[1].body, { version: 1, lines: [] })
})
test('the actual base-quantity control preserves the native six-decimal allocation scale', async () => {
  const control = source.match(/<el-input-number v-model="row\.baseQty"[^>]+\/>/)?.[0]
  assert.ok(control)
  const render = new Function('Vue', compile(control, { mode: 'function', prefixIdentifiers: true }).code)(vue)
  const captured = []
  const renderer = vue.createRenderer({ createElement: tag => ({ tag }), insert() {}, createComment: () => ({}), createText: text => ({ text }), setText() {}, setElementText() {}, remove() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
  const app = renderer.createApp({ setup: () => ({ row: { billLineId: 91, baseQty: 0.000001 }, canEditAssignment: true }), render })
  app.component('ElInputNumber', { props: ['min', 'precision', 'modelValue'], setup: props => { captured.push({ min: props.min, precision: props.precision, value: props.modelValue }); return () => vue.h('input') } })
  app.mount({}); app.unmount()
  assert.deepEqual(captured, [{ min: 0.000001, precision: 6, value: 0.000001 }])
  const p = page(); ready(p); await p.openAssignment({ id: 7, poId: 52 }); p.addAssignmentLine(p.assignment.data.candidates[0]); p.assignment.lines[0].baseQty = 0.000001; await p.saveAssignment()
  assert.equal(p.calls.find(x => x.method === 'PUT').body.lines[0].baseQty, 0.000001)
  assert.equal(p.assignmentQty?.(0.000001), '0.000001', 'the source and available base quantities must not display a native micro-quantity as zero')
  assert.equal(p.assignmentQty(null), '-')
})
test('the original intent retries the identical failed assignment with one key', async () => {
  let attempts = 0
  const p = page({ put: async () => { if (++attempts === 1) throw new Error('network response lost'); return basis({ version: 1, status: 'DRAFT' }) } }); ready(p); await p.openAssignment({ id: 7, poId: 52 }); p.addAssignmentLine(p.assignment.data.candidates[0]); p.assignment.lines[0].baseQty = 30
  await assert.rejects(p.saveAssignment(), /network response lost/); await p.saveAssignment(); const commands = p.calls.filter(x => x.method === 'PUT'); assert.equal(commands.length, 2); assert.equal(commands[0].key, commands[1].key)
})
test('cost-only readers receive safe owner status without bill details or write authority', async () => {
  const p = page({ ap: false }); ready(p); await p.openAssignment({ id: 7, poId: 52 }); assert.equal(p.assignment.data.basisStatus, 'WAITING'); assert.deepEqual(p.assignment.data.lines, []); assert.deepEqual(p.assignment.data.candidates, []); assert.equal(p.canEditAssignment.value, false); await p.saveAssignment(); assert.equal(p.calls.filter(x => x.method === 'PUT').length, 0)
  const hidden = page({ cost: 'HIDDEN' }); ready(hidden); await hidden.openAssignment({ id: 7, poId: 52 }); assert.equal(hidden.calls.length, 0)
})
for (const status of ['FROZEN', 'LEGACY']) test(`${status} owner records remain read-only even with all existing write permissions`, async () => {
  const p = page({ get: async () => basis({ status, canEdit: false, lines: [{ billLineId: 91, baseQty: 30, principalAmount: status === 'FROZEN' ? 750 : null }] }) }); ready(p); await p.openAssignment({ id: 7, poId: 52 }); const original = JSON.stringify(p.assignment.lines); p.addAssignmentLine(candidate); p.clearAssignmentLines(); await p.saveAssignment(); assert.equal(JSON.stringify(p.assignment.lines), original); assert.equal(p.calls.filter(x => x.method === 'PUT').length, 0)
})
test('incompatible candidates cannot be chosen and missing quantity is never replaced with a guessed zero or source quantity', async () => {
  const p = page({ get: async () => basis({ candidates: [{ ...candidate, compatible: false, basisReason: 'bill rate differs' }] }) }); ready(p); await p.openAssignment({ id: 7, poId: 52 }); p.addAssignmentLine(p.assignment.data.candidates[0]); assert.deepEqual(p.assignment.lines, [])
  p.assignment.data.candidates = [candidate]; p.addAssignmentLine(candidate); await p.saveAssignment(); assert.equal(p.calls.filter(x => x.method === 'PUT').length, 0); assert.ok(p.warnings.length)
})
test('country or session changes discard pending GET responses and reject stale commands', async () => {
  for (const change of [p => { p.country.epoch++ }, p => { p.context.token = 'session-B' }]) {
    let resolve; const response = new Promise(r => { resolve = r }); const p = page({ get: async () => response }); ready(p); const opening = p.openAssignment({ id: 7, poId: 52 }); change(p); resolve(basis()); await opening; assert.equal(p.assignment.data, null); await p.saveAssignment(); assert.equal(p.calls.filter(x => x.method === 'PUT').length, 0)
  }
})
test('a slow save cannot replace a newer cost editor in the same country and session', async () => {
  let finish; const pending = new Promise(r => { finish = r }); const p = page({ get: async url => basis({ costId: url.endsWith('/8') ? 8 : 7 }), put: async () => pending }); ready(p); await p.openAssignment({ id: 7, poId: 52 }); p.addAssignmentLine(candidate); p.assignment.lines[0].baseQty = 30; const saving = p.saveAssignment(); await Promise.resolve(); await p.openAssignment({ id: 8, poId: 53 }); finish(basis({ version: 9 })); await saving; assert.equal(p.assignment.costId, 8); assert.equal(p.assignment.data.costId, 8); assert.equal(p.assignment.data.version, 0)
})
