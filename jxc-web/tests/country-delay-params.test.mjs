import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, reactive, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

function setup(value, options = {}) {
  const calls = [], messages = [], country = { currentId: 3 }
  const detail = { id: 3, name: '测试国家', defaultCurrency: 'MXN', timezone: 'UTC', locale: 'zh-CN', dateFormat: 'YYYY-MM-DD', numberFormat: '1,234.56', isTest: true, enabledModules: ['sys'], version: 7, logisticsDelayToleranceHours: value }
  const page = loadVueScript(new URL('../src/modules/settings/country/CountryDetail.vue', import.meta.url), {
    computed, reactive, ref, onMounted() {}, useRoute: () => ({ params: { id: '3' } }), useRouter: () => ({}),
    useUserStore: () => ({ hasPerm: () => true, loadMe: async () => calls.push({ method: 'me' }) }), useCountryStore: () => country,
    ElMessage: Object.fromEntries(['warning', 'error', 'success'].map(type => [type, message => messages.push({ type, message })])),
    http: { get: async () => ({ ...detail }), put: async (path, body) => {
      calls.push({ method: 'put', path, body: { ...body } })
      if (options.saveError) throw options.saveError
      Object.assign(detail, body, { version: 8 })
    } },
  }, ['loadDetail', 'saveParams', 'form', 'saving'])
  return { ...page, calls, messages, detail, country }
}

test('缺失配置仅预填48小时，保存使用原国家参数接口及版本', async () => {
  for (const value of [null, undefined]) {
    const p = setup(value)
    await p.loadDetail()
    assert.equal(p.form.logisticsDelayToleranceHours, 48)
    assert.equal(p.calls.length, 0)
    await p.saveParams()
    const saved = p.calls.find(c => c.method === 'put')
    assert.equal(saved.path, '/sys/countries/3/params')
    assert.equal(saved.body.logisticsDelayToleranceHours, 48)
    assert.equal(saved.body.version, 7)
    assert.equal(p.form.logisticsDelayToleranceHours, 48)
    assert.equal(p.saving.value, false)
  }
})

test('已有配置与零小时保留，兼容历史数字字符串', async () => {
  for (const [value, expected] of [[0, 0], [72, 72], ['96', 96], [999999, 999999]]) {
    const p = setup(value)
    await p.loadDetail()
    assert.equal(p.form.logisticsDelayToleranceHours, expected)
    await p.saveParams()
    assert.equal(p.calls.find(c => c.method === 'put').body.logisticsDelayToleranceHours, expected)
  }
})

test('负数小数越界及空输入阻止保存并说明原因', async () => {
  const p = setup(48)
  await p.loadDetail()
  for (const value of [-1, 1.5, 1000000, undefined, NaN]) {
    p.form.logisticsDelayToleranceHours = value
    await p.saveParams()
  }
  assert.equal(p.calls.length, 0)
  assert.equal(p.messages.length, 5)
  assert(p.messages.every(m => m.type === 'warning' && m.message.includes('整数')))
})

test('原配置无效时明确提示且不冒充48小时默认值', async () => {
  for (const value of ['错误配置', '', -2]) {
    const p = setup(value)
    await p.loadDetail()
    assert.equal(p.form.logisticsDelayToleranceHours, undefined)
    assert(p.messages.some(m => m.type === 'error' && m.message.includes('配置无效')))
    await p.saveParams()
    assert.equal(p.calls.length, 0)
  }
})

test('保存失败如实抛出，恢复按钮且不报告成功', async () => {
  const failure = new Error('配置保存超时')
  const p = setup(48, { saveError: failure })
  await p.loadDetail()
  await assert.rejects(p.saveParams(), failure)
  assert.equal(p.saving.value, false)
  assert(!p.messages.some(m => m.type === 'success'))
})
