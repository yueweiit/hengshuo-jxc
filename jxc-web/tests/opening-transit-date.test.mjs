import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { renderToString } from '@vue/server-renderer'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const component = new URL('../src/components/DateTimeText.vue', import.meta.url)
function dateText(props, calls = []) {
  return loadVueScript(component, {
    computed: Vue.computed, defineProps: () => props,
    useCountryStore: () => ({ timezone: 'America/Mexico_City' }),
    formatDateTime: (value, timezone) => { calls.push({ value, timezone }); return value ? `timestamp:${value}:${timezone}` : '-' },
  }, ['text']).text.value
}

test('known opening source date remains a date with unknown time and never passes through timezone formatting', () => {
  const calls = []
  assert.equal(dateText({ value: null, knownDate: '2026-09-30' }, calls), '来源日期 2026-09-30（时刻未知）')
  assert.deepEqual(calls, [])
  assert.equal(dateText({ value: '2026-10-01T01:30:00Z', knownDate: '2026-09-30' }), 'timestamp:2026-10-01T01:30:00Z:America/Mexico_City')
  assert.equal(dateText({ value: null }), '-')
})

for (const [file, pattern, variable] of [
  ['logistics/ShipmentList.vue', /<div>\{\{ formatDate\(row\.plannedEtd\)[\s\S]*?<\/div>/, 'row'],
  ['logistics/ShipmentDetail.vue', /<div class="shipment-fact shipment-fact--date" data-field="departure">[\s\S]*?<\/div>/, 'sh'],
  ['purchase/PurchaseOrderDetail.vue', /<template #default="\{ row \}"><DateTimeText :value="row\.actualEtd"[\s\S]*?<\/template>/, 'row'],
]) {
  test(`${file} renders native opening date-only evidence without inventing an actual departure`, async () => {
    let markup = readFileSync(new URL(`../src/modules/${file}`, import.meta.url), 'utf8').match(pattern)?.[0]
    assert.ok(markup, 'existing departure display must remain present')
    markup = markup.replace(/<template #default="\{ row \}">/, '<div>').replace(/<\/template>$/, '</div>')
    const render = new Function('Vue', compile(markup, { mode: 'function' }).code)(Vue)
    const app = Vue.createSSRApp({
      components: { DateTimeText: { props: ['value', 'knownDate'], setup: props => () => Vue.h('span', dateText(props)) } },
      setup: () => ({ [variable]: { actualEtd: null, actualEta: null, openingRef: 'IMPORT:1', openingSourceDate: '2026-09-30' }, formatDate: () => '-' }),
      render,
    })
    const html = await renderToString(app)
    assert.match(html, /来源日期 2026-09-30（时刻未知）/)
    assert.doesNotMatch(html, /未发运|timestamp:/)
  })
}

test('only the original opening container uses its known source date instead of a technical creation instant', async () => {
  const source = readFileSync(new URL('../src/modules/logistics/ShipmentDetail.vue', import.meta.url), 'utf8')
  const cell = source.match(/<template #default="\{ row \}"><DateTimeText :value="[^"]*(?:row\.activeFrom)[\s\S]*?<\/template><\/template>/)?.[0]
  assert.ok(cell)
  const markup = cell.replace('<template #default="{ row }">', '<div>').replace(/<\/template>$/, '</div>')
  const render = new Function('Vue', compile(markup, { mode: 'function' }).code)(Vue)
  const first = { id: 1, bizDate: '2026-09-30', activeFrom: '2026-10-16T01:00:00Z', activeTo: '2026-10-15T21:00:00Z' }
  const second = { id: 2, bizDate: '2026-09-30', activeFrom: '2026-10-15T21:00:00Z', activeTo: null }
  const sh = { openingRef: 'IMPORT:1', openingSourceDate: '2026-09-20', cutoffDate: '2026-09-30', containers: [first, second] }
  for (const row of [first, second]) {
    const app = Vue.createSSRApp({ components: { DateTimeText: { props: ['value', 'knownDate'], setup: props => () => Vue.h('span', dateText(props)) } }, setup: () => ({ row, sh }), render })
    const html = await renderToString(app)
    if (row === first) { assert.match(html, /来源日期 2026-09-20（时刻未知）/); assert.doesNotMatch(html, /timestamp:2026-10-16/) }
    else { assert.match(html, /timestamp:2026-10-15T21:00:00Z/); assert.doesNotMatch(html, /来源日期/) }
  }
})
