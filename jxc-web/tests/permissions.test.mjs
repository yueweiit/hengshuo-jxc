import test from 'node:test'
import assert from 'node:assert/strict'
import { freshDb, context, callApi } from './support.mjs'
const { getDb } = await import('../src/mock/db.ts')
const { inScope, scopeOf, userFieldGroups, MockError, handle } = await import('../src/mock/utils.ts')
const { sysHandlers } = await import('../src/mock/handlers/sys.ts')
const { mdHandlers } = await import('../src/mock/handlers/md.ts')
const { orgHandlers } = await import('../src/mock/handlers/org.ts')
const { crud } = await import('../src/mock/crud.ts')
const { aiHandlers } = await import('../src/mock/handlers/ai.ts')
const { salHandlers } = await import('../src/mock/handlers/sal.ts')
const { purHandlers } = await import('../src/mock/handlers/pur.ts')
const { lgsHandlers } = await import('../src/mock/handlers/lgs.ts')
const { invHandlers } = await import('../src/mock/handlers/inv.ts')
const { canDocumentDataAccess } = await import('../src/mock/services/access.ts')
const { http } = await import('msw')
const api = (handlers, method, path, body, userId = 1, countryId = 1) => callApi(handlers, method, path, body, { userId, countryId })

function manager(db, scopes = [{ scopeType: 'WAREHOUSE', scopeRefId: 401 }]) {
  db.users.push({ id: 90, username: 'scoped-admin', displayName: '本国管理员', status: 'ENABLED', isPlatformAdmin: false })
  db.userRoles.push({ userId: 90, roleId: 12, countryId: 1 })
  db.dataScopes.push(...scopes.map((s, i) => ({ id: 900 + i, userId: 90, countryId: 1, ...s })))
}

test('expired and future data grants do not give warehouse access or implicit all access', () => {
  const db = freshDb()
  db.dataScopes = db.dataScopes.filter(s => s.userId !== 7)
  db.dataScopes.push({ userId: 7, countryId: 1, scopeType: 'COUNTRY_ALL', effectiveTo: '2000-01-01T00:00:00Z' })
  db.dataScopes.push({ userId: 7, countryId: 1, scopeType: 'WAREHOUSE', scopeRefId: 401, effectiveFrom: '2999-01-01T00:00:00Z' })
  assert.equal(inScope(context(7), { warehouseId: 401 }, { warehouseField: 'warehouseId' }), false)
  assert.equal(scopeOf(context(7)).all, false)
})

test('ENTITY and BOOK grants resolve only their own organization hierarchy', () => {
  const db = freshDb()
  db.dataScopes = db.dataScopes.filter(s => s.userId !== 7)
  db.dataScopes.push({ userId: 7, countryId: 1, scopeType: 'ENTITY', scopeRefId: 201 })
  assert.equal(inScope(context(7), { countryId: 1, warehouseId: 401 }, { warehouseField: 'warehouseId' }), true)
  assert.equal(inScope(context(7), { countryId: 2, warehouseId: 411 }, { warehouseField: 'warehouseId' }), false)
  db.dataScopes = [{ userId: 7, countryId: 1, scopeType: 'BOOK', scopeRefId: 61 }]
  assert.equal(inScope(context(7), { countryId: 1, bookId: 61 }, { bookField: 'bookId' }), true)
  assert.equal(inScope(context(7), { countryId: 1, bookId: 999 }, { bookField: 'bookId' }), false)
  assert.equal(inScope(context(7), { countryId: 1, warehouseId: 401 }, { warehouseField: 'warehouseId' }), false)
})

test('users with no scope see no scoped records; a disabled role exposes no field groups', () => {
  const db = freshDb()
  assert.equal(inScope(context(5), { countryId: 1, storeId: null }, { storeField: 'storeId' }), false)
  db.roles.find(r => r.id === 14).status = 'DISABLED'
  assert.equal(userFieldGroups(context(3).user, 1).COST, 'HIDDEN')
})

