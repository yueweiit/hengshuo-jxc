import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const file = new URL('../src/modules/purchase/domesticReceiptAudit.ts', import.meta.url)
function present(beforeValue, afterValue, action = 'CREATE') {
  assert.ok(existsSync(file), '国内收货日志展示尚未实现')
  return loadTsModule(file).domesticReceiptAudit({ id: 1, action, resourceType: 'DOMESTIC_RECEIPT', resourceId: 464, userName: '测试管理员', occurredAt: '2026-10-22T06:44:47Z', beforeValue, afterValue })
}
const row = (patch = {}) => ({ id: 465, version: 1, productId: 21, orderLineId: 223, qualifiedQty: 2, pendingInspectQty: 0, damagedQty: 0, ...patch })
const receipt = (patch = {}) => ({ docNo: 'T01DR-20261022000003', status: 'DRAFT', receiptDate: '2026-10-22', supplierId: 50, location: null, lines: [row()], ...patch })

test('receipt creation exposes real field and quantity columns without inventing historical names or units', () => {
  const source = receipt(), original = structuredClone(source)
  const view = present(null, source)
  assert.equal(view.title, '创建收货单')
  assert.equal(view.isCreate, true)
  assert.ok(view.summary.some(s => s.includes('1 行') && s.includes('2')))
  assert.equal(view.snapshot.fields.find(f => f.label === '供应商').value.text, '供应商 #50')
  assert.equal(view.snapshot.fields.find(f => f.label === '收货地点').value.text, '未填写')
  assert.deepEqual(view.snapshot.columns.map(c => c.label), ['商品', '合格', '待检', '破损'])
  assert.deepEqual(view.snapshot.rows[0].cells.map(c => c.text), ['商品 #21', '2', '0', '0'])
  assert.ok(view.notes.some(s => s.includes('名称') && s.includes('单位')))
  assert.deepEqual(source, original)
})

test('confirmation exposes only the recorded state change with Chinese values', () => {
  const view = present({ status: 'DRAFT' }, { status: 'CONFIRMED' }, 'CONFIRM')
  assert.equal(view.title, '确认收货')
  assert.equal(view.kind, 'confirm')
  assert.deepEqual(view.changes, [{ label: '单据状态', from: { text: '草稿', status: 'DRAFT' }, to: { text: '已确认', status: 'CONFIRMED' } }])
})

test('attachment cards keep the recorded filename, category, identifier and version', () => {
  const view = present(null, { fileName: '屏幕截图(2).png', category: 'PURCHASE_DOC', attachmentId: 1358, versionNo: 1, sha256: 'digest' }, 'ATTACHMENT_UPLOAD')
  assert.equal(view.title, '上传附件')
  assert.equal(view.attachment.fileName, '屏幕截图(2).png')
  assert.equal(view.attachment.category, '采购单据')
  assert.equal(view.attachment.id, '1358')
  assert.equal(view.attachment.version, '1')
})

test('regenerated receipt line IDs do not fabricate changed products or quantities', () => {
  const view = present(receipt(), receipt({ lines: [row({ id: 999, version: 2 })] }), 'UPDATE')
  assert.ok(!view.previousSnapshot)
  assert.ok(!view.summary.some(s => /新增商品|移除商品|商品明细发生变化/.test(s)))
  assert.equal(view.changes.length, 0)
})

test('changed receipt quantities retain both snapshots instead of pairing ambiguous rows by position', () => {
  const view = present(receipt(), receipt({ lines: [row({ id: 999, qualifiedQty: 3 })] }), 'UPDATE')
  assert.equal(view.title, '修改收货单')
  assert.equal(view.previousSnapshot.rows[0].cells[1].text, '2')
  assert.equal(view.snapshot.rows[0].cells[1].text, '3')
  assert.ok(view.summary.some(s => s.includes('商品明细发生变化')))
})

test('missing line snapshots and malformed rows are explicit, never fabricated empty product tables', () => {
  const missing = present(null, receipt({ lines: undefined }))
  const malformed = present(null, receipt({ lines: 'unexpected' }))
  assert.equal(missing.snapshot.rows.length, 0)
  assert.ok(missing.notes.some(s => s.includes('商品明细未记录')))
  assert.ok(malformed.notes.some(s => s.includes('商品明细格式无法识别')))
  assert.ok(!missing.summary.some(s => s.includes('0 行')))
  assert.ok(!malformed.summary.some(s => s.includes('0 行')))
})

test('recorded names and units may be shown, while absent, null and explicit zero remain distinct', () => {
  const view = present(null, receipt({ supplierName: '历史供应商', lines: [row({ productName: '历史商品', baseUnit: '条', qualifiedQty: 0, pendingInspectQty: null, damagedQty: undefined })] }))
  assert.equal(view.snapshot.fields.find(f => f.label === '供应商').value.text, '历史供应商（#50）')
  assert.deepEqual(view.snapshot.rows[0].cells.map(c => c.text), ['历史商品（#21）', '0 条', '未填写', '未记录'])
})

test('conversion and unknown actions preserve actual changes and notes rather than claiming successful creation', () => {
  const converted = present(receipt(), receipt({ lines: [row({ convertedQualifiedQty: 1 })] }), 'CONVERT')
  assert.equal(converted.title, '待检转换')
  assert.ok(converted.previousSnapshot)
  const unknown = present(null, null, 'FUTURE_ACTION')
  assert.equal(unknown.isCreate, false)
  assert.equal(unknown.originalAction, 'FUTURE_ACTION')
  assert.ok(unknown.notes.some(s => s.includes('快照')))
})

test('the actual lowercase void action is translated and keeps its recorded state change', () => {
  const view = present({ status: 'CONFIRMED' }, { status: 'VOIDED' }, 'void')
  assert.equal(view.title, '作废收货单')
  assert.equal(view.changes[0].to.status, 'VOIDED')
})

test('a partial update retains the recorded product side and explicitly distinguishes missing history', () => {
  const onlyAfter = present({ status: 'DRAFT' }, receipt(), 'UPDATE')
  assert.equal(onlyAfter.snapshot.rows[0].cells[1].text, '2')
  assert.equal(onlyAfter.previousSnapshot, undefined)
  assert.ok(onlyAfter.notes.some(s => s.includes('操作前商品明细未记录')))
  const onlyBefore = present(receipt(), { status: 'CONFIRMED' }, 'UPDATE')
  assert.equal(onlyBefore.previousSnapshot.rows[0].cells[1].text, '2')
  assert.equal(onlyBefore.snapshot, undefined)
  assert.ok(onlyBefore.notes.some(s => s.includes('操作后商品明细未记录')))
  assert.ok(!onlyBefore.summary.some(s => s.includes('删除') || s.includes('移除')))
})
