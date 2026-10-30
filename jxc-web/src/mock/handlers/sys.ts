/* eslint-disable @typescript-eslint/no-explicit-any */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, crud, findOr404 } from '../crud'
import { PERMISSION_TREE } from '../permissions'
import { computeMissing } from './country'
import { runPeriodic } from '../services/common'
import { readableBusinessFields, readableSalesOrder, requireDocumentAccess } from '../services/access'
import {
  FIELD_GROUPS,
  MockError,
  audit,
  handle,
  hasPerm,
  matchKeyword,
  notFound,
  paginate,
  permMatch,
  requireCountry,
  requirePerm,
  userPerms,
  userFieldGroups,
  scopeOf,
  type Ctx,
} from '../utils'

const FIELD_GROUP_NAMES: Record<string, string> = {
  COST: '成本',
  CUSTOMER_PRICE: '客户价格',
  ORDER_TOTAL: '订单金额',
  BANK_INFO: '银行信息',
  PROFIT: '利润',
  CREDIT: '授信额度',
}

function countryParam(ctx: Ctx) {
  const v = ctx.url.searchParams.get('countryId')
  const current = requireCountry(ctx)
  if (v && Number(v) !== current) throw new MockError(403, 'SYS_FORBIDDEN', '只能管理当前国家的授权')
  return current
}

function manageableUser(row: Row, ctx: Ctx) {
  if (ctx.countryId == null) return false
  if (ctx.user.isPlatformAdmin) return true
  return !row.isPlatformAdmin && (row.createdCountryId === ctx.countryId || getDb().userRoles.some((ur) => ur.userId === row.id && ur.countryId === ctx.countryId))
}

function managedUser(ctx: Ctx, userId: number, accountWrite = false) {
  const row = getDb().users.find((u) => u.id === userId)
  if (!row || !manageableUser(row, ctx)) notFound()
  if (accountWrite && !ctx.user.isPlatformAdmin && getDb().userRoles.some((ur) => ur.userId === userId && ur.countryId !== ctx.countryId)) {
    throw new MockError(403, 'SYS_FORBIDDEN', '跨国家共享账号的资料、状态和密码需由平台管理员维护')
  }
  return row
}

function assertGrantCeiling(ctx: Ctx, permissions: string[], fieldPolicies: Row = {}) {
  const own = userPerms(ctx.user, ctx.countryId)
  if (permissions.some((p) => typeof p !== 'string' || !permMatch(own, p))) throw new MockError(403, 'SYS_FORBIDDEN', '不能授予超出自身权限的角色或权限点')
  const ownFields = userFieldGroups(ctx.user, ctx.countryId)
  const ranks: Record<string, number> = { HIDDEN: 0, READ: 1, WRITE: 2 }
  for (const [group, access] of Object.entries(fieldPolicies)) {
    if (!FIELD_GROUPS.includes(group) || ranks[String(access)] == null) throw new MockError(400, 'SYS_BAD_REQUEST', '字段权限值不合法')
    if (ranks[String(access)]! > ranks[ownFields[group] ?? 'HIDDEN']!) throw new MockError(403, 'SYS_FORBIDDEN', '不能授予超出自身可见性的字段权限')
  }
}

function grantCovers(ctx: Ctx, source: Row, target: Row) {
  const db = getDb()
  if (source.scopeType === 'COUNTRY_ALL') return true
  if (source.scopeType === target.scopeType && source.scopeRefId === target.scopeRefId) return true
  if (source.scopeType === 'ENTITY') {
    const refs: Record<string, Row[]> = { STORE: db.stores, WAREHOUSE: db.warehouses, BOOK: db.books }
    return refs[target.scopeType]?.some((r) => r.id === target.scopeRefId && r.countryId === ctx.countryId && r.entityId === source.scopeRefId) ?? false
  }
  return source.scopeType === 'STORE' && target.scopeType === 'WAREHOUSE' && db.warehouses.some((w) => w.id === target.scopeRefId && w.countryId === ctx.countryId && w.storeId === source.scopeRefId)
}

// ---------- 用户 ----------