test('an unowned split order with no store cannot fall back to a shared national record', async () => {
  const db = freshDb()
  db.salOrders.push({ id: 804, countryId: 1, storeId: null, lines: [{ id: 805, allocs: [{ warehouseId: 402, allocQty: 2 }] }] })
  db.attachments.push({ id: 806, countryId: 1, bizType: 'SAL_ORDER', bizId: '804', status: 'ACTIVE', uploadedAt: '2026-10-01' })
  assert.equal((await api(sysHandlers, 'GET', '/sys/attachments?bizType=SAL_ORDER&bizId=804', undefined, 7)).status, 404)
})

test('national administrators cannot read or reset an account from another country', async () => {
  const db = freshDb(); manager(db)
  const list = await api(sysHandlers, 'GET', '/sys/users', undefined, 90)
  assert.equal(list.status, 200)
  assert.equal(list.data.records.some(u => u.id === 8), false)
  assert.equal((await api(sysHandlers, 'GET', '/sys/users/8', undefined, 90)).status, 404)
  assert.equal((await api(sysHandlers, 'POST', '/sys/users/8/reset-password', {}, 90)).status, 404)
  assert.equal((await api(sysHandlers, 'GET', '/sys/users/8/grants?countryId=2', undefined, 90)).status, 403)
  assert.equal(getDb().users.find(u => u.id === 8).password, '123456')
})

test('national administrators cannot create or assign roles beyond their permission ceiling', async () => {
  const db = freshDb(); manager(db)
  assert.equal((await api(sysHandlers, 'POST', '/sys/roles', { code: 'ESCALATE', permissions: ['*'], fieldPolicies: { COST: 'WRITE' } }, 90)).status, 403)
  assert.equal((await api(sysHandlers, 'PUT', '/sys/users/90/roles', { roleIds: [11] }, 90)).status, 403)
  assert.equal((await api(sysHandlers, 'PUT', '/sys/roles/12/permissions', { permissions: ['fin:voucher:post'] }, 90)).status, 403)
  assert.equal((await api(sysHandlers, 'PUT', '/sys/roles/12/field-policies', { fieldPolicies: { COST: 'WRITE' } }, 90)).status, 403)
})

test('generic enable/disable cannot bypass account-country or role privilege ceilings', async () => {
  const db = freshDb(); manager(db)
  db.userRoles.push({ userId: 7, roleId: 18, countryId: 2 })
  assert.equal((await api(sysHandlers, 'POST', '/sys/users/7/disable', {}, 90)).status, 403)
  assert.equal((await api(sysHandlers, 'POST', '/sys/roles/11/disable', {}, 90)).status, 403)
})

test('read-only CRUD registrations never expose implicit generic mutation endpoints', async () => {
  const db = freshDb(); db.invTxns.push({ id: 880, countryId: 1, status: 'CONFIRMED' })
  const handlers = crud('/test/read-only', 'invTxns', { viewPerm: 'inv:txn:view' }).handlers()
  assert.equal((await api(handlers, 'POST', '/test/read-only', { amount: 100 })).status, 403)
  assert.equal((await api(handlers, 'PUT', '/test/read-only/880', { amount: 100 })).status, 403)
  assert.equal((await api(handlers, 'POST', '/test/read-only/880/disable', {})).status, 403)
})

test('an expiring administrator grant cannot be delegated as an indefinite grant', async () => {
  const db = freshDb(); manager(db, [{ scopeType: 'COUNTRY_ALL', effectiveTo: '2026-12-31T00:00:00Z' }])
  assert.equal((await api(sysHandlers, 'PUT', '/sys/users/7/data-scopes', { dataScopes: [{ scopeType: 'WAREHOUSE', scopeRefId: 401 }] }, 90)).status, 403)
})

