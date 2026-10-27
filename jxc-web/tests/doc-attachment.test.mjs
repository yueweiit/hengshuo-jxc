import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compile, createRenderer, defineComponent, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRefs, watch } from 'vue'
import { loadVueScript, errorFeedback, feedbackText } from './contracts/load-vue-script.mjs'
import { attachmentDownloadTarget } from '../src/api/attachment-download.ts'

const file = new File(['invoice'], '发票.png', { type: 'image/png' })
file.uid = 10
const attachment = { id: 3, category: 'PURCHASE_DOC', fileName: '发票.png', contentType: 'image/png', size: 7, uploadedByName: '采购员', uploadedAt: '2026-10-23T00:00:00Z', versionNo: 1 }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const renderer = createRenderer({
  createElement: tag => ({ tag, children: [], props: {} }), createText: text => ({ text }), createComment: text => ({ comment: text }),
  setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
  insert(node, parent, anchor) { if (node.parent) this.remove(node); const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, node); node.parent = parent },
  remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null },
  patchProp: (node, key, before, value) => { node.props[key] = value }, parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1],
})
const componentFile = new URL('../src/components/DocAttachment.vue', import.meta.url)
test.beforeEach(() => errorFeedback.clearErrors())
const template = readFileSync(componentFile, 'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
const nodes = root => [root, ...(root.children || []).flatMap(nodes)]
const textContent = node => (node.text || '') + (node.children || []).map(textContent).join('')
async function mount(overrides = {}) {
  const calls = [], emitted = [], created = [], revoked = [], anchors = [], successes = []
  const props = reactive({ bizType: 'DOMESTIC_RECEIPT', bizId: 11, category: 'PURCHASE_DOC', readonly: false, ...overrides.props })
  const http = Object.fromEntries(['get', 'post', 'attachmentBlob'].map(method => [method, async (...args) => {
    calls.push({ method, args })
    if (overrides.http?.[method]) return overrides.http[method](...args)
    if (method === 'attachmentBlob') return new Blob(['image'], { type: 'image/png' })
    if (method === 'post') return attachment
    return args[0].endsWith('/url') ? { url: '/api/v1/sys/attachments/3/content?bizId=11' } : [attachment]
  }]))
  let state
  const app = renderer.createApp({ render: overrides.renderTemplate ? compile(template) : undefined, setup() {
    state = loadVueScript(componentFile, {
      ref, reactive, watch, onMounted, onBeforeUnmount, http, attachmentDownloadTarget,
      defineProps: () => props, defineEmits: () => (event, value) => emitted.push({ event, value }), defineExpose() {},
      ElMessage: { success: value => successes.push(value), error() {} },
      ElMessageBox: { confirm: (...args) => { calls.push({ method: 'confirm', args }); return overrides.confirm?.(...args) ?? Promise.resolve() } },
      window: { location: { origin: 'https://jxc.test' } },
      URL: { createObjectURL: blob => { const url = `blob:https://jxc.test/${created.length + 1}`; created.push({ url, blob }); return url }, revokeObjectURL: url => revoked.push(url) },
      document: { createElement: () => { const anchor = { click() { anchor.clicked = true }, remove() { anchor.removed = true } }; anchors.push(anchor); return anchor }, body: { append() {} } },
    }, ['load', 'upload', 'unlink', 'download', 'previewFile', 'previewImageFailed', 'closePreview', 'updatePreviewOpen', 'fileSize', 'items', 'uploads', 'loading', 'loadError', 'actionError', 'preview', 'deletingIds'])
    return overrides.renderTemplate ? { ...toRefs(props), ...state } : () => h('div')
  } })
  if (overrides.renderTemplate) {
    const pass = tag => defineComponent({ inheritAttrs: false, setup: (_, context) => () => h(tag, context.attrs, context.slots.default?.()) })
    for (const name of ['ElUpload', 'ElIcon', 'Upload', 'DateTimeText']) app.component(name, pass('span'))
    app.component('ElButton', pass('button')); app.component('ElLink', pass('a'))
    app.component('ElEmpty', defineComponent({ props: ['description'], setup: props => () => h('p', props.description) }))
    app.component('ElProgress', defineComponent({ props: ['percentage'], setup: props => () => h('progress', { value: props.percentage }) }))
    app.component('ElDialog', defineComponent({ props: ['modelValue'], setup: (props, context) => () => props.modelValue ? h('section', [context.slots.default?.(), context.slots.footer?.()]) : null }))
    app.directive('loading', {})
  }
  const root = { children: [] }
  app.mount(root)
  await new Promise(resolve => setImmediate(resolve))
  return { state, props, calls, emitted, created, revoked, anchors, successes, root, unmount: () => app.unmount() }
}

test('upload progress follows transport events and waits for server confirmation before completion', async t => {
  const pending = deferred()
  let config
  const page = await mount({ http: { post: (url, data, options) => { assert.equal(url, '/sys/attachments'); assert.equal(data.get('bizId'), '11'); config = options; return pending.promise } } })
  t.after(page.unmount)
  const result = page.state.upload({ file })
  config.onUploadProgress({ loaded: 50, total: 100 })
  assert.equal(page.state.uploads.value[0].percentage, 50)
  config.onUploadProgress({ loaded: 100, total: 100 })
  assert.equal(page.state.uploads.value[0].status, 'saving')
  assert.equal(page.successes.length, 0)
  pending.resolve(attachment)
  await result
  assert.deepEqual(page.state.uploads.value, [])
  assert.equal(page.successes.length, 1)
})

test('unknown transport total shows bytes without inventing a percentage', async t => {
  const pending = deferred()
  let config
  const page = await mount({ http: { post: (url, body, options) => { config = options; return pending.promise } } })
  t.after(page.unmount)
  const result = page.state.upload({ file })
  config.onUploadProgress({ loaded: 42 })
  assert.equal(page.state.uploads.value[0].percentage, undefined)
  assert.equal(page.state.uploads.value[0].loaded, 42)
  assert.equal(page.state.uploads.value[0].status, 'uploading')
  pending.resolve(attachment)
  await result
})

test('failed upload retains the original reason globally and never reports completion', async t => {
  const page = await mount({ renderTemplate: true, http: { post: async () => { throw new Error('附件大小须为1字节至1MB') } } })
  t.after(page.unmount)
  await assert.rejects(page.state.upload({ file }), /1MB/)
  assert.equal(page.state.uploads.value[0].status, 'error')
  assert.match(page.state.uploads.value[0].error, /1MB/)
  assert.equal(page.successes.length, 0)
  await nextTick()
  assert.match(feedbackText(), /1MB/)
  assert.doesNotMatch(textContent(page.root), /1MB/)
})

test('图片无法解码时在全局解释并保留下载入口，旧图片事件不能覆盖新预览', async t => {
  const page = await mount({ renderTemplate: true })
  t.after(page.unmount)
  await page.state.previewFile(attachment); await nextTick()
  const image = nodes(page.root).find(n => n.tag === 'img')
  assert.ok(image)
  const fail = image.props.onError
  fail({ target: { getAttribute: () => image.props.src } })
  await nextTick()
  assert.match(feedbackText(), /图片无法显示/)
  assert.doesNotMatch(textContent(page.root), /图片无法显示/)
  assert.match(textContent(page.root), /下载/)
  await page.state.previewFile({ ...attachment, id: 4 })
  fail({ target: { getAttribute: () => image.props.src } })
  assert.equal(page.state.preview.error, '')
})

test('successful upload with failed list refresh removes progress and warns against duplicate upload', async t => {
  let fail = false
  const page = await mount({ renderTemplate: true, http: { get: async () => { if (fail) throw new Error('列表超时'); return [attachment] } } })
  t.after(page.unmount)
  fail = true
  await page.state.upload({ file })
  assert.equal(nodes(page.root).filter(node => node.tag === 'progress').length, 0)
  assert.equal(page.successes.length, 1)
  assert.match(page.state.loadError.value, /已上传/)
  assert.match(page.state.loadError.value, /列表超时/)
  assert.deepEqual(page.state.items.value.map(a => a.id), [3])
})

test('failed initial list is distinguishable from an empty list and can be retried', async t => {
  let fail = true
  const page = await mount({ http: { get: async () => { if (fail) throw new Error('无来源权限'); return [] } } })
  t.after(page.unmount)
  assert.match(page.state.loadError.value, /无来源权限/)
  fail = false
  await page.state.load()
  assert.equal(page.state.loadError.value, '')
  assert.deepEqual(page.state.items.value, [])
})

test('image preview uses authorized content and releases its object URL when closed', async t => {
  const page = await mount()
  t.after(page.unmount)
  await page.state.previewFile(attachment)
  assert.equal(page.state.preview.open, true)
  assert.equal(page.state.preview.kind, 'image')
  assert.equal(page.state.preview.url, 'blob:https://jxc.test/1')
  assert.deepEqual(page.calls.find(call => call.method === 'attachmentBlob').args.slice(0, 1), ['/api/v1/sys/attachments/3/content?bizId=11'])
  page.state.closePreview()
  assert.deepEqual(page.revoked, ['blob:https://jxc.test/1'])
  assert.equal(page.state.preview.open, false)
})

test('PDF content gets the PDF viewer', async t => {
  const page = await mount({ http: { attachmentBlob: async () => new Blob(['pdf'], { type: 'application/pdf' }) } })
  t.after(page.unmount)
  await page.state.previewFile({ ...attachment, fileName: '发票.pdf' })
  assert.equal(page.state.preview.kind, 'pdf')
  assert.equal(page.created.length, 1)
})

test('Office, HTML and SVG content never become an embedded preview even with a misleading filename', async t => {
  let mime
  const page = await mount({ http: { attachmentBlob: async () => new Blob(['untrusted'], { type: mime }) } })
  t.after(page.unmount)
  for (mime of ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/html', 'image/svg+xml']) {
    await page.state.previewFile({ ...attachment, fileName: '看似图片.png' })
    assert.equal(page.state.preview.kind, 'unsupported')
    assert.equal(page.state.preview.url, '')
  }
  assert.equal(page.created.length, 0)
})

test('preview retrieval failures keep the business reason instead of showing an empty viewer', async t => {
  const page = await mount({ http: { attachmentBlob: async () => { throw new Error('附件已解除关联') } } })
  t.after(page.unmount)
  await page.state.previewFile(attachment)
  assert.match(page.state.preview.error, /已解除关联/)
  assert.equal(page.state.preview.loading, false)
  assert.equal(page.created.length, 0)
})

test('closing a preview during retrieval discards the late result', async t => {
  const pending = deferred()
  const page = await mount({ http: { attachmentBlob: () => pending.promise } })
  t.after(page.unmount)
  const result = page.state.previewFile(attachment)
  await nextTick()
  page.state.closePreview()
  pending.resolve(new Blob(['image'], { type: 'image/png' }))
  await result
  assert.equal(page.state.preview.open, false)
  assert.equal(page.created.length, 0)
})

test('changing documents clears old progress and preview, and ignores an old upload response', async t => {
  const pending = deferred()
  const page = await mount({ http: { post: () => pending.promise, get: async (url, params) => url.endsWith('/url') ? { url: '/api/v1/sys/attachments/3/content' } : params.bizId === 11 ? [attachment] : [] } })
  t.after(page.unmount)
  await page.state.previewFile(attachment)
  const uploading = page.state.upload({ file })
  page.props.bizId = 12
  await nextTick()
  await new Promise(resolve => setImmediate(resolve))
  pending.resolve(attachment)
  await uploading
  assert.deepEqual(page.state.items.value, [])
  assert.deepEqual(page.state.uploads.value, [])
  assert.equal(page.state.preview.open, false)
  assert.deepEqual(page.revoked, ['blob:https://jxc.test/1'])
  assert.equal(page.successes.length, 0)
})

test('readonly components refuse upload and unlink while retaining preview', async t => {
  const page = await mount({ props: { readonly: true } })
  t.after(page.unmount)
  await assert.rejects(page.state.upload({ file }), /只读/)
  await page.state.unlink(attachment)
  assert.equal(page.calls.filter(call => ['post', 'confirm'].includes(call.method)).length, 0)
  await page.state.previewFile(attachment)
  assert.equal(page.state.preview.kind, 'image')
})

test('cancelled unlink preserves the attachment without an error or write request', async t => {
  const page = await mount({ confirm: () => Promise.reject('cancel') })
  t.after(page.unmount)
  await page.state.unlink(attachment)
  assert.deepEqual(page.state.items.value.map(a => a.id), [3])
  assert.equal(page.state.actionError.value, '')
  assert.equal(page.calls.filter(call => call.method === 'post').length, 0)
})

test('failed unlink preserves the item and reason for retry', async t => {
  const page = await mount({ http: { post: async () => { throw new Error('来源已锁定') } } })
  t.after(page.unmount)
  await page.state.unlink(attachment)
  assert.deepEqual(page.state.items.value.map(a => a.id), [3])
  assert.match(page.state.actionError.value, /来源已锁定/)
  assert.equal(page.state.deletingIds.value.has(3), false)
})

test('repeated delete clicks send one unlink and remove only the confirmed association', async t => {
  const pending = deferred()
  const page = await mount({ confirm: () => pending.promise })
  t.after(page.unmount)
  const first = page.state.unlink(attachment)
  await page.state.unlink(attachment)
  pending.resolve()
  await first
  assert.equal(page.calls.filter(call => call.method === 'confirm').length, 1)
  assert.deepEqual(page.calls.filter(call => call.method === 'post').map(call => call.args[0]), ['/sys/attachments/3/unlink'])
  assert.deepEqual(page.state.items.value, [])
  assert.deepEqual(page.emitted.at(-1).value, [])
})

test('permission becoming readonly while delete confirmation is open prevents the write', async t => {
  const pending = deferred()
  const page = await mount({ confirm: () => pending.promise })
  t.after(page.unmount)
  const first = page.state.unlink(attachment)
  page.props.readonly = true
  pending.resolve()
  await first
  assert.equal(page.calls.filter(call => call.method === 'post').length, 0)
})

test('download retains its authenticated content path and original filename', async t => {
  const page = await mount()
  t.after(page.unmount)
  await page.state.download(attachment)
  assert.equal(page.anchors[0].download, '发票.png')
  assert.equal(page.anchors[0].clicked, true)
  assert.equal(page.anchors[0].removed, true)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(page.revoked, ['blob:https://jxc.test/1'])
})

test('unmount releases preview resources and prevents pending upload success feedback', async () => {
  const pending = deferred()
  const page = await mount({ http: { post: () => pending.promise } })
  await page.state.previewFile(attachment)
  const uploading = page.state.upload({ file })
  page.unmount()
  pending.resolve(attachment)
  await uploading
  assert.deepEqual(page.revoked, ['blob:https://jxc.test/1'])
  assert.equal(page.successes.length, 0)
})

test('older list requests cannot replace a newer refresh', async t => {
  const first = deferred(), second = deferred()
  let sequence = 0
  const page = await mount({ http: { get: () => ++sequence === 1 ? Promise.resolve([attachment]) : sequence === 2 ? first.promise : second.promise } })
  t.after(page.unmount)
  const oldLoad = page.state.load(), newLoad = page.state.load()
  second.resolve([{ ...attachment, id: 4 }])
  await newLoad
  first.resolve([attachment])
  await oldLoad
  assert.deepEqual(page.state.items.value.map(a => a.id), [4])
})

test('a list response started before unlink cannot bring back the deleted association', async t => {
  const pending = deferred()
  let sequence = 0
  const page = await mount({ http: { get: () => ++sequence === 1 ? Promise.resolve([attachment]) : pending.promise } })
  t.after(page.unmount)
  const loading = page.state.load()
  await page.state.unlink(attachment)
  pending.resolve([attachment])
  await loading
  assert.deepEqual(page.state.items.value, [])
})

test('late transport progress cannot restore a completed upload progress bar', async t => {
  let config
  const page = await mount({ http: { post: async (url, body, options) => { config = options; return attachment } } })
  t.after(page.unmount)
  await page.state.upload({ file })
  config.onUploadProgress({ loaded: 100, total: 100 })
  assert.deepEqual(page.state.uploads.value, [])
})

test('rendered upload progress follows transport then disappears on server success before list refresh finishes', async t => {
  const pending = deferred()
  const refresh = deferred()
  let config
  let lists = 0
  const page = await mount({ renderTemplate: true, http: {
    post: (url, body, options) => { config = options; return pending.promise },
    get: () => ++lists === 1 ? Promise.resolve([]) : refresh.promise,
  } })
  t.after(page.unmount)
  const uploading = page.state.upload({ file })
  await nextTick()
  assert.equal(nodes(page.root).find(node => node.tag === 'progress').props.value, undefined)
  config.onUploadProgress({ loaded: 40, total: 100 })
  await nextTick()
  assert.equal(nodes(page.root).find(node => node.tag === 'progress').props.value, 40)
  config.onUploadProgress({ loaded: 100, total: 100 })
  await nextTick()
  assert.equal(nodes(page.root).find(node => node.tag === 'progress').props.value, 100)
  assert.match(textContent(page.root), /正在保存/)
  pending.resolve(attachment)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.state.loading.value, true)
  assert.equal(nodes(page.root).filter(node => node.tag === 'progress').length, 0)
  assert.equal(page.successes.length, 1)
  refresh.resolve([attachment])
  await uploading
  await nextTick()
  assert.match(textContent(page.root), /发票.png/)
  assert.equal(nodes(page.root).filter(node => node.tag === 'progress').length, 0)
})

