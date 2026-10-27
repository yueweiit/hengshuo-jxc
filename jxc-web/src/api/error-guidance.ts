import type { ErrorAction, ErrorDetail, ErrorFeedbackOptions, ErrorNotice } from '@/api/error-feedback'
type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const finite = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value))
const positiveId = (value: unknown) => finite(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined
const safePath = (value: string) => /^\/(?!\/)[\w/-]+(?:\?[^\s#]*)?$/.test(value) && !value.startsWith('/api/')

function stock(data: Row): { details: ErrorDetail[]; actions: ErrorAction[]; nextStep: string } {
  const rows = data.detailsVisible === true && Array.isArray(data.shortages) ? data.shortages.map(record) : []
  const details = rows.filter(r => ['requiredQty', 'availableQty', 'shortageQty'].every(k => finite(r[k]))).map(r => ({ label: `${String(r.productCode)} · ${String(r.warehouseName)}`, value: `需要 ${Number(r.requiredQty)}，可用 ${Number(r.availableQty)}，还缺 ${Number(r.shortageQty)} ${String(r.unit)}`, permission: 'inv:stock:view' }))
  const actions: ErrorAction[] = []
  const warehouseId = positiveId(rows[0]?.warehouseId), orderId = positiveId(data.orderId)
  if (warehouseId) actions.push({ label: '查看库存', to: `/inventory/stocks?warehouseId=${warehouseId}`, permission: 'inv:stock:view' })
  actions.push({ label: '查看补货待办', to: '/inventory/replenishments', permission: ['inv:replenish:create', 'inv:replenish:decide'] })
  if (orderId) actions.push({ label: '打开销售订单', to: `/sales/orders/${orderId}`, permission: ['sal:order:view', 'sal:order:create', 'sal:outbound:create', 'sal:outbound:confirm'] })
  return { details, actions, nextStep: data.detailsVisible === false ? '请有库存查看权限的人员核对对应仓库。处理后返回原订单重新审批。' : '请先核对库存和已有补货安排，实际入库后回原订单重新审批；需调整订单时，由销售按原流程修改后重提。' }
}

function outbound(data: Row): { details: ErrorDetail[]; actions: ErrorAction[]; nextStep: string } {
  const checks = Array.isArray(data.checks) ? data.checks.map(record).filter(c => c.ok === false) : []
  const details: ErrorDetail[] = [], actions: ErrorAction[] = []
  const orderId = positiveId(data.orderId)
  for (const check of checks) {
    const payment = record(check.payment)
    if (check.item === '现款到账' && payment.amountsVisible === true && ['requiredAmount', 'confirmedAmount', 'shortageAmount'].every(k => finite(payment[k]))) {
      for (const [key, label] of [['requiredAmount', '出库后累计需要'], ['confirmedAmount', '本单已确认并分配'], ['shortageAmount', '尚差已确认收款']]) details.push({ label: label!, value: payment[key!] as number | string, currency: String(payment.currency), field: 'ORDER_TOTAL' })
      if (Number(payment.pendingAmount) > 0) details.push({ label: '另有待确认收款（尚未计入）', value: payment.pendingAmount as number | string, currency: String(payment.currency), field: 'ORDER_TOTAL' })
      if (orderId && payment.canManageReceipts === true) {
        const pending = Number(payment.pendingAmount) > 0
        const intent = pending ? 'confirm' : 'register'
        actions.push({ label: pending ? '去确认到账' : '去登记收款', intent, to: `${pending ? '/ar/receipts/confirm' : '/ar/receipts'}?orderId=${orderId}&source=sales-outbound&action=${intent}`, permission: pending ? 'ar:receipt:confirm' : 'ar:receipt:create', fields: pending ? { BANK_INFO: 'WRITE', ORDER_TOTAL: 'READ' } : { BANK_INFO: 'WRITE', ORDER_TOTAL: 'WRITE' } })
        actions.push({ label: '查看本单收款', intent: 'view', to: `/ar/receipts?orderId=${orderId}&source=sales-outbound&action=view`, permission: ['ar:receipt:create', 'ar:receipt:confirm'], fields: { ORDER_TOTAL: 'READ' } })
      }
    } else details.push({ label: String(check.item ?? '检查项'), value: String(check.message ?? '检查未通过') })
    if (orderId && check.code === 'SAL_PAYMENT_EVIDENCE_REQUIRED') actions.push({ label: '去补收款凭证', intent: 'payment-proof', to: `/sales/orders/${orderId}`, permission: ['sal:order:create', 'sal:order:submit', 'sal:outbound:confirm'], fields: { BANK_INFO: 'WRITE' } })
    if (orderId && check.code === 'SAL_ATTACHMENT_MISSING') actions.push({ label: '去上传销售单据', intent: 'sales-doc', to: `/sales/orders/${orderId}`, permission: ['sal:order:create', 'sal:order:submit', 'sal:outbound:confirm'], fields: { CUSTOMER_PRICE: 'WRITE' } })
  }
  return { details, actions, nextStep: '请按未通过项目处理后重新检查。收款只计入已确认并分配到本单的金额；有待确认记录时先处理原收款，避免重复登记。无对应权限时请交由财务或仓管核对。' }
}
const descriptions: Record<string, (data: Row) => ReturnType<typeof stock>> = { STOCK_SHORTAGE: stock, OUTBOUND_CHECK: outbound }
const common: Record<string, { nextStep: string; actions?: ErrorAction[] }> = {
  AI_PROVIDER_NOT_CONFIGURED: { nextStep: 'AI 服务尚未配置，请管理员完成服务配置后重新分析。当前未生成分析结果，已填条件保留。' },
  SYS_FORBIDDEN: { nextStep: '请联系有对应权限的人员处理；需要调整权限时，将问题信息交给管理员核对。' },
  NOT_FOUND: { nextStep: '请先核对当前国家和单据，记录可能已变更或不在当前账号的数据范围内。' },
  AUTH_REQUIRED: { nextStep: '请重新登录后核对原单据状态。', actions: [{ label: '重新登录', to: '/login' }] },
  FIN_PERIOD_CLOSED: { nextStep: '请财务核对业务日期和会计期间，处理后再返回原单办理。' },
  FIN_MAPPING_MISSING: { nextStep: '当前账套的凭证映射缺失或不完整。请财务核对事件规则、科目和资金账户关联，复核生效后重试。', actions: [{ label: '查看凭证映射', to: '/finance/mappings', permission: 'fin:mapping:edit' }] },
}

export function describeFailure(error: unknown, options: ErrorFeedbackOptions): Omit<ErrorNotice, 'id' | 'beforeNavigate'> {
  const failure = record(error), data = record(failure.data)
  const code = typeof failure.code === 'string' ? failure.code : 'CLIENT_ERROR'
  const message = typeof failure.message === 'string' && failure.message.trim() ? failure.message : typeof error === 'string' && error.trim() ? error : '操作未完成，未收到有效的错误说明'
  const special = descriptions[String(data.kind)]?.(data)
  const guide = special ?? common[code]
  const uncertain = ['NETWORK_ERROR', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_NETWORK'].includes(code) && options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())
  const nextStep = options.nextStep ?? (uncertain ? '请求结果尚未确认，操作可能已经成功。请先查看原单据状态，核对结果后再处理，避免重复提交。' : guide?.nextStep ?? '请核对原因和当前单据状态后重试；仍无法处理时，复制问题信息交给管理员核查。')
  const actions = [...(options.actions ?? guide?.actions ?? [])]
  if (options.sourcePath && safePath(options.sourcePath) && !actions.some(a => a.to === options.sourcePath)) actions.push({ label: '查看原操作页面', to: options.sourcePath })
  return { code, title: options.title ?? (options.method === 'GET' ? '读取未完成' : '操作未完成'), message, nextStep, details: options.details ?? special?.details ?? [], actions: actions.filter(a => !a.to || safePath(a.to)), traceId: typeof failure.traceId === 'string' ? failure.traceId : undefined }
}
