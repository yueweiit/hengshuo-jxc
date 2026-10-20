import test from 'node:test'
import assert from 'node:assert/strict'
import { ref, reactive, computed } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

function setup() {
  const posts = [], puts = [], warnings = []
  const page = loadVueScript(new URL('../src/modules/purchase/PurchaseOrderForm.vue', import.meta.url), {
    ref, reactive, computed, defineEmits: () => () => {}, defineExpose() {},
    createCommandIntent: () => ({ reset() {} }), useCountryStore: () => ({ timezone: 'UTC' }), todayIn: () => '2026-10-15',
    ElMessage: { warning: message => warnings.push(message), success() {} }, ElMessageBox: { alert: async () => {} },
    allRecords: async () => [],
    http: {
      get: async path => path === '/org/books' ? [{ id: 6 }] : ({ id: 77, version: 1, status: 'DRAFT', bookId: 6, supplierId: 93, lines: [{ productId: 44, unit: 'PCS', qty: 2, unitPrice: 10 }] }),
      postIdem: async (path, body) => { posts.push({ path, body: JSON.parse(JSON.stringify(body)) }); return { id: 77, status: 'DRAFT' } },
      put: async (path, body) => { puts.push({ path, body: JSON.parse(JSON.stringify(body)) }); return { id: 77, status: 'DRAFT' } },
    },
  }, ['open', 'model', 'save', 'visible'])
  return { ...page, posts, puts, warnings }
}

for (const operation of ['create', 'edit']) for (const price of [undefined, null]) test(`purchase ${operation} rejects unknown price ${String(price)} before saving or submitting`, async () => {
  const p = setup(); await p.open(operation === 'edit' ? 77 : undefined)
  p.model.bookId = 6; p.model.supplierId = 93
  Object.assign(p.model.lines[0], { productId: 44, unit: 'PCS', qty: 2, unitPrice: price })
  await p.save(true)
  assert.deepEqual(p.posts, []); assert.deepEqual(p.puts, [])
  assert.equal(p.visible.value, true); assert.match(p.warnings[0], /采购单价/)
})

for (const operation of ['create', 'edit']) test(`purchase ${operation} preserves an explicitly entered zero price`, async () => {
  const p = setup(); await p.open(operation === 'edit' ? 77 : undefined)
  p.model.bookId = 6; p.model.supplierId = 93
  Object.assign(p.model.lines[0], { productId: 44, unit: 'PCS', qty: 2, unitPrice: 0 })
  await p.save(false)
  const writes = operation === 'edit' ? p.puts : p.posts
  assert.equal(writes.length, 1); assert.equal(writes[0].body.lines[0].unitPrice, 0)
  assert.equal(writes[0].body.submit, false); assert.deepEqual(p.warnings, [])
})

test('a new purchase line starts without a fabricated price', async () => {
  const p = setup(); await p.open()
  assert.equal(p.model.lines[0].unitPrice, undefined)
})
