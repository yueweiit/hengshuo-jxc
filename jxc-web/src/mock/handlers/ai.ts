/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AI 只读解释：数字全部来自利润计算，不提供任何改业务的接口。
 */
import { http } from 'msw'
import { getDb, nextId, nowIso } from '../db'
import { API, findOr404 } from '../crud'
import { handle, notFound, requireCountry, requireFieldAccess, requirePerm, scopeOf, userFieldGroups, type Ctx } from '../utils'
import { product, today } from '../services/common'
import { PROFIT_DISCLAIMER, profitRows } from './cstOps'

function requireAnalysisAccess(ctx: Ctx) {
  requirePerm(ctx, 'ai:analysis:use')
  requirePerm(ctx, 'cst:profit:view')
  requireFieldAccess(ctx, 'PROFIT')
}

const ai = http.post(`${API}/ai/analysis`, handle((ctx, { body }) => {
  requireAnalysisAccess(ctx)
  const countryId = requireCountry(ctx)
  const from = body?.from || `${today(countryId).slice(0, 7)}-01`
  const to = body?.to || today(countryId)
  const fields = userFieldGroups(ctx.user, countryId)
  const hideCost = fields.COST === 'HIDDEN'
  const hideSales = fields.ORDER_TOTAL === 'HIDDEN'
  const rows = profitRows(countryId, from, to, ctx).filter((r) => !body?.productId || r.productId === Number(body.productId))
  const ccy = getDb().countries.find((c) => c.id === countryId)?.defaultCurrency
  const lines = rows.map((r) => {
    const name = product(r.productId)?.productCode || '未分到商品的费用'
    const cost = hideCost ? '（无权查看成本）' : String(r.cogsAmount)
    const gap = r.completeness === 'INSUFFICIENT' ? '缺成本快照或缺汇率' : r.completeness === 'ESTIMATED' ? '含暂估成本' : '数据完整'
    return `${name}：净销售 ${hideSales ? '（无权查看金额）' : `${r.netSalesAmount} ${ccy}`}，出库成本 ${cost}，基础毛利 ${hideCost || hideSales ? '（已隐藏）' : r.grossProfit}，贡献利润 ${hideCost || hideSales ? '（已隐藏）' : r.contributionProfit}。${gap}。`
  })
  const output = [
    `期间 ${from} 至 ${to}，币种 ${ccy}。`,
    lines.join('\n') || '这个范围内没有已出库的销售。',
    '建议只作复核：价格、费用是否登记完整、补货是否跟着畅销候选走。',
    PROFIT_DISCLAIMER,
    '系统没有营销费用和库龄跌价功能，回答里不会出现这两项。',
  ].join('\n')
  const req = {
    id: nextId(), userId: ctx.user.id, countryId, params: { from, to, productId: body?.productId ?? null, question: body?.question ?? '' },
    completeness: rows.some((r) => r.completeness === 'INSUFFICIENT') ? 'INSUFFICIENT' : 'COMPLETE',
    modelName: 'mock-explainer', modelVersion: 'b4', output, disclaimer: PROFIT_DISCLAIMER,
    sources: rows.map((r) => ({ productId: r.productId, productCode: r.productCode })), createdAt: nowIso(),
    accessSnapshot: scopeOf(ctx),
    fieldSnapshot: ['PROFIT', ...(!hideCost ? ['COST'] : []), ...(!hideSales ? ['ORDER_TOTAL'] : [])],
  }
  getDb().aiRequests.unshift(req)
  return req
}))

const aiGet = http.get(`${API}/ai/analysis/:id`, handle((ctx, { params }) => {
  const row = findOr404(ctx, 'aiRequests', Number(params.id))
  if (row.userId !== ctx.user.id) notFound()
  requireAnalysisAccess(ctx)
  const current = scopeOf(ctx)
  const currentIds: Record<string, number[]> = { warehouses: current.warehouses, stores: current.stores, entities: current.entities, books: current.books }
  const previous = row.accessSnapshot
  if (!previous || (previous.all && !current.all)) notFound()
  if (!current.all && Object.keys(currentIds).some((key) => (previous[key] ?? []).some((id: number) => !currentIds[key]!.includes(id)))) notFound()
  for (const group of row.fieldSnapshot ?? ['PROFIT', 'COST', 'ORDER_TOTAL']) requireFieldAccess(ctx, group)
  return row
}))

export const aiHandlers = [ai, aiGet]
