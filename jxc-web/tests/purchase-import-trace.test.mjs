import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const { createPurchaseImportModel } = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
const batchId = '11111111-2222-4333-8444-555555555555'
function setup(extra = {}) {
  const group = { id: 8, version: 4, sourceOrderNo: 'PO', header: {}, createStatus: 'DRAFT', verifyStatus: 'NOT_CHECKED', errors: [], preview: null, previewToken: null, orderId: null, feeTodosVersion: 1, sourceBasisHash: 'a'.repeat(64), feeTodos: [], sourceEvidence: [] }
  const batch = { batchId, header: { bookId: 1, supplierId: 2, currency: 'USD', orderDate: '2026-10-28', expectedDate: null, paymentTerms: '', prepayRatio: '0', termDays: 0 }, rows: [], groups: [group], version: 3, status: 'REVIEW' }
  return { group, batch, page: createPurchaseImportModel({ async load() { return batch }, ...extra }, '2026-10-28') }
}
test('费用保存失败保留原待办，成功仅更新费用版本而不改建单版本', async () => {
  let calls = 0
  const { page, group } = setup({ async saveFeeTodos(_id, original, items) { calls++; if (calls === 1) throw new Error('费用核对保存失败'); return { ...original, feeTodosVersion: 2, feeTodos: [], sourceEvidence: [] } } })
  await page.loadBatch(batchId)
  assert.equal(await page.saveFeeTodos(group, []), false); assert.equal(page.state.groups[0].feeTodosVersion, 1)
  assert.equal(await page.saveFeeTodos(group, []), true); assert.equal(page.state.groups[0].version, 4); assert.equal(page.state.groups[0].feeTodosVersion, 2)
})
test('后端不能把待办伪装成已登记费用，坏响应保留原分组', async () => {
  const { page, batch, group } = setup({ async saveFeeTodos() { return { ...group, feeTodosVersion: 2, feeTodos: [{ format: 'FeeTodoV1', status: 'REGISTERED', amount: '0', currency: 'USD', sourceRows: [] }] } } })
  await page.loadBatch(batchId)
  assert.equal(await page.saveFeeTodos(group, []), false); assert.match(page.state.error, /费用待办/)
  assert.equal(page.state.groups[0].feeTodosVersion, batch.groups[0].feeTodosVersion)
})

test('费用独立保存采用服务端最新建单状态，不用旧编辑副本覆盖原请求', async () => {
  const { page, group } = setup({ async saveFeeTodos(_id, original) { return { ...original, version: 5, feeTodosVersion: 2, createStatus: 'UNKNOWN', createIntent: { key: batchId, request: { groupVersion: 5 } } } } })
  await page.loadBatch(batchId)
  assert.equal(await page.saveFeeTodos(group, []), true)
  assert.equal(page.state.groups[0].version, 5); assert.equal(page.state.groups[0].createStatus, 'UNKNOWN')
  assert.equal(page.state.groups[0].createIntent.key, batchId)
})
