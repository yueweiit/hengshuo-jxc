import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

/** The shared CRUD transport must retain the same dialog intent for versioned edits. */
test('CRUD update uses the existing dialog intent for idempotent PUT', async () => {
  const source = readFileSync(new URL('../src/api/crud.ts', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText
  const calls = [], intent = { marker: 'same-dialog' }, body = { version: 3, glAccountId: 101 }
  const http = { put: (...args) => calls.push(['put', ...args]), putIdem: (...args) => calls.push(['putIdem', ...args]) }
  const createCrudApi = new Function('http', `${compiled}; return createCrudApi`)(http)
  await createCrudApi('/md/fund-accounts', intent).update(9, body)
  assert.deepEqual(calls, [['putIdem', '/md/fund-accounts/9', body, intent]])
})

test('CRUD enable and disable retain the version and the same dialog intent', async () => {
  const source = readFileSync(new URL('../src/api/crud.ts', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText
  const calls = [], intent = { marker: 'same-dialog' }, body = { version: 3 }
  const http = { post: (...args) => calls.push(['post', ...args]), postIdem: (...args) => calls.push(['postIdem', ...args]) }
  const createCrudApi = new Function('http', `${compiled}; return createCrudApi`)(http), api = createCrudApi('/md/fund-accounts', intent)
  await api.disable(9, body); await api.enable(9, body)
  assert.deepEqual(calls, [['postIdem', '/md/fund-accounts/9/disable', body, intent], ['postIdem', '/md/fund-accounts/9/enable', body, intent]])
})
