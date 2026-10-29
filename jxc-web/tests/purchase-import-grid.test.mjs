import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const batchId = '11111111-2222-4333-8444-555555555555'
const header = { bookId: null, supplierId: null, currency: null, orderDate: null, expectedDate: null, paymentTerms: '', prepayRatio: null, termDays: null }
const row = () => ({ id: 17, version: 3, rowNo: 1, sourceId: 9, sourceSheet: '原表', sourceRow: 8, sourceOrderNo: 'PO-01', suppliedProductName: '来源商品', photo: null, productSpec: 'S', purchaseQty: '10.0000', saleUnitPrice: null, saleTotal: null, purchaseUnitPrice: '53.0606250000', freight: null, landedUnitCost: null, usdUnitCost: null, usdTotal: null, readiness: 'READY', images: [{ id: 7, sha256: 'a'.repeat(64), status: 'CONFIRMED' }] })
const batch = () => ({ batchId, version: 5, status: 'REVIEW', header: { ...header }, rows: [row()] })
function setup(saveGrid = async () => batch()) {
  const { createPurchaseImportModel } = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
  let n = 0
  const page = createPurchaseImportModel({ load: async () => batch(), saveGrid }, '2026-10-29', () => `11111111-2222-4333-8444-${String(++n).padStart(12, '0')}`)
  return page
}

test('切换视图保留改名和完整精度，原图来源及服务器快照保持完整', async () => {
  const page = setup(); await page.loadBatch(batchId)
  assert.equal(page.grid.setMode('excel'), true)
  page.grid.edit(17, 'suppliedProductName', '新的名字')
  page.grid.edit(17, 'purchaseUnitPrice', '123.1234567890')
  for (let i = 0; i < 3; i++) { page.grid.setMode('table'); page.grid.setMode('excel') }
  const changed = page.grid.rows()[0]
  assert.equal(changed.suppliedProductName, '新的名字')
  assert.equal(changed.purchaseUnitPrice, '123.1234567890')
  assert.deepEqual(changed.images, row().images)
  assert.equal(changed.sourceRow, 8); assert.equal(changed.id, 17); assert.equal(changed.version, 3)
  assert.deepEqual(page.state.rows[0], row())
})

test('空表区域粘贴增加行，空数量与价格保持未知且固定表头不进入数据', () => {
  const page = setup(); page.grid.setMode('excel')
  assert.equal(page.grid.applyPaste(0, 'sourceOrderNo', [['新单号', '商品甲', '', 'M', ''], ['新单号', '商品乙', '', 'L', '2']]), true)
  assert.equal(page.grid.rows().filter(r => r.sourceOrderNo).length, 2)
  assert.equal(page.grid.rows()[0].purchaseQty, null)
  assert.equal(page.grid.rows()[0].purchaseUnitPrice, null)
  assert.equal(page.grid.rows()[1].suppliedProductName, '商品乙')
  assert.equal(page.grid.hasChanges(), true)
})

test('越列或锁定行粘贴整次拒绝，不截断也不部分覆盖', async () => {
  const page = setup(); await page.loadBatch(batchId); page.grid.setMode('excel')
  assert.equal(page.grid.applyPaste(0, 'usdTotal', [['10', '多余列']]), false)
  assert.equal(page.grid.rows()[0].usdTotal, null)
  page.state.rows[0].targetOrderLineId = 99
  assert.equal(page.grid.applyPaste(0, 'suppliedProductName', [['不能覆盖']]), false)
  assert.equal(page.grid.rows()[0].suppliedProductName, '来源商品')
  assert.match(page.state.error, /列|关联|不能/)
})

test('照片文本不可由Excel粘贴覆盖，非法数值不改变任何行', async () => {
  const page = setup(); await page.loadBatch(batchId); page.grid.setMode('excel')
  assert.equal(page.grid.applyPaste(0, 'photo', [['随意图片']]), false)
  assert.equal(page.grid.applyPaste(0, 'purchaseQty', [['abc'], ['3']]), false)
  assert.equal(page.grid.rows()[0].purchaseQty, '10.0000')
  assert.equal(page.grid.rows().filter(r => r.id > 0).length, 1)
})

