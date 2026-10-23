import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compile, createRenderer, defineComponent, h } from 'vue'

const file = new URL('../src/modules/approval/ApprovalTaskList.vue', import.meta.url)
function renderMoney(sample) {
  const source = readFileSync(file, 'utf8')
  const cells = source.match(/<el-table-column label="金额"[\s\S]*?<\/el-table-column>/)[0]
    + source.match(/<el-descriptions-item label="金额"[\s\S]*?<\/el-descriptions-item>/)[0]
  const calls = []
  const renderer = createRenderer({
    createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: text => ({ comment: text }),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    insert: (node, parent) => { parent.children.push(node) }, remove() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp({ setup: () => ({ detail: sample }), render: compile(`<div>${cells}</div>`) })
  const amountTemplate = readFileSync(new URL('../src/modules/approval/ApprovalAmount.vue', import.meta.url), 'utf8').match(/<template>([\s\S]*?)<\/template>/)[1]
  app.component('ApprovalAmount', defineComponent({ props: ['value', 'currency'], render: compile(amountTemplate) }))
  app.component('ElTableColumn', defineComponent({ setup: (_, context) => () => h('div', context.slots.default?.({ row: sample })) }))
  app.component('ElDescriptionsItem', defineComponent({ setup: (_, context) => () => h('div', context.slots.default?.()) }))
  app.component('MoneyText', defineComponent({ props: ['value', 'currency'], setup(props) { calls.push({ value: props.value, currency: props.currency }); return () => h('span', String(props.value)) } }))
  const root = { children: [] }; app.mount(root)
  function text(node) { return (node.text ?? '') + (node.children ?? []).map(text).join('') }
  const result = { calls, text: text(root) }; app.unmount(); return result
}

test('approval list and drawer keep the submitted foreign currency', () => {
  const actual = renderMoney({ amount: 14, currency: 'CNY' })
  assert.deepEqual(actual.calls, [{ value: 14, currency: 'CNY' }, { value: 14, currency: 'CNY' }])
})
test('approval amount with unknown currency never falls back to the current country currency', () => {
  const actual = renderMoney({ amount: 14, currency: null })
  assert.deepEqual(actual.calls, [])
  assert.equal((actual.text.match(/币种未知/g) ?? []).length, 2)
})
test('nonmonetary or masked unknown-currency tasks remain empty in both views', () => {
  const actual = renderMoney({ currency: null })
  assert.deepEqual(actual.calls, [])
  assert.equal(actual.text.includes('0'), false)
  assert.equal((actual.text.match(/—/g) ?? []).length, 2)
})