test('scope management rejects escalation and accepts bounded ENTITY/BOOK grants with dates', async () => {
  const db = freshDb(); manager(db)
  assert.equal((await api(sysHandlers, 'PUT', '/sys/users/90/data-scopes', { dataScopes: [{ scopeType: 'COUNTRY_ALL' }] }, 90)).status, 403)
  const res = await api(sysHandlers, 'PUT', '/sys/users/7/data-scopes', { dataScopes: [
    { scopeType: 'ENTITY', scopeRefId: 201, effectiveFrom: '2026-10-01T00:00:00Z', effectiveTo: '2027-01-01T00:00:00Z' },
    { scopeType: 'BOOK', scopeRefId: 61 },
  ] })
  assert.equal(res.status, 200)
  const grants = getDb().dataScopes.filter(s => s.userId === 7)
  assert.equal(grants[0].effectiveTo, '2027-01-01T00:00:00Z')
  assert.equal((await api(sysHandlers, 'PUT', '/sys/users/7/data-scopes', { dataScopes: [{ scopeType: 'BOOK', scopeRefId: 62 }] })).status, 400)
  assert.equal((await api(sysHandlers, 'PUT', '/sys/users/7/data-scopes', { dataScopes: [{ scopeType: 'MAGIC', scopeRefId: 201 }] })).status, 400)
})

test('attachments inherit source document scope and functional permission for list, URL, unlink and upload', async () => {
  const db = freshDb()
  db.salOrders.push({ id: 801, countryId: 1, storeId: 301, lines: [{ id: 802, allocs: [{ warehouseId: 402, allocQty: 2 }] }] })
  db.attachments.push({ id: 803, countryId: 1, bizType: 'SAL_ORDER', bizId: '801', status: 'ACTIVE', uploadedAt: '2026-10-01' })
  assert.equal((await api(sysHandlers, 'GET', '/sys/attachments?bizType=SAL_ORDER&bizId=801', undefined, 7)).status, 404)
  assert.equal((await api(sysHandlers, 'GET', '/sys/attachments/803/url', undefined, 7)).status, 404)
  assert.equal((await api(sysHandlers, 'POST', '/sys/attachments/803/unlink', {}, 7)).status, 404)
  const upload = new FormData(); upload.set('file', new File(['proof'], 'proof.pdf')); upload.set('bizType', 'SAL_ORDER'); upload.set('bizId', '801')
  assert.equal((await api(sysHandlers, 'POST', '/sys/attachments', upload, 7)).status, 404)
  assert.equal((await api(sysHandlers, 'GET', '/sys/attachments?bizType=SAL_ORDER&bizId=801', undefined, 2)).status, 200)
  assert.equal((await api(sysHandlers, 'GET', '/sys/attachments?bizType=SAL_ORDER&bizId=801', undefined, 6)).status, 403)
})

test('filtering audit logs by a guessed document ID does not bypass source-document access', async () => {
  const db = freshDb()
  db.salOrders.push({ id: 807, countryId: 1, storeId: 301, lines: [{ allocs: [{ warehouseId: 402, allocQty: 2 }] }] })
  db.auditLogs.push({ id: 808, countryId: 1, resourceType: 'sales-order', resourceId: 807, occurredAt: '2026-10-01', afterValue: { totalAmount: 99 } })
  assert.equal((await api(sysHandlers, 'GET', '/sys/audit-logs?resourceType=sales-order&resourceId=807', undefined, 7)).status, 404)
})

test('bank endpoints and fund account serialization obey BANK_INFO field access', async () => {
  const db = freshDb()
  const partner = db.partners.find(p => p.countryId === 1)
  Object.assign(partner, { bankName: 'secret-bank', accountName: 'secret-holder', accountNoMasked: '***777' })
  db.roles.find(r => r.id === 14).fieldPolicies.BANK_INFO = 'HIDDEN'
  assert.equal((await api(mdHandlers, 'GET', `/md/partners/${partner.id}/banks`, undefined, 3)).status, 403)
  const list = await api(mdHandlers, 'GET', '/md/fund-accounts', undefined, 2)
  assert.equal(list.status, 200)
  assert.ok(list.data.records.every(r => r.bankName === undefined && r.accountNoMasked === undefined))
  const allowed = await api(mdHandlers, 'GET', '/md/partners', undefined, 1)
  assert.equal(allowed.data.records.find(p => p.id === partner.id).bankName, 'secret-bank')
})

