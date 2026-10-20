import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, crud } from '../crud'
import { MockError, audit, handle, requireCountry, requireDataAccess, requirePerm, scopedRows } from '../utils'

const nameOf = (list: Row[], id: unknown) => list.find((r) => r.id === id)?.name ?? ''

const entities = crud('/org/entities', 'entities', {
  editPerm: 'org:entity:edit',
  scope: { entityField: 'id' },
  unique: ['code'],
  keywordKeys: ['code', 'name', 'legalName', 'taxId'],
  auditType: 'entity',
})

const warehouses = crud('/org/warehouses', 'warehouses', {
  editPerm: 'org:warehouse:edit',
  unique: ['code'],
  scope: { storeField: 'storeId', warehouseField: 'id' },
  filterKeys: ['status', 'type', 'entityId', 'storeId'],
  auditType: 'warehouse',
  out: (r) => {
    const db = getDb()
    return { ...r, entityName: nameOf(db.entities, r.entityId), storeName: nameOf(db.stores, r.storeId) }
  },
})

const stores = crud('/org/stores', 'stores', {
  editPerm: 'org:store:edit',
  unique: ['code'],
  scope: { storeField: 'id' },
  filterKeys: ['status', 'entityId'],
  auditType: 'store',
  out: (r) => {
    const db = getDb()
    return { ...r, entityName: nameOf(db.entities, r.entityId), defaultWarehouseName: nameOf(db.warehouses, r.defaultWarehouseId) }
  },
})

/**
 * 新开门店（docs/01 第 6.3 节）：一次提交完成门店、门店仓、收款账户和人员授权。
 * 优先于通用的 POST /org/stores 匹配。
 */
const createStore = http.post(
  `${API}/org/stores`,
  handle((ctx, { body }) => {
    requirePerm(ctx, 'org:store:edit')
    const countryId = requireCountry(ctx)
    const db = getDb()
    const code = String(body?.code ?? '').trim()
    if (!code || !body?.name) throw new MockError(400, 'SYS_BAD_REQUEST', '请填写门店编码和名称')
    if (db.stores.some((s) => s.countryId === countryId && s.code === code)) throw new MockError(409, 'MD_DUPLICATE', `门店编码 ${code} 已存在`)
    if (!db.entities.some((e) => e.id === body.entityId && e.countryId === countryId)) throw new MockError(400, 'SYS_BAD_REQUEST', '请选择本国的经营主体')
    requireDataAccess(ctx, { countryId, entityId: body.entityId }, { entityField: 'entityId' })
    const stamp = { countryId, status: 'ENABLED', version: 1, createdAt: nowIso(), updatedAt: nowIso(), createdBy: ctx.user.id }

    const store: Row = {
      ...stamp, id: nextId(), code, name: body.name, entityId: body.entityId, address: body.address ?? '',
      timezone: body.timezone ?? '', openedAt: body.openedAt ?? null, defaultWarehouseId: null,
    }
    db.stores.unshift(store)

    if (body.createWarehouse !== false) {
      const whCode = body.warehouseCode || `${code}-WH`
      if (db.warehouses.some((w) => w.countryId === countryId && w.code === whCode)) throw new MockError(409, 'MD_DUPLICATE', `仓库编码 ${whCode} 已存在`)
      const wh = {
        ...stamp, id: nextId(), entityId: body.entityId, code: whCode, name: body.warehouseName || `${body.name}门店仓`,
        type: 'STORE', storeId: store.id, timezone: '', address: store.address,
      }
      db.warehouses.unshift(wh)
      store.defaultWarehouseId = wh.id
    } else if (body.defaultWarehouseId) {
      store.defaultWarehouseId = body.defaultWarehouseId
    }

    if (body.fundAccount?.name) {
      const currency = db.countries.find((c) => c.id === countryId)!.defaultCurrency
      db.fundAccounts.unshift({
        ...stamp, id: nextId(), entityId: body.entityId, storeId: store.id, accountType: body.fundAccount.accountType ?? 'CASH',
        currency, name: body.fundAccount.name, bankName: '', accountNoMasked: '', glAccountId: null,
      })
    }

    for (const userId of (body.userIds ?? []) as number[]) {
      if (!db.dataScopes.some((s) => s.userId === userId && s.countryId === countryId && s.scopeType === 'STORE' && s.scopeRefId === store.id)) {
        db.dataScopes.push({ id: nextId(), userId, countryId, scopeType: 'STORE', scopeRefId: store.id, grantedBy: ctx.user.id, effectiveFrom: nowIso() })
      }
    }
    audit(ctx, '新开门店', 'store', store.id, null, { ...store, userIds: body.userIds ?? [], fundAccount: body.fundAccount ?? null })
    return store
  }),
)

const books = http.get(
  `${API}/org/books`,
  handle((ctx) => {
    const countryId = requireCountry(ctx)
    return scopedRows(ctx, getDb().books.filter((b) => b.countryId === countryId), { bookField: 'id', entityField: 'entityId' })
  }),
)

export const orgHandlers = [...entities.handlers(), ...warehouses.handlers(), ...stores.handlers([createStore]), books]
