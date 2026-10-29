import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const { createPurchaseImportModel } = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
const id = '11111111-2222-4333-8444-555555555555', key = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const header = { bookId: 1, supplierId: 2, currency: 'USD', orderDate: '2026-10-28', expectedDate: null, paymentTerms: '月结', prepayRatio: '0', termDays: null }
const row = { id: 10, version: 1, rowNo: 1, sourceOrderNo: 'PO', photo: null, productSpec: 'S', purchaseQty: '1', saleUnitPrice: null, saleTotal: null, purchaseUnitPrice: '5', freight: null, landedUnitCost: null, usdUnitCost: null, usdTotal: null }
const result = (pending = false) => ({ cleared: !pending, clearRequested: true, batchId: id, version: 2, requestKey: key, cleanupPending: pending, cleanupState: pending ? 'WAITING_TASKS' : 'DONE', retained: false, pendingFiles: 0, counts: { rows: pending ? 0 : 1, sources: 1, images: 1, tasks: 1, groups: 1, progress: 1 } })
function setup(extra = {}) {
  const calls = []
  const page = createPurchaseImportModel({ async load() { return { batchId: id, version: 2, status: 'REVIEW', header, rows: [row] } }, async clearBatch(...args) { calls.push(args); return result() }, ...extra }, '2026-10-29', () => key)
  return { page, calls }
}
async function clearAndProcess(page) { assert.equal(await page.clearAll(), true); await page.processCleanups() }

