import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const modelUrl = new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url)
const batchId = '11111111-2222-4333-8444-555555555555'
const header = () => ({ bookId: 1, supplierId: 2, currency: 'USD', orderDate: '2026-10-28', expectedDate: null, paymentTerms: '', prepayRatio: '0', termDays: null })
const row = (id = 1) => ({ id, version: 1, rowNo: id, sourceOrderNo: 'NY-051', photo: null, productSpec: 'S', purchaseQty: '10', saleUnitPrice: '82.15', saleTotal: '821.5', purchaseUnitPrice: '53', freight: null, landedUnitCost: null, usdUnitCost: null, usdTotal: null })
const batch = () => ({ batchId, header: header(), rows: [row()] })
const group = () => ({ id: 8, version: 2, sourceOrderNo: 'NY-051', header: header(), createStatus: 'DRAFT', verifyStatus: 'NOT_CHECKED', errors: [], preview: null, previewToken: null, orderId: null })
const file = () => new File(['xlsx-bytes'], '采购.xlsx')
const unconfiguredHeader = () => ({ bookId: null, supplierId: null, currency: null, orderDate: null, expectedDate: null, paymentTerms: '', prepayRatio: null, termDays: null })
function setup(overrides = {}) {
  assert.ok(existsSync(modelUrl), '缺少采购导入工作区模型')
  const { createPurchaseImportModel } = loadTsModule(modelUrl)
  const calls = []
  const api = {
    async upload(...args) { calls.push(['upload', ...args]); return batch() },
    async load(id) { calls.push(['load', id]); return batch() },
    async saveHeader(id, value, versions) { calls.push(['header', id, value, versions]); return { ...batch(), header: value } },
    async saveRow(id, item, values) { calls.push(['save', id, structuredClone(item), structuredClone(values)]); return { ...item, ...values, version: item.version + 1 } },
    async saveGrid(input, key) { calls.push(['grid', input, key]); return { ...batch(), version: 2, rows: input.rows.map(change => ({ ...row(change.id), ...change.values, ...change.matchInputs, version: change.version + 1 })) } },
    async deleteRow(id, item) { calls.push(['delete', id, structuredClone(item)]); return { deleted: true, id: item.id } },
    ...overrides,
  }
  let key = 0
  const page = createPurchaseImportModel(api, '2026-10-28', () => `intent-${++key}`)
  Object.assign(page.state.header, header())
  return { page, calls }
}

test('基础税务字段保存及本地草稿恢复保留明确值，未知保持为空且非法值不能保存', async () => {
  const { validateImportHeader } = loadTsModule(modelUrl)
  for (const value of [null, '', '0', '0.13', '1', '0.123456']) assert.equal(validateImportHeader({ ...header(), taxRate: value, priceTaxBasis: 'EXCLUSIVE' }), '')
  for (const value of ['-0.01', '1.01', '0.1234567', 'abc']) assert.match(validateImportHeader({ ...header(), taxRate: value }), /税率/)
  assert.match(validateImportHeader({ ...header(), priceTaxBasis: 'INCLUSIVE' }), /单价口径/)
  const { page, calls } = setup(); await page.loadBatch(batchId)
  Object.assign(page.state.header, { taxRate: '0.13', priceTaxBasis: 'EXCLUSIVE' })
  assert.equal(await page.saveHeader(), true)
  assert.equal(calls.find(call => call[0] === 'header')[2].taxRate, '0.13')
  const restored = setup().page; restored.restoreLocalDraft(page.exportLocalDraft())
  assert.equal(restored.state.header.taxRate, '0.13'); assert.equal(restored.state.header.priceTaxBasis, 'EXCLUSIVE')
  page.state.header.taxRate = null; assert.equal(await page.saveHeader(), true)
  assert.equal(page.state.header.taxRate, null)
})

test('未填写业务表头也能导入暂存，上传请求不携带页面基础信息', async () => {
  const { page, calls } = setup({ async upload(...args) { calls.push(['upload', ...args]); return { ...batch(), header: unconfiguredHeader() } } })
  Object.assign(page.state.header, unconfiguredHeader())
  assert.equal(await page.importFile(file()), true)
  assert.equal(calls[0].length, 5)
  assert.equal(typeof calls[0][4], 'function')
  assert.equal(calls[0][2], null)
  assert.equal(page.state.rows.length, 1)
  assert.equal(page.state.header.bookId, null)
  assert.equal(page.headerDirty(), false)
})

