import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import * as Vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/settings/integrations/ExternalServiceSettings.vue', import.meta.url)
const initial = () => ({ version: 0, keyReady: true, workerEnabled: false, recognitionEnabled: false, services: {
  n8n: { enabled: false, source: 'STARTUP', fieldsUrl: '', recognitionUrl: '', timeoutSeconds: 300, fieldsKeyConfigured: false, recognitionKeyConfigured: false, lastTest: null },
  deepseek: { enabled: false, source: 'UNCONFIGURED', url: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutSeconds: 180, keyConfigured: false, lastTest: null },
  docling: { enabled: false, source: 'STARTUP', url: '', timeoutSeconds: 600, keyConfigured: false, lastTest: null },
} })
function setup(options = {}) {
  assert.ok(existsSync(file), '外部服务配置页必须存在并接入实际后端')
  const calls = [], hooks = [], unmount = []
  const p = loadVueScript(file, {
    ref: Vue.ref, reactive: Vue.reactive, computed: Vue.computed,
    onMounted: fn => hooks.push(fn), onBeforeUnmount: fn => unmount.push(fn),
    useUserStore: () => ({ user: { isPlatformAdmin: true }, hasPerm: () => true }),
    http: {
      get: async (...args) => { calls.push(['get', ...args]); return options.get ? options.get(...args) : initial() },
      put: async (url, body, config) => { calls.push(['put', url, structuredClone(body), config]); const next = initial(); next.version = 1; next.services.deepseek.source = 'PAGE'; next.services.deepseek.keyConfigured = true; return options.put ? options.put(url, body) : next },
      post: async (...args) => { calls.push(['post', ...args]); return options.post ? options.post(...args) : { status: 'ok', message: '连接协议检查通过', checkedAt: '2026-10-30T10:00:00Z' } },
    },
  }, ['loadSettings', 'save', 'testConnection', 'selected', 'form', 'settings', 'loading', 'saving', 'testing', 'error', 'notice', 'selectService', 'clearSecretDraft'])
  return { ...p, calls, hooks, unmount }
}
test('加载真实配置并区分未配置与读取失败，支持重试', async () => {
  let fail = true
  const p = setup({ get: async () => { if (fail) throw new Error('配置读取超时'); return initial() } })
  await p.loadSettings(); assert.equal(p.error.value, '配置读取超时'); assert.equal(p.settings.value, null)
  fail = false; await p.loadSettings(); assert.equal(p.error.value, ''); assert.equal(p.settings.value.version, 0)
  assert.equal(p.calls[0][1], '/sys/external-services')
})
test('密钥留空时不发送替换，保存使用当前版本和唯一后端接口', async () => {
  const p = setup(); await p.loadSettings(); p.selectService('deepseek'); await p.save()
  const call = p.calls.find(c => c[0] === 'put')
  assert.equal(call[1], '/sys/external-services/deepseek'); assert.equal(call[2].version, 0)
  assert.equal('key' in call[2], false); assert.equal(p.settings.value.version, 1)
})
test('明确替换与清除分别发送，保存后清掉输入中的密钥', async () => {
  const p = setup(); await p.loadSettings(); p.selectService('deepseek'); p.form.key = 'test-key'; await p.save()
  assert.equal(p.calls.find(c => c[0] === 'put')[2].key, 'test-key'); assert.equal(p.form.key, '')
  p.form.key = 'pending-replacement'; p.form.clearKey = true; p.clearSecretDraft('key'); await p.save()
  const cleared = p.calls.filter(c => c[0] === 'put')[1][2]; assert.equal(cleared.clearKey, true); assert.equal('key' in cleared, false)
})
test('版本冲突保留草稿与错误，不能显示保存成功', async () => {
  const p = setup({ put: async () => { throw new Error('记录已被他人修改，请刷新后重试') } })
  await p.loadSettings(); p.selectService('deepseek'); p.form.model = 'user-selected-model'; await p.save()
  assert.match(p.error.value, /他人修改/); assert.equal(p.form.model, 'user-selected-model'); assert.equal(p.notice.value, '')
})
test('连接测试只使用已保存版本，返回的失败保持可见', async () => {
  const p = setup({ post: async () => ({ status: 'error', message: '访问密钥验证失败', checkedAt: '2026-10-30T10:00:00Z' }) })
  await p.loadSettings(); p.selectService('deepseek'); await p.testConnection()
  assert.deepEqual(p.calls.find(c => c[0] === 'post').slice(1, 3), ['/sys/external-services/deepseek/test', { version: 0 }])
  assert.match(p.error.value, /密钥验证失败/); assert.equal(p.notice.value, '')
})
test('保存进行中阻止重复保存和切换服务', async () => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const p = setup({ put: () => pending }); await p.loadSettings(); p.selectService('deepseek')
  const first = p.save(); await p.save(); p.selectService('n8n'); assert.equal(p.selected.value, 'deepseek')
  assert.equal(p.calls.filter(c => c[0] === 'put').length, 1)
  const next = initial(); next.version = 1; finish(next); await first; assert.equal(p.saving.value, false)
})
test('损坏的配置响应不能冒充未配置成功', async () => {
  const p = setup({ get: async () => ({ version: 0, services: {} }) }); await p.loadSettings()
  assert.match(p.error.value, /配置数据格式异常/); assert.equal(p.settings.value, null)
})
test('离开页面清除密钥并忽略晚到的加载响应', async () => {
  let finish; const pending = new Promise(resolve => { finish = resolve })
  const p = setup({ get: () => pending }); p.form.key = 'local-secret'; const loading = p.loadSettings()
  p.unmount[0](); assert.equal(p.form.key, ''); finish(initial()); await loading; assert.equal(p.settings.value, null)
})
test('普通账号即使具有广泛角色权限也看不到平台配置菜单', async () => {
  const user = Vue.reactive({ user: { isPlatformAdmin: false }, hasPerm: () => true })
  const menu = loadVueScript(new URL('../src/layouts/components/SideMenu.vue', import.meta.url), {
    computed: Vue.computed, useRoute: () => ({ path: '/workbench', meta: {} }), useI18n: () => ({ t: value => value }),
    useUserStore: () => user, useCountryStore: () => ({ current: { id: 101 }, isModuleEnabled: () => true }),
    menuGroups: [{ key: 'settings', children: [{ path: '/settings/external-services', meta: { platformOnly: true, perm: 'sys:integration:config' } }] }],
  }, ['visibleGroups'])
  assert.equal(menu.visibleGroups.value.length, 0)
  user.user.isPlatformAdmin = true; await Vue.nextTick(); assert.equal(menu.visibleGroups.value.length, 1)
})
