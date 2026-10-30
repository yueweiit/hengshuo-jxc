import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const { createPurchaseImportModel } = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
const id='11111111-2222-4333-8444-555555555555'
const header={bookId:null,supplierId:null,currency:null,orderDate:null,expectedDate:null,paymentTerms:'',prepayRatio:null,termDays:null}
const fields={sourceOrderNo:null,photo:null,productSpec:null,purchaseQty:null,saleUnitPrice:null,saleTotal:null,purchaseUnitPrice:null,freight:null,landedUnitCost:null,usdUnitCost:null,usdTotal:null}
test('来源明细允许单号数量暂缺，保留真实空值供核对',async()=>{
  const page=createPurchaseImportModel({async load(){return {batchId:id,header,version:1,rows:[{...fields,id:1,version:1,rowNo:1}]}}},'2026-10-29')
  assert.equal(await page.loadBatch(id),true,page.state.error)
  assert.equal(page.state.rows[0].purchaseQty,null);assert.equal(page.state.rows[0].sourceOrderNo,null)
})