test('导入及解析轮询保留未保存表头草稿，缺项只在保存时拦截', async () => {
  const pending = { ...batch(), header: unconfiguredHeader(), rows: [], status: 'PARSING', version: 1, tasks: [{ id: batchId, status: 'QUEUED' }] }
  const { page, calls } = setup({ async upload() { return pending }, async load() { return { ...pending, rows: [row()], status: 'REVIEW', version: 2, tasks: [{ id: batchId, status: 'SUCCEEDED' }] } } })
  Object.assign(page.state.header, unconfiguredHeader(), { paymentTerms: '待业务保存时核对', orderDate: '2026-02-30' })
  assert.equal(await page.importFile(file()), true)
  assert.equal(await page.refreshTasks(), true)
  assert.equal(page.state.rows.length, 1)
  assert.equal(page.state.header.paymentTerms, '待业务保存时核对')
  assert.equal(page.state.header.orderDate, '2026-02-30')
  assert.equal(await page.saveHeader(), false)
  assert.match(page.state.error, /账套/)
  assert.equal(calls.length, 0)
})

test('无表头的暂存数据可以刷新和编辑来源明细', async () => {
  const { page } = setup({ async load() { return { ...batch(), header: unconfiguredHeader() } } })
  assert.equal(await page.loadBatch(batchId), true)
  assert.equal(page.startEdit(page.state.rows[0], 'purchaseQty'), true)
  page.state.edit.values.purchaseQty = '11'
  assert.equal(await page.saveEdit(), true)
  assert.equal(page.grid.rows()[0].purchaseQty, '11')
  assert.equal(page.state.rows[0].purchaseQty, '10')
})

test('上传成功采用服务器保存后的批次和明细，不生成示例行', async () => {
  const { page, calls } = setup()
  assert.equal(page.state.rows.length, 0)
  assert.equal(await page.importFile(file()), true)
  assert.equal(page.state.batchId, batchId)
  assert.equal(page.state.rows[0].purchaseUnitPrice, '53')
  assert.equal(page.state.rows[0].freight, null)
  assert.equal(calls[0][2], null)
  assert.equal(calls[0].length, 5)
})

test('异步上传只接收任务，解析保存成功前不显示已导入', async () => {
  const pending = { ...batch(), version: 1, status: 'PARSING', rows: [], sources: [], tasks: [{ id: batchId, status: 'QUEUED' }], taskId: batchId }
  const { page } = setup({ async upload() { return pending }, async load() { return { ...pending, version: 2, status: 'REVIEW', rows: [row()], tasks: [{ id: batchId, status: 'SUCCEEDED' }] } } })
  assert.equal(await page.importFile(file()), true)
  assert.equal(page.state.batchId, batchId)
  assert.equal(page.state.rows.length, 0)
  assert.equal(page.state.success, '')
  assert.equal(page.state.status, 'PARSING')
  assert.equal(await page.refreshTasks(), true)
  assert.equal(page.state.rows.length, 1)
  assert.match(page.state.success, /已暂存/)
})

test('解析失败可恢复任务原因，多工作表需明确选择后重试', async () => {
  const failed = { ...batch(), version: 1, status: 'FAILED', rows: [], sources: [], tasks: [{ id: batchId, status: 'FAILED', errorCode: 'SHEET_SELECTION_REQUIRED', errorMessage: '请选择工作表', result: { sheets: ['采购A', '采购B'] } }] }
  let command
  const { page } = setup({ async load() { return failed }, async retryTask(...args) { command = args; return { id: batchId, status: 'QUEUED' } } })
  await page.loadBatch(batchId)
  assert.equal(page.state.tasks[0].errorCode, 'SHEET_SELECTION_REQUIRED')
  assert.equal(await page.retryTask(page.state.tasks[0], '采购B'), true)
  assert.equal(command[0], batchId)
  assert.equal(command[2], '采购B')
  assert.equal(page.state.tasks[0].status, 'QUEUED')
})

test('解析任务刷新失败保留原批次，不以空结果吞掉故障', async () => {
  let fail = false
  const pending = { ...batch(), version: 1, status: 'PARSING', tasks: [{ id: batchId, status: 'RUNNING' }] }
  const { page } = setup({ async load() { if (fail) throw new Error('读取超时'); return pending } })
  await page.loadBatch(batchId)
  fail = true
  assert.equal(await page.refreshTasks(), false)
  assert.equal(page.state.rows.length, 1)
  assert.match(page.state.error, /超时/)
})

