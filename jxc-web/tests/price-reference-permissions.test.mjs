import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

function pricePage(permissions, calls) {
  return loadVueScript(new URL('../src/modules/sales/PriceList.vue', import.meta.url), {
    reactive, ref, onMounted() {}, createCommandIntent: () => ({}),
    useCountryStore: () => ({ epoch: 1, timezone: 'UTC', currency: 'MXN' }),
    useUserStore: () => ({ hasPerm: codes => (Array.isArray(codes) ? codes : [codes]).some(code => permissions.includes(code)) }),
    allRecords: async url => { calls.push(url); return [{ productId: 44, productCode: 'SKU-A', name: 'Local product' }] },
  }, ['loadReferences', 'options'])
}

test('a price reader without MD permissions does not request protected master lists', async () => {
  const calls = [], page = pricePage(['sal:price:view'], calls)
  await page.loadReferences()
  assert.deepEqual(calls, [])
  assert.equal(page.options.products.length, 0)
  assert.equal(page.options.customers.length, 0)
  assert.equal(page.options.levels.length, 0)
})

test('price labels request only the master families the current user may read', async () => {
  const calls = [], page = pricePage(['sal:price:view', 'md:product:view'], calls)
  await page.loadReferences()
  assert.deepEqual(calls, ['/md/country-skus'])
  assert.equal(page.options.products[0].productCode, 'SKU-A')
  assert.equal(page.options.customers.length, 0)
})
