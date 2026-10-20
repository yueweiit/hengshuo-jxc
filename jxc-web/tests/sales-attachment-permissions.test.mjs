import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compile, computed, createRenderer, defineComponent, h, nextTick, onMounted, reactive, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const detailFile = new URL('../src/modules/sales/SalesOrderDetail.vue', import.meta.url)
const attachmentFile = new URL('../src/components/DocAttachment.vue', import.meta.url)
const source = readFileSync(detailFile, 'utf8')
// Compile the actual eager page panes and mount their actual attachment setup/load.
const panes = [...source.matchAll(/<el-tab-pane label="(?:销售单据|收款凭证)"[\s\S]*?<\/el-tab-pane>/g)].map(match => match[0]).join('')
const renderer = createRenderer({
  createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: text => ({ text }),
  setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
  insert: (node, parent) => { parent.children.push(node) }, remove() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
})
async function mount(groups, permissions) {
  const calls = [], mounted = []
  const page = loadVueScript(detailFile, {
    computed, reactive, ref, watch() {}, onMounted() {}, createCommandIntent: () => ({}),
    useRoute: () => ({ params: { id: '1164' } }), useRouter: () => ({}), useCountryStore: () => ({}),
    useUserStore: () => ({ fieldAccess: group => groups[group] ?? 'HIDDEN', hasPerm: codes => (Array.isArray(codes) ? codes : [codes]).some(code => permissions.includes(code)) }),
  }, ['order', 'id', 'user'])
  page.order.value = { id: 1164 }
  const attachment = defineComponent({
    props: ['bizType', 'bizId', 'category', 'readonly'],
    setup(props) {
      mounted.push({ category: props.category, readonly: Boolean(props.readonly) })
      loadVueScript(attachmentFile, { ref, onMounted, defineProps: () => props, defineEmits: () => () => {}, defineExpose() {}, http: { get: async (url, params) => { calls.push({ url, category: params.category }); return [] } } }, ['load'])
      return () => h('div')
    },
  })
  const app = renderer.createApp({ setup: () => page, render: compile(`<div>${panes}</div>`) })
  app.component('ElTabPane', defineComponent({ props: ['label', 'name'], setup: (_, context) => () => context.slots.default?.() }))
  app.component('DocAttachment', attachment)
  app.mount({ children: [] }); await nextTick(); app.unmount()
  return { calls, mounted }
}

test('initial sales detail does not request hidden BANK_INFO proof while ordinary SALES_DOC remains readable', async () => {
  const page = await mount({ CUSTOMER_PRICE: 'WRITE', BANK_INFO: 'HIDDEN' }, ['sal:order:create'])
  assert.deepEqual(page.calls, [{ url: '/sys/attachments', category: 'SALES_DOC' }])
  assert.deepEqual(page.mounted, [{ category: 'SALES_DOC', readonly: false }])
})
test('read access retains both original categories without upload or unlink authority', async () => {
  const page = await mount({ CUSTOMER_PRICE: 'READ', BANK_INFO: 'READ' }, ['sal:order:create'])
  assert.deepEqual(page.calls.map(call => call.category), ['SALES_DOC', 'PAYMENT_PROOF'])
  assert.ok(page.mounted.every(component => component.readonly === true))
})
test('field write cannot enable writing without the existing document write permission', async () => {
  const page = await mount({ CUSTOMER_PRICE: 'WRITE', BANK_INFO: 'WRITE' }, ['sal:order:view'])
  assert.ok(page.mounted.every(component => component.readonly === true))
})
test('authorized field and document writers keep original upload-enabled attachment components', async () => {
  const page = await mount({ CUSTOMER_PRICE: 'WRITE', BANK_INFO: 'WRITE' }, ['sal:order:submit'])
  assert.deepEqual(page.calls.map(call => call.category), ['SALES_DOC', 'PAYMENT_PROOF'])
  assert.ok(page.mounted.every(component => component.readonly === false))
})
