import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { ref } from 'vue'
import { loadVueScript, errorFeedback, feedbackText } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/purchase/PurchaseOrderImportDialog.vue', import.meta.url)
function setup(get) {
  assert.ok(existsSync(file), '采购页需要提供模板下载弹窗')
  errorFeedback.clearErrors()
  const downloads = [], released = [], requests = []
  let close, unmount
  const state = loadVueScript(file, {
    ref, defineExpose() {},
    watch: (_source, callback) => { close = () => callback(false) },
    onBeforeUnmount: callback => { unmount = callback },
    http: { get: path => { requests.push(path); return get() } },
    Blob, Uint8Array, atob,
    URL: { createObjectURL(blob) { downloads.push({ blob }); return 'blob:template' }, revokeObjectURL(url) { released.push(url) } },
    document: { createElement() { return { click() { downloads.at(-1).name = this.download; downloads.at(-1).href = this.href }, remove() {} } }, body: { appendChild() {} } },
  }, ['open', 'visible', 'downloading', 'downloadTemplate'])
  state.open()
  return { state, downloads, released, requests, close, unmount }
}
const content = { fileName: '采购单导入模板.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: 'UEsDBA==' }

test('template download uses the authorized purchase endpoint and releases the downloaded file URL', async () => {
  const p = setup(async () => content)
  await p.state.downloadTemplate()
  assert.deepEqual(p.requests, ['/pur/orders/import-template'])
  assert.equal(p.downloads[0].name, '采购单导入模板.xlsx')
  assert.deepEqual([...new Uint8Array(await p.downloads[0].blob.arrayBuffer())], [80, 75, 3, 4])
  assert.deepEqual(p.released, ['blob:template'])
  assert.equal(p.state.downloading.value, false)
})

test('a pending template download cannot be duplicated or finish after closing the dialog', async () => {
  let resolve
  const p = setup(() => new Promise(done => { resolve = done }))
  const pending = p.state.downloadTemplate()
  assert.equal(p.state.downloading.value, true)
  await p.state.downloadTemplate()
  p.state.visible.value = false
  p.close()
  p.state.open()
  resolve(content)
  await pending
  assert.equal(p.requests.length, 1)
  assert.equal(p.downloads.length, 0)
  assert.equal(p.state.downloading.value, false)
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

test('malformed file content reports failure instead of downloading an empty or HTML workbook', async () => {
  const p = setup(async () => ({ ...content, contentBase64: 'PGh0bWw+' }))
  await assert.rejects(p.state.downloadTemplate(), /模板文件/)
  assert.match(feedbackText(), /模板文件/)
  assert.equal(p.downloads.length, 0)
  assert.equal(p.state.downloading.value, false)
})