test('bank fields cannot be written through generic master-data CRUD without WRITE access', async () => {
  const db = freshDb(); manager(db, [{ scopeType: 'COUNTRY_ALL' }])
  assert.equal((await api(mdHandlers, 'POST', '/md/partners', { code: 'PRIVATE-BANK', name: 'Test', bankName: 'hidden bank' }, 90)).status, 403)
  assert.equal((await api(mdHandlers, 'POST', '/md/fund-accounts', { name: 'Hidden', bankName: 'hidden bank', entityId: 201 }, 90)).status, 403)
})

test('organization lists enforce ENTITY/BOOK scope without breaking the second country', async () => {
  const db = freshDb()
  db.dataScopes = db.dataScopes.filter(s => s.userId !== 7)
  db.dataScopes.push({ userId: 7, countryId: 1, scopeType: 'ENTITY', scopeRefId: 201 })
  assert.equal((await api(orgHandlers, 'GET', '/org/entities', undefined, 7)).data.records.length, 1)
  assert.equal((await api(orgHandlers, 'GET', '/org/books', undefined, 7)).data.length, 1)
  assert.equal((await api(orgHandlers, 'GET', '/org/books', undefined, 8, 2)).data[0].id, 62)
})

test('AI requires profit permission and field visibility in addition to its own permission', async () => {
  const db = freshDb(); const role = db.roles.find(r => r.id === 13)
  role.permissions.push('ai:analysis:use')
  assert.equal((await api(aiHandlers, 'POST', '/ai/analysis', {}, 2)).status, 403)
  getDb().roles.find(r => r.id === 13).permissions.push('cst:profit:view')
  assert.equal((await api(aiHandlers, 'POST', '/ai/analysis', {}, 2)).status, 403)
})

test('AI history is private and revoked fields or data scope cannot read a stale output', async () => {
  const db = freshDb()
  const role = db.roles.find(r => r.id === 15)
  db.aiRequests.push({ id: 850, countryId: 1, userId: 4, params: { from: '2026-10-01', to: '2026-10-31' }, output: 'old secret', accessSnapshot: { all: true, warehouses: [401, 402], stores: [301], entities: [201], books: [61] } })
  assert.equal((await api(aiHandlers, 'GET', '/ai/analysis/850', undefined, 1)).status, 404)
  role.fieldPolicies.PROFIT = 'HIDDEN'
  assert.equal((await api(aiHandlers, 'GET', '/ai/analysis/850', undefined, 4)).status, 403)
  role.fieldPolicies.PROFIT = 'READ'
  db.dataScopes = db.dataScopes.filter(s => s.userId !== 4)
  db.dataScopes.push({ userId: 4, countryId: 1, scopeType: 'WAREHOUSE', scopeRefId: 401 })
  assert.equal((await api(aiHandlers, 'GET', '/ai/analysis/850', undefined, 4)).status, 404)
})

test('warehouse order responses contain only assigned lines and exclude sensitive nested fields', async () => {
  const db = freshDb()
  db.salOrders.push({ id: 860, countryId: 1, docNo: 'SO-TEST', storeId: 301, totalAmount: 200, totalQty: 20, approvalStatus: 'APPROVED', lines: [
    { id: 861, productId: db.products[0].id, qty: 10, baseQty: 10, cancelledQty: 0, outboundQty: 0, signedQty: 0, price: 10, lineAmount: 100, unitCost: 3, allocs: [{ warehouseId: 401, allocQty: 4, cancelledQty: 0, outboundQty: 0 }, { warehouseId: 402, allocQty: 6, cancelledQty: 0, outboundQty: 0 }] },
    { id: 862, productId: db.products[1].id, qty: 10, baseQty: 10, cancelledQty: 0, outboundQty: 0, signedQty: 0, price: 10, lineAmount: 100, allocs: [{ warehouseId: 402, allocQty: 10, cancelledQty: 0, outboundQty: 0 }] },
  ] })
  const res = await api(salHandlers, 'GET', '/sal/orders/860', undefined, 7)
  assert.equal(res.status, 200)
  assert.deepEqual(res.data.lines.map(l => l.id), [861])
  assert.deepEqual(res.data.lines[0].allocs.map(a => a.warehouseId), [401])
  assert.equal(res.data.lines[0].baseQty, 4)
  assert.equal(res.data.totalAmount, undefined)
  assert.equal(res.data.lines[0].price, undefined)
  assert.equal(res.data.lines[0].unitCost, undefined)
  const store = await api(salHandlers, 'GET', '/sal/orders/860', undefined, 2)
  assert.equal(store.data.lines.length, 2)
  assert.equal(store.data.totalAmount, 200)
})

