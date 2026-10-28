import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const { createPurchaseImportModel } = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
const batchId = '11111111-2222-4333-8444-555555555555', token = '22222222-2222-4333-8444-555555555555'
function setup(extra = {}) {
  const header = { bookId: 1, supplierId: 2, currency: 'USD', orderDate: '2026-10-28', expectedDate: null, paymentTerms: '', prepayRatio: '0', termDays: 0 }
  const row = { id: 1, rowNo: 1, version: 2, sourceOrderNo: 'PO', photo: null, productSpec: 'S', purchaseQty: '10', saleUnitPrice: null, saleTotal: null, purchaseUnitPrice: '53', freight: null, landedUnitCost: null, usdUnitCost: null, usdTotal: null, groupId: 8, readiness: 'READY' }
  const group = { id: 8, version: 2, sourceOrderNo: 'PO', header, createStatus: 'READY', verifyStatus: 'NOT_CHECKED', previewToken: token, errors: [], preview: { header, lines: [{ lineNo: 1, productId: 501, qty: '10', unit: 'PCS', sourceUnitPrice: '53', unitPrice: '53.0000', amount: '530.0000', taxRate: '0' }], totalAmount: '530.0000', taxAmount: '0.0000' }, orderId: null }
  const batch = { batchId, version: 2, status: 'REVIEW', header, rows: [row], groups: [group] }
  const api = { async load() { return batch }, ...extra }
  return { page: createPurchaseImportModel(api, '2026-10-28', () => '33333333-2222-4333-8444-555555555555'), batch, group }
}
test('按单预览使用完整批次版本，并保留未确认行错误', async () => {
  let version
  const { page, batch } = setup({ async previews(_id, value) { version = value; return { ...batch, groups: [{ ...batch.groups[0], createStatus: 'DRAFT', preview: null, errors: [{ message: '第2行未确认' }] }] } } })
  await page.loadBatch(batchId)
  assert.equal(await page.previewDrafts(), true)
  assert.equal(version, 2)
  assert.equal(page.state.groups[0].createStatus, 'DRAFT')
  assert.match(page.state.groups[0].errors[0].message, /第2行未确认/)
})
test('建单超时重试保持原确认内容和请求编号', async () => {
  const calls = []
  const { page, group } = setup({ async createDraft(_id, _group, request, key) { calls.push([structuredClone(request), key]); throw new Error('请求超时，请查询原结果') } })
  await page.loadBatch(batchId)
  await page.createDraft(group); await page.createDraft(group)
  assert.deepEqual(calls[0], calls[1])
  assert.deepEqual(calls[0][0], { groupVersion: 2, previewToken: token, confirm: true })
})
test('已创建但读回失败保留真实采购单，不能再次发起创建', async () => {
  let creates = 0
  const { page, batch, group } = setup({ async createDraft() { creates++; batch.groups[0] = { ...group, createStatus: 'CREATED', orderId: 909, verifyStatus: 'READ_FAILED', errorMessage: '读取权限不足' }; return batch.groups[0] } })
  await page.loadBatch(batchId)
  assert.equal(await page.createDraft(group), true)
  assert.equal(page.state.groups[0].orderId, 909)
  assert.equal(page.state.groups[0].verifyStatus, 'READ_FAILED')
  assert.equal(await page.createDraft(page.state.groups[0]), false)
  assert.equal(creates, 1)
})
test('创建失败保留完整原行和预览，不把错误变成空成功', async () => {
  const { page, group } = setup({ async createDraft() { throw new Error('期间已关闭') } })
  await page.loadBatch(batchId)
  assert.equal(await page.createDraft(group), false)
  assert.equal(page.state.rows.length, 1)
  assert.equal(page.state.groups[0].previewToken, token)
  assert.match(page.state.error, /期间已关闭/)
})
test('刷新后沿用服务端原创建意图，创建结果待核实的来源禁止编辑', async () => {
  let sent
  const { page, batch } = setup({ async createDraft(_id, _group, request, key) { sent = [request, key]; throw new Error('继续查询原事务') } })
  const intent = { key: batchId, request: { groupVersion: 2, previewToken: token, confirm: true } }
  batch.groups[0].createStatus = 'UNKNOWN'; batch.groups[0].createIntent = intent
  await page.loadBatch(batchId)
  assert.equal(page.startEdit(page.state.rows[0], 'productSpec'), false)
  await page.createDraft(page.state.groups[0])
  assert.deepEqual(sent, [intent.request, intent.key])
})