test('completing one file preserves other uploads and their failure reasons', async t => {
  const first = deferred(), second = deferred()
  const secondFile = new File(['receipt'], '收据.pdf', { type: 'application/pdf' })
  secondFile.uid = 11
  const page = await mount({ renderTemplate: true, http: {
    post: (url, body) => body.get('file').name === file.name ? first.promise : second.promise,
  } })
  t.after(page.unmount)
  const uploadingFirst = page.state.upload({ file })
  const uploadingSecond = page.state.upload({ file: secondFile })
  const secondFailure = assert.rejects(uploadingSecond, /网络中断/)
  await nextTick()
  assert.equal(nodes(page.root).filter(node => node.tag === 'progress').length, 2)
  first.resolve(attachment)
  await uploadingFirst
  await nextTick()
  assert.equal(nodes(page.root).filter(node => node.tag === 'progress').length, 1)
  assert.deepEqual(page.state.uploads.value.map(entry => entry.fileName), ['收据.pdf'])
  assert.equal(page.state.uploads.value[0].status, 'uploading')
  second.reject(new Error('网络中断'))
  await secondFailure
  await nextTick()
  assert.match(feedbackText(), /网络中断/)
  assert.doesNotMatch(textContent(page.root), /网络中断/)
  assert.equal(page.state.uploads.value[0].status, 'error')
  assert.equal(nodes(page.root).filter(node => node.tag === 'progress').length, 1)
})

test('rendered actions expose preview/download/delete and readonly removes writing actions', async t => {
  const page = await mount({ renderTemplate: true })
  t.after(page.unmount)
  const buttons = () => nodes(page.root).filter(node => node.tag === 'button').map(node => textContent(node).trim())
  assert.deepEqual(buttons(), ['上传', '预览', '下载', '删除'])
  const previewButton = nodes(page.root).find(node => node.tag === 'button' && textContent(node) === '预览')
  await previewButton.props.onClick()
  await nextTick()
  assert.equal(nodes(page.root).find(node => node.tag === 'img').props.src, 'blob:https://jxc.test/1')
  page.state.closePreview()
  page.props.readonly = true
  await nextTick()
  assert.deepEqual(buttons(), ['预览', '下载'])
})
