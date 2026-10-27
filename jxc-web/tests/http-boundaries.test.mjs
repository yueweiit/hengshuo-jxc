import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import axios from 'axios'
import { createPinia, defineStore } from 'pinia'
import { effectScope, nextTick, toRaw, watchEffect } from 'vue'
import './support.mjs'
import { loadPagination } from './contracts/load-pagination.mjs'
import { createCommandIntent } from '../src/api/command-intent.ts'
import { attachmentDownloadTarget, readBlobError } from '../src/api/attachment-download.ts'
import { errorFeedback } from './contracts/load-vue-script.mjs'

function httpModule(adapter, session = { token: 'test-session', countryId: 2, cleared: 0 }) {
  const source = readFileSync(new URL('../src/api/http.ts', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/^export \{.*$/gm, '').replace(/^export /gm, '')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText
  const errors = []
  errorFeedback.clearErrors()
  const deps = { axios: { create: config => axios.create({ ...config, adapter }) }, AxiosError: axios.AxiosError, ElMessage: { error: message => errors.push(message) }, getToken: () => session.token, getCountryId: () => session.countryId, clearSession() { session.cleared++ }, router: { replace() {}, currentRoute: { value: { fullPath: '/test' } } }, attachmentDownloadTarget, readBlobError, window: { location: { origin: 'https://jxc.test' } } }
  deps.rememberFailureContext = errorFeedback.rememberFailureContext
  deps.reportError = (error, options) => { const notice = errorFeedback.reportError(error, options); if (notice) errors.push(notice.message) }
  const module = new Function('deps', `const {axios,AxiosError,ElMessage,getToken,getCountryId,clearSession,router,attachmentDownloadTarget,readBlobError,window,rememberFailureContext,reportError}=deps; ${compiled}; return {http,BizError};`)(deps)
  return { ...module, errors }
}
const response = (config, data) => ({ config, data, status: 200, statusText: 'OK', headers: {} })

test('idempotent POST and PUT retain their intent through real Axios transport failures', async () => {
 for (const [command, method] of [['postIdem', 'post'], ['putIdem', 'put']]) {
  const calls = []
  const { http } = httpModule(async config => {
    calls.push({ method: config.method, headers: config.headers.toJSON(), data: JSON.parse(config.data) })
    if (calls.length === 1) throw new axios.AxiosError('response disconnected', 'ECONNABORTED', config)
    return response(config, { code: 'OK', message: '', data: { id: 1 }, traceId: 'test' })
  })
  const intent = createCommandIntent(() => 'stable-retry-key')
  const source = { amount: 10 }
  const failed = http[command]('/ar/writeoffs', source, intent)
  source.amount = 99
  await assert.rejects(failed, /response disconnected/)
  await http[command]('/ar/writeoffs', { amount: 10 }, intent)
  await http.post('/auth/login', { username: 'fixture' })
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key'])
  assert.deepEqual(calls.slice(0, 2).map(c => c.method), [method, method])
  assert.deepEqual(calls.slice(0, 2).map(c => c.data), [{ amount: 10 }, { amount: 10 }])
  assert.equal(calls[2].headers['Idempotency-Key'], undefined)
 }
})

test('attachment blob proxy keeps Bearer/country and decodes denied blob envelopes through normal error handling', async () => {
  const calls = []
  const { http, errors } = httpModule(async config => {
    calls.push(config)
    if (calls.length === 1) return response(config, new Blob(['proof']))
    const denied = { ...response(config, new Blob([JSON.stringify({ code: 'SYS_FORBIDDEN', message: '来源授权已撤销', data: null, traceId: 'test' })], { type: 'application/json' })), status: 403 }
    throw new axios.AxiosError('HTTP 403', 'ERR_BAD_REQUEST', config, undefined, denied)
  })
  const blob = await http.attachmentBlob('/api/v1/sys/attachments/1/content')
  assert.equal(await blob.text(), 'proof')
  assert.equal(calls[0].baseURL, '')
  assert.equal(calls[0].headers.Authorization, 'Bearer test-session')
  assert.equal(calls[0].headers['X-Country-Id'], '2')
  await assert.rejects(http.attachmentBlob('/api/v1/sys/attachments/1/content'), error => error.code === 'SYS_FORBIDDEN' && error.message === '来源授权已撤销')
  assert.deepEqual(errors, ['来源授权已撤销'])
  await assert.rejects(http.attachmentBlob('https://other.test/api/v1/sys/attachments/1/content'))
  assert.equal(calls.length, 2, 'no authenticated request may leave the configured origin')
})


test('a previous country response cannot replace the new country data or log out its session', async () => {
  {
    const session = { token: 'same-session', countryId: 1, cleared: 0 }
    let resolveResponse
    const { http } = httpModule(config => new Promise(resolve => { resolveResponse = () => {
      resolve(response(config, { code: 'OK', data: { countryId: 1 } }))
    } }), session)
    const pending = http.get('/fin/books')
    await Promise.resolve()
    session.countryId = 2
    resolveResponse()
    await assert.rejects(pending, error => error.code === 'CONTEXT_CHANGED')
    assert.equal(session.cleared, 0)
  }
})

test('a queued command cannot be dispatched with another country header after switching', async () => {
  const session = { token: 'same-session', countryId: 1, cleared: 0 }, calls = []
  const { http } = httpModule(async config => { calls.push(config); return response(config, { code: 'OK', data: {} }) }, session)
  const pending = http.postIdem('/fin/periods/1/close', { bookId: 1 }, createCommandIntent())
  session.countryId = 2
  await assert.rejects(pending, error => error.code === 'CONTEXT_CHANGED')
  assert.equal(calls.length, 0)
})

function optionsModule(get, session = { token: 'options-session', countryId: 1 }, devtools = false) {
  const source = readFileSync(new URL('../src/stores/options.ts', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText
  const { useOptionsStore } = new Function('deps', `const {defineStore,toRaw,http,getToken,getCountryId,BizError,allRecords}=deps; ${compiled}; return {useOptionsStore};`)({ defineStore, toRaw, allRecords: loadPagination(get, session), http: { get }, getToken: () => session.token, getCountryId: () => session.countryId, BizError: class BizError extends Error { constructor(code, message) { super(message); this.code = code } } })
  const store = useOptionsStore(createPinia())
  if (devtools) {
    // Pinia devtools patchActionForGrouping passes a fresh trackedStore Proxy to each action.
    for (const name of ['load', 'dict', 'remote', 'invalidate']) {
      const action = toRaw(store)[name]
      store[name] = function (...args) { return action.apply(new Proxy(store, {}), args) }
    }
  }
  return store
}

test('option dictionaries and remote references load every page within the real 200-row limit', async () => {
  for (const total of [0, 200, 201, 400, 401]) for (const kind of ['dict', 'remote']) {
    const calls = []
    const store = optionsModule(async (url, query) => {
      calls.push({ url, ...query })
      assert.equal(query.size, 200)
      assert.ok(query.page >= 1)
      const records = Array.from({ length: Math.max(0, Math.min(query.size, total - (query.page - 1) * query.size)) }, (_, i) => ({ id: (query.page - 1) * query.size + i + 1, code: `D${(query.page - 1) * query.size + i + 1}`, label: 'Dictionary', name: 'Reference' }))
      return { records, total, page: query.page, size: query.size }
    })
    const options = await (kind === 'dict' ? store.dict('HOLD_REASON') : store.remote('/org/warehouses'))
    assert.equal(options.length, total)
    assert.equal(calls.length, Math.max(1, Math.ceil(total / 200)), 'exact multiples must not request an extra page')
    if (total) assert.equal(options.at(-1).value, kind === 'dict' ? `D${total}` : total)
    if (kind === 'dict') assert.ok(calls.every(query => query.dictType === 'HOLD_REASON' && query.status === 'ENABLED'))
  }
})

test('option source filters survive pagination while caller page and size cannot exceed its contract', async () => {
  const calls = []
  const store = optionsModule(async (url, query) => {
    calls.push(query)
    assert.equal(query.size, 200)
    assert.equal(query.page, calls.length)
    return { records: Array.from({ length: query.page === 1 ? 200 : 1 }, (_, i) => ({ id: (query.page - 1) * 200 + i + 1, name: 'Enabled' })), total: 201, page: query.page, size: query.size }
  })
  const values = await store.remote('/md/categories', 'name', 'id', { status: 'ENABLED', entityId: 301, page: 9, size: 500 })
  assert.equal(values.length, 201)
  assert.ok(calls.every(query => query.status === 'ENABLED' && query.entityId === 301))
})

test('country switch isolates pending options and prevents their late response from repopulating cache', async () => {
  const session = { token: 'same-session', countryId: 1 }, calls = []
  let resolvePrevious
  const store = optionsModule(async () => {
    const countryId = session.countryId; calls.push(countryId)
    if (countryId === 1) return new Promise(resolve => { resolvePrevious = resolve })
    return { records: [{ id: 202, name: 'Country two' }], total: 1, page: 1, size: 200 }
  }, session)
  const previous = store.remote('/org/warehouses')
  session.countryId = 2
  store.invalidate()
  const currentPending = store.remote('/org/warehouses')
  resolvePrevious({ records: [{ id: 101, name: 'Country one' }], total: 1, page: 1, size: 200 })
  const current = await currentPending
  assert.deepEqual(current, [{ label: 'Country two', value: 202 }])
  await assert.rejects(previous, error => error.code === 'CONTEXT_CHANGED')
  assert.deepEqual(await store.remote('/org/warehouses'), current)
  assert.deepEqual(calls, [1, 2])
})

test('an option pagination continuation cannot outlive its country, login or cache generation', async () => {
  const outcomes = await Promise.allSettled(['countryId', 'token', 'invalidate', 'aba'].map(async changed => {
    const session = { token: 'first-session', countryId: 1 }, calls = []
    const store = optionsModule(async (url, query) => {
      calls.push(query)
      if (changed === 'countryId') session.countryId = 2
      else if (changed === 'token') session.token = 'second-session'
      else if (changed === 'aba') {
        session.countryId = 2; store.invalidate()
        session.countryId = 1; store.invalidate()
      } else store.invalidate()
      return { records: Array.from({ length: 200 }, (_, id) => ({ id, name: 'Old scope' })), total: 201, page: query.page, size: 200 }
    }, session)
    await assert.rejects(store.remote('/org/warehouses'), error => error.code === 'CONTEXT_CHANGED')
    assert.equal(calls.length, 1, `${changed}: an invalidated page must not schedule its next request`)
    assert.deepEqual(store.cache, {})
  }))
  assert.deepEqual(outcomes.filter(result => result.status === 'rejected').map(result => result.reason.message), [])
})


test('option watchers for two sources sharing a cache settle after loading their data', async () => {
  const calls = [], runs = new Map(), values = new Map(), sources = ['/org/warehouses', '/md/categories']
  const store = optionsModule(async (url, query) => {
    calls.push(url)
    return { records: [{ id: url === sources[0] ? 401 : 551, name: url }], total: 1, page: query.page, size: query.size }
  }, undefined, true)
  const scope = effectScope()
  scope.run(() => {
    for (const source of sources) watchEffect(async () => {
      runs.set(source, (runs.get(source) ?? 0) + 1)
      // Bound a renderer-style microtask loop so a broken implementation fails instead of hanging Node.
      if (runs.get(source) > 20) { scope.stop(); return }
      values.set(source, await store.remote(source))
    })
  })
  try {
    for (let turn = 0; turn < 12; turn++) { await Promise.resolve(); await nextTick() }
    for (const source of sources) {
      assert.ok(runs.get(source) <= 2, `${source} reran ${runs.get(source)} times`)
      assert.deepEqual(values.get(source), [{ label: source, value: source === sources[0] ? 401 : 551 }])
    }
    assert.deepEqual(calls, sources)
  } finally { scope.stop() }
})
