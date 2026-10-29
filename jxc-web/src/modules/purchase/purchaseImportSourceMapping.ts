import type { SupplierMapping } from './purchaseImportModel'

/** 只修改原格引用；数量与金额仍由原解析器从原文件读取。 */
export function splitSupplierMapping(mapping: SupplierMapping, input: string): SupplierMapping {
  const columns = input.trim().toUpperCase().split(/[,，\s]+/).filter(Boolean)
  if (!columns.length || columns.length > 20 || new Set(columns).size !== columns.length || columns.some(c => !/^[A-Z]{1,3}$/.test(c))) throw new Error('请填写不同的原数量列字母，例如 B,C,D')
  const result = JSON.parse(JSON.stringify(mapping)) as SupplierMapping
  const evidence = new Map<number, string>()
  for (const line of result.lines) {
    const refs = JSON.stringify(Object.entries(line.cells).filter(([key]) => !['purchaseQty','productSpec'].includes(key)).sort(([a],[b]) => a.localeCompare(b)))
    if (evidence.has(line.sourceRow) && evidence.get(line.sourceRow) !== refs) throw new Error('同一原行有不同的价款或其他字段来源，请逐项核对，不能合并拆分建议')
    evidence.set(line.sourceRow,refs)
  }
  const rows = [...new Map(result.lines.map(line => [line.sourceRow, line])).values()]
  result.lines = rows.flatMap(line => columns.map(column => ({ sourceRow: line.sourceRow, cells: { ...line.cells, purchaseQty: `${column}${line.sourceRow}`, productSpec: null } })))
  return result
}
