import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
const base = { computed: vue.computed, reactive: vue.reactive, ref: vue.ref, nextTick: vue.nextTick, STATUS_OPTIONS: [], ROLE_TYPES: [], ENTITY_SOURCE: [], STORE_SOURCE: [], WAREHOUSE_SOURCE: [], ElMessage: { success() {} }, ElMessageBox: { confirm: async () => {} }, useUserStore: () => ({ loadMe: async () => {}, user: { id: 99 } }), useOptionsStore: () => ({ invalidate() {} }), useCountryStore: () => ({ currentId: 1 }) }

test('role permission and field editors fetch the current record and carry its original version', async () => {
  const calls = []
  const fresh = { id: 1, version: 7, permissions: [], fieldPolicies: { COST: 'READ' } }
  const http = { get: async path => path === '/sys/permissions/tree' ? { tree: [], fieldGroups: [{ code: 'COST', name: 'Cost' }] } : fresh, put: async (path, body) => { calls.push({ path, body }); return { ...fresh, version: 8 } } }
  const scope = loadVueScript(new URL('../src/modules/settings/perm/RoleList.vue', import.meta.url), { ...base, http }, ['openPerm', 'savePerm', 'openField', 'saveField'])
  await scope.openPerm({ ...fresh, version: 1 })
  await scope.savePerm()
  await scope.openField({ ...fresh, version: 1 })
  await scope.saveField()
  assert.deepEqual(calls.map(c => c.body.version), [7, 7])
})

test('user grant replacement sends one atomic command with the current user version', async () => {
  const calls = []
  const http = {
    get: async path => path === '/sys/roles' ? { records: [] } : path.endsWith('/grants') ? { roleIds: [], dataScopes: [], version: 7 } : path === '/org/books' ? [] : { id: 1, version: 7 },
    put: async (path, body) => { calls.push({ path, body }); return { version: body.version + 1 } },
  }
  const scope = loadVueScript(new URL('../src/modules/settings/perm/UserList.vue', import.meta.url), { ...base, http }, ['openGrant', 'saveGrant'])
  await scope.openGrant({ id: 1, version: 1 })
  await scope.saveGrant()
  assert.deepEqual(calls, [{ path: '/sys/users/1/grants', body: { roleIds: [], dataScopes: [], version: 7 } }])
})

test('new-user forms require an explicit password and never suggest a default credential', () => {
  const scope = loadVueScript(new URL('../src/modules/settings/perm/UserList.vue', import.meta.url), { ...base, http: {} }, ['formFields'])
  const password = scope.formFields.find(f => f.prop === 'password')
  assert.equal(password.required, true)
  assert.ok(password.rules.some(rule => rule.min === 10))
  assert.equal(password.placeholder.includes('123456'), false)
})

test('create-only password validation is removed from an existing-user edit', async () => {
  const { createCommandIntent, withEditVersion } = await import('../src/api/command-intent.ts')
  const scope = loadVueScript(new URL('../src/components/crud/CrudPage.vue', import.meta.url), { ...base, computed: vue.computed, ref: vue.ref, reactive: vue.reactive, onMounted() {}, useI18n: () => ({ t: value => value }), createCrudApi: () => ({}), createCommandIntent, withEditVersion, defineEmits: () => () => {}, defineExpose() {}, defineProps: () => ({ resource: '/sys/users', formFields: [{ prop: 'password', label: '密码', createOnly: true, required: true, rules: [{ min: 10 }] }] }), withDefaults: (props, defaults) => ({ ...Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof value === 'function' ? value() : value])), ...props }) }, ['mode', 'rules'])
  assert.equal(scope.rules.value.password.some(rule => rule.required), true)
  scope.mode.value = 'edit'
  assert.equal(scope.rules.value.password, undefined)
})
