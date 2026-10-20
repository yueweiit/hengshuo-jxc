import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import './support.mjs'
import { createCommandIntent } from '../src/api/command-intent.ts'

function helper(send) {
  const context = { country: 101, token: 'session-a' }, calls = [], navigation = []
  const code = ts.transpileModule(readFileSync(new URL('../src/modules/logistics/receipt.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/^import .*$/gm, '').replace(/export /g, '')
  const http = {
    post: async () => { throw new Error('Native command requires UUID Idempotency-Key') },
    postIdem: (url, body, intent) => intent.run(`${context.token}:${context.country}`, url, body, async key => { calls.push({ url, body, key }); return send(calls.length, context) }),
  }
  class BizError extends Error { constructor(code, message) { super(message); this.code = code } }
  const openReceiptFor = new Function('http', 'createCommandIntent', 'getCountryId', 'getToken', 'BizError', `${code};return openReceiptFor;`)(http, createCommandIntent, () => context.country, () => context.token, BizError)
  const router = { push: async url => { navigation.push(url) } }
  return { openReceiptFor: delivery => openReceiptFor(router, delivery), calls, navigation, context }
}

test('original delivery receipt helper sends a UUID and retains one failed intent for retry', async () => {
  const page = helper(attempt => { if (attempt === 1) throw new Error('response lost'); return { id: 88 } })
  await assert.rejects(page.openReceiptFor(71), /response lost/)
  await page.openReceiptFor(71)
  assert.equal(page.calls.length, 2); assert.equal(page.calls[0].key, page.calls[1].key)
  assert.match(page.calls[0].key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.deepEqual(page.calls[0].body, { deliveryId: 71 }); assert.deepEqual(page.navigation, ['/logistics/receipts/88'])
})
test('double clicks share the same original create request', async () => {
  let release; const page = helper(() => new Promise(resolve => { release = resolve }))
  const first = page.openReceiptFor(71), second = page.openReceiptFor(71)
  await Promise.resolve(); assert.equal(page.calls.length, 1); release({ id: 88 }); await Promise.all([first, second])
})
for (const field of ['country', 'token']) test(`a changed ${field} cannot navigate to a preceding receipt response`, async () => {
  const page = helper((_, context) => { context[field] = field === 'country' ? 102 : 'session-b'; return { id: 88 } })
  await assert.rejects(page.openReceiptFor(71), error => error.code === 'CONTEXT_CHANGED')
  assert.deepEqual(page.navigation, [])
})