test('AI reads only authorized warehouse profit and records a history that the owner can reopen', async () => {
  const db = freshDb(); const role = db.roles.find(r => r.id === 16)
  role.permissions.push('ai:analysis:use', 'cst:profit:view')
  role.fieldPolicies = { PROFIT: 'READ', COST: 'READ', ORDER_TOTAL: 'READ' }
  db.products.push({ id: 890, productCode: 'ALLOWED-PRODUCT', name: 'Allowed' }, { id: 891, productCode: 'OTHER-WAREHOUSE-PRODUCT', name: 'Private' })
  db.salOutbounds.push({ id: 892, countryId: 1, warehouseId: 401, status: 'OUTBOUNDED', bizDate: '2026-10-10', lines: [{ productId: 890, qty: 1, amount: 111 }] },
    { id: 893, countryId: 1, warehouseId: 402, status: 'OUTBOUNDED', bizDate: '2026-10-10', lines: [{ productId: 891, qty: 1, amount: 999 }] })
  const res = await api(aiHandlers, 'POST', '/ai/analysis', { from: '2026-10-01', to: '2026-10-31' }, 7)
  assert.equal(res.status, 200)
  assert.match(res.data.output, /ALLOWED-PRODUCT/)
  assert.doesNotMatch(res.data.output, /OTHER-WAREHOUSE-PRODUCT|999/)
  assert.equal((await api(aiHandlers, 'GET', `/ai/analysis/${res.data.id}`, undefined, 7)).status, 200)
  role.fieldPolicies.COST = 'HIDDEN'
  assert.equal((await api(aiHandlers, 'GET', `/ai/analysis/${res.data.id}`, undefined, 7)).status, 403)
  const hidden = await api(aiHandlers, 'POST', '/ai/analysis', { from: '2026-10-01', to: '2026-10-31' }, 7)
  assert.equal(hidden.status, 200)
  assert.match(hidden.data.output, /出库成本 （无权查看成本）/)
  assert.match(hidden.data.output, /基础毛利 （已隐藏）/)
})

test('transaction rollback retains only an explicitly approved failure marker', async () => {
  const db = freshDb(); db.finEvents.push({ id: 999, countryId: 1, status: 'PENDING', failReason: '' })
  const handlers = [http.post('/api/v1/test/failure', handle(() => {
    getDb().finEvents[0].status = 'GENERATED'
    getDb().finEvents[0].unexpected = 'must roll back'
    throw new MockError(400, 'FIN_BAD_MAPPING', 'missing mapping', null, { table: 'finEvents', id: 999, fields: { status: 'FAILED', failReason: 'missing mapping' } })
  }))]
  assert.equal((await api(handlers, 'POST', '/test/failure', {})).status, 400)
  assert.equal(getDb().finEvents[0].status, 'FAILED')
  assert.equal(getDb().finEvents[0].failReason, 'missing mapping')
  assert.equal(getDb().finEvents[0].unexpected, undefined)
})

