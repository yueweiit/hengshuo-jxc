/* eslint-disable @typescript-eslint/no-explicit-any */
import { http } from 'msw'
import { getDb, nextId, nowIso, COUNTRY_ADMIN_PERMS, type Row } from '../db'
import { API } from '../crud'
import { MockError, audit, handle, notFound, requirePerm, userCountries, type Ctx } from '../utils'

function visibleCountry(ctx: Ctx, id: number) {
  const c = userCountries(ctx.user).find((x) => x.id === id) ?? (ctx.user.isPlatformAdmin ? getDb().countries.find((x) => x.id === id) : null)
  if (!c) notFound()
  return c
}

/** docs/01 第 5 节：缺项检查。BLOCK 阻断启用，WARN 只提示 */
export function computeMissing(countryId: number) {
  const db = getDb()
  const c = db.countries.find((x) => x.id === countryId)!
  const base = `/settings/countries/${countryId}`
  const items: { key: string; label: string; level: 'BLOCK' | 'WARN'; link?: string }[] = []
  const add = (key: string, label: string, level: 'BLOCK' | 'WARN', link?: string) => items.push({ key, label, level, link })
  const job = db.cloneJobs.find((j) => j.targetCountryId === countryId)

  if (job && job.status === 'DRAFT') add('CLONE_NOT_APPLIED', '尚未生成配置草稿（复制向导最后一步）', 'BLOCK', `/settings/countries/clone?jobId=${job.id}`)
  if (!c.defaultCurrency) add('CURRENCY', '未设置默认币种', 'BLOCK', base)
  if (!c.timezone) add('TIMEZONE', '未设置时区', 'BLOCK', base)
  if (!db.entities.some((e) => e.countryId === countryId)) add('ENTITY', '未建立经营主体', 'BLOCK', '/settings/entities')
  if (!db.warehouses.some((w) => w.countryId === countryId)) add('WAREHOUSE', '未建立仓库', 'BLOCK', '/settings/warehouses')
  const adminRoleIds = db.roles
    .filter((r) => r.countryId === countryId && (r.code === 'COUNTRY_ADMIN' || r.permissions.includes('*')))
    .map((r) => r.id)
  if (!db.userRoles.some((ur) => ur.countryId === countryId && adminRoleIds.includes(ur.roleId))) add('ADMIN', '未指定国家管理员', 'BLOCK', '/settings/users')

  if (!db.stores.some((s) => s.countryId === countryId)) add('STORE', '未建立门店（可以先启用，开门店前补齐）', 'WARN', '/settings/stores')
  if (!db.books.some((b) => b.countryId === countryId)) add('BOOK', '未建立账套，财务模块不可用', 'WARN', '/finance/books')
  if (!db.fundAccounts.some((f) => f.countryId === countryId)) add('FUND_ACCOUNT', '未设置银行或现金账户，收款前需补齐', 'WARN', '/master/fund-accounts')
  if (c.defaultCurrency && c.defaultCurrency !== 'CNY' &&
    !db.exchangeRates.some((r) => r.countryId === countryId && r.fromCcy === 'CNY' && r.toCcy === c.defaultCurrency && r.status === 'CONFIRMED')) {
    add('RATE', `没有已确认的 CNY→${c.defaultCurrency} 汇率，成本确认会被拦截`, 'WARN', '/master/exchange-rates')
  }
  const pending = db.reviews.filter((r) => r.countryId === countryId && r.status === 'NEED_REVIEW').length
  if (pending) add('REVIEW', `${pending} 项复制配置待复核（阈值、额度、映射等）`, 'WARN', base)
  return items
}

function readinessSummary(countryId: number) {
  const m = computeMissing(countryId)
  return { blockCount: m.filter((x) => x.level === 'BLOCK').length, warnCount: m.filter((x) => x.level === 'WARN').length }
}

