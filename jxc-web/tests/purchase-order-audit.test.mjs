import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const { purchaseOrderAudit } = loadTsModule(new URL('../src/modules/purchase/purchaseOrderAudit.ts', import.meta.url))
const line = (patch = {}) => ({ id: 10, lineNo: 1, productId: 501, unit: 'PCS', baseUnit: 'PCS', factor: 1, qty: 100, unitPrice: '12.3456', amount: '1234.5600', ...patch })
const log = (beforeValue, afterValue, action = 'UPDATE') => ({ id: 1, action, userName: '操作人', resourceType: 'purchase-order', resourceId: 1, beforeValue, afterValue, occurredAt: '2026-10-23T02:30:00Z' })
const view = (before, after, action) => purchaseOrderAudit(log(before, after, action))

test('a four-place decimal string near the numeric boundary does not lose its recorded fraction', () => {
  const entry = view(null, { currency: 'CNY', lines: [line({ unitPrice: '9999999999999.0001', amount: '9999999999999.0001' })] }, 'CREATE')
  assert.equal(entry.snapshot.lines[0].cells.unitPrice.text, '9,999,999,999,999.0001')
  assert.equal(entry.snapshot.lines[0].cells.amount.text, '9,999,999,999,999.0001')
})

for (const [action, title] of Object.entries({ CREATE: '创建采购单', UPDATE: '修改采购单', submit: '提交采购单', 'cancel-lines': '部分取消', close: '关闭采购单', void: '作废采购单', WORKFLOW_APPROVED: '审批通过', WORKFLOW_REJECTED: '审批驳回', 新增: '创建采购单', 提交: '提交采购单' })) {
  test(`purchase audit translates recorded action ${action}`, () => assert.equal(view(null, {}, action).title, title))
}

test('creation summarizes the recorded order and readable line instead of empty-to-JSON diffs', () => {
  const entry = view(null, { docNo: 'PO-001', supplierId: 801, currency: 'CNY', status: 'DRAFT', lines: [line()] }, 'CREATE')
  assert.equal(entry.isCreate, true)
  assert.ok(entry.summary.includes('采购单号：PO-001'))
  assert.ok(entry.summary.some(s => s.includes('供应商 #801')))
  assert.ok(entry.summary.includes('商品明细：1 行'))
  assert.equal(entry.status, 'DRAFT')
  assert.equal(entry.snapshot.lines[0].cells.qty.text, '100'); assert.equal(entry.snapshot.lines[0].cells.unitPrice.text, '12.3456')
  assert.ok(entry.notes.some(s => s.includes('历史名称未记录')))
  assert.ok(!JSON.stringify(entry.changes).includes('"productId"'))
})

test('business differences contain Chinese labels, actual states and unchanged fields are omitted', () => {
  const entry = view({ remark: '旧备注', status: 'CONFIRMED', currency: 'CNY' }, { remark: '新备注', status: 'DRAFT', currency: 'CNY' })
  assert.deepEqual(entry.changes.map(c => c.label), ['备注', '单据状态'])
  assert.equal(entry.changes[0].from.text, '旧备注')
  assert.equal(entry.changes[1].from.status, 'CONFIRMED')
  assert.equal(entry.changes[1].to.text, '草稿')
})

test('stable line IDs take priority even for duplicate products and reordered lines', () => {
  const before = [line(), line({ id: 11, lineNo: 2, qty: 50 })]
  const after = [line({ id: 11, lineNo: 1, qty: 60 }), line({ lineNo: 2 })]
  const entry = view({ lines: before }, { lines: after })
  assert.equal(entry.changes.length, 1)
  assert.match(entry.changes[0].label, /采购数量/)
  assert.equal(entry.changes[0].from.text, '50 PCS')
  assert.equal(entry.changes[0].to.text, '60 PCS')
})

test('regenerated IDs pair only a unique business identity and preserve four-digit price differences', () => {
  const entry = view({ currency: 'CNY', lines: [line()] }, { currency: 'CNY', lines: [line({ id: 99, qty: 120, unitPrice: '12.3457' })] })
  assert.equal(entry.changes.length, 2)
  assert.ok(entry.changes.some(c => c.from.text === '12.3456 CNY' && c.to.text === '12.3457 CNY'))
  assert.ok(entry.changes.every(c => !/新增|移除/.test(c.label)))
})

test('regenerated duplicate identities remain unmatched instead of fabricating line edits', () => {
  const before = [line(), line({ id: 11, lineNo: 2, qty: 50 })]
  const after = [line({ id: 91 }), line({ id: 92, lineNo: 2, qty: 60 })]
  const entry = view({ lines: before }, { lines: after })
  assert.equal(entry.removed.lines.length, 2)
  assert.equal(entry.added.lines.length, 2)
  assert.ok(entry.notes.includes('历史明细无法唯一对应，已分别列出移除和新增。'))
})

