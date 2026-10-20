import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

test('editing a loaded reactive approval rule opens an isolated draft and preserves the saved version', async () => {
  const calls = []
  const page = loadVueScript(new URL('../src/modules/settings/perm/ApprovalRuleList.vue', import.meta.url), {
    ref: vue.ref, reactive: vue.reactive, toRaw: vue.toRaw, onMounted() {}, useCountryStore: () => ({ currentId: 183 }),
    computed: vue.computed, useUserStore: () => ({ hasPerm: () => true }),
    ElMessage: { success() {} }, DOC_TYPES: [], labelOf: (_options, value) => value,
    http: {
      put: async (path, body) => { calls.push({ path, body: structuredClone(vue.toRaw(body)) }); return { versionNo: 2 } },
      get: async () => ({ records: [] }),
    },
  }, ['openEdit', 'edit', 'save'])
  const saved = vue.reactive({ id: 218, name: '当地采购复核', docType: 'PURCHASE_ORDER', priority: 10,
    effectiveFrom: '2026-10-01', version: 3, status: 'DRAFT',
    conditions: [{ field: 'amount', op: 'gte', value: 100 }],
    nodes: [{ seq: 1, nodeName: '当地复核', approverType: 'ROLE', approverRef: 'COUNTRY_ADMIN', mode: 'ANY' }],
  })
  page.openEdit(saved)
  assert.equal(page.edit.visible, true)
  page.edit.model.conditions[0].value = 200
  page.edit.model.nodes[0].approverRef = 'LOCAL_REVIEWER'
  assert.equal(saved.conditions[0].value, 100)
  assert.equal(saved.nodes[0].approverRef, 'COUNTRY_ADMIN')
  await page.save()
  assert.equal(calls[0].path, '/wf/rules/218')
  assert.equal(calls[0].body.version, 3)
  assert.equal(calls[0].body.conditions[0].value, 200)
  assert.equal(calls[0].body.nodes[0].approverRef, 'LOCAL_REVIEWER')
  assert.equal(page.edit.visible, false)
})

function configurationPage(put = async (_path, body) => ({ ...body, version: 1 })) {
  const calls = [], messages = [], user = vue.reactive({ allowed: true })
  const page = loadVueScript(new URL('../src/modules/settings/perm/ApprovalRuleList.vue', import.meta.url), {
    ref: vue.ref, reactive: vue.reactive, computed: vue.computed, toRaw: vue.toRaw, onMounted() {},
    useCountryStore: () => ({ currentId: 183 }), useUserStore: () => ({ hasPerm: () => user.allowed }),
    DOC_TYPES: [{ value: 'SALES_ORDER', label: '销售订单' }, { value: 'PURCHASE_ORDER', label: '采购单' }], labelOf: (_options, value) => value,
    ElMessage: { success: text => messages.push(text), warning: text => messages.push(text) },
    http: { get: async () => [], put: async (path, body) => { calls.push({ path, body: structuredClone(vue.toRaw(body)) }); return put(path, body) } },
  }, ['docTypes', 'docTypeDraft', 'availableDocTypes', 'openDocType', 'saveNewDocType', 'saveDocType', 'loadDocTypes'])
  return { page, calls, messages, user }
}

test('empty approval settings can be explicitly created through the existing configuration command', async () => {
  const { page, calls } = configurationPage()
  await page.loadDocTypes()
  page.openDocType()
  assert.equal(page.docTypeDraft.visible, true)
  assert.equal(page.docTypeDraft.docType, '')
  assert.equal(page.docTypeDraft.approvalRequired, undefined, 'the operator must choose the approval policy')
  assert.deepEqual(page.docTypeDraft.keyFields, [])
  await page.saveNewDocType()
  assert.equal(calls.length, 0, 'opening or submitting an incomplete policy must not write configuration')
  Object.assign(page.docTypeDraft, { docType: 'SALES_ORDER', approvalRequired: true, keyFields: ['amount', 'customerId'] })
  await page.saveNewDocType()
  assert.deepEqual(calls, [{ path: '/wf/doc-types/SALES_ORDER', body: { docType: 'SALES_ORDER', approvalRequired: true, keyFields: ['amount', 'customerId'] } }])
  assert.equal(page.docTypes.value[0].version, 1)
  assert.equal(page.docTypeDraft.visible, false)
  assert.deepEqual(page.availableDocTypes.value.map(d => d.value), ['PURCHASE_ORDER'])
})

test('new approval configuration rejects a duplicate or unknown type and rechecks current permission', async () => {
  for (const kind of ['duplicate', 'unknown', 'revoked']) {
    const { page, calls, user } = configurationPage()
    page.openDocType()
    Object.assign(page.docTypeDraft, { docType: kind === 'unknown' ? 'UNREVIEWED_TYPE' : 'SALES_ORDER', approvalRequired: false, keyFields: [] })
    if (kind === 'duplicate') page.docTypes.value = [{ docType: 'SALES_ORDER', approvalRequired: true, keyFields: [], version: 2 }]
    if (kind === 'revoked') user.allowed = false
    await page.saveNewDocType()
    assert.equal(calls.length, 0, kind)
    assert.equal(page.docTypeDraft.visible, true, kind)
    if (kind === 'revoked') { page.docTypeDraft.visible = false; page.openDocType(); assert.equal(page.docTypeDraft.visible, false) }
  }
})

test('approval configuration retains explicit input after a failure and serializes retries', async () => {
  let fail = true, release
  const { page, calls } = configurationPage(async (_path, body) => {
    if (fail) throw new Error('configuration conflict')
    return new Promise(resolve => { release = () => resolve({ ...body, version: 1 }) })
  })
  page.openDocType()
  Object.assign(page.docTypeDraft, { docType: 'SALES_ORDER', approvalRequired: false, keyFields: ['amount'] })
  await assert.rejects(page.saveNewDocType(), /configuration conflict/)
  assert.equal(page.docTypeDraft.visible, true)
  assert.equal(page.docTypeDraft.saving, false)
  assert.equal(page.docTypeDraft.approvalRequired, false)
  assert.deepEqual(page.docTypeDraft.keyFields, ['amount'])
  fail = false
  const retry = page.saveNewDocType()
  await page.saveNewDocType()
  assert.equal(calls.length, 2)
  assert.equal(page.docTypeDraft.saving, true)
  release(); await retry
  assert.equal(page.docTypeDraft.visible, false)
  assert.equal(page.docTypeDraft.saving, false)
})

test('editing an existing approval setting keeps its optimistic version and server response', async () => {
  const { page, calls, user } = configurationPage(async (_path, body) => ({ ...body, version: 8 }))
  const existing = vue.reactive({ docType: 'SALES_ORDER', approvalRequired: true, keyFields: ['amount'], version: 7 })
  page.docTypes.value = [existing]
  await page.saveDocType(existing)
  assert.equal(calls[0].body.version, 7)
  assert.equal(existing.version, 8)
  user.allowed = false
  await page.saveDocType(existing)
  assert.equal(calls.length, 1)
})
