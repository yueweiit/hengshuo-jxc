import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, reactive, ref, watch } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

function receipt(orderId = '71') {
  const order = { id: 71, docNo: 'SO-71', bookId: 601, customerId: 801 }
  const writes = [], warnings = []
  const page = loadVueScript(new URL('../src/modules/ar/ReceiptList.vue', import.meta.url), {
    computed, reactive, ref, watch, onMounted() {},
    useRoute: () => ({ path: '/ar/receipts', query: { orderId, source: 'sales-outbound', action: 'register' } }), useRouter: () => ({ push() {} }),
    useCountryStore: () => ({ currency: 'MXN' }), useUserStore: () => ({ hasPerm: () => true, fieldAccess: () => 'WRITE' }),
    createCommandIntent: () => ({ reset() {} }), CUSTOMER_SOURCE: [], RECEIPT_STATUS: [],
    ElMessage: { warning: value => warnings.push(value), success() {} },
    allRecords: async url => url === '/sal/orders' ? [order] : [],
    http: { get: async url => url.startsWith('/ar/receipts/order-context/') ? order : [{ id: 601 }], postIdem: async (...args) => writes.push(args) },
  }, ['open', 'form'])
  return { ...page, writes, warnings }
}

test('从出库进入登记时预选授权订单客户账套，实收金额仍由人填写', async () => {
  const p = receipt(); await p.open()
  assert.equal(p.form.bookId, 601)
  assert.equal(p.form.customerId, 801)
  assert.equal(p.form.orderId, 71)
  assert.equal(p.form.amount, 0)
  assert.equal(p.form.plannedAmount, 0)
  assert.deepEqual(p.writes, [])
})

test('跳转订单不在授权选项时不允许登记到另一个订单', async () => {
  const p = receipt('99')
  await assert.rejects(p.open(), /订单.*无权|订单.*不可|订单.*读取/)
  assert.equal(p.form.visible, false)
  assert.deepEqual(p.writes, [])
})
