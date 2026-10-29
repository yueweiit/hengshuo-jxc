import type { ImportRow } from './purchaseImportModel'

/** 已核对名称仅用于显示，不能写入来源字段或作为下一次匹配的文字证据。 */
export function confirmedProductName(row: ImportRow): string | null {
  if (row.suppliedProductName?.trim() || !row.matchedProductId || !['EXISTING', 'NEW_REQUESTED'].includes(row.decision ?? '')) return null
  const product = row.productSnapshot
  return product?.id === row.matchedProductId && typeof product.name === 'string' && product.name.trim() ? product.name : null
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
