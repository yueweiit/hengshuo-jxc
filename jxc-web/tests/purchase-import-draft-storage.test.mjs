import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const modelModule = () => loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
const draftModule = () => loadTsModule(new URL('../src/modules/purchase/purchaseImportDraft.ts', import.meta.url))
const page = () => modelModule().createPurchaseImportModel({}, '2026-10-29')

test('清空同时覆盖空白入口和旧批次入口，后台清理待办跨页面继续保留', async () => {
  const { createPurchaseImportDraftSession, purchaseImportDraftKey } = draftModule()
  const records = new Map(), store = { read: async key => records.get(key), write: async (key, value) => records.set(key, value) }
  const current = page(), session = createPurchaseImportDraftSession(current, store)
  const blank = purchaseImportDraftKey(1, 2, null), batch = purchaseImportDraftKey(1, 2, '11111111-2222-4333-8444-555555555555')
  await session.open(blank); current.state.header.paymentTerms = '旧入口'; await session.flush()
  await session.open(batch); current.state.header.paymentTerms = '旧批次'; await current.clearAll()
  current.restoreCleanupJobs([{ id: '11111111-2222-4333-8444-555555555555', version: 1, key: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'READY', error: '' }])
  assert.equal(await session.flushCleared(), true); session.stop()
  for (const entry of [blank, batch]) {
    const restored = page(), next = createPurchaseImportDraftSession(restored, store); await next.open(entry)
    assert.equal(restored.state.header.paymentTerms, ''); assert.equal(restored.state.header.orderDate, null)
    assert.equal(restored.state.cleanupJobs.length, 1); next.stop()
  }
})

test('同一浏览器会话恢复文字和图片，账号国家入口批次分别隔离', async () => {
  const { createPurchaseImportDraftSession, purchaseImportDraftKey } = draftModule()
  const records = new Map()
  const store = { read: async key => records.get(key), write: async (key, value) => { records.set(key, value) } }
  const key = purchaseImportDraftKey(1, 2, null)
  let current = page(), session = createPurchaseImportDraftSession(current, store)
  await session.open(key); current.grid.setMode('excel')
  current.grid.applyPaste(0, 'suppliedProductName', [['本地照片商品']])
  current.grid.selectPhoto(current.grid.rows()[0].id, new File(['image'], '本地图.png', { type: 'image/png' }))
  current.grid.setMode('table'); assert.equal(await session.flush(), true); session.stop()
  current = page(); session = createPurchaseImportDraftSession(current, store)
  assert.equal(await session.open(key), true)
  assert.equal(current.grid.rows()[0].suppliedProductName, '本地照片商品')
  assert.equal(await current.grid.photo(current.grid.rows()[0].id).text(), 'image')
  for (const other of [purchaseImportDraftKey(3, 2, null), purchaseImportDraftKey(1, 4, null), purchaseImportDraftKey(1, 2, 'batch-a')]) assert.notEqual(key, other)
  assert.equal(await session.open(purchaseImportDraftKey(3, 2, null)), false)
  assert.equal(current.grid.rows().length, 0); session.stop()
})

test('本地写入失败明确报告且阻止上传，仍保留内存草稿', async () => {
  const { createPurchaseImportDraftSession } = draftModule()
  const current = page(), session = createPurchaseImportDraftSession(current, { read: async () => undefined, write: async () => { throw new Error('QuotaExceededError') } })
  await session.open('account'); current.grid.setMode('excel')
  current.grid.applyPaste(0, 'suppliedProductName', [['不能丢失']])
  assert.equal(await session.flush(), false)
  assert.match(session.view.error, /QuotaExceededError/)
  assert.equal(current.grid.rows()[0].suppliedProductName, '不能丢失')
  assert.equal(await current.grid.save(), false)
  assert.equal(current.state.batchId, null); session.stop()
})

test('清空后的空白快照排在旧写入之后，重新进入不能恢复旧照片和表头', async () => {
  const { createPurchaseImportDraftSession } = draftModule()
  const records = new Map(); let release, delayed = false
  const store = { read: async key => records.get(key), write: async (key, value) => {
    if (!delayed) { delayed = true; await new Promise(resolve => { release = resolve }) }
    records.set(key, value)
  } }
  const current = page(), session = createPurchaseImportDraftSession(current, store)
  await session.open('clear'); current.grid.setMode('excel'); current.grid.applyPaste(0, 'suppliedProductName', [['旧商品']])
  const oldWrite = session.flush(); await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(await current.clearAll(), true)
  const clearedWrite = session.flush(); release(); await oldWrite; await clearedWrite; session.stop()
  const restored = page(), next = createPurchaseImportDraftSession(restored, store)
  await next.open('clear')
  assert.equal(restored.grid.rows().length, 0); assert.equal(restored.state.header.orderDate, null); next.stop()
})

test('只有最后一个排队写入完成后才能显示草稿已保存', async () => {
  const { createPurchaseImportDraftSession } = draftModule()
  const releases = []
  const session = createPurchaseImportDraftSession(page(), { read: async () => undefined, write: () => new Promise(resolve => releases.push(resolve)) })
  await session.open('queued')
  const first = session.flush(), second = session.flush()
  await new Promise(resolve => setTimeout(resolve, 0)); releases[0](); await first
  assert.equal(session.view.saved, false)
  assert.equal(session.view.saving, true)
  releases[1](); assert.equal(await second, true)
  assert.equal(session.view.saved, true); session.stop()
})