test('purchase records and sources obey explicit entity scope for lists, IDs and actions', async () => {
  const db = freshDb(); manager(db, [{ scopeType: 'ENTITY', scopeRefId: 201 }])
  db.roles.find(r => r.id === 12).permissions.push('pur:*')
  db.entities.push({ id: 203, countryId: 1, status: 'ENABLED', name: 'Other entity' })
  const base = { countryId: 1, status: 'CONFIRMED', lines: [], version: 1, supplierId: db.partners[0].id }
  db.purOrders.push({ ...base, id: 910, docNo: 'OWN-PO', entityId: 201 }, { ...base, id: 911, docNo: 'OTHER-PO', entityId: 203 })
  const list = await api(purHandlers, 'GET', '/pur/orders', undefined, 90)
  assert.deepEqual(list.data.records.map(r => r.id), [910])
  assert.equal((await api(purHandlers, 'GET', '/pur/orders/911', undefined, 90)).status, 404)
  assert.equal((await api(purHandlers, 'POST', '/pur/orders/911/close', { reason: 'test' }, 90)).status, 404)
  assert.equal((await api(purHandlers, 'GET', '/pur/orders/910', undefined, 90)).status, 200)
  assert.equal((await api(purHandlers, 'POST', '/pur/orders', { supplierId: base.supplierId, entityId: 203, lines: [] }, 90)).status, 404)
  assert.equal((await api(purHandlers, 'PUT', '/pur/orders/911', {}, 90)).status, 404)
})

test('transport lists, IDs, related quantities, fees and hold actions inherit authorized warehouse', async () => {
  const db = freshDb(); const role = db.roles.find(r => r.id === 16); role.permissions.push('lgs:*')
  const base = { countryId: 1, status: 'IN_TRANSIT', lines: [], nodes: [], containers: [], transportMode: 'SEA' }
  db.shipments.push({ ...base, id: 920, docNo: 'OWN-SHIP', destWarehouseId: 401 }, { ...base, id: 921, docNo: 'OTHER-SHIP', destWarehouseId: 402 })
  db.holds.push({ id: 922, countryId: 1, shipmentId: 921, lines: [], status: 'ACTIVE' })
  db.lgsFees.push({ id: 923, countryId: 1, shipmentId: 921, refType: 'SHIPMENT', refId: 921, status: 'CONFIRMED', amount: 100 })
  assert.deepEqual((await api(lgsHandlers, 'GET', '/lgs/shipments', undefined, 7)).data.records.map(s => s.id), [920])
  for (const suffix of ['', '/related', '/quantities']) assert.equal((await api(lgsHandlers, 'GET', `/lgs/shipments/921${suffix}`, undefined, 7)).status, 404)
  assert.equal((await api(lgsHandlers, 'POST', '/lgs/holds/922/release', { lines: [] }, 7)).status, 404)
  assert.equal((await api(lgsHandlers, 'POST', '/lgs/fees/923/confirm', {}, 7)).status, 404)
  assert.equal((await api(lgsHandlers, 'GET', '/lgs/fees', undefined, 7)).data.records.length, 0)
  const carrierId = getDb().partners.find(p => p.countryId === 1 && p.partnerType === 'LOGISTICS').id
  assert.equal((await api(lgsHandlers, 'POST', '/lgs/shipments', { carrierId, destWarehouseId: 402 }, 7)).status, 404)
  getDb().shipments.find(s => s.id === 920).status = 'DRAFT'
  assert.equal((await api(lgsHandlers, 'PUT', '/lgs/shipments/920', { carrierId, destWarehouseId: 402 }, 7)).status, 404)
})

test('cost and logistics source chains never treat unowned transactional rows as shared master data', () => {
  const db = freshDb()
  db.shipments.push({ id: 930, countryId: 1, destWarehouseId: 402 })
  db.lgsFees.push({ id: 931, countryId: 1, shipmentId: 930 })
  db.inboundCosts.push({ id: 932, countryId: 1, batchId: 933, warehouseId: 402 })
  assert.equal(canDocumentDataAccess(context(7), 'LGS_FEE', db.lgsFees[0]), false)
  assert.equal(canDocumentDataAccess(context(7), 'COST_ALLOCATION', { countryId: 1, feeId: 931, lines: [{ batchId: 933 }] }), false)
  assert.equal(canDocumentDataAccess(context(7), 'PURCHASE_ORDER', { countryId: 1, lines: [] }), false)
  db.shipments[0].destWarehouseId = 401
  db.inboundCosts[0].warehouseId = 401
  assert.equal(canDocumentDataAccess(context(7), 'LGS_FEE', db.lgsFees[0]), true)
  assert.equal(canDocumentDataAccess(context(7), 'COST_ALLOCATION', { countryId: 1, feeId: 931, lines: [{ batchId: 933 }] }), true)
})

