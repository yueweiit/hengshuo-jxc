import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const file = new URL('../src/modules/logistics/receiptAudit.ts', import.meta.url)
function present(beforeValue, afterValue, action = 'confirm') {
  assert.ok(existsSync(file), '实收日志适配尚未实现')
  return loadTsModule(file).receiptAudit({ id: 1, action, beforeValue, afterValue })
}
test('lowercase confirmation uses Chinese action and retains historical line values without live master substitutions', () => {
  const before = { status: 'DRAFT', lines: [{ productId: 21, dispatchQty: 3, goodQty: 3, damagedQty: 0, pendingInspectQty: 0, shortQty: 0 }] }
  const after = structuredClone(before); after.status = 'CONFIRMED'; after.lines[0].goodQty = 2; after.lines[0].shortQty = 1
  const v = present(before, after)
  assert.equal(v.title, '确认实收'); assert.equal(v.kind, 'confirm')
  assert.equal(v.previousSnapshot.rows[0].cells[2].text, '3')
  assert.equal(v.snapshot.rows[0].cells[0].text, '商品 #21')
  assert.equal(v.snapshot.rows[0].cells[5].text, '1')
  assert.ok(v.notes.some(text => text.includes('历史名称和单位')))
})
test('missing and invalid historical lines stay explicit; receipt attachment has the real filename and category', () => {
  const v = present(null, { lines: 'invalid' }, 'CREATE')
  assert.equal(v.snapshot.rows.length, 0); assert.ok(v.notes.some(text => text.includes('无法识别')))
  const missing = present(null, { status: 'DRAFT' }, 'CREATE')
  assert.ok(missing.notes.some(text => text.includes('明细未记录')))
  const attachment = present(null, { fileName: '照片.png', category: 'RECEIPT_PHOTO', attachmentId: 534 }, 'ATTACHMENT_UPLOAD')
  assert.equal(attachment.attachment.fileName, '照片.png'); assert.equal(attachment.attachment.category, '现场照片')
})
