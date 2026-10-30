import type { ImportRow } from './purchaseImportModel'

export const isImportPlaceholderName = (name: string | null | undefined) => !!name && /验收商品|测试商品|待命名商品/.test(name)
export function currentImportNameSuggestion(row: ImportRow) {
  const run = row.matchResult, name = run?.explanation?.productNameSuggestion
  if (!name || run!.runId !== row.matchTaskId || run!.inputRevision !== row.version || (name.productSpec ?? '') !== (row.productSpec?.trim() ?? '') || name.sourceKeys.some(key => !row.images?.some(image => key === `SOURCE:${image.id}` && image.status !== 'REJECTED'))) return null
  return name
}
/** 新品表单复用图片建议，但不把建议写回原表参与匹配评分。 */
export function importProductNameDraft(row?: ImportRow): string {
  if (!row) return ''
  if (row.suppliedProductName?.trim() && !isImportPlaceholderName(row.suppliedProductName)) return row.suppliedProductName
  const name = currentImportNameSuggestion(row)
  return name?.status === 'READY' ? name.name! : ''
}

/** 商品名称只作带来源的展示，不能写入原表或充当下一次匹配证据。 */
export function importProductNameDisplay(row: ImportRow): { text: string; label: string; title: string } | null {
  if (row.suppliedProductName?.trim() && !isImportPlaceholderName(row.suppliedProductName)) return null
  const name = currentImportNameSuggestion(row)
  if (name) return { text: name.status === 'READY' ? name.name! : '名称待核对', label: name.status === 'READY' ? 'AI图片命名、待确认' : '图片命名待核对', title: `${name.reason}${row.suppliedProductName ? `；原名称：${row.suppliedProductName}` : ''}${row.productSnapshot?.name ? `；档案名称：${row.productSnapshot.name}` : ''}` }
  const catalogName = (text: string, label: string, title: string) => isImportPlaceholderName(text) ? { text, label: '验收占位名、待更名', title: '原档案使用验收占位名，请按来源图核对名称' } : { text, label, title }
  if (row.matchedProductId) {
    const product = row.productSnapshot
    return ['EXISTING', 'NEW_REQUESTED'].includes(row.decision ?? '') && product?.id === row.matchedProductId && typeof product.name === 'string' && product.name.trim()
      ? catalogName(product.name, '已核对商品', '来自已核对商品，原表名称未填写') : null
  }
  const run = row.matchResult
  if (!run || run.runId !== row.matchTaskId || run.inputRevision !== row.version || run.ranking?.status !== 'RECOMMENDED' || run.ranking.recommendedIds.length !== 1) return null
  const id = run.ranking.recommendedIds[0], product = run.candidates.find(candidate => candidate.productId === id)?.product
  return product?.id === id && typeof product.name === 'string' && product.name.trim()
    ? catalogName(product.name, 'AI推荐、待确认', '来自当前AI推荐，商品和单位尚未人工确认，原表名称未填写') : null
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
