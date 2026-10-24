import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as Vue from 'vue'
import { compile, parse } from '@vue/compiler-dom'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/analysis/ProfitView.vue', import.meta.url)
const source = readFileSync(file, 'utf8')
const helperCode = ts.transpileModule(readFileSync(new URL('../src/utils/finance-source.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { financeSourcePath } = await import('data:text/javascript;base64,' + Buffer.from(helperCode).toString('base64'))
function sourceDetail(sources) {
  const template = source.slice(source.indexOf('<template>') + 10, source.lastIndexOf('</template>'))
  function find(node) { if (node.tag === 'el-table-column' && node.props.some(p => p.name === 'type' && p.value?.content === 'expand')) return node; return (node.children ?? []).map(find).find(Boolean) }
  const expansion = find(parse(template))
  assert.ok(expansion, 'the original profit row must expose its owner-provided sources')
  const page = loadVueScript(file, { computed: Vue.computed, ref: Vue.ref, onMounted() {}, onBeforeUnmount() {}, useCountryStore: () => ({}), financeSourcePath, formatDate: value => value || '-' }, ['data', 'bookId', 'moneyFields', 'sourceLabel', 'formatDate'])
  page.bookId.value = 6; page.data.value = { baseCurrency: 'MXN', rows: [{ sources }] }
  const calls = [], money = []
  const renderer = Vue.createRenderer({ createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: () => ({}), setText: (n,t) => { n.text=t }, setElementText: (n,t) => { n.text=t }, insert: (n,p) => p.children.push(n), remove() {}, patchProp: (n,k,_old,v) => { n[k]=v }, parentNode: () => null, nextSibling: () => null })
  const render = new Function('Vue', ts.transpileModule(compile(`<el-table :data="data.rows">${expansion.loc.source}</el-table>`, { mode: 'function', prefixIdentifiers: true, expressionPlugins: ['typescript'] }).code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(Vue)
  const app = renderer.createApp({ setup: () => ({ ...page, financeSourcePath }), render })
  app.config.globalProperties.$router = { push: route => calls.push(route) }
  app.component('ElTable', { props: ['data'], setup: (p, ctx) => { Vue.provide('sourceRows', p.data); return () => Vue.h('table', ctx.slots.default?.()) } })
  app.component('ElTableColumn', { props: ['prop', 'label'], setup: (p, ctx) => { const rows = Vue.inject('sourceRows'); return () => Vue.h('section', [p.label, ...rows.map(row => ctx.slots.default?.({ row }) ?? String(row[p.prop] ?? '—'))]) } })
  app.component('ElButton', { setup: (_, ctx) => () => Vue.h('button', ctx.attrs, ctx.slots.default?.()) })
  app.component('ElAlert', { props: ['title'], setup: p => () => Vue.h('alert', p.title) })
  app.component('ElTag', { setup: (_, ctx) => () => Vue.h('tag', ctx.slots.default?.()) })
  app.component('MoneyText', { props: ['value', 'currency'], setup: p => { money.push({ ...p }); return () => Vue.h('span', p.value == null ? '—' : String(p.value)) } })
  app.component('StatusTag', { props: ['status'], setup: p => () => Vue.h('span', p.status) })
  app.config.warnHandler = warning => { throw new Error(warning) }
  const root = { children: [] }; app.mount(root)
  const walk = n => [n, ...(n.children ?? []).flatMap(walk)]
  const nodes = walk(root); nodes.filter(n => n.tag === 'button').forEach(n => n.onClick?.())
  const result = { calls, money, text: nodes.map(n => n.text ?? '').join('') }; app.unmount(); return result
}
test('profit source expansion follows original outbound, return and adjustment references with the selected book', () => {
  const actual = sourceDetail([{ sourceType: 'SAL_OUTBOUND', sourceId: 71, sourceLineId: 72, sourceNo: 'OUT-71', cogsAmount: '12.34', costVersions: [{ cogsId: 81, method: 'FIFO', methodVersion: 2 }] }, ...['SALES_RETURN_SETTLEMENT', 'SALES_RETURN_SETTLEMENT_REVERSED', 'SALES_RETURN_INSPECTION'].map(sourceType => ({ sourceType, sourceId: 73, sourceNo: 'RETURN-73' })), { sourceType: 'CST_ADJUSTMENT', sourceId: 74, sourceNo: 'ADJ-74' }])
  assert.deepEqual(actual.calls, [71, 73, 73, 73, 74].map((id, i) => ({ path: i === 0 ? '/sales/outbounds' : i === 4 ? '/cost/adjustments' : '/returns/sales', query: { sourceId: id, bookId: 6 } })))
  assert.match(actual.text, /OUT-71/); assert.match(actual.text, /81/); assert.match(actual.text, /FIFO/)
  assert.ok(actual.money.some(m => m.value === '12.34' && m.currency === 'MXN'))
})
test('unknown profit references remain visible without invented routes and missing source amounts remain unknown', () => {
  const actual = sourceDetail([{ sourceType: 'FUTURE_SOURCE', sourceId: 91, sourceLineId: 92, sourceNo: 'SOURCE-91', cogsAmount: null }])
  assert.deepEqual(actual.calls, []); assert.match(actual.text, /SOURCE-91/); assert.match(actual.text, /92/)
  assert.ok(actual.money.length > 0); assert.ok(actual.money.every(m => m.value == null), 'missing source money must never be filled with zero')
})