const users = crud('/sys/users', 'users', {
  countryScoped: false,
  viewPerm: 'sys:user:edit',
  editPerm: 'sys:user:edit',
  unique: ['username'],
  keywordKeys: ['username', 'displayName', 'phone', 'email'],
  auditType: 'user',
  canAccess: manageableUser,
  beforeCreate: (row, ctx) => {
    row.createdCountryId = requireCountry(ctx)
    row.password = row.password || '123456'
    row.isPlatformAdmin = false
    row.locale ??= 'zh-CN'
  },
  beforeUpdate: (row, body, ctx) => {
    managedUser(ctx, row.id, true)
    delete body.password
    delete body.isPlatformAdmin
    delete body.username
    delete body.createdCountryId
  },
  beforeToggle: (row, ctx) => { managedUser(ctx, row.id, true) },
  out: (r, ctx) => {
    const db = getDb()
    const roleIds = db.userRoles.filter((ur) => ur.userId === r.id && ur.countryId === ctx.countryId).map((ur) => ur.roleId)
    const scopes = db.dataScopes.filter((s) => s.userId === r.id && s.countryId === ctx.countryId)
    const { password: _p, ...rest } = r
    return {
      ...rest,
      roleNames: db.roles.filter((x) => roleIds.includes(x.id)).map((x) => x.name),
      scopeText: scopes.map((s) => scopeLabel(s)).join('、'),
    }
  },
})

function scopeLabel(s: Row) {
  const db = getDb()
  if (s.scopeType === 'COUNTRY_ALL') return '本国全部'
  if (s.scopeType === 'STORE') return `门店：${db.stores.find((x) => x.id === s.scopeRefId)?.name ?? s.scopeRefId}`
  if (s.scopeType === 'WAREHOUSE') return `仓库：${db.warehouses.find((x) => x.id === s.scopeRefId)?.name ?? s.scopeRefId}`
  if (s.scopeType === 'ENTITY') return `主体：${db.entities.find((x) => x.id === s.scopeRefId)?.name ?? s.scopeRefId}`
  if (s.scopeType === 'BOOK') return `账套：${db.books.find((x) => x.id === s.scopeRefId)?.name ?? s.scopeRefId}`
  return s.scopeType
}

function validateRoleGrant(ctx: Ctx, countryId: number, roleIds: number[]) {
  const db = getDb()
      if (roleIds.some((id) => !db.roles.some((r) => r.id === id && r.countryId === countryId))) {
        throw new MockError(400, 'SYS_BAD_REQUEST', '只能分配本国的角色')
      }
      for (const role of db.roles.filter((r) => roleIds.includes(r.id))) assertGrantCeiling(ctx, role.permissions ?? [], role.fieldPolicies)
}
function validateScopeGrant(ctx: Ctx, countryId: number, scopes: Row[]) {
  const db = getDb()
      const ownScope = scopeOf(ctx)
      for (const s of scopes) {
        const refs: Record<string, Row[]> = { STORE: db.stores, WAREHOUSE: db.warehouses, ENTITY: db.entities, BOOK: db.books }
        if (s.scopeType !== 'COUNTRY_ALL' && !refs[s.scopeType]) throw new MockError(400, 'SYS_BAD_REQUEST', '不支持的数据范围类型')
        if (s.scopeType !== 'COUNTRY_ALL' && !refs[s.scopeType]!.some((x) => x.id === s.scopeRefId && x.countryId === countryId)) throw new MockError(400, 'SYS_BAD_REQUEST', '数据范围不属于该国家')
        for (const key of ['effectiveFrom', 'effectiveTo']) if (s[key] && !Number.isFinite(Date.parse(s[key]))) throw new MockError(400, 'SYS_BAD_REQUEST', '授权有效期不合法')
        if (s.effectiveFrom && s.effectiveTo && Date.parse(s.effectiveFrom) >= Date.parse(s.effectiveTo)) throw new MockError(400, 'SYS_BAD_REQUEST', '授权结束时间必须晚于开始时间')
        const ownIds: Record<string, number[]> = { STORE: ownScope.stores, WAREHOUSE: ownScope.warehouses, ENTITY: ownScope.entities, BOOK: ownScope.books }
        if (!ownScope.all && (s.scopeType === 'COUNTRY_ALL' || !ownIds[s.scopeType]?.includes(s.scopeRefId))) throw new MockError(403, 'SYS_FORBIDDEN', '不能授予超出自身的数据范围')
        const start = s.effectiveFrom ? Date.parse(s.effectiveFrom) : Date.now()
        const end = s.effectiveTo ? Date.parse(s.effectiveTo) : Infinity
        const bounded = db.dataScopes.some((own) => own.userId === ctx.user.id && own.countryId === countryId && grantCovers(ctx, own, s) &&
          (!own.effectiveFrom || Date.parse(own.effectiveFrom) <= start) && (!own.effectiveTo || Date.parse(own.effectiveTo) >= end))
        if (!bounded) throw new MockError(403, 'SYS_FORBIDDEN', '授权期限不能超出自己的有效授权期限')
      }
}
function replaceRoles(countryId: number, userId: number, roleIds: number[]) {
  const db = getDb()
      db.userRoles = db.userRoles.filter((ur) => !(ur.userId === userId && ur.countryId === countryId))
      for (const roleId of roleIds) db.userRoles.push({ userId, roleId, countryId })
}
function replaceScopes(ctx: Ctx, countryId: number, userId: number, scopes: Row[]) {
  const db = getDb()
      db.dataScopes = db.dataScopes.filter((s) => !(s.userId === userId && s.countryId === countryId))
      for (const s of scopes) {
        db.dataScopes.push({
          id: nextId(), userId, countryId, scopeType: s.scopeType, scopeRefId: s.scopeType === 'COUNTRY_ALL' ? null : s.scopeRefId,
          grantedBy: ctx.user.id, effectiveFrom: s.effectiveFrom || nowIso(), effectiveTo: s.effectiveTo || null,
        })
      }
}

