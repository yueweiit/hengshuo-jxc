import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as vue from 'vue'
import { loadVueScript, errorFeedback, feedbackText } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/ap/ApPaymentList.vue', import.meta.url)
const template = readFileSync(file, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
const renderer = vue.createRenderer({
  createElement: tag => ({ tag, children: [], props: {} }), createText: text => ({ text }), createComment: text => ({ text }),
  setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
  insert(node, parent, anchor) { if (node.parent) this.remove(node); const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, node); node.parent = parent },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
  patchProp: (node, key, before, value) => { node.props[key] = value }, parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1],
})
const nodes = root => [root, ...(root.children || []).flatMap(nodes)]
const text = node => (node.text || '') + (node.children || []).map(text).join('')
async function mount(sourceId, get = async () => ({ id: 1373, docNo: 'AI04-PAY', status: 'CONFIRMED' })) {
  errorFeedback.clearErrors()
  const calls = [], attachments = [], pending = []
  const row = { id: 1373, docNo: 'AI04-PAY', status: 'CONFIRMED', referenceNo: 'ORIGINAL' }
  let state
  const app = renderer.createApp({ render: vue.compile(template), setup() {
    state = loadVueScript(file, { ref: vue.ref, reactive: vue.reactive, useRoute: () => ({ query: { sourceId } }),
      watch: (source, callback, options) => { if (options?.immediate) pending.push(Promise.resolve(callback(source()))) },
      useCountryStore: () => ({ epoch: 1 }), useUserStore: () => ({ hasPerm: () => true }), createCommandIntent: () => ({}),
      http: { get: async path => { calls.push(['GET', path]); return get(path) }, postIdem: async (...args) => calls.push(['POST', ...args]) },
      ElMessage: { warning() {}, success() {} },
    }, ['user', 'columns', 'form', 'confirmation', 'open', 'confirm', 'doConfirm', 'save', 'bookChanged', 'partners', 'accounts', 'books', 'currencies', 'page', 'evidence', 'openEvidence'])
    return state
  } })
  const pass = tag => vue.defineComponent({ inheritAttrs: false, setup: (_, c) => () => vue.h(tag, c.attrs, [c.slots.default?.(), c.slots.footer?.()]) })
  app.component('CrudPage', vue.defineComponent({ setup: (_, c) => () => vue.h('div', c.slots['row-actions']?.({ row })) }))
  app.component('ElDialog', vue.defineComponent({ props: ['modelValue'], setup: (p, c) => () => p.modelValue ? vue.h('section', [c.slots.default?.(), c.slots.footer?.()]) : null }))
  for (const name of ['ElButton', 'ElForm', 'ElFormItem', 'ElSelect', 'ElOption', 'ElDatePicker', 'ElInputNumber', 'ElInput', 'MoneyText']) app.component(name, pass('span'))
  app.component('DocAttachment', vue.defineComponent({ props: { bizType: String, bizId: Number, category: String, readonly: Boolean }, setup(p) { attachments.push({ ...p }); return () => vue.h('div') } }))
  const root = { children: [] }; app.mount(root); await Promise.all(pending); await vue.nextTick()
  return { state, row, calls, attachments, root, unmount: () => app.unmount() }
}

test('confirmed supplier payment exposes its original proof read-only without confirming payment again', async t => {
  const p = await mount(); t.after(p.unmount)
  const button = nodes(p.root).find(node => text(node) === '查看凭证' && node.props?.onClick)
  assert.ok(button, 'confirmed payment needs a visible evidence entry')
  button.props.onClick(); await vue.nextTick()
  assert.deepEqual(p.attachments, [{ bizType: 'AP_PAYMENT', bizId: 1373, category: 'PAYMENT_OUT_PROOF', readonly: true }])
  assert.equal(p.state.evidence.row.docNo, 'AI04-PAY'); assert.equal(p.state.confirmation.visible, false)
  assert.deepEqual(p.calls, []); assert.equal(p.row.referenceNo, 'ORIGINAL')
})

test('payment source link reads the native document before showing its original evidence', async t => {
  const p = await mount('1373'); t.after(p.unmount)
  assert.deepEqual(p.calls, [['GET', '/ap/payments/1373']])
  assert.equal(p.state.evidence.visible, true); assert.equal(p.state.evidence.row.id, 1373)
  assert.equal(p.attachments.at(-1).readonly, true)
})

test('denied payment source read displays an error and never presents an empty success or a mutable proof', async t => {
  const p = await mount('1373', async () => { throw new Error('没有该付款单查看权限') }); t.after(p.unmount)
  assert.match(feedbackText(), /没有该付款单查看权限/)
  assert.doesNotMatch(text(p.root), /没有该付款单查看权限/)
  assert.equal(p.attachments.length, 0); assert.equal(p.state.evidence.row, null)
  assert.equal(p.calls.filter(call => call[0] === 'POST').length, 0)
})

test('malformed or mismatched payment detail remains an explicit read failure without an attachment', async () => {
  for (const detail of [null, {}, { id: 1374, docNo: 'OTHER-PAYMENT' }]) {
    const p = await mount('1373', async () => detail)
    try {
      assert.match(feedbackText(), /付款单数据不完整，请重试/)
      assert.doesNotMatch(text(p.root), /付款单数据不完整，请重试/)
      assert.equal(p.state.evidence.row, null)
      assert.equal(p.attachments.length, 0)
      assert.deepEqual(p.calls, [['GET', '/ap/payments/1373']])
    } finally { p.unmount() }
  }
})
