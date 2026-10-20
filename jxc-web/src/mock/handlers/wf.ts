/* eslint-disable @typescript-eslint/no-explicit-any */
import { http } from 'msw'
import { getDb, nextId, nowIso, type Row } from '../db'
import { API, findOr404 } from '../crud'
import { MockError, audit, checkVersion, handle, matchKeyword, notFound, paginate, requireCountry, requirePerm, type Ctx } from '../utils'
import { approvalHook } from '../services/approval'

const userName = (id: unknown) => getDb().users.find((u) => u.id === id)?.displayName ?? ''

function validateRule(body: Row) {
  if (!body?.name || !body?.docType) throw new MockError(400, 'SYS_BAD_REQUEST', '请填写规则名称和单据类型')
  const nodes: Row[] = body.nodes ?? []
  if (!nodes.length) throw new MockError(400, 'SYS_BAD_REQUEST', '至少需要一个审批节点')
  nodes.forEach((n, i) => {
    if (!n.nodeName || !n.approverRef) throw new MockError(400, 'SYS_BAD_REQUEST', `第 ${i + 1} 个节点缺少名称或审批人`)
    n.seq = i + 1
  })
}

/** 按角色编码或用户 ID 找到节点审批人 */
function resolveApprovers(countryId: number, node: Row): number[] {
  const db = getDb()
  if (node.approverType === 'USER') return [Number(node.approverRef)]
  const roleIds = db.roles.filter((r) => r.countryId === countryId && r.code === node.approverRef).map((r) => r.id)
  return [...new Set(db.userRoles.filter((ur) => ur.countryId === countryId && roleIds.includes(ur.roleId)).map((ur) => ur.userId))]
}

function ruleOut(r: Row) {
  return { ...r, createdByName: userName(r.createdBy) }
}

