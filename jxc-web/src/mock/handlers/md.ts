/* eslint-disable @typescript-eslint/no-explicit-any */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, crud, findOr404 } from '../crud'
import {
  MockError,
  audit,
  checkVersion,
  handle,
  hasPerm,
  matchKeyword,
  paginate,
  requireCountry,
  requirePerm,
  scopeOf,
  userFieldGroups,
  requireFieldAccess,
} from '../utils'

const nameOf = (list: Row[], id: unknown, key = 'name') => list.find((r) => r.id === id)?.[key] ?? ''

function mask(accountNo: string) {
  const s = String(accountNo ?? '').replace(/\s/g, '')
  return s ? `**** ${s.slice(-4)}` : ''
}

// ---------- 商品（全局） ----------

function prepareProduct(row: Row) {
  const db = getDb()
  const units: Row[] = row.units ?? []
  if (!units.some((u) => u.unit === row.baseUnit)) units.unshift({ unit: row.baseUnit, factorToBase: 1, isPurchaseDefault: false, isSalesDefault: true })
  for (const u of units) {
    if (u.unit === row.baseUnit && Number(u.factorToBase) !== 1) throw new MockError(400, 'MD_BAD_UNIT', '基础单位的换算系数必须为 1')
    if (!(Number(u.factorToBase) > 0)) throw new MockError(400, 'MD_BAD_UNIT', `单位“${u.unit}”的换算系数必须大于 0`)
  }
  if (new Set(units.map((u) => u.unit)).size !== units.length) throw new MockError(400, 'MD_BAD_UNIT', '单位不能重复')
  const barcodes: Row[] = (row.barcodes ?? []).filter((b: Row) => b.barcode)
  const seen = new Set<string>()
  for (const b of barcodes) {
    if (seen.has(b.barcode)) throw new MockError(400, 'MD_DUPLICATE', `条码 ${b.barcode} 重复`)
    seen.add(b.barcode)
    const other = db.products.find((p) => p.id !== row.id && (p.barcodes ?? []).some((x: Row) => x.barcode === b.barcode))
    if (other) throw new MockError(409, 'MD_DUPLICATE', `条码 ${b.barcode} 已被商品 ${other.productCode} 使用`)
    if (!units.some((u) => u.unit === b.unit)) throw new MockError(400, 'MD_BAD_UNIT', `条码 ${b.barcode} 的单位不存在`)
  }
  row.units = units
  row.barcodes = barcodes
  row.barcodeText = barcodes.map((b) => b.barcode).join(' ')
}

const products = crud('/md/products', 'products', {
  countryScoped: false,
  viewPerm: 'md:product:view',
  editPerm: 'md:product:edit',
  unique: ['productCode'],
  keywordKeys: ['productCode', 'name', 'brand', 'spec', 'barcodeText'],
  filterKeys: ['status', 'categoryId'],
  auditType: 'product',
  beforeCreate: (row) => prepareProduct(row),
  beforeUpdate: (row, body) => {
    const next: Row = { ...row, ...body, id: row.id }
    for (const old of row.units ?? []) {
      const changed = (body.units ?? []).find((u: Row) => u.unit === old.unit)
      if (changed && Number(changed.factorToBase) !== Number(old.factorToBase) && row.referenced) {
        throw new MockError(409, 'MD_REFERENCED', `单位“${old.unit}”已被历史单据引用，换算系数不能修改`)
      }
    }
    prepareProduct(next)
    body.units = next.units
    body.barcodes = next.barcodes
    body.barcodeText = next.barcodeText
  },
  out: (r) => ({ ...r, categoryName: nameOf(getDb().categories, r.categoryId) }),
})

const categories = crud('/md/categories', 'categories', {
  countryScoped: false,
  editPerm: 'md:product:edit',
  unique: ['code'],
})

// ---------- 本国经营 SKU ----------

