import test from 'node:test'
import assert from 'node:assert/strict'
import './support.mjs'
import { retireMockWorker } from '../src/api/mock-exit.ts'

test('real startup retires only this app demo worker and its caches while preserving business storage', async () => {
  const removed = [], cacheRemoved = []
  localStorage.setItem('jxc.mock.db.v6', 'existing-demo-data')
  localStorage.setItem('jxc.token', 'real-session')
  const registrations = [
    { active: { scriptURL: 'https://app.test/mockServiceWorker.js' }, unregister: async () => removed.push('demo') },
    { active: { scriptURL: 'https://app.test/offline-worker.js' }, unregister: async () => removed.push('offline') },
  ]
  const reload = await retireMockWorker({ controller: registrations[0].active, getRegistrations: async () => registrations }, { keys: async () => ['msw:demo', 'mock-service-worker-v1', 'user-attachments', 'order-drafts'], delete: async key => cacheRemoved.push(key) })
  assert.equal(reload, true)
  assert.deepEqual(removed, ['demo'])
  assert.deepEqual(cacheRemoved, ['msw:demo', 'mock-service-worker-v1'])
  assert.equal(localStorage.getItem('jxc.mock.db.v6'), 'existing-demo-data')
  assert.equal(localStorage.getItem('jxc.token'), 'real-session')
})

test('an uncontrolled or unrelated service worker requires no startup reload', async () => {
  assert.equal(await retireMockWorker(undefined, undefined), false)
  assert.equal(await retireMockWorker({ controller: { scriptURL: 'https://app.test/offline-worker.js' }, getRegistrations: async () => [] }, undefined), false)
})