test('人工确认图片后保留其他规格行并采用新的行与批次版本', async () => {
  const image = { id: 8, sha256: 'a'.repeat(64), status: 'UNCONFIRMED' }
  const { page } = setup({ async load() { return { ...batch(), version: 3, rows: [{ ...row(), images: [image] }, row(2)] } }, async associate(_batch, current, imageId, status) { return { ...current, version: 2, batchVersion: 4, images: [{ ...image, id: imageId, status }] } } })
  await page.loadBatch(batchId)
  assert.equal(await page.associate(page.state.rows[0], 8, 'CONFIRMED'), true)
  assert.equal(page.state.rows[0].images[0].status, 'CONFIRMED')
  assert.equal(page.state.rows[1].productSpec, 'S')
  assert.equal(page.state.version, 4)
})

test('非XLSX或空文件仍不会触发上传', async () => {
  const { page, calls } = setup()
  for (const bad of [new File(['text'], '单据.csv'), new File([], '单据.xlsx')]) {
    assert.equal(await page.importFile(bad), false)
    assert.ok(page.state.error)
  }
  assert.equal(calls.length, 0)
})

test('导入失败保留现有行，并展示后端行字段错误而不是假成功', async () => {
  const { page } = setup({ async upload() { throw Object.assign(new Error('文件校验失败'), { data: { errors: [{ rowNo: 5, field: 'purchaseQty', message: '采购数量须大于0' }] } }) } })
  await page.loadBatch(batchId)
  assert.equal(await page.importFile(file()), false)
  assert.equal(page.state.rows.length, 1)
  assert.match(page.state.error, /文件校验失败/)
  assert.equal(page.state.errors[0].rowNo, 5)
  assert.equal(page.state.importing, false)
})

test('空成功响应与重复记录编号被当作响应错误，不替换既有数据', async () => {
  for (const response of [undefined, {}, { ...batch(), rows: [row(), row()] }]) {
    const { page } = setup({ async upload() { return response } })
    await page.loadBatch(batchId)
    assert.equal(await page.importFile(file()), false)
    assert.equal(page.state.rows.length, 1)
    assert.match(page.state.error, /返回|重复/)
  }
})

test('文件上传重试不受未保存表头变化影响，并明确提示网络中断', async () => {
  const keys = []
  const { page } = setup({ async upload(_file, _batch, key) { keys.push(key); throw new Error('Network Error') } })
  const selected = file()
  await page.importFile(selected)
  await page.importFile(selected)
  page.state.header.paymentTerms = '30天'
  await page.importFile(selected)
  assert.deepEqual(keys, ['intent-1', 'intent-1', 'intent-1'])
  assert.match(page.state.error, /连接中断.*未确认/)
})

test('单元格编辑保存精确数值及版本，取消不改变正式值', async () => {
  const { page, calls } = setup()
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], 'purchaseQty')
  page.state.edit.values.purchaseQty = '12.0001'
  assert.equal(page.state.rows[0].purchaseQty, '10')
  assert.equal(await page.saveEdit(), true)
  assert.equal(page.state.rows[0].purchaseQty, '10')
  assert.equal(await page.grid.save(), true)
  assert.equal(page.state.rows[0].purchaseQty, '12.0001')
  assert.equal(page.state.rows[0].version, 2)
  assert.equal(calls.at(-1)[1].rows[0].version, 1)
  page.startEdit(page.state.rows[0], null)
  page.state.edit.values.purchaseUnitPrice = '999'
  page.cancelEdit()
  assert.equal(page.state.rows[0].purchaseUnitPrice, '53')
})

test('保存失败保留编辑草稿，可重试且不会开启另一份编辑', async () => {
  let failures = 1
  const { page } = setup({ async saveGrid(input) { if (failures--) throw new Error('版本冲突，请核对'); return { ...batch(), rows: [{ ...row(), ...input.rows[0].values, version: 2 }] } } })
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], null)
  page.state.edit.values.purchaseQty = '12'
  assert.equal(page.startEdit(row(2), 'purchaseQty'), false)
  assert.equal(await page.saveEdit(), true)
  assert.equal(await page.grid.save(), false)
  assert.match(page.state.error, /版本冲突/)
  assert.equal(page.grid.rows()[0].purchaseQty, '12')
  assert.equal(page.state.rows[0].purchaseQty, '10')
  assert.equal(await page.grid.save(), true)
  assert.equal(page.state.rows[0].purchaseQty, '12')
})