const countrySkuHandlers = [
  http.get(
    `${API}/md/country-skus`,
    handle((ctx) => {
      requirePerm(ctx, 'md:product:view')
      const countryId = requireCountry(ctx)
      const db = getDb()
      const sp = ctx.url.searchParams
      const list = db.products
        .filter((p) => matchKeyword(p, sp.get('keyword'), ['productCode', 'name', 'barcodeText']))
        .map((p) => {
          const sku = db.countrySkus.find((s) => s.countryId === countryId && s.productId === p.id)
          return {
            id: p.id,
            productId: p.id,
            productCode: p.productCode,
            name: p.name,
            label: `${p.productCode} ${p.name}`,
            spec: p.spec,
            baseUnit: p.baseUnit,
            units: p.units,
            barcodeText: p.barcodeText,
            categoryName: nameOf(db.categories, p.categoryId),
            productStatus: p.status,
            enabled: sku?.status === 'ENABLED',
            skuId: sku?.id ?? null,
            localName: sku?.localName ?? '',
            taxCategory: sku?.taxCategory ?? '',
            version: sku?.version ?? 0,
          }
        })
        .filter((r) => !sp.get('enabled') || String(r.enabled) === sp.get('enabled'))
      return paginate(list, ctx.url)
    }),
  ),
  http.put(
    `${API}/md/country-skus/:productId`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, 'md:country-sku:edit')
      const countryId = requireCountry(ctx)
      const db = getDb()
      const productId = Number(params.productId)
      const product = db.products.find((p) => p.id === productId)
      if (!product) throw new MockError(404, 'NOT_FOUND', '商品不存在')
      if (body?.enabled && product.status !== 'ENABLED') throw new MockError(400, 'MD_DISABLED', '商品主档已停用，不能在本国启用')
      let sku = db.countrySkus.find((s) => s.countryId === countryId && s.productId === productId)
      const before = sku ? { ...sku } : null
      if (!sku) {
        sku = { id: nextId(), countryId, productId, localName: '', taxCategory: '', status: 'DISABLED', version: 0 }
        db.countrySkus.push(sku)
      }
      if (body?.enabled !== undefined) sku.status = body.enabled ? 'ENABLED' : 'DISABLED'
      if (body?.localName !== undefined) sku.localName = body.localName
      if (body?.taxCategory !== undefined) sku.taxCategory = body.taxCategory
      sku.version += 1
      audit(ctx, body?.enabled === false ? '本国停用' : '本国启用/修改', 'country-sku', sku.id, before, sku)
      return sku
    }),
  ),
]

// ---------- 客户 ----------

const customers = crud('/md/customers', 'customers', {
  viewPerm: 'md:customer:view',
  editPerm: 'md:customer:edit',
  unique: ['code'],
  scope: { storeField: 'storeId' },
  keywordKeys: ['code', 'name', 'phone', 'taxId'],
  filterKeys: ['status', 'groupId', 'levelId', 'customerType', 'storeId'],
  auditType: 'customer',
  beforeCreate: (row, ctx) => {
    const s = scopeOf(ctx)
    if (!s.all && row.storeId == null && s.stores.length) row.storeId = s.stores[0]
    row.addresses ??= []
  },
  out: (r) => {
    const db = getDb()
    return {
      ...r,
      groupName: nameOf(db.customerGroups, r.groupId),
      levelName: nameOf(db.customerLevels, r.levelId),
      salesOwnerName: nameOf(db.users, r.salesOwnerId, 'displayName'),
      storeName: nameOf(db.stores, r.storeId),
    }
  },
})

const customerGroups = crud('/md/customer-groups', 'customerGroups', { editPerm: 'md:customer:edit', unique: ['code'], auditType: 'customer-group' })
const customerLevels = crud('/md/customer-levels', 'customerLevels', { editPerm: 'md:customer:edit', unique: ['code'], auditType: 'customer-level' })

// ---------- 供应商与物流商 ----------

const BANK_FIELDS = ['bankName', 'accountName', 'accountNoMasked']
function checkBankWrite(ctx: Parameters<typeof requireFieldAccess>[0], body: Row, previous?: Row) {
  const changed = [...BANK_FIELDS, 'accountNo', 'bankAddress', 'swiftCode', 'iban'].some((key) => key in body &&
    (previous ? body[key] !== previous[key] : body[key] != null && body[key] !== ''))
  if (changed) requireFieldAccess(ctx, 'BANK_INFO', true)
}

const partners = crud('/md/partners', 'partners', {
  viewPerm: 'md:partner:view',
  editPerm: 'md:partner:edit',
  unique: ['code'],
  keywordKeys: ['code', 'name', 'contact', 'phone'],
  filterKeys: ['status', 'partnerType', 'locatedCountry'],
  auditType: 'partner',
  beforeCreate: (row, ctx) => {
    checkBankWrite(ctx, row)
    if (row.accountNo) row.accountNoMasked = mask(row.accountNo)
    delete row.accountNo
  },
  beforeUpdate: (_row, body, ctx) => {
    checkBankWrite(ctx, body, _row)
    if (body.accountNo) body.accountNoMasked = mask(body.accountNo)
    delete body.accountNo
  },
  out: (r, ctx) => {
    const canSee = hasPerm(ctx, 'md:partner:bank-view') && userFieldGroups(ctx.user, ctx.countryId).BANK_INFO !== 'HIDDEN'
    if (!canSee) for (const f of BANK_FIELDS) r[f] = undefined
    return { ...r, bankHidden: !canSee }
  },
})