test('changed conversion identity and missing identity fields are not paired by position', () => {
  for (const after of [line({ id: 90, factor: 10 }), line({ id: 90, baseUnit: undefined })]) {
    const entry = view({ lines: [line()] }, { lines: [after] })
    assert.equal(entry.removed.lines.length, 1)
    assert.equal(entry.added.lines.length, 1)
  }
})

test('technical metadata and equivalent numeric strings do not create business changes', () => {
  const entry = view({ id: 1, version: 1, updatedAt: 'old', lines: [line()] }, { id: 1, version: 2, updatedAt: 'new', lines: [line({ id: 90, version: 2, qty: '100.0000', amount: 1234.56, updatedAt: 'new' })] })
  assert.deepEqual(entry.changes, [])
  assert.deepEqual(entry.other, [])
})

test('masked money is never invented, and explicit zero prices remain visible', () => {
  const before = line(), after = line({ id: 90, qty: 120 })
  for (const record of [before, after]) { delete record.unitPrice; delete record.amount }
  const masked = view({ lines: [before] }, { lines: [after] })
  assert.ok(!JSON.stringify(masked).match(/单价|金额|0 CNY/))
  const zero = view({ currency: 'CNY', lines: [line()] }, { currency: 'CNY', lines: [line({ id: 90, unitPrice: 0 })] })
  assert.ok(zero.changes.some(c => c.to.text === '0 CNY'))
})

test('currency belongs to each snapshot and is never substituted from the current country', () => {
  const entry = view({ currency: 'CNY', lines: [line()] }, { currency: 'USD', lines: [line({ id: 90 })] })
  assert.ok(entry.changes.some(c => c.from.text === '12.3456 CNY' && c.to.text === '12.3456 USD'))
  const unknown = view({ lines: [line()] }, { lines: [line({ id: 90, unitPrice: 0 })] })
  assert.ok(unknown.changes.some(c => c.to.text === '0（币种未记录）'))
})

test('only recorded names are used and formatter does not modify snapshots', () => {
  const after = { supplierId: 801, supplierName: '历史供应商', lines: [line({ productName: '历史商品' })] }
  const snapshot = structuredClone(after)
  const entry = view(null, after, 'CREATE')
  assert.ok(entry.summary.includes('供应商：历史供应商'))
  assert.equal(entry.snapshot.lines[0].name, '历史商品')
  assert.deepEqual(after, snapshot)
})

test('unknown nested changes remain structured, and missing fields differ from explicit null', () => {
  const entry = view({ remark: '旧备注', extra: { flags: ['a'], reference: null } }, { remark: null, extra: { flags: ['b'] } })
  assert.equal(entry.changes[0].to.text, '未填写')
  assert.ok(entry.other.some(c => c.label.includes('extra.flags') && c.from.text === 'a' && c.to.text === 'b'))
  assert.ok(entry.other.some(c => c.from.text === '未填写' && c.to.text === '未记录'))
  const omitted = view({ remark: '旧备注' }, {})
  assert.equal(omitted.changes[0].to.text, '未记录')
})

test('an unknown action is neutral and preserves its actual code for inspection', () => {
  const entry = view(null, null, 'CUSTOM_ACTION')
  assert.equal(entry.title, '其他操作')
  assert.equal(entry.originalAction, 'CUSTOM_ACTION')
  assert.ok(entry.notes.some(s => s.includes('未提供可展示的字段快照')))
})

test('unchanged empty structures are quiet and missing line snapshots are not interpreted as deletion', () => {
  const entry = view({ extra: { flags: [], data: {} } }, { extra: { data: {}, flags: [] } })
  assert.deepEqual(entry.other, [])
  const missing = view({ lines: [line()] }, {})
  assert.deepEqual(missing.changes, [])
  assert.ok(missing.notes.some(s => s.includes('修改后的商品明细未记录')))
})

test('malformed line data remains inspectable as structured content instead of becoming an empty list', () => {
  const entry = view({ lines: [line()] }, { lines: '无法解析的历史内容' })
  assert.ok(entry.notes.some(s => s.includes('商品明细格式无法识别')))
  assert.ok(entry.other.some(c => c.to.text === '无法解析的历史内容'))
  assert.ok(!entry.changes.some(c => c.label.includes('移除')))
})

test('creation has separate document fields and eight product columns with precise prices', () => {
  const entry = view(null, { docNo: 'PO-428', currency: 'CNY', orderDate: '2026-10-22', lines: [line({ taxRate: 0.13, deliveryDate: null })] }, 'CREATE')
  assert.ok(entry.snapshot.fields.some(f => f.label === '下单日期' && f.value.text === '2026-10-22'))
  assert.deepEqual(entry.snapshot.columns.map(c => c.key), ['lineNo', 'product', 'qty', 'unit', 'unitPrice', 'amount', 'taxRate', 'deliveryDate'])
  assert.equal(entry.snapshot.lines[0].cells.unitPrice.text, '12.3456')
  assert.equal(entry.snapshot.lines[0].cells.amount.text, '1,234.56')
  assert.equal(entry.snapshot.lines[0].cells.taxRate.text, '13%')
  assert.equal(entry.snapshot.lines[0].cells.deliveryDate.text, '未填写')
  assert.deepEqual(entry.changes, [])
})