test('duplicate shipment source lines are rejected on create and on dispatch of legacy drafts', async () => {
  const db = freshDb(); const productId = db.products[0].id
  const supplierId = db.partners.find(p => p.countryId === 1 && p.partnerType === 'SUPPLIER').id
  const carrierId = db.partners.find(p => p.countryId === 1 && p.partnerType === 'LOGISTICS').id
  db.purOrders.push({ id: 940, countryId: 1, entityId: 201, supplierId, lines: [{ id: 941, productId, shippedQty: 0 }] })
  db.exportNodes.push({ id: 942, countryId: 1, status: 'CONFIRMED', docNo: 'EX-TEST', lines: [{ id: 943, orderId: 940, orderLineId: 941, productId, qty: 10, shippedQty: 0 }] })
  const created = await api(lgsHandlers, 'POST', '/lgs/shipments', { carrierId, destWarehouseId: 401, transportMode: 'SEA', vessel: 'V', voyage: 'V1', blNo: 'BL', containerNo: 'C', lines: [{ sourceLineId: 943, baseQty: 10 }, { sourceLineId: 943, baseQty: 10 }] })
  assert.equal(created.status, 400)
  assert.equal(created.code, 'LGS_DUPLICATE_SOURCE')
  const current = getDb()
  current.shipments.push({ id: 944, countryId: 1, destWarehouseId: 401, status: 'PENDING_DISPATCH', nodes: [], containers: [], lines: [{ id: 945, sourceLineId: 943, baseQty: 10, productId }, { id: 946, sourceLineId: 943, baseQty: 10, productId }] })
  assert.equal((await api(lgsHandlers, 'POST', '/lgs/shipments/944/dispatch', {})).code, 'LGS_DUPLICATE_SOURCE')
  assert.equal(getDb().purOrders.find(o => o.id === 940).lines[0].shippedQty, 0)
})

test('duplicate hold and delivery lines cannot overconsume pending quantities, including legacy delivery drafts', async () => {
  const db = freshDb(); const productId = db.products[0].id
  db.shipments.push({ id: 950, countryId: 1, docNo: 'SHIP-TEST', destWarehouseId: 401, status: 'PENDING_DELIVERY', version: 1, nodes: [], containers: [], lines: [{ id: 951, productId, pendingDeliveryQty: 10, onHoldQty: 0, deliveringQty: 0 }] })
  const hold = await api(lgsHandlers, 'POST', '/lgs/holds', { shipmentId: 950, reasonCode: 'CUSTOMS', parkLocation: 'Port', ownerId: 1, reviewDate: '2026-10-30', lines: [{ shipmentLineId: 951, holdQty: 10 }, { shipmentLineId: 951, holdQty: 10 }] })
  assert.equal(hold.code, 'LGS_DUPLICATE_SOURCE')
  const delivery = await api(lgsHandlers, 'POST', '/lgs/deliveries', { shipmentId: 950, lines: [{ shipmentLineId: 951, dispatchQty: 10 }, { shipmentLineId: 951, dispatchQty: 10 }] })
  assert.equal(delivery.code, 'LGS_DUPLICATE_SOURCE')
  getDb().deliveries.push({ id: 952, countryId: 1, destWarehouseId: 401, shipmentId: 950, status: 'DRAFT', lines: [{ shipmentLineId: 951, dispatchQty: 10 }, { shipmentLineId: 951, dispatchQty: 10 }] })
  assert.equal((await api(lgsHandlers, 'POST', '/lgs/deliveries/952/dispatch', {})).code, 'LGS_DUPLICATE_SOURCE')
  assert.equal(getDb().shipments[0].lines[0].pendingDeliveryQty, 10)
})