function jobView(job: Row) {
  const db = getDb()
  const template = db.templates.find((t) => t.id === job.templateId)
  return {
    ...job,
    template,
    sourceCountry: db.countries.find((c) => c.id === job.sourceCountryId),
    targetCountry: db.countries.find((c) => c.id === job.targetCountryId),
    entity: db.entities.find((e) => e.countryId === job.targetCountryId) ?? null,
    warehouse: db.warehouses.find((w) => w.countryId === job.targetCountryId) ?? null,
    store: db.stores.find((s) => s.countryId === job.targetCountryId) ?? null,
    book: db.books.find((b) => b.countryId === job.targetCountryId) ?? null,
    adminUserIds: adminUsers(job.targetCountryId),
  }
}

function adminUsers(countryId: number) {
  const db = getDb()
  const roleIds = db.roles.filter((r) => r.countryId === countryId && r.code === 'COUNTRY_ADMIN').map((r) => r.id)
  return db.userRoles.filter((ur) => ur.countryId === countryId && roleIds.includes(ur.roleId)).map((ur) => ur.userId)
}

function getJob(id: number) {
  const job = getDb().cloneJobs.find((j) => j.id === id)
  if (!job) notFound()
  return job
}

function ensureAdminRole(countryId: number) {
  const db = getDb()
  let role = db.roles.find((r) => r.countryId === countryId && r.code === 'COUNTRY_ADMIN')
  if (!role) {
    role = {
      id: nextId(), countryId, code: 'COUNTRY_ADMIN', name: '国家管理员', roleType: 'ADMIN', status: 'ENABLED',
      permissions: [...COUNTRY_ADMIN_PERMS], fieldPolicies: {}, isTemplate: true, version: 1, createdAt: nowIso(), updatedAt: nowIso(),
    }
    db.roles.push(role)
  }
  return role
}

/** 复制向导第 6 步：按勾选项生成目标国家配置草稿，重复调用不会重复生成 */
function applyJob(ctx: Ctx, job: Row) {
  if (job.status !== 'DRAFT') return
  const db = getDb()
  const template = db.templates.find((t) => t.id === job.templateId)!
  const selected = template.items.filter((i: Row) => job.selectedItemIds.includes(i.id))
  const keys = new Set(selected.map((i: Row) => i.itemKey))
  const src = job.sourceCountryId
  const dst = job.targetCountryId
  const stamp = { version: 1, createdAt: nowIso(), updatedAt: nowIso() }

  if (keys.has('dicts')) {
    for (const d of db.dicts.filter((x) => x.countryId === src)) db.dicts.push({ ...d, ...stamp, id: nextId(), countryId: dst })
  }
  if (keys.has('expense-items')) {
    for (const e of db.expenseItems.filter((x) => x.countryId === src)) db.expenseItems.push({ ...e, ...stamp, id: nextId(), countryId: dst })
  }
  if (keys.has('roles')) {
    for (const r of db.roles.filter((x) => x.countryId === src && x.isTemplate && x.code !== 'SUPER')) {
      if (!db.roles.some((x) => x.countryId === dst && x.code === r.code)) {
        db.roles.push({ ...structuredClone(r), ...stamp, id: nextId(), countryId: dst })
      }
    }
  }
  if (keys.has('approval-rules')) {
    for (const r of db.approvalRules.filter((x) => x.countryId === src && x.status === 'ACTIVE')) {
      db.approvalRules.push({ ...structuredClone(r), ...stamp, id: nextId(), countryId: dst, versionNo: 1, status: 'DRAFT', ruleKey: r.ruleKey })
    }
    for (const t of db.docTypeConfigs.filter((x) => x.countryId === src)) db.docTypeConfigs.push({ ...structuredClone(t), countryId: dst })
  }
  if (keys.has('classify-rules')) {
    for (const r of db.classifyRules.filter((x) => x.countryId === src && x.status === 'ACTIVE')) {
      db.classifyRules.push({ ...structuredClone(r), ...stamp, id: nextId(), countryId: dst, versionNo: 1, status: 'NEED_REVIEW' })
    }
  }
  if (keys.has('account-chart') || keys.has('voucher-mapping')) {
    const srcBook = db.books.find((b) => b.countryId === src && b.status === 'ACTIVE')
    const target = db.countries.find((c) => c.id === dst)
    let dstBook = db.books.find((b) => b.countryId === dst)
    if (!dstBook && srcBook) {
      dstBook = { id: nextId(), countryId: dst, entityId: null, code: `${target?.code ?? 'XX'}-B01`, name: '主账套（待复核）', baseCurrency: target?.defaultCurrency || '', status: 'DRAFT' }
      db.books.push(dstBook)
    }
    if (dstBook && srcBook && keys.has('account-chart') && !db.finAccounts.some((a) => a.bookId === dstBook!.id)) {
      for (const a of db.finAccounts.filter((x) => x.bookId === srcBook.id)) {
        db.finAccounts.push({ ...structuredClone(a), ...stamp, id: nextId(), bookId: dstBook.id, countryId: dst })
      }
    }
    if (dstBook && srcBook && keys.has('voucher-mapping')) {
      for (const m of db.finMappings.filter((x) => x.bookId === srcBook.id && x.status === 'ACTIVE')) {
        db.finMappings.push({ ...structuredClone(m), id: nextId(), bookId: dstBook.id, countryId: dst, versionNo: 1, status: 'NEED_REVIEW', reviewedBy: null, reviewedAt: null })
      }
    }
  }
  for (const item of selected.filter((i: Row) => i.requiresReview)) {
    db.reviews.push({
      id: nextId(), countryId: dst, itemKey: item.itemKey, label: item.label, source: `模板 v${template.versionNo}`,
      status: 'NEED_REVIEW', reviewedBy: null, reviewedAt: null, comment: '',
    })
  }
  job.status = 'APPLIED'
  job.appliedAt = nowIso()
  audit(ctx, '生成配置草稿', 'country', dst, null, { templateVersion: template.versionNo, items: selected.map((i: Row) => i.itemKey) })
}