const partnerBank = http.get(
  `${API}/md/partners/:id/banks`,
  handle((ctx, { params }) => {
    requirePerm(ctx, 'md:partner:bank-view')
    requireFieldAccess(ctx, 'BANK_INFO')
    const p = findOr404(ctx, 'partners', Number(params.id))
    audit(ctx, '查看银行信息', 'partner', p.id, null, null)
    return p.bankName ? [{ bankName: p.bankName, accountName: p.accountName, accountNoMasked: p.accountNoMasked, currency: p.settleCurrency, isDefault: true }] : []
  }),
)

// ---------- 费用项目、币种、汇率、账户、字典 ----------

const expenseItems = crud('/md/expense-items', 'expenseItems', {
  editPerm: 'md:expense-item:edit',
  unique: ['code'],
  filterKeys: ['status', 'feeCategory', 'costTreatment'],
  auditType: 'expense-item',
})

const currencies = http.get(
  `${API}/md/currencies`,
  handle((ctx) => paginate(getDb().currencies, ctx.url)),
)

const RATE_KEY = ['fromCcy', 'toCcy', 'rateDate', 'scope']
const sameRateKey = (a: Row, b: Row) => a.countryId === b.countryId && RATE_KEY.every((k) => a[k] === b[k])

const rates = crud('/md/exchange-rates', 'exchangeRates', {
  editPerm: 'md:rate:edit',
  keywordKeys: ['fromCcy', 'toCcy', 'rateDate'],
  filterKeys: ['status', 'fromCcy', 'toCcy', 'scope'],
  auditType: 'exchange-rate',
  beforeCreate: (row) => {
    if (!(Number(row.rate) > 0)) throw new MockError(400, 'MD_BAD_RATE', '汇率必须大于 0')
    if (row.fromCcy === row.toCcy) throw new MockError(400, 'MD_BAD_RATE', '原币和目标币不能相同')
    const versions = getDb().exchangeRates.filter((r) => sameRateKey(r, row))
    if (versions.some((r) => r.status === 'DRAFT')) throw new MockError(409, 'MD_RATE_DRAFT_EXISTS', '同日期同范围已有待确认的汇率，请先确认或修改它')
    row.versionNo = versions.length + 1
    row.status = 'DRAFT'
    row.confirmedBy = null
    row.confirmedAt = null
  },
  out: (r) => {
    const db = getDb()
    return { ...r, createdByName: nameOf(db.users, r.createdBy, 'displayName'), confirmedByName: nameOf(db.users, r.confirmedBy, 'displayName') }
  },
})

