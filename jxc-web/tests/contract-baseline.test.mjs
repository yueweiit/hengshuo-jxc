import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const generatorUrl = new URL('../scripts/contracts/generate.mjs', import.meta.url)
const baselineUrl = new URL('../../docs/backend/contracts/', import.meta.url)
const readJson = name => JSON.parse(readFileSync(new URL(name, baselineUrl), 'utf8'))

async function generator() {
  assert.ok(existsSync(generatorUrl), 'M0 needs an AST-based reproducible contract generator')
  return import(generatorUrl.href)
}

test('contract artifacts reproduce the frozen route and 111-test baseline without drift', async () => {
  const { generateArtifacts } = await generator()
  const artifacts = generateArtifacts()
  for (const [name, value] of Object.entries(artifacts)) assert.deepEqual(value, readJson(name), `${name} drift: regenerate and review the change`)
  const baseline = artifacts['mock-regressions.json']
  assert.equal(baseline.expandedTestCount, 111)
  assert.equal(baseline.contracts.flatMap(c => c.expansions).length, 111)
  assert.equal(new Set(baseline.contracts.flatMap(c => c.expansions.map(e => e.name))).size, 111)
  assert.ok(baseline.independentContractCount < 111, 'parameter expansions are not new independent contracts')
})

test('extra and export registration order explain shadowing; read-only CRUD writes stay blocked', async () => {
  const { generateArtifacts } = await generator()
  const { registrations, operations } = generateArtifacts()['route-catalog.json']
  const store = operations.find(r => r.method === 'POST' && r.path === '/api/v1/org/stores')
  assert.equal(store.registrations.length, 2)
  assert.equal(registrations[store.registrationIndex].kind, 'http')
  assert.equal(registrations[store.registrations[1]].effective, false)
  assert.equal(registrations[store.registrations[1]].shadowedBy, store.registrationIndex)
  const readonly = registrations.filter(r => r.kind === 'crud' && r.table === 'invTxns' && r.method !== 'GET')
  assert.equal(readonly.length, 4)
  assert.ok(readonly.every(r => r.mockStatus === 'blocked' && r.backend.status === 'blocked'))
  assert.ok(operations.every(r => ['permissions', 'scope', 'field', 'idem', 'facts', 'phase'].every(k => k in r)))
  assert.ok(operations.every(r => r.analysis.completeness === 'partial' && r.analysis.reviewRequired))
})

test('M1 declarations have explicit status and schemas without claiming deferred commands exist', async () => {
  const { generateArtifacts, validateM1Surface } = await generator()
  const surface = readJson('m1-surface.json')
  assert.deepEqual(validateM1Surface(surface), [])
  const openapi = generateArtifacts()['openapi.json']
  assert.equal(openapi.openapi, '3.1.0')
  assert.deepEqual(openapi.components.schemas.ApiEnvelope.required, ['code', 'message', 'data', 'traceId'])
  for (const entry of surface.operations) {
    const operation = openapi.paths[entry.path][entry.method.toLowerCase()]
    assert.equal(operation['x-backend-status'], entry.status)
    assert.deepEqual(operation.responses, entry.responses)
  }
  const outbound = openapi.paths['/api/v1/sal/outbounds/{id}/confirm'].post
  assert.equal(outbound['x-backend-status'], 'implemented-business-foundation')
  assert.equal(outbound['x-phase'], 'M2')
  const invalid = structuredClone(surface)
  invalid.operations[0].status = 'complete'
  assert.ok(validateM1Surface(invalid).length)
})

test('AST-expanded registrations match the current MSW runtime exports in their exact order', async () => {
  await import('./support.mjs')
  const { generateArtifacts } = await generator()
  const catalog = generateArtifacts()['route-catalog.json']
  assert.ok(Array.isArray(catalog.exportOrder), 'catalogue must preserve the browser export order')
  const actual = []
  for (const entry of catalog.exportOrder) {
    const module = await import(new URL(`../../${entry.file}`, import.meta.url))
    for (const handler of module[entry.name]) actual.push([handler.info.method, handler.info.path])
  }
  assert.deepEqual(actual, catalog.registrations.map(r => [r.method, r.path]))
})

test('shared JSON fixtures replay real resolver HTTP contracts and preserve documented Mock gaps', async () => {
  const fixtureUrl = new URL('./contracts/http-scenarios.json', import.meta.url)
  assert.ok(existsSync(fixtureUrl), 'shared HTTP fixture must be available without executing business algorithms')
  const { runMockScenarios } = await import('./contracts/fixture-runner.mjs')
  const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'))
  const results = await runMockScenarios(fixture)
  assert.equal(results.length, fixture.scenarios.length)
  assert.ok(results.some(r => r.documentedGap), 'same-key/different-body Mock gap must not be silently accepted as real backend behavior')
})

test('page requests and documented gaps are evidence with explicit unresolved cases', async () => {
  const { generateArtifacts } = await generator()
  const evidence = generateArtifacts()['request-evidence.json']
  assert.ok(evidence, 'M0 must reconcile requests and documentation with handler registration')
  assert.ok(evidence.frontend.some(e => e.method === 'POST' && e.pathPattern === '/api/v1/auth/login' && e.match === 'registered'))
  assert.ok(evidence.frontend.some(e => e.match === 'unknown-dynamic'))
  assert.ok(evidence.frontend.some(e => e.method === 'GET' && e.pathPattern === '/api/v1/md/dicts' && e.wrapperMethod === 'allRecords'), 'reviewed option pagination must retain its explicit dictionary GET evidence')
  assert.ok(evidence.documented.some(e => e.method === 'POST' && e.pathPattern === '/api/v1/fin/mapping-templates' && e.match === 'not-registered'))
})