const ruleHandlers = [
  http.get(
    `${API}/wf/rules`,
    handle((ctx) => {
      requirePerm(ctx, 'wf:rule:edit')
      const countryId = requireCountry(ctx)
      const sp = ctx.url.searchParams
      const status = sp.get('status')
      const list = getDb()
        .approvalRules.filter((r) => r.countryId === countryId)
        .filter((r) => (status ? r.status === status : r.status !== 'RETIRED'))
        .filter((r) => !sp.get('docType') || r.docType === sp.get('docType'))
        .filter((r) => matchKeyword(r, sp.get('keyword'), ['name', 'ruleKey']))
        .sort((a, b) => a.docType.localeCompare(b.docType) || a.priority - b.priority)
        .map(ruleOut)
      return paginate(list, ctx.url)
    }),
  ),
  http.get(
    `${API}/wf/rules/:id/versions`,
    handle((ctx, { params }) => {
      requirePerm(ctx, 'wf:rule:edit')
      const r = findOr404(ctx, 'approvalRules', Number(params.id))
      return getDb()
        .approvalRules.filter((x) => x.countryId === r.countryId && x.ruleKey === r.ruleKey)
        .sort((a, b) => b.versionNo - a.versionNo)
        .map((x) => ({
          ...ruleOut(x),
          instanceCount: getDb().approvalInstances.filter((i) => i.ruleId === x.id).length,
        }))
    }),
  ),
  http.get(
    `${API}/wf/rules/:id`,
    handle((ctx, { params }) => {
      requirePerm(ctx, 'wf:rule:edit')
      return ruleOut(findOr404(ctx, 'approvalRules', Number(params.id)))
    }),
  ),
  http.post(
    `${API}/wf/rules`,
    handle((ctx, { body }) => {
      requirePerm(ctx, 'wf:rule:edit')
      const countryId = requireCountry(ctx)
      validateRule(body)
      const id = nextId()
      const row = {
        ruleKey: `R-${id}`, priority: 100, conditions: [], effectiveFrom: nowIso().slice(0, 10), ...body,
        id, countryId, versionNo: 1, status: 'ACTIVE', version: 1, createdBy: ctx.user.id, createdAt: nowIso(), updatedAt: nowIso(),
      }
      getDb().approvalRules.unshift(row)
      audit(ctx, '新增', 'approval-rule', row.id, null, row)
      return ruleOut(row)
    }),
  ),
  /** 规则修改生成新版本；在途审批继续使用提交时的版本（docs/02 第 5.4 节） */
  http.put(
    `${API}/wf/rules/:id`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, 'wf:rule:edit')
      const db = getDb()
      const r = findOr404(ctx, 'approvalRules', Number(params.id))
      checkVersion(r, body)
      validateRule(body)
      const fields = ['name', 'docType', 'priority', 'conditions', 'nodes', 'effectiveFrom']
      if (r.status === 'DRAFT') {
        const before = structuredClone(r)
        for (const f of fields) if (body[f] !== undefined) r[f] = body[f]
        r.version += 1
        r.updatedAt = nowIso()
        audit(ctx, '修改', 'approval-rule', r.id, before, r)
        return ruleOut(r)
      }
      if (r.status === 'RETIRED') throw new MockError(409, 'SYS_STATE_INVALID', '历史版本不能修改，请编辑当前版本')
      const maxVersion = Math.max(...db.approvalRules.filter((x) => x.countryId === r.countryId && x.ruleKey === r.ruleKey).map((x) => x.versionNo))
      const next: Row = { ...structuredClone(r), id: nextId(), versionNo: maxVersion + 1, status: r.status, version: 1, createdBy: ctx.user.id, createdAt: nowIso(), updatedAt: nowIso() }
      for (const f of fields) if (body[f] !== undefined) next[f] = body[f]
      r.status = 'RETIRED'
      r.retiredAt = nowIso()
      db.approvalRules.unshift(next)
      const inflight = db.approvalInstances.filter((i) => i.ruleId === r.id && i.status === 'PENDING').length
      audit(ctx, '新版本', 'approval-rule', next.id, { versionNo: r.versionNo }, { versionNo: next.versionNo, inflightKeepOldVersion: inflight })
      return { ...ruleOut(next), inflight }
    }),
  ),
  ...(['disable', 'enable'] as const).map((action) =>
    http.post(
      `${API}/wf/rules/:id/${action}`,
      handle((ctx, { params }) => {
        requirePerm(ctx, 'wf:rule:edit')
        const r = findOr404(ctx, 'approvalRules', Number(params.id))
        if (r.status === 'RETIRED') throw new MockError(409, 'SYS_STATE_INVALID', '历史版本不能启停')
        const before = r.status
        r.status = action === 'disable' ? 'DISABLED' : 'ACTIVE'
        r.version += 1
        audit(ctx, action === 'disable' ? '停用' : '启用', 'approval-rule', r.id, { status: before }, { status: r.status })
        return ruleOut(r)
      }),
    ),
  ),
]

const docTypeHandlers = [
  http.get(
    `${API}/wf/doc-types`,
    handle((ctx) => {
      requirePerm(ctx, 'wf:rule:edit')
      const countryId = requireCountry(ctx)
      return getDb().docTypeConfigs.filter((d) => d.countryId === countryId)
    }),
  ),
  http.put(
    `${API}/wf/doc-types/:docType`,
    handle((ctx, { params, body }) => {
      requirePerm(ctx, 'wf:rule:edit')
      const countryId = requireCountry(ctx)
      const db = getDb()
      let cfg = db.docTypeConfigs.find((d) => d.countryId === countryId && d.docType === params.docType)
      const before = cfg ? structuredClone(cfg) : null
      if (!cfg) {
        cfg = { countryId, docType: params.docType, approvalRequired: false, keyFields: [] }
        db.docTypeConfigs.push(cfg)
      }
      if (body?.approvalRequired !== undefined) cfg.approvalRequired = !!body.approvalRequired
      if (body?.keyFields) cfg.keyFields = body.keyFields
      audit(ctx, '修改单据审批设置', 'doc-type', 0, before, cfg)
      return cfg
    }),
  ),
]