test('保存失败保留草稿和请求标识，重试成功读回后才清草稿', async () => {
  const calls = []; let fail = true
  const page = setup(async (input, key) => {
    calls.push([structuredClone(input), key])
    if (fail) throw new Error('保存连接中断')
    return { ...batch(), version: 6, rows: [{ ...row(), version: 4, suppliedProductName: '修改名称' }] }
  })
  await page.loadBatch(batchId); page.grid.setMode('excel'); page.grid.edit(17, 'suppliedProductName', '修改名称')
  assert.equal(await page.grid.save(), false); assert.equal(page.grid.hasChanges(), true)
  page.grid.setMode('table'); assert.equal(page.grid.rows()[0].suppliedProductName, '修改名称')
  fail = false; assert.equal(await page.grid.save(), true)
  assert.deepEqual(calls[0], calls[1])
  assert.equal(page.grid.hasChanges(), false); assert.equal(page.state.rows[0].version, 4)
})

test('保存响应缺行或丢图时不清除草稿，不误报成功', async () => {
  const page = setup(async () => ({ ...batch(), version: 6, rows: [] }))
  await page.loadBatch(batchId); page.grid.setMode('excel'); page.grid.edit(17, 'suppliedProductName', '留下草稿')
  assert.equal(await page.grid.save(), false); assert.equal(page.grid.hasChanges(), true)
  assert.equal(page.grid.rows()[0].suppliedProductName, '留下草稿')
  assert.match(page.state.error, /返回|明细|记录/)
})

test('有表格草稿时重新读取与原编辑不能覆盖草稿', async () => {
  const page = setup(); await page.loadBatch(batchId); page.grid.setMode('excel')
  page.grid.edit(17, 'suppliedProductName', '尚未保存')
  assert.equal(await page.loadBatch(batchId), false)
  assert.equal(page.startEdit(page.state.rows[0], 'purchaseQty'), false)
  assert.equal(page.grid.rows()[0].suppliedProductName, '尚未保存')
})

test('保存期间切换上下文，旧响应不能回填新页面', async () => {
  let resolve
  const page = setup(() => new Promise(r => { resolve = r }))
  await page.loadBatch(batchId); page.grid.setMode('excel'); page.grid.edit(17, 'suppliedProductName', '旧页')
  const pending = page.grid.save(); page.invalidate(); resolve({ ...batch(), version: 6 })
  assert.equal(await pending, false); assert.equal(page.state.batchId, null); assert.equal(page.grid.hasChanges(), false)
})

test('区域删除与填充也进入同一草稿，不能只改组件投影', async () => {
  const page = setup(); await page.loadBatch(batchId); page.grid.setMode('excel')
  assert.equal(page.grid.applyRange({ 0: { productSpec: null, purchaseUnitPrice: '7.1234567890' } }), true)
  page.grid.setMode('table')
  assert.equal(page.grid.rows()[0].productSpec, null)
  assert.equal(page.grid.rows()[0].purchaseUnitPrice, '7.1234567890')
  assert.equal(page.grid.rows()[0].suppliedProductName, '来源商品')
  assert.deepEqual(page.grid.rows()[0].images, row().images)
})

test('商品名可在原普通表格保存，继续复用补充名称字段', async () => {
  const { createPurchaseImportModel } = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
  let request
  const page = createPurchaseImportModel({load: async()=>batch(),saveRow:async(_batch,current,values,matchInputs)=>{
    request={values,matchInputs};return {...current,...values,...matchInputs,version:4}
  }},'2026-10-29')
  await page.loadBatch(batchId);assert.equal(page.startEdit(page.state.rows[0],'suppliedProductName'),true)
  page.state.edit.values.suppliedProductName='普通表格名称'
  assert.equal(await page.saveEdit(),true);assert.equal(page.state.rows[0].suppliedProductName,'普通表格名称')
  assert.equal(request.matchInputs.suppliedProductName,'普通表格名称')
  assert.equal('suppliedProductName' in request.values,false)
})

test('整行改名并上传照片必须一起提交，不能保存照片后丢掉名称', async () => {
  const { createPurchaseImportModel } = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
  let request
  const page=createPurchaseImportModel({load:async()=>batch(),uploadPhoto:async(_batch,current,_file,values,_key,matchInputs)=>{
    request=matchInputs
    return {...batch(),version:6,rows:[{...current,...values,...matchInputs,version:4,images:[{id:8,sha256:'b'.repeat(64),status:'CONFIRMED',origin:'MANUAL_UPLOAD'}]}]}
  }},'2026-10-29')
  await page.loadBatch(batchId);page.startEdit(page.state.rows[0],null)
  page.state.edit.values.suppliedProductName='新名称和照片'
  page.selectPhoto(new File(['png'],'商品.png',{type:'image/png'}))
  assert.equal(await page.saveEdit(),true)
  assert.equal(request?.suppliedProductName,'新名称和照片')
  assert.equal(page.state.rows[0].suppliedProductName,'新名称和照片')
})