test('reviewed M1 mappings remain exact while later phase declarations are checked against real Controllers', async () => {
  const { generateArtifacts } = await generator()
  const mappings = generateArtifacts()['controller-mappings.json']
  assert.ok(mappings, 'real Controller mappings need their own bounded source inventory')
  const surface = readJson('m1-surface.json')
  const expected = new Set(surface.operations.map(r => `${r.method} ${r.path}`))
  const actual = new Set(mappings.operations.map(r => `${r.method} ${r.path}`))
  for (const key of expected) assert.ok(actual.has(key), `missing M1 Controller ${key}`)
  const m4 = readJson('m4-surface.json')
  const m4Keys = new Set(m4.operations.map(r => `${r.method} ${r.path}`))
  assert.deepEqual((await generator()).validateM1Surface(m4), [])
  for (const operation of m4.operations) {
    assert.ok(actual.has(`${operation.method} ${operation.path}`), `missing M4 Controller ${operation.path}`)
    for (const evidence of operation.evidence) assert.ok(existsSync(new URL(`../../${evidence.file}`, import.meta.url)), `missing M4 evidence ${evidence.file}`)
  }
  const closure = readJson('closure-surface.json')
  const closureKeys = new Set(closure.operations.map(r => `${r.method} ${r.path}`))
  assert.deepEqual((await generator()).validateM1Surface(closure), [])
  for (const entry of closure.operations) {
    assert.ok(actual.has(`${entry.method} ${entry.path}`), `missing closure Controller ${entry.path}`)
    for (const evidence of entry.evidence) {
      const location = new URL(`../../${evidence.file}`, import.meta.url)
      assert.ok(existsSync(location), `missing closure evidence ${evidence.file}`)
      if (evidence.test) assert.ok(readFileSync(location, 'utf8').includes(`${evidence.test}(`), `stale closure test ${evidence.test}`)
    }
  }
  const m3 = readJson('m3-surface.json')
  const m3Keys = new Set(m3.operations.map(r => `${r.method} ${r.path}`))
  for (const entry of mappings.operations.filter(r => !expected.has(`${r.method} ${r.path}`))) {
    if (m4Keys.has(`${entry.method} ${entry.path}`) || closureKeys.has(`${entry.method} ${entry.path}`)) continue
    if (entry.file.includes('/jxc-module-fin/')) assert.ok(m3Keys.has(`${entry.method} ${entry.path}`), 'a new FIN mapping needs an explicit M3 or M4 declaration')
    else assert.match(entry.file, /jxc-module-(md|pur|lgs|inv|cst|sal|ar|ap|rtn)\//, 'an undeclared M1 mapping cannot be accepted as a later business route')
  }
  assert.deepEqual((await generator()).validateM1Surface(m3), [])
  for (const operation of m3.operations) {
    assert.ok(actual.has(`${operation.method} ${operation.path}`), `missing M3 Controller ${operation.path}`)
    for (const evidence of operation.evidence) {
      assert.ok(existsSync(new URL(`../../${evidence.file}`, import.meta.url)), `missing M3 evidence ${evidence.file}`)
      if (evidence.test) assert.ok(readFileSync(new URL(`../../${evidence.file}`, import.meta.url), 'utf8').includes(`${evidence.test}(`), `stale M3 test ${evidence.test}`)
    }
  }
  const m2 = readJson('m2-surface.json')
  assert.ok(m2.operations.length > 40)
  assert.deepEqual((await generator()).validateM1Surface(m2), [])
  for (const operation of m2.operations) {
    assert.ok(actual.has(`${operation.method} ${operation.path}`), `missing M2 Controller ${operation.path}`)
    for (const evidence of operation.evidence) {
      assert.ok(existsSync(new URL(`../../${evidence.file}`, import.meta.url)), `missing M2 evidence ${evidence.file}`)
      if (evidence.test) assert.ok(readFileSync(new URL(`../../${evidence.file}`, import.meta.url), 'utf8').includes(`${evidence.test}(`), `stale M2 test ${evidence.test}`)
    }
  }
  assert.ok(actual.has('GET /api/v1/inv/stocks') && actual.has('GET /api/v1/cst/cogs'))
  assert.ok(actual.has('POST /api/v1/pur/domestic-receipts/{id}/confirm'))

  assert.ok(surface.operations.every(r => r.status === 'implemented-foundation' && r.policy && r.policy.scope && r.policy.idem))
  assert.ok(surface.operations.every(r => r.evidence.some(e => e.file?.includes('/it/'))))
  for (const operation of surface.operations) for (const evidence of operation.evidence.filter(e => e.test)) {
    const content = readFileSync(new URL(`../../${evidence.file}`, import.meta.url), 'utf8')
    assert.ok(content.includes(`${evidence.test}(`), `stale M1 test reference ${evidence.file}:${evidence.test}`)
  }
})