// ---------- 任务与实例 ----------

function taskView(t: Row) {
  const inst = getDb().approvalInstances.find((i) => i.id === t.instanceId)!
  return {
    id: t.id,
    instanceId: inst.id,
    nodeSeq: t.nodeSeq,
    nodeName: t.nodeName,
    status: t.status,
    comment: t.comment ?? '',
    actedAt: t.actedAt ?? null,
    docType: inst.docType,
    docId: inst.docId,
    docNo: inst.docNo,
    docTitle: inst.docTitle,
    amount: inst.amount,
    currency: inst.currency,
    ruleName: inst.ruleName,
    ruleVersionNo: inst.ruleVersionNo,
    instanceStatus: inst.status,
    invalidReason: inst.invalidReason ?? null,
    submittedByName: userName(inst.submittedBy),
    submittedAt: inst.submittedAt,
  }
}

function myTask(ctx: Ctx, id: number) {
  const db = getDb()
  const t = db.approvalTasks.find((x) => x.id === id && x.assigneeId === ctx.user.id)
  const inst = t && db.approvalInstances.find((i) => i.id === t.instanceId && i.countryId === ctx.countryId)
  if (!t || !inst) notFound()
  if (t.status !== 'PENDING' || inst.status !== 'PENDING') {
    throw new MockError(409, inst.status === 'INVALIDATED' ? 'WF_APPROVAL_INVALIDATED' : 'SYS_STATE_INVALID',
      inst.status === 'INVALIDATED' ? '单据关键字段已修改，原审批失效，需要重新提交' : '这条审批已处理')
  }
  return { t, inst }
}

function notify(userId: number, countryId: number, title: string, content: string, link: string) {
  getDb().notifications.push({ id: nextId(), userId, countryId, notifyType: 'APPROVAL_RESULT', title, content, link, readAt: null, createdAt: nowIso(), version: 1, updatedAt: nowIso() })
}

