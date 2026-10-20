import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { freshDb, callApi } from '../support.mjs'

const catalog = JSON.parse(readFileSync(new URL('../../../docs/backend/contracts/route-catalog.json', import.meta.url), 'utf8'))
const handlers = []
for (const entry of catalog.exportOrder) {
  const module = await import(new URL(`../../../${entry.file}`, import.meta.url))
  handlers.push(...module[entry.name])
}
const at = (object, path) => path.split('.').reduce((value, key) => value?.[key], object)
const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)

/** Data setup and structural assertions only. No copied valuation, permission, period or idempotency algorithm. */
export async function runMockScenarios(fixture) {
  const results = []
  for (const scenario of fixture.scenarios) {
    const db = freshDb()
    for (const [table, rows] of Object.entries(scenario.arrange?.replace ?? {})) db[table] = structuredClone(rows)
    for (const [table, rows] of Object.entries(scenario.arrange?.append ?? {})) db[table].push(...structuredClone(rows))
    for (const patch of scenario.arrange?.patch ?? []) {
      const row = db[patch.table].find(row => matches(row, patch.where))
      assert.ok(row, `${scenario.id}: setup row must exist`)
      Object.assign(row, structuredClone(patch.values))
    }
    for (const request of scenario.requests) {
      const expected = request.expect.mock
      assert.ok(expected, `${scenario.id}: Mock observation is explicit`)
      const response = await callApi(handlers, request.method, request.path, request.body, request.options)
      if (expected.status !== undefined) assert.equal(response.status, expected.status, `${scenario.id}: HTTP status`)
      if (expected.code !== undefined) assert.equal(response.code, expected.code, `${scenario.id}: business code`)
      for (const [path, value] of Object.entries(expected.equals ?? {})) assert.deepEqual(at(response.body, path), value, `${scenario.id}: ${path}`)
      for (const path of expected.absent ?? []) assert.equal(at(response.body, path), undefined, `${scenario.id}: hidden ${path}`)
      for (const [path, type] of Object.entries(expected.types ?? {})) assert.equal(typeof at(response.body, path), type, `${scenario.id}: ${path} type`)
    }
    // handle() may replace the database object after rollback; reacquire it rather than asserting an abandoned snapshot.
    const { getDb } = await import('../../src/mock/db.ts')
    const committed = getDb()
    for (const check of scenario.after ?? []) {
      if (check.length !== undefined) assert.equal(committed[check.table].length, check.length, `${scenario.id}: ${check.table} length`)
      if (check.where) {
        const row = committed[check.table].find(row => matches(row, check.where))
        assert.ok(row, `${scenario.id}: retained source`)
        for (const [key, value] of Object.entries(check.equals)) assert.deepEqual(at(row, key), value, `${scenario.id}: retained ${key}`)
      }
    }
    results.push({ id: scenario.id, documentedGap: !!scenario.documentedGap })
  }
  return results
}
