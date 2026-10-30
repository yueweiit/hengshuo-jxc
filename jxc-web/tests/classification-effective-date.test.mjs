import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/inventory/ClassifyRuleList.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
function page(request = async () => ({})) {
  const commands = []
  const p = loadVueScript(file, {
    reactive: Vue.reactive, ref: Vue.ref, onMounted() {},
    useUserStore: () => ({ hasPerm: () => true }), ElMessage: { success() {} },
    allRecords: async () => [],
    http: {
      post: async (url, body) => { commands.push({ method: 'POST', url, body: JSON.parse(JSON.stringify(body)) }); return request() },
      put: async (url, body) => { commands.push({ method: 'PUT', url, body: JSON.parse(JSON.stringify(body)) }); return request() },
    },
  }, ['form', 'open', 'edit', 'save'])
  return { ...p, commands }
}
const existing = { id: 42, name: '原仓库规则', dimType: 'WAREHOUSE', periodType: 'ROLLING_DAYS', periodDays: 30, versionNo: 7, effectiveFrom: '2026-10-16', conditions: [{ priority: 1, label: 'SLOW_CANDIDATE', stockOp: 'GTE', stockValue: 50, orderOp: 'LTE', orderValue: 5 }] }

test('the original rule form exposes a date-only effective date and preserves its native binding', async () => {
  const control = source.match(/<el-date-picker v-model="form\.effectiveFrom"[^>]+\/>/)?.[0]
  assert.ok(control, 'the native effectiveFrom field needs an original date picker')
  const p = page(); p.edit(existing)
  const captured = []
  const render = new Function('Vue', compile(control, { mode: 'function', prefixIdentifiers: true }).code)(Vue)
  const renderer = Vue.createRenderer({ createElement: tag => ({ tag }), insert() {}, createComment: () => ({}), createText: text => ({ text }), setText() {}, setElementText() {}, remove() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
  const app = renderer.createApp({ setup: () => p, render })
  app.component('ElDatePicker', { props: ['modelValue', 'type', 'valueFormat'], emits: ['update:modelValue'], setup: (props, ctx) => { captured.push({ value: props.modelValue, type: props.type, format: props.valueFormat, update: value => ctx.emit('update:modelValue', value) }); return () => Vue.h('input') } })
  app.mount({})
  assert.deepEqual({ value: captured[0].value, type: captured[0].type, format: captured[0].format }, { value: '2026-10-16', type: 'date', format: 'YYYY-MM-DD' })
  captured[0].update('2026-12-31'); await Vue.nextTick(); assert.equal(p.form.effectiveFrom, '2026-12-31')
  app.unmount()
  await p.save()
  assert.deepEqual(p.commands, [{ method: 'PUT', url: '/inv/classify-rules/42', body: { ...existing, effectiveFrom: '2026-12-31', orderMetric: 'QTY', stockMetric: 'AVAILABLE' } }])
})

test('a new rule never inherits the previously edited future date and blank dates stay with the owner default', async () => {
  const p = page(); p.edit({ ...existing, effectiveFrom: '2030-01-01' }); p.edit({ name: '新本地规则', dimType: 'STORE' })
  assert.equal(p.form.effectiveFrom, undefined, 'new dialog must not silently carry the previous future date')
  await p.save(); assert.equal(p.commands[0].url, '/inv/classify-rules'); assert.equal('effectiveFrom' in p.commands[0].body, false)
  p.edit(existing); p.form.effectiveFrom = null; await p.save()
  assert.equal(p.commands[1].body.effectiveFrom, null)
  assert.equal(p.commands[1].body.versionNo, 7)
  assert.deepEqual(p.commands[1].body.conditions, existing.conditions)
})

test('saving a pending rule sends one version command and keeps the dialog open until confirmation', async () => {
  let confirm
  const p = page(() => new Promise(resolve => { confirm = resolve }))
  p.edit(existing)
  const first = p.save()
  const repeated = p.save()
  assert.equal(p.commands.length, 1, 'a repeated click must not create another rule version')
  assert.equal(p.open.value, true)
  confirm({})
  await Promise.all([first, repeated])
  assert.equal(p.open.value, false)
})

test('a failed save retains edited values and permits a subsequent retry', async () => {
  let attempts = 0
  const p = page(async () => { if (++attempts === 1) throw new Error('规则冲突') })
  p.edit(existing)
  p.form.conditions[0].stockValue = 75
  await assert.rejects(p.save(), /规则冲突/)
  assert.equal(p.open.value, true)
  assert.equal(p.form.conditions[0].stockValue, 75)
  await p.save()
  assert.equal(p.commands.length, 2)
  assert.equal(p.commands[1].body.conditions[0].stockValue, 75)
  assert.equal(p.open.value, false)
})