test('数量和金额精度校验不把空值与未知价格自动转换成0', async () => {
  const { page, calls } = setup()
  await page.loadBatch(batchId)
  for (const invalid of ['0', '-1', 'NaN', '1.00001']) {
    page.startEdit(page.grid.rows()[0], null)
    page.state.edit.values.purchaseQty = invalid
    assert.equal(await page.saveEdit(), true)
    assert.equal(await page.grid.save(), false)
  }
  assert.equal(calls.filter(item => item[0] === 'save').length, 0)
  page.startEdit(page.grid.rows()[0], null)
  page.state.edit.values.purchaseQty = '1'
  page.state.edit.values.purchaseUnitPrice = ''
  assert.equal(await page.saveEdit(), true)
  assert.equal(page.grid.rows()[0].purchaseUnitPrice, null)
})

test('整行编辑与单元格编辑使用同一校验，错误保存响应不能覆盖原行', async () => {
  const { page } = setup({ async saveGrid() { return { ...batch(), rows: [{ ...row(2), version: 2 }] } } })
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], 'purchaseQty')
  page.state.edit.values.purchaseQty = '12'
  assert.equal(await page.saveEdit(), true)
  assert.equal(await page.grid.save(), false)
  assert.equal(page.state.rows[0].id, 1)
  assert.equal(page.grid.hasChanges(), true)
})

test('删除失败保留原行，明确成功后才删除，最后一行删除后为空', async () => {
  let failures = 1
  const { page } = setup({ async deleteRow(_batch, item) { if (failures--) throw new Error('删除失败'); return { deleted: true, id: item.id } } })
  await page.loadBatch(batchId)
  assert.equal(await page.removeRow(page.state.rows[0]), false)
  assert.equal(page.state.rows.length, 1)
  assert.equal(await page.removeRow(page.state.rows[0]), true)
  assert.equal(page.state.rows.length, 0)
})

test('删除空响应不视为成功', async () => {
  const { page } = setup({ async deleteRow() {} })
  await page.loadBatch(batchId)
  assert.equal(await page.removeRow(page.state.rows[0]), false)
  assert.equal(page.state.rows.length, 1)
})

test('刷新按批次读取，失败保留错误，重试可恢复', async () => {
  let attempts = 0
  const { page } = setup({ async load(id) { assert.equal(id, batchId); if (!attempts++) throw new Error('没有权限'); return batch() } })
  assert.equal(await page.loadBatch(batchId), false)
  assert.match(page.state.error, /没有权限/)
  assert.equal(await page.loadBatch(batchId), true)
  assert.equal(page.state.rows[0].sourceOrderNo, 'NY-051')
  assert.equal(page.state.error, '')
})

test('保存基础信息携带全部行版本，成功前保留服务器快照', async () => {
  const { page, calls } = setup()
  await page.loadBatch(batchId)
  page.state.header.paymentTerms = '货到30天'
  assert.equal(page.headerDirty(), true)
  assert.equal(await page.saveHeader(), true)
  assert.equal(page.headerDirty(), false)
  assert.deepEqual(calls.at(-1)[3], [{ id: 1, version: 1 }])
})

test('基础信息合法性包括真实日期和非负整数账期', async () => {
  const { page, calls } = setup()
  await page.loadBatch(batchId)
  for (const [field, value] of [['orderDate', '2026-02-30'], ['prepayRatio', '1.01'], ['termDays', -1], ['termDays', 1.5]]) {
    Object.assign(page.state.header, header(), { [field]: value })
    assert.equal(await page.saveHeader(), false)
    assert.ok(page.state.error)
  }
  assert.equal(calls.filter(call => call[0] === 'header').length, 0)
})

test('离开或切换上下文后，旧上传回调不能写回新页面', async () => {
  let resolve
  const { page } = setup({ upload: () => new Promise(done => { resolve = done }) })
  const pending = page.importFile(file())
  assert.equal(page.state.importing, true)
  assert.equal(await page.importFile(file()), false)
  page.invalidate()
  resolve(batch())
  await pending
  assert.equal(page.state.rows.length, 0)
  assert.equal(page.state.batchId, null)
})

