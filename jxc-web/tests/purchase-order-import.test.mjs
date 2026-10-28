import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { ref, computed, compile, createRenderer, defineComponent, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadVueScript, errorFeedback, feedbackText } from './contracts/load-vue-script.mjs'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const file = new URL('../src/modules/purchase/PurchaseOrderImport.vue', import.meta.url)
function setup(get) {
  assert.ok(existsSync(file), '采购导入需要独立页面')
  errorFeedback.clearErrors()
  const downloads = [], released = [], requests = []
  let unmount
  const state = loadVueScript(file, {
    ref,
    onBeforeUnmount: callback => { unmount = callback },
    http: { get: path => { requests.push(path); return get() } },
    Blob, Uint8Array, TextDecoder, atob,
    URL: { createObjectURL(blob) { downloads.push({ blob }); return 'blob:template' }, revokeObjectURL(url) { released.push(url) } },
    document: { createElement() { return { click() { downloads.at(-1).name = this.download; downloads.at(-1).href = this.href }, remove() {} } }, body: { appendChild() {} } },
  }, ['downloading', 'downloadTemplate'])
  return { state, downloads, released, requests, unmount }
}
const xlsx = readFileSync(new URL('../../jxc-server/jxc-module-pur/src/main/resources/templates/purchase-order-import-template.xlsx', import.meta.url))
const content = { fileName: '采购单导入模板.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: xlsx.toString('base64') }

test('template download uses the authorized purchase endpoint and releases the downloaded file URL', async () => {
  const p = setup(async () => content)
  await p.state.downloadTemplate()
  assert.deepEqual(p.requests, ['/pur/orders/import-template'])
  assert.equal(p.downloads[0].name, '采购单导入模板.xlsx')
  assert.equal(p.downloads[0].blob.type, content.contentType)
  assert.deepEqual(Buffer.from(await p.downloads[0].blob.arrayBuffer()), xlsx)
  assert.deepEqual(p.released, ['blob:template'])
  assert.equal(p.state.downloading.value, false)
})

test('a pending template download cannot be duplicated or finish after leaving the import page', async () => {
  let resolve
  const p = setup(() => new Promise(done => { resolve = done }))
  const pending = p.state.downloadTemplate()
  assert.equal(p.state.downloading.value, true)
  await p.state.downloadTemplate()
  p.unmount()
  resolve(content)
  await pending
  assert.equal(p.requests.length, 1)
  assert.equal(p.downloads.length, 0)
  assert.equal(p.state.downloading.value, false)
})

function pageRouter() {
  const registered = loadTsModule(new URL('../src/router/routes.ts', import.meta.url)).routes
  const replaceView = route => ({ ...route, component: { render: () => null }, children: route.children?.map(replaceView) })
  return createRouter({ history: createMemoryHistory(), routes: registered.map(replaceView) })
}

test('the import URL resolves to its own creation-permission page rather than an order ID', () => {
  const router = pageRouter()
  const route = router.resolve('/purchase/orders/import')
  assert.equal(route.matched.at(-1).path, '/purchase/orders/import')
  assert.equal(route.meta.perm, 'pur:order:create')
  assert.equal(route.meta.hidden, true)
  assert.equal(route.meta.activeMenu, '/purchase/orders')
  assert.equal(route.meta.module, 'pur')
  const key = route.meta.title.split('.')[1]
  const zh = loadTsModule(new URL('../src/locales/zh-CN.ts', import.meta.url)).default
  const es = loadTsModule(new URL('../src/locales/es-MX.ts', import.meta.url)).default
  assert.equal(zh.menu[key], '导入文件')
  assert.equal(es.menu[key], 'Importar archivo')
  assert.equal(router.resolve('/purchase/orders/123').matched.at(-1).path, '/purchase/orders/:id')
})

async function orderToolbar(canCreate) {
  const router = pageRouter()
  await router.push('/purchase/orders')
  const list = new URL('../src/modules/purchase/PurchaseOrderList.vue', import.meta.url)
  const template = readFileSync(list, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const renderer = createRenderer({
    createElement: tag => ({ tag, children: [], props: {} }), createText: text => ({ text }), createComment: () => ({}),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text },
    insert(node, parent, anchor) {
      if (node.parent) this.remove(node)
      const index = parent.children.indexOf(anchor)
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
      node.parent = parent
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
    patchProp: (node, key, _before, value) => { node.props[key] = value }, parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1],
  })
  const state = loadVueScript(list, {
    ref, computed, useRouter: () => router, useUserStore: () => ({ hasPerm: permission => canCreate && permission === 'pur:order:create' }),
    createCommandIntent: () => ({}), PO_STATUS: [], PRODUCT_SOURCE: {}, SUPPLIER_SOURCE: {},
    auditDocumentContext: () => ({}),
  }, ['router', 'user', 'page', 'form', 'columns', 'searchFields', 'auditOrder', 'auditVisible', 'auditContext', 'openAudit', 'submit', 'voidOrder', 'onSaved'])
  const app = renderer.createApp({ setup: () => state, render: compile(template) })
  app.component('CrudPage', defineComponent({ setup: (_, ctx) => () => h('div', ctx.slots.toolbar?.()) }))
  app.component('ElButton', defineComponent({ inheritAttrs: false, setup: (_, ctx) => () => h('button', ctx.attrs, ctx.slots.default?.()) }))
  app.component('ElIcon', defineComponent({ setup: (_, ctx) => () => h('span', ctx.slots.default?.()) }))
  for (const name of ['PurchaseOrderForm', 'PurchaseOrderAudit', 'MoneyText', 'ElLink', 'Plus', 'Upload']) app.component(name, { render: () => null })
  const root = { children: [] }; app.mount(root); await nextTick()
  const nodes = node => [node, ...(node.children || []).flatMap(nodes)]
  const text = node => (node.text || '') + (node.children || []).map(text).join('')
  return { app, router, buttons: nodes(root).filter(node => node.tag === 'button').map(node => ({ node, label: text(node).trim() })) }
}

test('the order-list import command navigates to the independent page', async t => {
  const p = await orderToolbar(true); t.after(() => p.app.unmount())
  const button = p.buttons.find(button => button.label === '导入文件')
  assert.ok(button, `采购创建用户应看到导入入口：${JSON.stringify(p.buttons.map(item => item.label))}`)
  await button.node.props.onClick()
  await nextTick()
  assert.equal(p.router.currentRoute.value.path, '/purchase/orders/import')
})

test('the order-list import command is hidden without purchase creation permission', async t => {
  const p = await orderToolbar(false); t.after(() => p.app.unmount())
  assert.equal(p.buttons.some(button => button.label === '导入文件'), false)
  assert.equal(p.router.currentRoute.value.path, '/purchase/orders')
})

test('download failure is propagated without saving a fake file and allows a retry', async () => {
  const failure = new Error('没有此操作的权限')
  let attempt = 0
  const p = setup(async () => { if (!attempt++) throw failure; return content })
  await assert.rejects(p.state.downloadTemplate(), error => error === failure)
  assert.equal(p.downloads.length, 0)
  assert.equal(p.state.downloading.value, false)
  await p.state.downloadTemplate()
  assert.equal(p.downloads.length, 1)
})

test('malformed file content reports failure instead of downloading an HTML page as XLSX', async () => {
  const p = setup(async () => ({ ...content, contentBase64: 'PGh0bWw+' }))
  await assert.rejects(p.state.downloadTemplate(), /模板文件/)
  assert.match(feedbackText(), /模板文件/)
  assert.equal(p.downloads.length, 0)
  assert.equal(p.state.downloading.value, false)
})

test('an old CSV response is rejected instead of downloading the wrong template format', async () => {
  const p = setup(async () => ({ fileName: '采购单导入模板.csv', contentType: 'text/csv;charset=utf-8', contentBase64: Buffer.from('采购单号,商品规格').toString('base64') }))
  await assert.rejects(p.state.downloadTemplate(), /模板文件/)
  assert.equal(p.downloads.length, 0)
  assert.equal(p.state.downloading.value, false)
})