const userExtras = [
  http.get(`${API}/sys/user-options`, handle((ctx) => {
    requirePerm(ctx, ['sys:user:edit', 'wf:rule:edit', 'sys:watcher:edit', 'org:store:edit'])
    return getDb().users.filter((u) => u.status === 'ENABLED' && manageableUser(u, ctx)).map((u) => ({ id: u.id, username: u.username, displayName: u.displayName }))
  })),
  http.put(`${API}/sys/users/:id/grants`, handle((ctx, { params, body }) => {
    requirePerm(ctx, 'sys:user:edit')
    const db = getDb(), countryId = countryParam(ctx), userId = Number(params.id), user = managedUser(ctx, userId)
    if (body?.version !== user.version) throw new MockError(409, 'SYS_VERSION_CONFLICT', '授权已被他人修改，请刷新')
    const roleIds: number[] = body?.roleIds ?? [], scopes: Row[] = body?.dataScopes ?? []
    validateRoleGrant(ctx, countryId, roleIds)
    validateScopeGrant(ctx, countryId, scopes)
    const before = { roleIds: db.userRoles.filter((r) => r.countryId === countryId && r.userId === userId).map((r) => r.roleId), dataScopes: db.dataScopes.filter((r) => r.countryId === countryId && r.userId === userId) }
    replaceRoles(countryId, userId, roleIds)
    replaceScopes(ctx, countryId, userId, scopes)
    user.version += 1
    audit(ctx, '设置授权', 'user', userId, before, { roleIds, dataScopes: scopes })
    return { roleIds, dataScopes: scopes, version: user.version }
  })),
  http.get(
    `${API}/sys/users/:id/grants`,
    handle((ctx, { params }) => {
      requirePerm(ctx, 'sys:user:edit')
      const db = getDb()
      const countryId = countryParam(ctx)
      const userId = Number(params.id)
      managedUser(ctx, userId)
      return {
        version: managedUser(ctx, userId).version,
        roleIds: db.userRoles.filter((ur) => ur.userId === userId && ur.countryId === countryId).map((ur) => ur.roleId),
        dataScopes: db.dataScopes
          .filter((s) => s.userId === userId && s.countryId === countryId)
          .map((s) => ({ scopeType: s.scopeType, scopeRefId: s.scopeRefId, effectiveFrom: s.effectiveFrom, effectiveTo: s.effectiveTo })),
      }
    }),
  ),
  http.put(
    `${API}/sys/users/:id/roles`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, 'sys:user:edit')
      const db = getDb()
      const countryId = countryParam(ctx)
      const userId = Number(params.id)
      managedUser(ctx, userId)
      const roleIds: number[] = body?.roleIds ?? []
      validateRoleGrant(ctx, countryId, roleIds)
      const before = db.userRoles.filter((ur) => ur.userId === userId && ur.countryId === countryId).map((ur) => ur.roleId)
      replaceRoles(countryId, userId, roleIds)
      audit(ctx, '设置角色', 'user', userId, { roleIds: before }, { roleIds })
      return { roleIds }
    }),
  ),
  http.put(
    `${API}/sys/users/:id/data-scopes`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, 'sys:user:edit')
      const db = getDb()
      const countryId = countryParam(ctx)
      const userId = Number(params.id)
      managedUser(ctx, userId)
      const scopes: Row[] = body?.dataScopes ?? []
      validateScopeGrant(ctx, countryId, scopes)
      const before = db.dataScopes.filter((s) => s.userId === userId && s.countryId === countryId).map(scopeLabel)
      replaceScopes(ctx, countryId, userId, scopes)
      audit(ctx, '设置数据范围', 'user', userId, { dataScopes: before }, { dataScopes: scopes.map(scopeLabel) })
      return { dataScopes: scopes }
    }),
  ),
  http.post(
    `${API}/sys/users/:id/reset-password`,
    handle((ctx, { params }) => {
      requirePerm(ctx, 'sys:user:edit')
      const user = managedUser(ctx, Number(params.id), true)
      const password = `Tmp${Math.random().toString().slice(2, 8)}`
      user.password = password
      const db = getDb()
      for (const [token, uid] of Object.entries(db.sessions)) if (uid === user.id) delete db.sessions[token]
      audit(ctx, '重置密码', 'user', user.id, null, null)
      return { password }
    }),
  ),
]

