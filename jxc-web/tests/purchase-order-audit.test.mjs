import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const { purchaseOrderAudit } = loadTsModule(new URL('../src/modules/purchase/purchaseOrderAudit.ts', import.meta.url))
const line = (patch = {}) => ({ id: 10, lineNo: 1, productId: 501, unit: 'PCS', baseUnit: 'PCS', factor: 1, qty: 100, unitPrice: '12.3456', amount: '1234.5600', ...patch })
const log = (beforeValue, afterValue, action = 'UPDATE') => ({ id: 1, action, userName: '操作人', resourceType: 'purchase-order', resourceId: 1, beforeValue, afterValue, occurredAt: '2026-10-23T02:30:00Z' })
const view = (before, after, action) => purchaseOrderAudit(log(before, after, action))

for (const [action, title] of Object.entries({ CREATE: '创建采购单', UPDATE: '修改采购单', submit: '提交审批', 'cancel-lines': '部分取消', close: '关闭采购单', void: '作废采购单', WORKFLOW_APPROVED: '审批通过', WORKFLOW_REJECTED: '审批驳回', 新增: '创建采购单', 提交: '提交审批' })) {
  test(`purchase audit translates recorded action ${action}`, () => assert.equal(view(null, {}, action).title, title))
}

test('creation summarizes the recorded order and readable line instead of empty-to-JSON diffs', () => {
  const entry = view(null, { docNo: 'PO-001', supplierId: 801, currency: 'CNY', status: 'DRAFT', lines: [line()] }, 'CREATE')
  assert.equal(entry.isCreate, true)
  assert.ok(entry.summary.includes('采购单号：PO-001'))
  assert.ok(entry.summary.some(s => s.includes('供应商 #801')))
  assert.ok(entry.summary.includes('商品明细：1 行'))
  assert.equal(entry.status, 'DRAFT')
  assert.ok(entry.changes.some(c => c.to.text.includes('100 PCS') && c.to.text.includes('12.3456 CNY')))
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
  assert.equal(entry.changes.filter(c => c.label.includes('移除')).length, 2)
  assert.equal(entry.changes.filter(c => c.label.includes('新增')).length, 2)
  assert.ok(entry.notes.includes('历史明细无法唯一对应，已分别列出移除和新增。'))
})

test('changed conversion identity and missing identity fields are not paired by position', () => {
  for (const after of [line({ id: 90, factor: 10 }), line({ id: 90, baseUnit: undefined })]) {
    const entry = view({ lines: [line()] }, { lines: [after] })
    assert.equal(entry.changes.length, 2)
    assert.ok(entry.changes.some(c => c.label.includes('移除')))
    assert.ok(entry.changes.some(c => c.label.includes('新增')))
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
  assert.ok(entry.changes.some(c => c.label.includes('历史商品')))
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
