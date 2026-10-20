/* eslint-disable @typescript-eslint/no-explicit-any */
import { getDb, nextId, nowIso, type Row } from '../db'
import { audit, type Ctx } from '../utils'
import { openTodo } from './common'

export interface ApprovalHook {
  onApproved?: (inst: Row, ctx: Ctx) => void
  onRejected?: (inst: Row, ctx: Ctx) => void
  onWithdrawn?: (inst: Row, ctx: Ctx) => void
}

const hooks: Record<string, ApprovalHook> = {}

/** 业务模块登记审批结果回调，审批引擎在最后节点通过、驳回、撤回时调用 */
export function onApproval(docType: string, hook: ApprovalHook) {
  hooks[docType] = hook
}

export function approvalHook(docType: string): ApprovalHook {
  return hooks[docType] ?? {}
}

function matchCond(c: Row, facts: Row) {
  const v = facts[c.field]
  switch (c.op) {
    case 'gte': return Number(v) >= Number(c.value)
    case 'gt': return Number(v) > Number(c.value)
    case 'lte': return Number(v) <= Number(c.value)
    case 'lt': return Number(v) < Number(c.value)
    case 'eq': return v === c.value || String(v) === String(c.value)
    default: return false
  }
}

function resolveApprovers(countryId: number, node: Row): number[] {
  const db = getDb()
  if (node.approverType === 'USER') return [Number(node.approverRef)]
  const roleIds = db.roles.filter((r) => r.countryId === countryId && r.code === node.approverRef && r.status === 'ENABLED').map((r) => r.id)
  return [...new Set(db.userRoles.filter((ur) => ur.countryId === countryId && roleIds.includes(ur.roleId)).map((ur) => ur.userId))]
}

export interface SubmitInput {
  docType: string
  docId: number
  docNo: string
  docTitle: string
  amount?: number
  currency?: string
  /** 规则条件取值，例如 amount（本位币）、paymentType */
  facts?: Row
  /** 授信例外等业务条件必须经过审批，不能沿单据默认免审放行。 */
  forceRequired?: boolean
}

export interface SubmitResult {
  /** APPROVED：无需审批直接通过；PENDING：进入审批；BLOCKED：缺规则或缺审批人，不能自动通过 */
  status: 'APPROVED' | 'PENDING' | 'BLOCKED'
  instance?: Row
  message: string
}

/** 提交审批（docs/02 第 4 节）：按优先级取第一条命中的规则；必须审批但无规则或无审批人时停在待审批 */
export function submitApproval(ctx: Ctx, input: SubmitInput): SubmitResult {
  const db = getDb()
  const countryId = ctx.countryId!
  const cfg = db.docTypeConfigs.find((d) => d.countryId === countryId && d.docType === input.docType)
  const facts = { amount: input.amount ?? 0, ...input.facts }
  const rule = db.approvalRules
    .filter((r) => r.countryId === countryId && r.docType === input.docType && r.status === 'ACTIVE')
    .sort((a, b) => a.priority - b.priority)
    .find((r) => (r.conditions ?? []).every((c: Row) => matchCond(c, facts)))

  const base = {
    id: nextId(), countryId, docType: input.docType, docId: input.docId, docNo: input.docNo, docTitle: input.docTitle,
    amount: input.amount ?? 0, currency: input.currency ?? '', facts, forceRequired: !!input.forceRequired, submittedBy: ctx.user.id, submittedAt: nowIso(),
  }

  if (!rule) {
    if (!input.forceRequired && !cfg?.approvalRequired) {
      audit(ctx, '提交（无需审批）', 'approval', input.docId, null, { docType: input.docType, docNo: input.docNo })
      return { status: 'APPROVED', message: '无匹配审批规则，单据类型无需审批，已直接通过' }
    }
    const inst = { ...base, ruleId: null, ruleName: '无匹配规则', ruleVersionNo: 0, status: 'BLOCKED' }
    db.approvalInstances.unshift(inst)
    blockedTodo(countryId, inst, '没有匹配的审批规则')
    return { status: 'BLOCKED', instance: inst, message: '该单据类型必须审批，但没有匹配的审批规则，已通知国家管理员补齐配置' }
  }

  const first = rule.nodes[0]
  const approvers = resolveApprovers(countryId, first)
  const inst = { ...base, ruleId: rule.id, ruleName: rule.name, ruleVersionNo: rule.versionNo, status: approvers.length ? 'PENDING' : 'BLOCKED' }
  db.approvalInstances.unshift(inst)
  if (!approvers.length) {
    blockedTodo(countryId, inst, `节点“${first.nodeName}”没有可用的审批人`)
    return { status: 'BLOCKED', instance: inst, message: `审批节点“${first.nodeName}”没有可用的审批人，已通知国家管理员` }
  }
  for (const assigneeId of approvers) {
    db.approvalTasks.push({ id: nextId(), instanceId: inst.id, nodeSeq: first.seq, nodeName: first.nodeName, assigneeId, status: 'PENDING' })
  }
  audit(ctx, '提交审批', 'approval', inst.id, null, { docType: input.docType, docNo: input.docNo, rule: rule.name, versionNo: rule.versionNo })
  return { status: 'PENDING', instance: inst, message: `已提交审批：${rule.name}（v${rule.versionNo}）` }
}

function blockedTodo(countryId: number, inst: Row, reason: string) {
  openTodo({
    countryId,
    todoType: 'CONFIG_MISSING',
    dedupKey: `WF_BLOCKED:${inst.docType}:${inst.docId}`,
    title: `${inst.docNo} 无法进入审批：${reason}`,
    link: '/settings/approval-rules',
    perm: 'wf:rule:edit',
  })
}

/** 已通过的审批因关键字段修改而失效（docs/02 第 4.2 节） */
export function invalidateApproval(docType: string, docId: number, reason: string) {
  for (const i of getDb().approvalInstances.filter((x) => x.docType === docType && x.docId === docId && x.status === 'APPROVED')) {
    i.status = 'INVALIDATED'
    i.invalidReason = reason
  }
}

/** 单据撤回或作废时，结束进行中的审批 */
export function cancelPendingApproval(docType: string, docId: number) {
  const db = getDb()
  for (const i of db.approvalInstances.filter((x) => x.docType === docType && x.docId === docId && (x.status === 'PENDING' || x.status === 'BLOCKED'))) {
    i.status = 'WITHDRAWN'
    for (const t of db.approvalTasks.filter((x) => x.instanceId === i.id && x.status === 'PENDING')) t.status = 'SKIPPED'
  }
}