// ---------- 角色 ----------

const roles = crud('/sys/roles', 'roles', {
  viewPerm: ['sys:role:edit', 'sys:user:edit'],
  editPerm: 'sys:role:edit',
  unique: ['code'],
  filterKeys: ['status', 'roleType'],
  auditType: 'role',
  beforeCreate: (row, ctx) => {
    row.permissions ??= []
    row.fieldPolicies ??= {}
    row.isTemplate ??= false
    assertGrantCeiling(ctx, row.permissions, row.fieldPolicies)
  },
  beforeUpdate: (row, body, ctx) => {
    assertGrantCeiling(ctx, row.permissions ?? [], row.fieldPolicies)
    delete body.permissions
    delete body.fieldPolicies
    if (row.code === 'SUPER' && body.code && body.code !== 'SUPER') throw new MockError(400, 'SYS_BAD_REQUEST', '演示超级管理员的编码不能修改')
  },
  beforeToggle: (row, ctx) => { assertGrantCeiling(ctx, row.permissions ?? [], row.fieldPolicies) },
  out: (r) => ({ ...r, userCount: getDb().userRoles.filter((ur) => ur.roleId === r.id).length }),
})

const roleExtras = [
  http.put(
    `${API}/sys/roles/:id/permissions`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, 'sys:role:edit')
      const role = findOr404(ctx, 'roles', Number(params.id))
      assertGrantCeiling(ctx, role.permissions ?? [], role.fieldPolicies)
      assertGrantCeiling(ctx, body?.permissions ?? [])
      if (role.permissions.includes('*')) throw new MockError(400, 'SYS_BAD_REQUEST', '演示超级管理员拥有全部权限，不能修改')
      const before = [...role.permissions]
      role.permissions = body?.permissions ?? []
      role.version += 1
      audit(ctx, '设置权限', 'role', role.id, { permissions: before }, { permissions: role.permissions })
      return role
    }),
  ),
  http.put(
    `${API}/sys/roles/:id/field-policies`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, 'sys:role:edit')
      const role = findOr404(ctx, 'roles', Number(params.id))
      assertGrantCeiling(ctx, role.permissions ?? [], role.fieldPolicies)
      const before = { ...role.fieldPolicies }
      const next: Record<string, string> = {}
      for (const g of FIELD_GROUPS) next[g] = body?.fieldPolicies?.[g] ?? 'HIDDEN'
      assertGrantCeiling(ctx, [], next)
      role.fieldPolicies = next
      role.version += 1
      audit(ctx, '设置字段权限', 'role', role.id, before, next)
      return role
    }),
  ),
]

const permissionTree = http.get(
  `${API}/sys/permissions/tree`,
  handle(() => ({
    tree: PERMISSION_TREE,
    fieldGroups: FIELD_GROUPS.map((code) => ({ code, name: FIELD_GROUP_NAMES[code] })),
  })),
)