test('清空取消编辑并立即清空全部表头，后台清理独立于新页面', async () => {
  const { page, calls } = setup(); await page.loadBatch(id); page.startEdit(page.state.rows[0], 'productSpec')
  assert.equal(await page.clearAll(), true)
  assert.equal(page.state.batchId, null); assert.deepEqual(page.state.rows, []); assert.equal(page.state.edit, null)
  assert.equal(page.state.header.orderDate, null); assert.equal(page.state.header.currency, ''); assert.equal(page.busy(), false)
  await page.processCleanups(); assert.deepEqual(calls, [[id, 2, key]]); assert.equal(page.state.cleanupJobs.length, 0)
})
test('无批次只清页面，不创建后台删除请求', async () => {
  const { page, calls } = setup(); Object.assign(page.state.header, header); await clearAndProcess(page)
  assert.deepEqual(calls, []); assert.equal(page.state.header.bookId, null)
})
test('解析、核对、保存和已建单状态都能清页面，后台回执说明保留来源', async () => {
  for (const status of ['PARSING', 'REVIEW', 'COMPLETED']) {
    const { page } = setup({ async clearBatch() { return { ...result(), retained: true } } }); await page.loadBatch(id)
    page.state.status = status; page.state.saving = true; page.state.rows[0].targetOrderLineId = 99
    await clearAndProcess(page); assert.equal(page.state.batchId, null); assert.equal(page.busy(), false); assert.deepEqual(page.state.rows, [])
  }
})
test('后台仍在处理的回执保留清理待办，但允许下一次导入', async () => {
  const { page } = setup({ async clearBatch() { return result(true) }, async upload() { return { batchId: id, version: 2, status: 'REVIEW', header, rows: [row] } } })
  await page.loadBatch(id); await clearAndProcess(page)
  assert.equal(page.state.cleanupJobs[0].status, 'PENDING'); assert.equal(page.busy(), false)
  assert.equal(await page.importFile(new File(['x'], 'next.xlsx')), true)
  assert.equal(page.state.clearedBatchId, null)
})
test('网络未知与坏清理回执显示错误并保留原请求，重试不更换编号', async () => {
  for (const fault of [new Error('Network Error'), { cleared: true }]) {
    let failed = true; const requests = []; const { page } = setup({ async clearBatch(...args) { requests.push(args); if (failed) { if (fault instanceof Error) throw fault; return fault } return result() } })
    await page.loadBatch(id); await clearAndProcess(page)
    assert.equal(page.state.cleanupJobs[0].status, 'ERROR'); assert.ok(page.state.cleanupJobs[0].error)
    assert.equal(page.state.rows.length, 0); assert.equal(page.busy(), false)
    failed = false; await page.processCleanups(); assert.deepEqual(requests, [[id, 2, key], [id, 2, key]]); assert.equal(page.state.cleanupJobs.length, 0)
  }
})
test('文件清理失败只保留待办，不恢复已清空明细，重试仍按原回执', async () => {
  const { page } = setup({ async clearBatch() { throw Object.assign(new Error('文件清理失败'), { code: 'PUR_IMPORT_FILES_PENDING', data: { ...result(), cleanupPending: true, cleanupState: 'FILES_PENDING', pendingFiles: 1 } }) } })
  await page.loadBatch(id); await clearAndProcess(page)
  assert.equal(page.state.batchId, null); assert.equal(page.state.cleanupJobs.length, 1); assert.match(page.state.cleanupJobs[0].error, /文件/)
})
test('清理旧批次的响应晚到不能清空下一批次的新输入', async () => {
  let resolve; const { page } = setup({ clearBatch() { return new Promise(done => resolve = done) } }); await page.loadBatch(id)
  await page.clearAll(); const cleaning = page.processCleanups(); await Promise.resolve(); page.state.header.paymentTerms = '下一次资料'
  resolve(result()); await cleaning; assert.equal(page.state.header.paymentTerms, '下一次资料')
})
test('上传未返回时清空仍会按原文件原请求找回旧批次并删除，不回填旧行', async () => {
  let resolve; const uploads = []; const { page, calls } = setup({ upload(file, batch, request) { uploads.push([file.name, batch, request]); return new Promise(done => resolve = done) } })
  const uploading = page.importFile(new File(['x'], 'first.xlsx')); await page.clearAll()
  const cleaning = page.processCleanups(); resolve({ batchId: id, version: 2, status: 'REVIEW', header, rows: [row] })
  await uploading; await cleaning
  assert.equal(uploads.length, 1); assert.deepEqual(calls, [[id, 2, key]]); assert.deepEqual(page.state.rows, []); assert.equal(page.state.header.orderDate, null)
})
test('清理待办包含原上传文件并可从本地快照恢复，账号切换使旧清理回调失效', async () => {
  const { page } = setup({ async upload() { throw new Error('Network Error') } }); await page.importFile(new File(['x'], 'first.xlsx')); await page.clearAll()
  const snapshot = page.exportLocalDraft(); const { page: restored, calls } = setup({ async upload(file, batch, request) { assert.equal(file.name, 'first.xlsx'); assert.equal(request, key); return { batchId: id, version: 2, status: 'REVIEW', header, rows: [row] } } })
  restored.restoreLocalDraft(snapshot); await restored.processCleanups(); assert.deepEqual(calls, [[id, 2, key]])
  page.invalidate(); assert.equal(page.state.cleanupJobs.length, 0)
})
test('上传连接失败后清空可在当前页面按原请求重试，不必刷新才能找回旧批次', async () => {
  let attempts = 0
  const { page } = setup({ async upload() { if (++attempts === 1) throw new Error('Network Error'); return { batchId: id, version: 2, status: 'REVIEW', header, rows: [row] } } })
  await page.importFile(new File(['x'], 'first.xlsx')); await clearAndProcess(page)
  assert.equal(page.state.cleanupJobs.length, 0); assert.equal(attempts, 2)
})
test('找回未知上传后先保存批次编号，存储失败不能先删除再丢失恢复入口', async () => {
  let failed = true
  const { page, calls } = setup({ async upload() { if (failed) throw new Error('Network Error'); return { batchId: id, version: 2, status: 'REVIEW', header, rows: [row] } } })
  await page.importFile(new File(['x'], 'first.xlsx')); await page.clearAll(); failed = false
  page.setCleanupCheckpoint(async () => false); await page.processCleanups()
  assert.equal(calls.length, 0); assert.equal(page.state.cleanupJobs[0].id, id); assert.match(page.state.cleanupJobs[0].error, /保存/)
  page.setCleanupCheckpoint(async () => true); await page.processCleanups(); assert.equal(calls.length, 1)
})
test('刷新已删除批次从清空回执恢复空白，读取异常不能伪装成功', async () => {
  const { page } = setup({ async load() { throw Object.assign(new Error('不存在'), { code: 'NOT_FOUND' }) }, async clearStatus() { return result() } })
  assert.equal(await page.loadBatch(id), true); assert.equal(page.state.batchId, null); assert.equal(page.state.clearedBatchId, id)
  const { page: failed } = setup({ async load() { throw new Error('读取失败') } })
  assert.equal(await failed.loadBatch(id), false); assert.match(failed.state.error, /读取失败/)
})
