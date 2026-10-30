import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/auth/LoginView.vue', import.meta.url)

function loginPage(options = {}) {
  const calls = []
  const page = loadVueScript(file, {
    reactive, ref,
    useI18n: () => ({ t: key => key, locale: ref('zh-CN') }),
    useRoute: () => ({ query: { redirect: options.redirect } }),
    useRouter: () => ({ replace: async path => calls.push(['redirect', path]) }),
    useUserStore: () => ({ login: async (username, password) => {
      calls.push(['login', username, password])
      await options.login?.()
    } }),
    importMetaEnv: { MODE: options.mode, VITE_USE_MOCK: options.mock },
  }, ['form', 'formRef', 'submit', 'loading', 'fill', 'isMock'])
  page.formRef.value = { validate: async () => {
    calls.push(['validate'])
    await options.validate?.()
  } }
  page.form.username = 'synthetic-user'
  page.form.password = 'synthetic-password'
  return { ...page, calls }
}

test('login validates first, delegates exact credentials to the existing user store and opens the workbench', async () => {
  const page = loginPage()
  await page.submit()
  assert.deepEqual(page.calls, [
    ['validate'], ['login', 'synthetic-user', 'synthetic-password'], ['redirect', '/workbench'],
  ])
  assert.equal(page.loading.value, false)
})

test('login preserves the existing string redirect after authentication', async () => {
  const page = loginPage({ redirect: '/sal/orders?view=open' })
  await page.submit()
  assert.deepEqual(page.calls.at(-1), ['redirect', '/sal/orders?view=open'])
})

test('a non-string route query retains the workbench fallback', async () => {
  const page = loginPage({ redirect: ['/sal/orders', '/workbench'] })
  await page.submit()
  assert.deepEqual(page.calls.at(-1), ['redirect', '/workbench'])
})

test('validation failure never sends credentials or starts a loading state', async () => {
  const failure = new Error('synthetic required field failure')
  const page = loginPage({ validate: async () => { throw failure } })
  await assert.rejects(page.submit(), error => error === failure)
  assert.deepEqual(page.calls, [['validate']])
  assert.equal(page.loading.value, false)
})

test('a pending login keeps loading active and postpones navigation until it resolves', async () => {
  let complete
  const pending = new Promise(resolve => { complete = resolve })
  const page = loginPage({ login: () => pending })
  const request = page.submit()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.loading.value, true)
  assert.equal(page.calls.some(call => call[0] === 'redirect'), false)
  complete()
  await request
  assert.equal(page.loading.value, false)
  assert.deepEqual(page.calls.at(-1), ['redirect', '/workbench'])
})

test('authentication failure remains an error, clears loading and never redirects', async () => {
  const failure = new Error('synthetic denied credentials')
  const page = loginPage({ login: async () => { throw failure } })
  await assert.rejects(page.submit(), error => error === failure)
  assert.equal(page.loading.value, false)
  assert.deepEqual(page.calls, [['validate'], ['login', 'synthetic-user', 'synthetic-password']])
})

test('the existing demo account helper still fills the actual reactive form', () => {
  const page = loginPage()
  page.fill({ username: 'synthetic-demo', password: 'synthetic-demo-password' })
  assert.deepEqual(page.form, { username: 'synthetic-demo', password: 'synthetic-demo-password' })
})

for (const [mode, mock, visible] of [
  ['production', 'true', false], ['development', 'false', false],
  ['demo', 'false', false], ['demo', 'true', true],
]) {
  test(`demo account visibility preserves the explicit demo gate: ${mode}/${mock}`, () => {
    assert.equal(loginPage({ mode, mock }).isMock, visible)
  })
}