const rateExtras = [
  http.get(
    `${API}/md/exchange-rates/resolve`,
    handle((ctx) => {
      const countryId = requireCountry(ctx)
      const sp = ctx.url.searchParams
      const date = sp.get('date') ?? nowIso().slice(0, 10)
      const scope = sp.get('scope') ?? 'ALL'
      const hit = getDb()
        .exchangeRates.filter(
          (r) => r.countryId === countryId && r.fromCcy === sp.get('from') && r.toCcy === sp.get('to') &&
            r.status === 'CONFIRMED' && (r.scope === scope || r.scope === 'ALL') && r.rateDate <= date,
        )
        .sort((a, b) => (a.rateDate === b.rateDate ? b.versionNo - a.versionNo : b.rateDate.localeCompare(a.rateDate)))[0]
      return hit ? { rate: hit } : { rate: null, reason: `没有 ${date} 及之前已确认的 ${sp.get('from')}→${sp.get('to')} 汇率（待补汇率）` }
    }),
  ),
  http.get(
    `${API}/md/exchange-rates/:id/versions`,
    handle((ctx, { params }) => {
      const r = findOr404(ctx, 'exchangeRates', Number(params.id))
      return getDb().exchangeRates.filter((x) => sameRateKey(x, r)).sort((a, b) => b.versionNo - a.versionNo)
    }),
  ),
  http.put(
    `${API}/md/exchange-rates/:id`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, 'md:rate:edit')
      const r = findOr404(ctx, 'exchangeRates', Number(params.id))
      checkVersion(r, body)
      if (!(Number(body?.rate) > 0)) throw new MockError(400, 'MD_BAD_RATE', '汇率必须大于 0')
      if (r.status === 'DRAFT') {
        const before = { rate: r.rate }
        r.rate = Number(body.rate)
        r.remark = body.remark ?? r.remark
        r.version += 1
        audit(ctx, '修改', 'exchange-rate', r.id, before, { rate: r.rate })
        return r
      }
      if (r.status === 'RETIRED') throw new MockError(409, 'SYS_STATE_INVALID', '已被替代的汇率不能修改')
      const db = getDb()
      if (db.exchangeRates.some((x) => sameRateKey(x, r) && x.status === 'DRAFT')) {
        throw new MockError(409, 'MD_RATE_DRAFT_EXISTS', '已有待确认的新版本，请先处理它')
      }
      const next = {
        ...r, id: nextId(), rate: Number(body.rate), remark: body.remark ?? '', status: 'DRAFT',
        versionNo: Math.max(...db.exchangeRates.filter((x) => sameRateKey(x, r)).map((x) => x.versionNo)) + 1,
        createdBy: ctx.user.id, confirmedBy: null, confirmedAt: null, version: 1, createdAt: nowIso(), updatedAt: nowIso(),
      }
      db.exchangeRates.unshift(next)
      audit(ctx, '新增版本', 'exchange-rate', next.id, { rate: r.rate, versionNo: r.versionNo }, { rate: next.rate, versionNo: next.versionNo })
      return next
    }),
  ),
  http.post(
    `${API}/md/exchange-rates/:id/confirm`,
    handle((ctx, { params }) => {
      requirePerm(ctx, 'md:rate:confirm')
      const r = findOr404(ctx, 'exchangeRates', Number(params.id))
      if (r.status !== 'DRAFT') throw new MockError(409, 'SYS_STATE_INVALID', '只有待确认的汇率可以确认')
      for (const old of getDb().exchangeRates.filter((x) => sameRateKey(x, r) && x.status === 'CONFIRMED')) old.status = 'RETIRED'
      r.status = 'CONFIRMED'
      r.confirmedBy = ctx.user.id
      r.confirmedAt = nowIso()
      r.version += 1
      audit(ctx, '确认', 'exchange-rate', r.id, { status: 'DRAFT' }, { status: 'CONFIRMED' })
      return { ...r, sameUser: r.createdBy === ctx.user.id }
    }),
  ),
]

const fundAccounts = crud('/md/fund-accounts', 'fundAccounts', {
  scope: { storeField: 'storeId' },
  editPerm: 'md:fund-account:edit',
  keywordKeys: ['name', 'bankName'],
  filterKeys: ['status', 'accountType', 'storeId', 'currency'],
  auditType: 'fund-account',
  beforeCreate: (row, ctx) => {
    checkBankWrite(ctx, row)
    if (row.accountNo) row.accountNoMasked = mask(row.accountNo)
    delete row.accountNo
  },
  beforeUpdate: (_row, body, ctx) => {
    checkBankWrite(ctx, body, _row)
    if (body.accountNo) body.accountNoMasked = mask(body.accountNo)
    delete body.accountNo
  },
  out: (r, ctx) => {
    const db = getDb()
    const out: Row = { ...r, entityName: nameOf(db.entities, r.entityId), storeName: nameOf(db.stores, r.storeId) }
    if (userFieldGroups(ctx.user, ctx.countryId).BANK_INFO === 'HIDDEN') for (const key of [...BANK_FIELDS, 'accountNo', 'bankAddress', 'swiftCode', 'iban']) delete out[key]
    return out
  },
})

const dicts = crud('/md/dicts', 'dicts', {
  editPerm: 'md:dict:edit',
  keywordKeys: ['code', 'label'],
  filterKeys: ['status', 'dictType'],
  auditType: 'dict',
  beforeCreate: (row) => {
    if (getDb().dicts.some((d) => d.countryId === row.countryId && d.dictType === row.dictType && d.code === row.code)) {
      throw new MockError(409, 'MD_DUPLICATE', `${row.dictType} 下已存在编码 ${row.code}`)
    }
  },
  beforeUpdate: (row, body) => {
    delete body.dictType
    delete body.code
    void row
  },
})

export const mdHandlers = [
  ...products.handlers(),
  ...categories.handlers(),
  ...countrySkuHandlers,
  ...customers.handlers(),
  ...customerGroups.handlers(),
  ...customerLevels.handlers(),
  ...partners.handlers([partnerBank]),
  ...expenseItems.handlers(),
  currencies,
  ...rates.handlers(rateExtras),
  ...fundAccounts.handlers(),
  ...dicts.handlers(),
]
