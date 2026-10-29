import type { ImportRow } from './purchaseImportModel'

/** 商品名称只作带来源的展示，不能写入原表或充当下一次匹配证据。 */
export function importProductNameDisplay(row: ImportRow): { text: string; label: string; title: string } | null {
  if (row.suppliedProductName?.trim()) return null
  if (row.matchedProductId) {
    const product = row.productSnapshot
    return ['EXISTING', 'NEW_REQUESTED'].includes(row.decision ?? '') && product?.id === row.matchedProductId && typeof product.name === 'string' && product.name.trim()
      ? { text: product.name, label: '已核对商品', title: '来自已核对商品，原表名称未填写' } : null
  }
  const run = row.matchResult
  if (!run || run.runId !== row.matchTaskId || run.inputRevision !== row.version || run.ranking?.status !== 'RECOMMENDED' || run.ranking.recommendedIds.length !== 1) return null
  const id = run.ranking.recommendedIds[0], product = run.candidates.find(candidate => candidate.productId === id)?.product
  return product?.id === id && typeof product.name === 'string' && product.name.trim()
    ? { text: product.name, label: 'AI推荐、待确认', title: '来自当前AI推荐，商品和单位尚未人工确认，原表名称未填写' } : null
}

/** 展示不改写原始精度；整数与小数都不经过浮点数转换。 */
export function formatImportDecimal(value: string | null): string {
  if (value === null) return '待核实'
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('导入数字格式不正确')
  const [integer, fraction = ''] = value.split('.')
  let cents = BigInt(integer!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
  if ((fraction[2] ?? '0') >= '5') cents++
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}