export const countryHandlers = [
  // ---------- 国家 ----------
  http.get(
    `${API}/sys/countries`,
    handle((ctx) => {
      requirePerm(ctx, 'sys:country:view')
      const db = getDb()
      const list = ctx.user.isPlatformAdmin ? db.countries : userCountries(ctx.user)
      return list.map((c) => ({ ...c, ...readinessSummary(c.id), cloneJobId: db.cloneJobs.find((j) => j.targetCountryId === c.id)?.id ?? null }))
    }),
  ),
  http.get(
    `${API}/sys/countries/:id/readiness`,
    handle((ctx, { params }) => {
      const c = visibleCountry(ctx, Number(params.id))
      const missing = computeMissing(c.id)
      return { ready: !missing.some((m) => m.level === 'BLOCK'), missing }
    }),
  ),
  http.get(
    `${API}/sys/countries/:id/reviews`,
    handle((ctx, { params }) => {
      const c = visibleCountry(ctx, Number(params.id))
      return getDb().reviews.filter((r) => r.countryId === c.id)
    }),
  ),
  http.post(
    `${API}/sys/countries/:id/reviews/:reviewId/confirm`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, ['sys:country-param:edit', 'sys:country:create'])
      const c = visibleCountry(ctx, Number(params.id))
      const r = getDb().reviews.find((x) => x.id === Number(params.reviewId) && x.countryId === c.id)
      if (!r) notFound()
      r.status = 'REVIEWED'
      r.reviewedBy = ctx.user.displayName
      r.reviewedAt = nowIso()
      r.comment = body?.comment ?? ''
      audit(ctx, '复核确认', 'country', c.id, null, { itemKey: r.itemKey, comment: r.comment })
      return r
    }),
  ),
  http.put(
    `${API}/sys/countries/:id/params`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, ['sys:country-param:edit', 'sys:country:create'])
      const c = visibleCountry(ctx, Number(params.id))
      if (body?.version != null && body.version !== c.version) throw new MockError(409, 'SYS_VERSION_CONFLICT', '国家参数已被他人修改，请刷新后重试')
      const before = structuredClone(c)
      const fields = ['name', 'defaultCurrency', 'timezone', 'locale', 'dateFormat', 'numberFormat', 'isTest', 'enabledModules', 'addressRule']
      if (c.status === 'ACTIVE' && body?.defaultCurrency && body.defaultCurrency !== c.defaultCurrency) {
        throw new MockError(400, 'SYS_CURRENCY_LOCKED', '国家启用后不能修改默认币种')
      }
      for (const f of fields) if (body?.[f] !== undefined) c[f] = body[f]
      c.version += 1
      c.updatedAt = nowIso()
      audit(ctx, '修改地区参数', 'country', c.id, before, c)
      return c
    }),
  ),
  http.post(
    `${API}/sys/countries/:id/activate`,
    handle((ctx, { params }) => {
      requirePerm(ctx, 'sys:country:activate')
      const c = visibleCountry(ctx, Number(params.id))
      const missing = computeMissing(c.id)
      if (missing.some((m) => m.level === 'BLOCK')) {
        throw new MockError(400, 'SYS_CONFIG_MISSING', '还有阻断缺项，不能启用', { missing })
      }
      c.status = 'ACTIVE'
      c.activatedAt = nowIso()
      const job = getDb().cloneJobs.find((j) => j.targetCountryId === c.id)
      if (job) job.status = 'DONE'
      audit(ctx, '启用国家', 'country', c.id, { status: 'DRAFT' }, { status: 'ACTIVE' })
      return { ...c, missing }
    }),
  ),
  http.get(
    `${API}/sys/countries/:id`,
    handle((ctx, { params }) => {
      requirePerm(ctx, 'sys:country:view')
      const c = visibleCountry(ctx, Number(params.id))
      const db = getDb()
      const tpl = db.templates.find((t) => t.id === c.sourceTemplateVersionId)
      return {
        ...c,
        ...readinessSummary(c.id),
        sourceCountry: db.countries.find((x) => x.id === c.sourceCountryId) ?? null,
        sourceTemplateVersionNo: tpl?.versionNo ?? null,
        cloneJobId: db.cloneJobs.find((j) => j.targetCountryId === c.id)?.id ?? null,
      }
    }),
  ),

  // ---------- 模板 ----------
  http.get(
    `${API}/sys/country-templates`,
    handle((ctx) => {
      requirePerm(ctx, ['sys:country:view', 'sys:template:publish'])
      const db = getDb()
      const src = ctx.url.searchParams.get('sourceCountryId')
      return db.templates
        .filter((t) => !src || t.sourceCountryId === Number(src))
        .filter((t) => !ctx.url.searchParams.get('status') || t.status === ctx.url.searchParams.get('status'))
        .map((t): Row => ({ ...t, sourceCountryName: db.countries.find((c) => c.id === t.sourceCountryId)?.name, itemCount: t.items.length }))
        .sort((a, b) => b.id - a.id)
    }),
  ),
  http.get(
    `${API}/sys/country-templates/:id`,
    handle((_ctx, { params }) => {
      const t = getDb().templates.find((x) => x.id === Number(params.id))
      if (!t) notFound()
      return t
    }),
  ),
  http.post(
    `${API}/sys/country-templates`,
    handle((ctx, { body }) => {
      requirePerm(ctx, 'sys:template:publish')
      const db = getDb()
      const sourceCountryId = Number(body?.sourceCountryId)
      if (!db.countries.some((c) => c.id === sourceCountryId)) throw new MockError(400, 'SYS_BAD_REQUEST', '来源国家不存在')
      const versions = db.templates.filter((t) => t.sourceCountryId === sourceCountryId)
      if (versions.some((t) => t.status === 'DRAFT')) throw new MockError(409, 'SYS_TEMPLATE_DRAFT_EXISTS', '已有未发布的模板草稿，请先发布或删除')
      const latest = versions.sort((a, b) => b.versionNo - a.versionNo)[0]
      const t = {
        id: nextId(), sourceCountryId, versionNo: (latest?.versionNo ?? 0) + 1, status: 'DRAFT', publishedAt: null,
        changeNote: body?.changeNote ?? '', items: structuredClone(latest?.items ?? []).map((i: Row) => ({ ...i, id: nextId() })),
        createdAt: nowIso(),
      }
      db.templates.push(t)
      audit(ctx, '生成模板草稿', 'country-template', t.id, null, { versionNo: t.versionNo })
      return t
    }),
  ),
  http.post(
    `${API}/sys/country-templates/:id/publish`,
    handle((ctx, { params }) => {
      requirePerm(ctx, 'sys:template:publish')
      const t = getDb().templates.find((x) => x.id === Number(params.id))
      if (!t) notFound()
      if (t.status !== 'DRAFT') throw new MockError(409, 'SYS_STATE_INVALID', '只有草稿可以发布')
      t.status = 'PUBLISHED'
      t.publishedAt = nowIso()
      audit(ctx, '发布模板', 'country-template', t.id, { status: 'DRAFT' }, { status: 'PUBLISHED' })
      return t
    }),
  ),

  // ---------- 复制向导 ----------
  http.post(
    `${API}/sys/country-clone-jobs`,
    handle((ctx, { body }) => {
      requirePerm(ctx, 'sys:country:create')
      const db = getDb()
      const template = db.templates.find((t) => t.id === Number(body?.templateId))
      if (!template || template.status !== 'PUBLISHED') throw new MockError(400, 'SYS_BAD_REQUEST', '请选择已发布的模板版本')
      const code = String(body?.targetCode ?? '').trim().toUpperCase()
      if (!/^[A-Z]{2}$/.test(code)) throw new MockError(400, 'SYS_BAD_REQUEST', '国家代码应为两位字母（ISO 3166-1）')
      if (db.countries.some((c) => c.code === code)) throw new MockError(409, 'MD_DUPLICATE', `国家 ${code} 已存在`)
      const source = db.countries.find((c) => c.id === template.sourceCountryId)!
      const country = {
        id: nextId(), code, name: body?.targetName || code, status: 'DRAFT', defaultCurrency: '', timezone: '', locale: '',
        dateFormat: source.dateFormat, numberFormat: source.numberFormat, isTest: !!body?.isTest,
        enabledModules: [...source.enabledModules], addressRule: structuredClone(source.addressRule),
        sourceCountryId: source.id, sourceTemplateVersionId: template.id, activatedAt: null,
        version: 1, createdAt: nowIso(), updatedAt: nowIso(),
      }
      db.countries.push(country)
      const job = {
        id: nextId(), sourceCountryId: source.id, templateId: template.id, targetCountryId: country.id, status: 'DRAFT',
        selectedItemIds: template.items.filter((i: Row) => !i.sensitive).map((i: Row) => i.id),
        createdBy: ctx.user.id, createdAt: nowIso(), appliedAt: null,
      }
      db.cloneJobs.push(job)
      audit(ctx, '创建国家草稿', 'country', country.id, null, { code, templateVersion: template.versionNo })
      return jobView(job)
    }),
  ),
  http.get(
    `${API}/sys/country-clone-jobs/:id/preview`,
    handle((ctx, { params }) => {
      requirePerm(ctx, 'sys:country:create')
      const job = getJob(Number(params.id))
      const template = getDb().templates.find((t) => t.id === job.templateId)!
      const copyList = template.items.filter((i: Row) => job.selectedItemIds.includes(i.id))
      const excluded = template.items
        .filter((i: Row) => !job.selectedItemIds.includes(i.id))
        .map((i: Row) => ({ ...i, reason: i.sensitive ? '敏感数据，系统禁止复制' : '未勾选' }))
      return { copyList, excluded, missing: computeMissing(job.targetCountryId) }
    }),
  ),
  http.get(
    `${API}/sys/country-clone-jobs/:id`,
    handle((ctx, { params }) => {
      requirePerm(ctx, 'sys:country:create')
      return jobView(getJob(Number(params.id)))
    }),
  ),
  http.put(
    `${API}/sys/country-clone-jobs/:id/items`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, 'sys:country:create')
      const job = getJob(Number(params.id))
      if (job.status !== 'DRAFT') throw new MockError(409, 'SYS_STATE_INVALID', '配置草稿已生成，不能再修改勾选项')
      const template = getDb().templates.find((t) => t.id === job.templateId)!
      const ids: number[] = body?.itemIds ?? []
      const sensitive = template.items.filter((i: Row) => i.sensitive && ids.includes(i.id))
      if (sensitive.length) throw new MockError(400, 'SYS_SENSITIVE_ITEM', `敏感项不能复制：${sensitive.map((i: Row) => i.label).join('、')}`)
      job.selectedItemIds = ids
      return jobView(job)
    }),
  ),
  http.post(
    `${API}/sys/country-clone-jobs/:id/org`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, 'sys:country:create')
      const db = getDb()
      const job = getJob(Number(params.id))
      const countryId = job.targetCountryId
      const stamp = { status: 'ENABLED', version: 1, createdAt: nowIso(), updatedAt: nowIso(), countryId }
      const upsert = (list: Row[], data: Row | undefined, extra: Row = {}, same: (r: Row) => boolean = () => true) => {
        if (!data?.code) return null
        const dup = list.find((r) => r.countryId !== countryId && r.code === data.code)
        if (dup) throw new MockError(409, 'MD_DUPLICATE', `编码 ${data.code} 已被其他国家使用`)
        let row = list.find((r) => r.countryId === countryId && same(r))
        if (row) Object.assign(row, data, extra)
        else {
          row = { id: nextId(), ...stamp, ...data, ...extra }
          list.push(row)
        }
        return row
      }
      const entity = upsert(db.entities, body?.entity)
      if (!entity) throw new MockError(400, 'SYS_BAD_REQUEST', '请填写经营主体')
      upsert(db.warehouses, body?.warehouse, { entityId: entity.id, type: 'WAREHOUSE', storeId: null, timezone: '' }, (w) => w.type === 'WAREHOUSE')
      if (body?.store?.code) {
        const store = upsert(db.stores, body.store, { entityId: entity.id, timezone: '', openedAt: null })!
        const storeWh = db.warehouses.find((w) => w.storeId === store.id)
        if (!storeWh) {
          const wh = { id: nextId(), ...stamp, entityId: entity.id, code: `${store.code}-WH`, name: `${store.name}门店仓`, type: 'STORE', storeId: store.id, timezone: '', address: store.address ?? '' }
          db.warehouses.push(wh)
          store.defaultWarehouseId = wh.id
        }
      }
      if (body?.book?.code) {
        const book = db.books.find((b) => b.countryId === countryId)
        const currency = db.countries.find((c) => c.id === countryId)!.defaultCurrency
        if (book) Object.assign(book, body.book, { entityId: entity.id, baseCurrency: currency })
        else db.books.push({ id: nextId(), countryId, entityId: entity.id, baseCurrency: currency, status: 'ACTIVE', ...body.book })
      }
      audit(ctx, '初始化组织', 'country', countryId, null, body)
      return jobView(job)
    }),
  ),
  http.post(
    `${API}/sys/country-clone-jobs/:id/admin`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, 'sys:country:create')
      const db = getDb()
      const job = getJob(Number(params.id))
      const countryId = job.targetCountryId
      const userIds: number[] = body?.userIds ?? []
      if (!userIds.length) throw new MockError(400, 'SYS_BAD_REQUEST', '至少指定一名国家管理员')
      const role = ensureAdminRole(countryId)
      db.userRoles = db.userRoles.filter((ur) => !(ur.countryId === countryId && ur.roleId === role.id))
      for (const userId of userIds) {
        db.userRoles.push({ userId, roleId: role.id, countryId })
        if (!db.dataScopes.some((s) => s.userId === userId && s.countryId === countryId && s.scopeType === 'COUNTRY_ALL')) {
          db.dataScopes.push({ id: nextId(), userId, countryId, scopeType: 'COUNTRY_ALL', scopeRefId: null, grantedBy: ctx.user.id, effectiveFrom: nowIso() })
        }
      }
      audit(ctx, '指定国家管理员', 'country', countryId, null, { userIds })
      return jobView(job)
    }),
  ),
  http.post(
    `${API}/sys/country-clone-jobs/:id/apply`,
    handle((ctx, { params }) => {
      requirePerm(ctx, 'sys:country:create')
      const job = getJob(Number(params.id))
      applyJob(ctx, job)
      return jobView(job)
    }),
  ),

  // ---------- 模板升级 ----------
  http.get(
    `${API}/sys/template-upgrades`,
    handle((ctx) => {
      const countryId = Number(ctx.url.searchParams.get('countryId'))
      visibleCountry(ctx, countryId)
      return getDb().upgrades.filter((u) => u.countryId === countryId).sort((a, b) => b.id - a.id)
    }),
  ),
  http.post(
    `${API}/sys/template-upgrades`,
    handle((ctx, { body }) => {
      requirePerm(ctx, ['sys:template:upgrade', 'sys:country:create'])
      const db = getDb()
      const country = visibleCountry(ctx, Number(body?.countryId))
      const from = db.templates.find((t) => t.id === country.sourceTemplateVersionId)
      if (!from) throw new MockError(400, 'SYS_BAD_REQUEST', '这个国家不是从模板复制的，无需升级')
      const to = db.templates.find((t) => t.id === Number(body?.toTemplateId))
      if (!to || to.status !== 'PUBLISHED' || to.sourceCountryId !== from.sourceCountryId || to.versionNo <= from.versionNo) {
        throw new MockError(400, 'SYS_BAD_REQUEST', '请选择同一来源、版本更高的已发布模板')
      }
      const oldMap = new Map<string, Row>(from.items.map((i: Row) => [i.itemKey, i]))
      const newMap = new Map<string, Row>(to.items.map((i: Row) => [i.itemKey, i]))
      const diffs: Row[] = []
      for (const [key, item] of newMap) {
        if (item.sensitive) continue
        const old = oldMap.get(key)
        if (!old) diffs.push({ itemKey: key, label: item.label, changeType: 'ADDED', requiresReview: item.requiresReview, oldLabel: null })
        else if (old.label !== item.label || old.requiresReview !== item.requiresReview) {
          diffs.push({ itemKey: key, label: item.label, changeType: 'MODIFIED', requiresReview: item.requiresReview, oldLabel: old.label })
        }
      }
      for (const [key, item] of oldMap) {
        if (!newMap.has(key) && !item.sensitive) diffs.push({ itemKey: key, label: item.label, changeType: 'REMOVED', requiresReview: false, oldLabel: item.label })
      }
      const up = {
        id: nextId(), countryId: country.id, fromTemplateId: from.id, toTemplateId: to.id, fromVersionNo: from.versionNo,
        toVersionNo: to.versionNo, status: 'PREVIEWED', diffs, createdBy: ctx.user.displayName, createdAt: nowIso(), confirmedAt: null,
      }
      db.upgrades.push(up)
      return up
    }),
  ),
  http.post(
    `${API}/sys/template-upgrades/:id/confirm`,
    handle((ctx, { params }) => {
      requirePerm(ctx, ['sys:template:upgrade', 'sys:country:create'])
      const db = getDb()
      const up = db.upgrades.find((u) => u.id === Number(params.id))
      if (!up) notFound()
      const country = visibleCountry(ctx, up.countryId)
      if (up.status !== 'PREVIEWED') throw new MockError(409, 'SYS_STATE_INVALID', '这次升级已经处理过')
      if (country.sourceTemplateVersionId !== up.fromTemplateId) throw new MockError(409, 'SYS_STATE_INVALID', '国家当前模板版本已变化，请重新生成预览')
      const template = db.templates.find((t) => t.id === up.toTemplateId)!
      if (up.diffs.some((d: Row) => d.itemKey === 'expense-items' && d.changeType === 'ADDED') &&
        !db.expenseItems.some((e) => e.countryId === country.id)) {
        for (const e of db.expenseItems.filter((x) => x.countryId === template.sourceCountryId)) {
          db.expenseItems.push({ ...e, id: nextId(), countryId: country.id, version: 1, createdAt: nowIso(), updatedAt: nowIso() })
        }
      }
      for (const d of up.diffs.filter((x: Row) => x.requiresReview && x.changeType !== 'REMOVED')) {
        db.reviews.push({
          id: nextId(), countryId: country.id, itemKey: d.itemKey, label: d.label, source: `升级到模板 v${up.toVersionNo}`,
          status: 'NEED_REVIEW', reviewedBy: null, reviewedAt: null, comment: '',
        })
      }
      country.sourceTemplateVersionId = up.toTemplateId
      up.status = 'CONFIRMED'
      up.confirmedAt = nowIso()
      audit(ctx, '模板升级', 'country', country.id, { templateVersion: up.fromVersionNo }, { templateVersion: up.toVersionNo })
      return up
    }),
  ),
]