// ---------- 看单与抄送 ----------

const watchers = crud('/sys/doc-watchers', 'docWatchers', {
  viewPerm: 'sys:watcher:edit',
  editPerm: 'sys:watcher:edit',
  keywordKeys: ['docType'],
  filterKeys: ['status', 'watchType', 'docType', 'userId'],
  auditType: 'doc-watcher',
  out: (r) => {
    const db = getDb()
    return {
      ...r,
      userName: db.users.find((u) => u.id === r.userId)?.displayName ?? '',
      warehouseName: db.warehouses.find((w) => w.id === r.warehouseId)?.name ?? '',
    }
  },
})

// ---------- 审计日志 ----------

const auditLogs = http.get(
  `${API}/sys/audit-logs`,
  handle((ctx) => {
    const sp = ctx.url.searchParams
    const resourceType = sp.get('resourceType')
    const resourceId = sp.get('resourceId')
    const docTypes: Record<string, string> = { 'sales-order': 'SAL_ORDER', 'sal-order': 'SAL_ORDER', 'sales-outbound': 'SAL_OUTBOUND', outbound: 'SAL_OUTBOUND', 'purchase-order': 'PURCHASE_ORDER', 'domestic-receipt': 'DOMESTIC_RECEIPT', 'export-node': 'EXPORT_NODE', shipment: 'SHIPMENT', 'lgs-receipt': 'LGS_RECEIPT', transfer: 'TRANSFER', stocktake: 'STOCKTAKE', 'ar-receipt': 'AR_RECEIPT', 'ar-writeoff': 'AR_WRITEOFF', 'ap-bill': 'AP_BILL', 'ap-payment': 'AP_PAYMENT', 'ap-settlement': 'AP_SETTLEMENT', 'sales-return': 'SALES_RETURN', refund: 'REFUND', 'purchase-return': 'PURCHASE_RETURN' }
    let source: Row | null = null
    if (resourceType && resourceId && docTypes[resourceType]) source = requireDocumentAccess(ctx, docTypes[resourceType]!, resourceId)
    else requirePerm(ctx, 'sys:audit:view')
    const from = sp.get('from')
    const to = sp.get('to')
    const list = getDb()
      .auditLogs.filter((l) => l.countryId === ctx.countryId || (l.countryId == null && ctx.user.isPlatformAdmin))
      .filter((l) => !resourceType || l.resourceType === resourceType)
      .filter((l) => !resourceId || l.resourceId === Number(resourceId))
      .filter((l) => !sp.get('userId') || l.userId === Number(sp.get('userId')))
      .filter((l) => !sp.get('action') || l.action === sp.get('action'))
      .filter((l) => !from || l.occurredAt.slice(0, 10) >= from)
      .filter((l) => !to || l.occurredAt.slice(0, 10) <= to)
      .filter((l) => matchKeyword(l, sp.get('keyword'), ['action', 'resourceType', 'userName', 'reason']))
      .filter((l) => {
        if (source || !docTypes[l.resourceType]) return true
        try { requireDocumentAccess(ctx, docTypes[l.resourceType]!, l.resourceId); return true } catch { return false }
      })
      .map((l) => {
        const out = readableBusinessFields(ctx, l, { amountGroup: /^(purchase|domestic|export|ap-|lgs-|shipment)/.test(l.resourceType) ? 'COST' : 'ORDER_TOTAL' })
        if (source && ['SAL_ORDER', 'SALES_ORDER'].includes(docTypes[resourceType!]!)) {
          const visible = readableSalesOrder(ctx, source)
          if (visible.partialScope) for (const key of ['beforeValue', 'afterValue']) {
            if (out[key]?.lines) out[key].lines = out[key].lines.filter((line: Row) => visible.lines.some((v: Row) => v.id === line.id))
          }
        }
        return out
      })
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    return paginate(list, ctx.url)
  }),
)

// ---------- 附件 ----------

/** 文件内容只保存在内存里，刷新页面后无法再打开（元数据仍保留在演示库中） */
const files = new Map<number, Blob>()

