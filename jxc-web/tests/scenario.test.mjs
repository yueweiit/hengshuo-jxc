import test from 'node:test'
import assert from 'node:assert/strict'
import { freshDb } from './support.mjs'
await import('../src/mock/scenario.ts')

test('existing demo scenario completes in both countries without swallowed business errors', () => {
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args)
  let db
  try { db = freshDb() } finally { console.error = original }
  assert.deepEqual(errors.map(e => e.map(String).join(' ')), [])
  assert.ok(db.salOutbounds.some(o => o.countryId === 1 && o.status === 'OUTBOUNDED'))
  assert.ok(db.salOutbounds.some(o => o.countryId === 2 && o.status === 'OUTBOUNDED'))
  assert.ok(db.finVouchers.some(v => v.status === 'POSTED'))
  for (const outbound of db.salOutbounds.filter(o => o.status === 'OUTBOUNDED')) {
    assert.ok(outbound.lines.every(l => l.costSnapshot), 'confirmed outbound must save cost snapshot')
  }
})