test('较早的批次读取不能覆盖较新的读取结果', async () => {
  let first
  const { page } = setup({ load: id => id === batchId ? new Promise(done => { first = done }) : Promise.resolve({ ...batch(), batchId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', rows: [row(2)] }) })
  const pending = page.loadBatch(batchId)
  await page.loadBatch('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  first(batch())
  await pending
  assert.equal(page.state.rows[0].id, 2)
})

test('无效的新批次地址会结束旧读取的忙碌状态', async () => {
  let resolve
  const { page } = setup({ load: () => new Promise(done => { resolve = done }) })
  const old = page.loadBatch(batchId)
  assert.equal(await page.loadBatch('invalid'), false)
  assert.equal(page.state.loading, false)
  resolve(batch())
  await old
  assert.equal(page.state.batchId, null)
})

test('已过期的删除目标不会被提交到当前批次', async () => {
  const { page, calls } = setup()
  await page.loadBatch(batchId)
  assert.equal(await page.removeRow({ ...row(), version: 9 }), false)
  assert.equal(calls.filter(call => call[0] === 'delete').length, 0)
  assert.equal(page.state.rows.length, 1)
})

test('重新读取坏候选证据时明确失败并保留原明细', async () => {
  let response = batch()
  const { page } = setup({ async load() { return response } })
  await page.loadBatch(batchId)
  response = { ...batch(), rows: [{ ...row(), matchResult: { format: 'MatchRunV1', candidates: [{ productId: 'fake' }] } }] }
  assert.equal(await page.loadBatch(batchId), false)
  assert.match(page.state.error, /候选/)
  assert.deepEqual(page.state.rows, batch().rows)
})

test('实际图片候选证据保留原图和命中图编号，损坏编号或分数拒绝替换已加载明细', async () => {
  const evidence = { queryAssetId: 11, imageId: 701, featureId: 801, score: 0.91 }
  const candidate = { productId: 501, product: { id: 501, productCode: 'SKU', name: '商品', spec: 'S', units: [{ unit: '件' }] }, visualScore: 0.91, visualEvidence: [evidence], textEvidence: [], conflicts: [] }
  const matchResult = { format: 'MatchRunV1', runId: batchId, inputRevision: 1, status: 'OK', text: { status: 'NO_INPUT', reason: '无文字' }, image: { status: 'FOUND', reason: '有命中图' }, candidates: [candidate], explanation: { status: 'NOT_REQUESTED', message: '未请求' } }
  let response = { ...batch(), rows: [{ ...row(), matchResult }] }
  const { page } = setup({ async load() { return response } })
  assert.equal(await page.loadBatch(batchId), true)
  assert.deepEqual(page.state.rows[0].matchResult.candidates[0].visualEvidence, [evidence])
  for (const patch of [{ queryAssetId: 0 }, { imageId: 'wrong' }, { featureId: null }, { score: NaN }, { score: 1.1 }]) {
    response = { ...batch(), rows: [{ ...row(), matchResult: { ...matchResult, candidates: [{ ...candidate, visualEvidence: [{ ...evidence, ...patch }] }] } }] }
    assert.equal(await page.loadBatch(batchId), false)
    assert.match(page.state.error, /候选证据/)
    assert.deepEqual(page.state.rows[0].matchResult.candidates[0].visualEvidence, [evidence])
  }
})

test('历史批次不能把费用待办伪装成已登记，坏响应保留原分组', async () => {
  const original = { ...group(), feeTodosVersion: 1, sourceBasisHash: 'a'.repeat(64), feeTodos: [], sourceEvidence: [] }
  let response = { ...batch(), groups: [original] }
  const { page } = setup({ async load() { return response } })
  await page.loadBatch(batchId)
  response = { ...batch(), groups: [{ ...original, feeTodos: [{ format: 'FeeTodoV1', todoId: batchId, status: 'REGISTERED', registeredReference: null, reviewStatus: 'UNRESOLVED', sourceRowIds: [1], sourceRows: [{ rowId: 1 }], amount: '0', currency: 'USD', scope: 'ORDER', reason: '原运费待核实' }] }] }
  assert.equal(await page.loadBatch(batchId), false)
  assert.match(page.state.error, /费用待办/)
  assert.deepEqual(page.state.groups, [original])
})

test('刷新历史批次后创建结果待核实的来源仍禁止编辑', async () => {
  const pending = { ...group(), createStatus: 'UNKNOWN', createIntent: { key: batchId, request: { groupVersion: 2 } } }
  const { page } = setup({ async load() { return { ...batch(), rows: [{ ...row(), groupId: 8 }], groups: [pending] } } })
  assert.equal(await page.loadBatch(batchId), true)
  assert.equal(page.startEdit(page.state.rows[0], 'productSpec'), false)
  assert.equal(page.state.edit, null)
  assert.equal(page.state.groups[0].createIntent.key, batchId)
})
