import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const modelUrl = new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url)
const batchId = '11111111-2222-4333-8444-555555555555'
const header = () => ({ bookId: 1, supplierId: 2, currency: 'USD', orderDate: '2026-10-28', expectedDate: null, paymentTerms: '', prepayRatio: '0', termDays: null })
const row = (id = 1) => ({ id, version: 1, rowNo: id, sourceOrderNo: 'NY-051', photo: null, productSpec: 'S', purchaseQty: '10', saleUnitPrice: '82.15', saleTotal: '821.5', purchaseUnitPrice: '53', freight: null, landedUnitCost: null, usdUnitCost: null, usdTotal: null })
const batch = () => ({ batchId, header: header(), rows: [row()] })
const file = () => new File(['xlsx-bytes'], '采购.xlsx')
function setup(overrides = {}) {
  assert.ok(existsSync(modelUrl), '缺少采购导入工作区模型')
  const { createPurchaseImportModel } = loadTsModule(modelUrl)
  const calls = []
  const api = {
    async upload(...args) { calls.push(['upload', ...args]); return batch() },
    async load(id) { calls.push(['load', id]); return batch() },
    async saveHeader(id, value, versions) { calls.push(['header', id, value, versions]); return { ...batch(), header: value } },
    async saveRow(id, item, values) { calls.push(['save', id, structuredClone(item), structuredClone(values)]); return { ...item, ...values, version: item.version + 1 } },
    async deleteRow(id, item) { calls.push(['delete', id, structuredClone(item)]); return { deleted: true, id: item.id } },
    ...overrides,
  }
  let key = 0
  const page = createPurchaseImportModel(api, '2026-10-28', () => `intent-${++key}`)
  Object.assign(page.state.header, header())
  return { page, calls }
}

test('上传成功采用服务器保存后的批次和明细，不生成示例行', async () => {
  const { page, calls } = setup()
  assert.equal(page.state.rows.length, 0)
  assert.equal(await page.importFile(file()), true)
  assert.equal(page.state.batchId, batchId)
  assert.equal(page.state.rows[0].purchaseUnitPrice, '53')
  assert.equal(page.state.rows[0].freight, null)
  assert.equal(calls[0][2].currency, 'USD')
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
  assert.match(page.state.success, /保存1条/)
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

test('缺少基础信息以及非XLSX或空文件不会触发上传', async () => {
  const { page, calls } = setup()
  page.state.header.bookId = null
  assert.equal(await page.importFile(file()), false)
  assert.match(page.state.error, /账套/)
  page.state.header.bookId = 1
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

test('同一次上传失败重试沿用幂等键，基础信息变化时更换', async () => {
  const keys = []
  const { page } = setup({ async upload(_file, _header, _batch, key) { keys.push(key); throw new Error('超时') } })
  const selected = file()
  await page.importFile(selected)
  await page.importFile(selected)
  page.state.header.paymentTerms = '30天'
  await page.importFile(selected)
  assert.deepEqual(keys, ['intent-1', 'intent-1', 'intent-2'])
})

test('单元格编辑保存精确数值及版本，取消不改变正式值', async () => {
  const { page, calls } = setup()
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], 'purchaseQty')
  page.state.edit.values.purchaseQty = '12.0001'
  assert.equal(page.state.rows[0].purchaseQty, '10')
  assert.equal(await page.saveEdit(), true)
  assert.equal(page.state.rows[0].purchaseQty, '12.0001')
  assert.equal(page.state.rows[0].version, 2)
  assert.equal(calls.at(-1)[2].version, 1)
  page.startEdit(page.state.rows[0], null)
  page.state.edit.values.purchaseUnitPrice = '999'
  page.cancelEdit()
  assert.equal(page.state.rows[0].purchaseUnitPrice, '53')
})

test('保存失败保留编辑草稿，可重试且不会开启另一份编辑', async () => {
  let failures = 1
  const { page } = setup({ async saveRow(_batch, item, values) { if (failures--) throw new Error('版本冲突，请核对'); return { ...item, ...values, version: 2 } } })
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], null)
  page.state.edit.values.purchaseQty = '12'
  assert.equal(page.startEdit(row(2), 'purchaseQty'), false)
  assert.equal(await page.saveEdit(), false)
  assert.match(page.state.error, /版本冲突/)
  assert.equal(page.state.edit.values.purchaseQty, '12')
  assert.equal(page.state.rows[0].purchaseQty, '10')
  assert.equal(await page.saveEdit(), true)
  assert.equal(page.state.rows[0].purchaseQty, '12')
})

test('数量和金额精度校验不把空值与未知价格自动转换成0', async () => {
  const { page, calls } = setup()
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], null)
  for (const invalid of ['0', '-1', 'NaN', '1.00001']) {
    page.state.edit.values.purchaseQty = invalid
    assert.equal(await page.saveEdit(), false)
  }
  assert.equal(calls.filter(item => item[0] === 'save').length, 0)
  page.state.edit.values.purchaseQty = '1'
  page.state.edit.values.purchaseUnitPrice = ''
  assert.equal(await page.saveEdit(), true)
  assert.equal(page.state.rows[0].purchaseUnitPrice, null)
})

test('整行编辑与单元格编辑使用同一校验，错误保存响应不能覆盖原行', async () => {
  const { page } = setup({ async saveRow() { return { ...row(2), version: 2 } } })
  await page.loadBatch(batchId)
  page.startEdit(page.state.rows[0], 'purchaseQty')
  page.state.edit.values.purchaseQty = '12'
  assert.equal(await page.saveEdit(), false)
  assert.equal(page.state.rows[0].id, 1)
  assert.ok(page.state.edit)
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
  for (const [field, value] of [['orderDate', '2026-02-30'], ['prepayRatio', '1.01'], ['termDays', -1], ['termDays', 1.5]]) {
    Object.assign(page.state.header, header(), { [field]: value })
    assert.equal(await page.importFile(file()), false)
    assert.ok(page.state.error)
  }
  assert.equal(calls.length, 0)
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