const taskHandlers = [
  http.get(
    `${API}/wf/tasks/mine`,
    handle((ctx) => {
      const countryId = requireCountry(ctx)
      const sp = ctx.url.searchParams
      const done = sp.get('mode') === 'done'
      const db = getDb()
      const list = db.approvalTasks
        .filter((t) => t.assigneeId === ctx.user.id)
        .filter((t) => {
          const inst = db.approvalInstances.find((i) => i.id === t.instanceId)
          if (inst?.countryId !== countryId) return false
          return done ? t.status !== 'PENDING' && t.status !== 'SKIPPED' : t.status === 'PENDING' && inst.status === 'PENDING'
        })
        .map(taskView)
        .filter((v) => !sp.get('docType') || v.docType === sp.get('docType'))
        .filter((v) => matchKeyword(v, sp.get('keyword'), ['docNo', 'docTitle', 'submittedByName']))
        .sort((a, b) => (done ? String(b.actedAt).localeCompare(String(a.actedAt)) : b.submittedAt.localeCompare(a.submittedAt)))
      return paginate(list, ctx.url)
    }),
  ),
  http.post(
    `${API}/wf/tasks/:id/approve`,
    handle((ctx, { params, body }) => {
      const db = getDb()
      const { t, inst } = myTask(ctx, Number(params.id))
      t.status = 'APPROVED'
      t.comment = body?.comment ?? ''
      t.actedAt = nowIso()
      const rule = db.approvalRules.find((r) => r.id === inst.ruleId)
      const node = rule?.nodes.find((n: Row) => n.seq === t.nodeSeq)
      const siblings = db.approvalTasks.filter((x) => x.instanceId === inst.id && x.nodeSeq === t.nodeSeq && x.status === 'PENDING')
      if (node?.mode === 'ALL' && siblings.length) {
        audit(ctx, '审批通过', 'approval', inst.id, null, { taskId: t.id, node: t.nodeName, comment: t.comment, waiting: siblings.length })
        return taskView(t)
      }
      for (const other of siblings) other.status = 'SKIPPED'
      const nextNode = rule?.nodes.find((n: Row) => n.seq === t.nodeSeq + 1)
      if (nextNode) {
        const approvers = resolveApprovers(inst.countryId, nextNode)
        if (!approvers.length) throw new MockError(400, 'WF_NO_APPROVER', `下一节点“${nextNode.nodeName}”没有可用的审批人`)
        for (const assigneeId of approvers) {
          db.approvalTasks.push({ id: nextId(), instanceId: inst.id, nodeSeq: nextNode.seq, nodeName: nextNode.nodeName, assigneeId, status: 'PENDING' })
        }
      } else {
        inst.status = 'APPROVED'
        inst.finishedAt = nowIso()
        approvalHook(inst.docType).onApproved?.(inst, ctx)
        notify(inst.submittedBy, inst.countryId, `${inst.docNo} 审批已通过`, `${ctx.user.displayName}：${t.comment || '同意'}`, '/approval/done')
      }
      audit(ctx, '审批通过', 'approval', inst.id, null, { taskId: t.id, node: t.nodeName, comment: t.comment })
      return taskView(t)
    }),
  ),
  http.post(
    `${API}/wf/tasks/:id/reject`,
    handle((ctx, { params, body }) => {
      if (!body?.comment) throw new MockError(400, 'SYS_BAD_REQUEST', '驳回时必须填写意见')
      const db = getDb()
      const { t, inst } = myTask(ctx, Number(params.id))
      t.status = 'REJECTED'
      t.comment = body.comment
      t.actedAt = nowIso()
      for (const other of db.approvalTasks.filter((x) => x.instanceId === inst.id && x.status === 'PENDING')) other.status = 'SKIPPED'
      inst.status = 'REJECTED'
      inst.finishedAt = nowIso()
      approvalHook(inst.docType).onRejected?.(inst, ctx)
      notify(inst.submittedBy, inst.countryId, `${inst.docNo} 审批被驳回`, `${ctx.user.displayName}：${t.comment}`, '/approval/done')
      audit(ctx, '审批驳回', 'approval', inst.id, null, { taskId: t.id, node: t.nodeName, comment: t.comment })
      return taskView(t)
    }),
  ),
  http.get(
    `${API}/wf/instances`,
    handle((ctx) => {
      const countryId = requireCountry(ctx)
      const sp = ctx.url.searchParams
      const db = getDb()
      return db.approvalInstances
        .filter((i) => i.countryId === countryId && i.docType === sp.get('docType') && String(i.docId) === sp.get('docId'))
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
        .map((i) => ({
          ...i,
          submittedByName: userName(i.submittedBy),
          tasks: db.approvalTasks
            .filter((t) => t.instanceId === i.id)
            .sort((a, b) => a.nodeSeq - b.nodeSeq)
            .map((t) => ({ ...t, assigneeName: userName(t.assigneeId) })),
        }))
    }),
  ),
  http.post(
    `${API}/wf/instances/:id/withdraw`,
    handle((ctx, { params }) => {
      const inst = getDb().approvalInstances.find((i) => i.id === Number(params.id) && i.countryId === ctx.countryId)
      if (!inst) notFound()
      if (inst.submittedBy !== ctx.user.id) throw new MockError(403, 'SYS_FORBIDDEN', '只有提交人可以撤回')
      if (inst.status !== 'PENDING' && inst.status !== 'BLOCKED') throw new MockError(409, 'SYS_STATE_INVALID', '只有审批中的单据可以撤回')
      inst.status = 'WITHDRAWN'
      for (const t of getDb().approvalTasks.filter((x) => x.instanceId === inst.id && x.status === 'PENDING')) t.status = 'SKIPPED'
      approvalHook(inst.docType).onWithdrawn?.(inst, ctx)
      audit(ctx, '撤回审批', 'approval', inst.id, { status: 'PENDING' }, { status: 'WITHDRAWN' })
      return inst
    }),
  ),
]

export const wfHandlers = [...ruleHandlers, ...docTypeHandlers, ...taskHandlers]
