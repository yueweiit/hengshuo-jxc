import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import './support.mjs'
const url = new URL('../src/api/attachment-download.ts', import.meta.url)
async function helper() {
  assert.ok(existsSync(url), 'authorized attachment proxies need a blob download boundary')
  return import(url.href)
}
test('attachment authorization is sent only to the same-origin content proxy; Mock blobs are explicit', async () => {
  const { attachmentDownloadTarget } = await helper()
  assert.deepEqual(attachmentDownloadTarget('/api/v1/sys/attachments/123/content', 'https://jxc.test'), { kind: 'proxy', url: '/api/v1/sys/attachments/123/content' })
  assert.deepEqual(attachmentDownloadTarget('/api/v1/sys/attachments/123/content?bizType=ENTITY&bizId=1&category=IMPORT_FILE&linkVersion=1&sha256=abc', 'https://jxc.test'), { kind: 'proxy', url: '/api/v1/sys/attachments/123/content?bizType=ENTITY&bizId=1&category=IMPORT_FILE&linkVersion=1&sha256=abc' })
  assert.throws(() => attachmentDownloadTarget('https://other.test/api/v1/sys/attachments/123/content', 'https://jxc.test'))
  assert.throws(() => attachmentDownloadTarget('/api/v1/auth/logout', 'https://jxc.test'))
  assert.deepEqual(attachmentDownloadTarget('/api/v1/md/product-images/123/content', 'https://jxc.test'), { kind: 'proxy', url: '/api/v1/md/product-images/123/content' })
  assert.throws(() => attachmentDownloadTarget('https://other.test/api/v1/md/product-images/123/content', 'https://jxc.test'))
  assert.throws(() => attachmentDownloadTarget('blob:https://jxc.test/abc', 'https://jxc.test'))
  assert.deepEqual(attachmentDownloadTarget('blob:https://jxc.test/abc', 'https://jxc.test', true), { kind: 'mock-blob', url: 'blob:https://jxc.test/abc' })
})
test('JSON error envelopes inside a failed blob response keep the original business message', async () => {
  const { readBlobError } = await helper()
  assert.deepEqual(await readBlobError(new Blob([JSON.stringify({ code: 'SYS_FORBIDDEN', message: '无来源权限', data: null, traceId: 'test' })], { type: 'application/json' })), { code: 'SYS_FORBIDDEN', message: '无来源权限', data: null, traceId: 'test' })
  assert.equal(await readBlobError(new Blob(['not JSON'])), undefined)
  assert.equal(await readBlobError(new Blob(['{"file":"a user JSON file"}'])), undefined)
})
test('采购来源下载只接受当前站点固定批次原文件和原图路径', async () => {
  const { attachmentDownloadTarget } = await helper()
  const path = '/api/v1/pur/order-imports/11111111-2222-4333-8444-555555555555/images/123/content'
  assert.deepEqual(attachmentDownloadTarget(path, 'https://jxc.test'), { kind: 'proxy', url: path })
  assert.throws(() => attachmentDownloadTarget('https://other.test' + path, 'https://jxc.test'))
  assert.throws(() => attachmentDownloadTarget(path.replace('images/123', 'tasks/123'), 'https://jxc.test'))
})