test('duplicate domestic receipt and export lines cannot exceed one purchase source balance', async () => {
  const db = freshDb(); const productId = db.products[0].id
  db.purOrders.push({ id: 960, countryId: 1, entityId: 201, status: 'CONFIRMED', version: 1, docNo: 'PO-SOURCE', supplierId: db.partners[0].id, lines: [{ id: 961, productId, baseQty: 10, cancelledQty: 0, qualifiedQty: 0, pendingInspectQty: 0, damagedQty: 0, exportedQty: 0 }] })
  const received = await api(purHandlers, 'POST', '/pur/domestic-receipts', { orderId: 960, confirm: true, lines: [{ orderLineId: 961, qualifiedQty: 10 }, { orderLineId: 961, qualifiedQty: 10 }] })
  assert.equal(received.code, 'PUR_DUPLICATE_SOURCE')
  getDb().domesticReceipts.push({ id: 962, countryId: 1, orderId: 960, status: 'CONFIRMED', lines: [{ id: 963, orderLineId: 961, productId, qualifiedQty: 10, convertedQualifiedQty: 0, exportedQty: 0 }] })
  const exported = await api(purHandlers, 'POST', '/pur/export-nodes', { declarationNo: 'TEST', confirm: true, lines: [{ receiptLineId: 963, qty: 10 }, { receiptLineId: 963, qty: 10 }] })
  assert.equal(exported.code, 'PUR_DUPLICATE_SOURCE')
  getDb().exportNodes.push({ id: 964, countryId: 1, status: 'DRAFT', lines: [{ orderId: 960, receiptId: 962, receiptLineId: 963, orderLineId: 961, productId, qty: 10 }, { orderId: 960, receiptId: 962, receiptLineId: 963, orderLineId: 961, productId, qty: 10 }] })
  assert.equal((await api(purHandlers, 'POST', '/pur/export-nodes/964/confirm', {})).code, 'PUR_DUPLICATE_SOURCE')
  assert.equal(getDb().domesticReceipts[0].lines[0].exportedQty, 0)
})

test('inventory transfer detail and actions share the same warehouse scope as its list', async () => {
  const db = freshDb(); db.warehouses.push({ id: 403, countryId: 1, entityId: 201, name: 'Other warehouse' })
  db.transfers.push({ id: 970, countryId: 1, fromWarehouseId: 402, toWarehouseId: 403, status: 'DRAFT', lines: [] })
  assert.equal((await api(invHandlers, 'GET', '/inv/transfers', undefined, 7)).data.records.length, 0)
  assert.equal((await api(invHandlers, 'GET', '/inv/transfers/970', undefined, 7)).status, 404)
  assert.equal((await api(invHandlers, 'POST', '/inv/transfers/970/submit', {}, 7)).status, 404)
})

test('legacy transfer allocation shortfall rejects receipt and rolls back all quantities', async () => {
  const db = freshDb(); const productId = db.products[0].id
  db.invBatches.push({ id: 976, countryId: 1, productId, batchNo: 'OLD-BATCH', firstInboundDate: '2026-10-01' })
  db.transfers.push({ id: 974, countryId: 1, docNo: 'OLD-TRANSFER', fromWarehouseId: 402, toWarehouseId: 401, status: 'IN_TRANSIT', version: 1,
    lines: [{ id: 975, productId, qty: 10, shippedQty: 10, receivedQty: 0, diffQty: 0, allocs: [{ batchId: 976, qty: 2 }], received: {}, inSeq: 0 }] })
  const res = await api(invHandlers, 'POST', '/inv/transfers/974/receive', { lines: [{ lineId: 975, qty: 10 }] }, 7)
  assert.equal(res.status, 409)
  assert.equal(res.code, 'INV_TRANSFER_ALLOCATION_INCOMPLETE')
  assert.equal(getDb().transfers[0].status, 'IN_TRANSIT')
  assert.equal(getDb().transfers[0].lines[0].receivedQty, 0)
  assert.deepEqual(getDb().transfers[0].lines[0].received, {})
  assert.equal(getDb().invTxns.length, 0)
  assert.equal(getDb().invBatchBalances.length, 0)
})
