import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const feature = () => loadTsModule(new URL('../src/modules/purchase/purchaseImportIssues.ts', import.meta.url))
const tax = { field: 'taxRate', message: '本行税率待核实，请明确填写', sourceSheet: '采购', sourceRow: 18 }

test('60条同类缺项汇总一次但完整保留逐行来源，同一原表行拆出的明细分别计数', () => {
  const { summarizeImportIssues, formatImportIssues } = feature()
  const issues = Array.from({ length: 60 }, (_, n) => ({ ...tax, rowId: n + 1 }))
  const summary = summarizeImportIssues(issues)
  assert.equal(summary.length, 1)
  assert.equal(summary[0].message, '本行税率待核实，请明确填写（60行）')
  assert.equal(summary[0].issues.length, 60)
  assert.deepEqual(summary[0].issues.map(issue => issue.rowId), Array.from({ length: 60 }, (_, n) => n + 1))
  assert.equal(formatImportIssues(issues), '本行税率待核实，请明确填写（60行）')
  assert.equal(issues.length, 60)
})

test('整单提示与行级问题分别保留，同一行的重复问题不增加受影响行数', () => {
  const { summarizeImportIssues, formatImportIssues } = feature()
  const issues = [{ field: 'priceTaxBasis', message: '请确认未含税单价' }, { field: 'paymentTerms', message: '请明确付款条件' }, { ...tax, rowId: 1 }, { ...tax, rowId: 1 }]
  assert.equal(summarizeImportIssues(issues).length, 3)
  assert.equal(formatImportIssues(issues), '请确认未含税单价；请明确付款条件；本行税率待核实，请明确填写（1行）')
  assert.deepEqual(summarizeImportIssues([]), [])
})