test('current names are reference-only, identity-bound, and never overwrite recorded names', () => {
  const sample = log(null, { supplierId: 801, currency: 'CNY', lines: [line(), line({ id: 11, productId: 502, productName: '历史名称' })] }, 'CREATE')
  const entry = purchaseOrderAudit(sample, { supplierId: 801, supplierName: '当前供应商', lines: [{ productId: 501, productName: '当前商品', productCode: 'NOW-501' }, { productId: 502, productName: '新名称' }] })
  assert.equal(entry.snapshot.lines[0].name, '商品 #501')
  assert.equal(entry.snapshot.lines[0].currentName, '当前商品')
  assert.equal(entry.snapshot.lines[1].name, '历史名称')
  assert.equal(entry.snapshot.lines[1].currentName, undefined)
  assert.ok(entry.snapshot.fields.some(f => f.reference === '当前名称：当前供应商'))
  const mismatch = purchaseOrderAudit(sample, { supplierId: 999, supplierName: '其他供应商', lines: [] })
  assert.ok(!mismatch.snapshot.fields.some(f => f.reference))
  assert.ok(!JSON.stringify(mismatch).includes('当前商品'))
})

test('snapshots omit hidden amount columns and totals without inventing zeroes', () => {
  const row = line(); delete row.unitPrice; delete row.amount
  const entry = view(null, { lines: [row] }, 'CREATE')
  assert.ok(!entry.snapshot.columns.some(c => ['unitPrice', 'amount'].includes(c.key)))
  assert.deepEqual(entry.snapshot.totals, [])
  const zero = view(null, { currency: 'CNY', totalAmount: 0, lines: [line({ unitPrice: 0, amount: 0 })] }, 'CREATE')
  assert.equal(zero.snapshot.lines[0].cells.unitPrice.text, '0.0000')
  assert.equal(zero.snapshot.lines[0].cells.amount.text, '0.00')
  assert.ok(zero.snapshot.totals.some(f => f.value.text.includes('0.00')))
})

test('unit conversion and zero delivery values remain in secondary rows', () => {
  const entry = view(null, { lines: [line({ baseQty: 100, cancelledQty: 0, qualifiedQty: 0 })] }, 'CREATE')
  assert.ok(entry.snapshot.secondaryColumns.some(c => c.key === 'cancelledQty'))
  assert.equal(entry.snapshot.lines[0].cells.cancelledQty.text, '0')
  assert.equal(entry.snapshot.lines[0].cells.factor.text, '1')
  assert.ok(!entry.snapshot.columns.some(c => c.key === 'qualifiedQty'))
})

test('regenerated unchanged product lines retain a full snapshot without fabricated differences', () => {
  const entry = view({ lines: [line()] }, { lines: [line({ id: 99 })] })
  assert.equal(entry.linesUnchanged, 1)
  assert.deepEqual(entry.changes, [])
  assert.equal(entry.snapshot.lines.length, 1)
  assert.equal(entry.added, undefined)
  assert.equal(entry.removed, undefined)
})

test('new and removed lines use structured product tables instead of field strings', () => {
  const entry = view({ currency: 'CNY', lines: [line()] }, { currency: 'CNY', lines: [line({ id: 90, productId: 502 })] })
  assert.equal(entry.added.lines[0].productId, '502')
  assert.equal(entry.removed.lines[0].productId, '501')
  assert.ok(!entry.changes.some(c => c.to.text.includes('；')))
})

test('snapshot absence, empty lines and malformed lines are distinct states', () => {
  assert.equal(view(null, null, 'CREATE').snapshot, undefined)
  assert.equal(view(null, {}, 'CREATE').snapshot.lines, undefined)
  assert.deepEqual(view(null, { lines: [] }, 'CREATE').snapshot.lines, [])
  const malformed = view(null, { lines: '错误内容' }, 'CREATE')
  assert.equal(malformed.snapshot.lines, undefined)
  assert.ok(malformed.notes.some(n => n.includes('无法识别')))
})

test('invalid recorded tax rates stay explicit while zero and missing values remain distinct', () => {
  const tax = value => view(null, { lines: [line({ taxRate: value })] }, 'CREATE').snapshot.lines[0].cells.taxRate.text
  assert.equal(tax('invalid'), '无法识别的数值：invalid')
  assert.equal(tax(0), '0%')
  assert.equal(tax(null), '未填写')
  assert.equal(tax(undefined), '未记录')
})
