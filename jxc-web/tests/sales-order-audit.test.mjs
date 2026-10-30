import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const file = new URL('../src/modules/sales/salesOrderAudit.ts', import.meta.url)
function present(beforeValue, afterValue, action = 'UPDATE') {
  assert.ok(existsSync(file), '销售日志业务适配尚未实现')
  return loadTsModule(file).salesOrderAudit({ id: 1, action, beforeValue, afterValue })
}
const order = () => ({ docNo: 'SO-71', currency: 'MXN', approvalStatus: 'DRAFT', fulfillmentStatus: 'PENDING_PREPARE', paymentStatus: 'UNPAID', paymentType: 'CREDIT', totalQty: 20, totalAmount: 200, lines: [{ id: 11, productId: 501, qty: 2, unit: '箱', baseQty: 20, cancelledQty: 0, outboundQty: 0, openQty: 20, price: 100, lineAmount: 200, allocs: [{ id: 31, warehouseId: 401, allocQty: 20, cancelledQty: 0, outboundQty: 0, openQty: 20 }] }] })
for (const [action, title] of [['SUBMIT', '提交审批'], ['WORKFLOW_APPROVED', '审批通过'], ['WORKFLOW_WITHDRAWN', '撤回审批'], ['CANCEL_LINES', '取消未交数量'], ['CLOSE', '关闭未交数量']]) {
  test(`销售动作可读：${action}`, () => assert.equal(present(null, null, action).title, title))
}
test('分别表达审批、履约、付款变化，不合并成整单状态', () => {
  const before = order(), after = { ...order(), approvalStatus: 'APPROVED', fulfillmentStatus: 'PENDING_OUTBOUND', paymentStatus: 'PAID' }
  const v = present(before, after)
  assert.deepEqual(v.changes.map(c => [c.label, c.from.text, c.to.text]), [['审批状态', '草稿', '已审批'], ['履约状态', '待备货', '待出库'], ['付款状态', '未付款', '已付清']])
})
test('创建快照区分商品销售单位与基础量，分仓单列为独立层级', () => {
  const original = order(), v = present(null, original, 'CREATE')
  assert.equal(v.title, '创建销售订单')
  assert.equal(v.snapshot.rows.length, 2)
  const cells = v.snapshot.rows[0].cells.map(c => c.text)
  assert.ok(cells.includes('商品 #501')); assert.ok(cells.includes('2')); assert.ok(cells.includes('箱')); assert.ok(cells.includes('20')); assert.ok(cells.includes('MXN 200.00'))
  assert.ok(v.snapshot.rows[1].cells.some(c => c.text === '仓库 #401'))
  assert.match(v.summary.join('；'), /1 行商品/)
  assert.deepEqual(original, order())
})
test('缺币种时金额保留原值并说明，缺失数量和零值不能混同', () => {
  const value = order(); delete value.currency; delete value.lines[0].baseQty
  const v = present(null, value, 'CREATE'), cells = v.snapshot.rows[0].cells.map(c => c.text)
  assert.ok(cells.includes('200（币种未提供）')); assert.ok(cells.includes('未记录')); assert.ok(cells.includes('0'))
  assert.ok(!JSON.stringify(v).includes('CNY'))
})
test('权限裁剪或历史缺失不写成当时未填写，不从现单回填', () => {
  const v = present(null, null, 'CANCEL_LINES')
  assert.equal(v.snapshot, undefined); assert.equal(v.previousSnapshot, undefined)
  assert.deepEqual(v.changes, [])
  assert.match(v.notes.join('；'), /未提供.*权限|权限.*未提供/)
})
test('单侧历史只展示已提供快照，不产生虚构的前后变化', () => {
  const v = present(null, order())
  assert.deepEqual(v.changes, []); assert.equal(v.previousSnapshot, undefined)
  assert.ok(v.snapshot); assert.match(v.notes.join('；'), /操作前.*未提供/)
})
test('重建明细ID不显示商品增删，前后数量仍可查', () => {
  const before = order(), after = order(); after.lines[0].id = 88; after.lines[0].allocs[0].id = 99
  const v = present(before, after)
  assert.deepEqual(v.changes, []); assert.deepEqual(v.previousSnapshot.rows, v.snapshot.rows)
  assert.ok(!/新增商品|删除商品/.test(JSON.stringify(v)))
})
test('未知动作与字段可追溯，明细格式异常不伪装成零行', () => {
  const v = present(null, { lines: 'broken', mystery: 7 }, 'FUTURE_ACTION')
  assert.match(v.notes.join('；'), /FUTURE_ACTION/)
  assert.match(v.notes.join('；'), /明细.*格式/)
  assert.ok(!v.summary.some(text => /0 行/.test(text)))
})
test('明确空值与空白字段保留区别，缺单位不擅自补件', () => {
  const before = { remark: null }, after = { remark: '', lines: [{ productId: 9, qty: 3 }] }
  const v = present(before, after)
  assert.deepEqual(v.changes.map(c => [c.label, c.from.text, c.to.text]), [['备注', '未填写', '空白']])
  assert.ok(v.snapshot.rows[0].cells.some(c => c.text === '未记录'))
  assert.ok(!JSON.stringify(v.snapshot).includes('件'))
})
test('快照结构异常明确说明格式问题，不当作历史缺失', () => {
  const v = present([], 'broken')
  assert.match(v.notes.join('；'), /操作前.*格式/)
  assert.match(v.notes.join('；'), /操作后.*格式/)
})
test('销售附件沿用公共文件卡片并显示真实分类', () => {
  const v = present(null, { fileName: '凭证.png', category: 'PAYMENT_PROOF', attachmentId: 15 }, 'ATTACHMENT_UPLOAD')
  assert.equal(v.attachment.fileName, '凭证.png'); assert.equal(v.attachment.category, '收款凭证')
  assert.equal(v.snapshot, undefined)
})