const attachmentHandlers = [
  http.get(
    `${API}/sys/attachments/:id/url`,
    handle((ctx, { params }) => {
      const a = getDb().attachments.find((x) => x.id === Number(params.id) && x.countryId === ctx.countryId)
      if (!a) notFound()
      requireDocumentAccess(ctx, a.bizType, a.bizId)
      const blob = files.get(a.id)
      if (!blob) throw new MockError(410, 'SYS_FILE_EXPIRED', '演示环境的文件只在当前页面会话内保留，请重新上传')
      return { url: URL.createObjectURL(blob), expiresIn: 300 }
    }),
  ),
  http.get(
    `${API}/sys/attachments`,
    handle((ctx) => {
      const sp = ctx.url.searchParams
      requireDocumentAccess(ctx, String(sp.get('bizType')), String(sp.get('bizId')))
      return getDb()
        .attachments.filter((a) => a.countryId === ctx.countryId && a.status === 'ACTIVE')
        .filter((a) => a.bizType === sp.get('bizType') && String(a.bizId) === sp.get('bizId'))
        .filter((a) => !sp.get('category') || a.category === sp.get('category'))
        .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    }),
  ),
  http.post(
    `${API}/sys/attachments`,
    handle((ctx, { body }) => {
      const countryId = requireCountry(ctx)
      const form = body as FormData
      const file = form.get('file') as File | null
      if (!file) throw new MockError(400, 'SYS_BAD_REQUEST', '请选择文件')
      if (file.size > 20 * 1024 * 1024) throw new MockError(400, 'SYS_FILE_TOO_LARGE', '单个文件不能超过 20MB')
      const db = getDb()
      const bizType = String(form.get('bizType'))
      const bizId = String(form.get('bizId'))
      const category = String(form.get('category') ?? 'OTHER')
      requireDocumentAccess(ctx, bizType, bizId, true)
      const versionNo = db.attachments.filter((a) => a.countryId === countryId && a.bizType === bizType && String(a.bizId) === bizId && a.category === category).length + 1
      const row = {
        id: nextId(), countryId, bizType, bizId, category, fileName: file.name, size: file.size, contentType: file.type,
        uploadedBy: ctx.user.id, uploadedByName: ctx.user.displayName, uploadedAt: nowIso(), versionNo, status: 'ACTIVE',
      }
      db.attachments.push(row)
      files.set(row.id, file)
      audit(ctx, '上传附件', bizType, Number(bizId) || 0, null, { fileName: file.name, category, versionNo })
      return row
    }),
  ),
  http.post(
    `${API}/sys/attachments/:id/unlink`,
    handle((ctx, { params, body }) => {
      const a = getDb().attachments.find((x) => x.id === Number(params.id) && x.countryId === ctx.countryId)
      if (!a) notFound()
      requireDocumentAccess(ctx, a.bizType, a.bizId, true)
      a.status = 'UNLINKED'
      audit(ctx, '解除附件', a.bizType, Number(a.bizId) || 0, { fileName: a.fileName }, null, body?.reason)
      return a
    }),
  ),
]

// ---------- 工作台、待办、通知 ----------

const TODO_LABELS: Record<string, string> = {
  APPROVAL: '待我审批',
  CONFIG_MISSING: '国家配置缺项',
  PENDING_PAYMENT_CONFIRM: '待确认到账',
  PENDING_OUTBOUND: '待出库',
  OUTBOUND_BLOCKED: '出库被拦截',
  PENDING_RECEIPT: '待实收',
  PENDING_DISPATCH: '待发运',
  LOGISTICS_DELAY: '物流延误',
  HOLD_REVIEW: '暂缓待复查',
  DISCREPANCY_OPEN: '到货差异待处理',
  PENDING_COST_RATE: '成本待补汇率',
  OVERDUE_FOLLOWUP: '逾期待跟进',
  STOCK_ALERT: '库存预警',
  PENDING_VOUCHER_AUDIT: '待审凭证',
}

function visibleTodos(ctx: Ctx) {
  const perms = userPerms(ctx.user, ctx.countryId)
  return getDb().todos.filter(
    (t) => t.countryId === ctx.countryId && t.status === 'OPEN' && (!t.perm || permMatch(perms, t.perm)) && (!t.assigneeId || t.assigneeId === ctx.user.id),
  )
}

function pendingApprovals(ctx: Ctx) {
  const db = getDb()
  return db.approvalTasks.filter((t) => {
    if (t.assigneeId !== ctx.user.id || t.status !== 'PENDING') return false
    const inst = db.approvalInstances.find((i) => i.id === t.instanceId)
    return inst?.countryId === ctx.countryId && inst.status === 'PENDING'
  })
}

const workbenchHandlers = [
  http.get(
    `${API}/sys/workbench/summary`,
    handle((ctx) => {
      if (ctx.countryId == null) return { items: [], unreadNotifications: 0 }
      runPeriodic(ctx.countryId)
      const items: { type: string; label: string; count: number; link: string }[] = []
      const approvals = pendingApprovals(ctx).length
      if (approvals) items.push({ type: 'APPROVAL', label: TODO_LABELS.APPROVAL, count: approvals, link: '/approval/todo' })
      if (hasPerm(ctx, 'sys:country:view')) {
        const blocks = computeMissing(ctx.countryId).filter((m) => m.level === 'BLOCK').length
        if (blocks) items.push({ type: 'CONFIG_MISSING', label: TODO_LABELS.CONFIG_MISSING, count: blocks, link: `/settings/countries/${ctx.countryId}` })
      }
      const groups = new Map<string, Row[]>()
      for (const t of visibleTodos(ctx)) groups.set(t.todoType, [...(groups.get(t.todoType) ?? []), t])
      for (const [type, list] of groups) items.push({ type, label: TODO_LABELS[type] ?? type, count: list.length, link: list[0].link })
      const unreadNotifications = getDb().notifications.filter(
        (n) => n.userId === ctx.user.id && (n.countryId === ctx.countryId || n.countryId == null) && !n.readAt,
      ).length
      return { items, unreadNotifications }
    }),
  ),
  http.get(
    `${API}/sys/todos`,
    handle((ctx) => {
      runPeriodic(requireCountry(ctx))
      const type = ctx.url.searchParams.get('type')
      const keyword = ctx.url.searchParams.get('keyword')?.trim().toLowerCase()
      const order = ctx.url.searchParams.get('order') ?? 'desc'
      if (order !== 'asc' && order !== 'desc') throw new MockError(400, 'SYS_BAD_REQUEST', '待办排序参数不合法')
      const list = visibleTodos(ctx)
        .filter((t) => !type || t.todoType === type)
        .filter((t) => !keyword || t.title.toLowerCase().includes(keyword) || String(t.id).includes(keyword))
        .map((t): Row => ({ ...t, typeLabel: TODO_LABELS[t.todoType] ?? t.todoType }))
        .sort((a, b) => (order === 'asc' ? 1 : -1) * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()))
      return paginate(list, ctx.url)
    }),
  ),
  http.get(
    `${API}/sys/notifications`,
    handle((ctx) => {
      const unread = ctx.url.searchParams.get('unread') === 'true'
      const list = getDb()
        .notifications.filter((n) => n.userId === ctx.user.id && (n.countryId === ctx.countryId || n.countryId == null))
        .filter((n) => !unread || !n.readAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return paginate(list, ctx.url)
    }),
  ),
  http.post(
    `${API}/sys/notifications/read-all`,
    handle((ctx) => {
      for (const n of getDb().notifications) {
        if (n.userId === ctx.user.id && (n.countryId === ctx.countryId || n.countryId == null) && !n.readAt) n.readAt = nowIso()
      }
    }),
  ),
  http.post(
    `${API}/sys/notifications/:id/read`,
    handle((ctx, { params }) => {
      const n = getDb().notifications.find((x) => x.id === Number(params.id) && x.userId === ctx.user.id)
      if (!n) notFound()
      n.readAt ??= nowIso()
      return n
    }),
  ),
]

/** 选人下拉：当前国家内启用的用户，只返回 id 与姓名，供责任人、负责人字段使用 */
const userOptions = http.get(`${API}/sys/user-options`, handle((ctx) => {
  const countryId = requireCountry(ctx)
  const db = getDb()
  const ids = new Set(db.userRoles.filter((ur) => ur.countryId === countryId).map((ur) => ur.userId))
  const records = db.users.filter((u) => ids.has(u.id) && u.status === 'ENABLED').map((u) => ({ id: u.id, displayName: u.displayName }))
  return paginate(records, ctx.url)
}))

export const sysHandlers = [
  userOptions,
  ...users.handlers(userExtras),
  ...roles.handlers(roleExtras),
  permissionTree,
  ...watchers.handlers(),
  auditLogs,
  ...attachmentHandlers,
  ...workbenchHandlers,
]
