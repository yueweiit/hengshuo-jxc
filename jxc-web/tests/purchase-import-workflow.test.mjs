import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const { createPurchaseImportModel } = loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url))
const batchId='11111111-2222-4333-8444-555555555555'
const header={bookId:1,supplierId:2,currency:'USD',orderDate:'2026-10-29',expectedDate:null,paymentTerms:'',prepayRatio:'0',termDays:0}
const row={id:1,version:1,rowNo:1,sourceOrderNo:'NY-051',photo:null,productSpec:'S',purchaseQty:'10',saleUnitPrice:null,saleTotal:null,purchaseUnitPrice:'53',freight:'29.1',landedUnitCost:null,usdUnitCost:null,usdTotal:null,readiness:'UNRESOLVED'}
const group={id:8,version:2,sourceOrderNo:'NY-051',header,createStatus:'READY',verifyStatus:'NOT_CHECKED',previewToken:batchId,orderId:null,errors:[],preview:{header,totalAmount:'530',taxAmount:'0',lines:[{productId:501,unit:'PCS',qty:'10',unitPrice:'53'}]}}
async function setup(extra={},source={}){
  const data={batchId,version:1,status:'REVIEW',header,rows:[structuredClone(row)],groups:[],...source}
  const page=createPurchaseImportModel({async load(){return structuredClone(data)},...extra},'2026-10-29',()=>batchId)
  await page.loadBatch(batchId);return page
}
test('人工选择零库存已有商品仍复用真实商品，不创建新品',async()=>{
  const page=await setup({async decide(_id,r,input){return {...r,version:2,matchedProductId:input.productId,purchaseUnit:input.unit,readiness:'READY',decision:'EXISTING'}}})
  assert.equal(await page.decideProduct(page.state.rows[0],{decision:'EXISTING',productId:501,unit:'PCS'}),true)
  assert.equal(page.state.rows[0].matchedProductId,501);assert.equal(page.state.rows[0].readiness,'READY')
})
test('新品部分成功保留真实ID及原请求，恢复不另建商品',async()=>{
  const calls=[],body={version:1,confirmNew:true,unit:'PCS',product:{productCode:'NY051-DRAFT-TEST',name:'测试商品',baseUnit:'PCS',spec:'S'}}
  const page=await setup({async createProduct(_id,r,request,key){calls.push([request,key]);if(calls.length===1)throw Object.assign(new Error('本国启用失败'),{data:{partialResult:{productId:909,rowId:1,rowVersion:2,readiness:'NEEDS_SETUP'}}});return {...r,version:3,matchedProductId:909,readiness:'READY'}}})
  assert.equal(await page.createProduct(page.state.rows[0],body,batchId),false)
  assert.equal(page.state.rows[0].matchedProductId,909);assert.equal(page.state.rows[0].readiness,'NEEDS_SETUP')
  assert.equal(await page.createProduct(page.state.rows[0],body,batchId),true);assert.deepEqual(calls[0],calls[1])
})
test('候选版本变化后不能请求旧候选解释',async()=>{
  const page=await setup({}, {rows:[{...row,version:3,matchResult:{format:'MatchRunV1',runId:batchId,inputRevision:2,status:'OK',text:{status:'NO_INPUT',reason:'未提供'},image:{status:'NOT_FOUND',reason:'无候选'},candidates:[],explanation:{status:'NOT_REQUESTED',message:'待请求'}}}]})
  assert.equal(await page.explainMatch(page.state.rows[0]),false)
})
test('未核对明细的预览保留服务端错误且不能创建',async()=>{
  const page=await setup({async previews(){return {batchId,header,rows:[row],groups:[{...group,createStatus:'DRAFT',previewToken:null,preview:null,errors:[{rowId:1,message:'本行商品或单位未确认'}]}]}}})
  assert.equal(await page.previewDrafts(),true);assert.match(page.state.groups[0].errors[0].message,/未确认/)
  assert.equal(await page.createDraft(page.state.groups[0]),false)
})
test('重复点击和超时恢复保留同一创建意图',async()=>{
  const calls=[];let release
  const page=await setup({async createDraft(_id,g,body,key){calls.push([body,key]);await new Promise(r=>{release=r});throw new Error('连接中断')}},{groups:[group]})
  const first=page.createDraft(page.state.groups[0]);assert.equal(await page.createDraft(page.state.groups[0]),false);release();assert.equal(await first,false)
  const retry=page.createDraft(page.state.groups[0]);release();await retry;assert.deepEqual(calls[0],calls[1])
})
test('预览过期反馈保留原组，要求重新核对',async()=>{
  const page=await setup({async createDraft(){throw Object.assign(new Error('预览依据已变化'),{code:'PUR_IMPORT_PREVIEW_CHANGED'})}},{groups:[group]})
  assert.equal(await page.createDraft(page.state.groups[0]),false);assert.match(page.state.error,/预览依据已变化/)
})
test('已创建但读回失败时只查询原结果，不重建',async()=>{
  const page=await setup({async creation(_id,g){return {...g,verifyStatus:'VERIFIED'}}},{groups:[{...group,createStatus:'CREATED',orderId:700,verifyStatus:'READ_FAILED'}]})
  assert.equal(await page.createDraft(page.state.groups[0]),false)
  assert.equal(await page.refreshCreation(page.state.groups[0]),true);assert.equal(page.state.groups[0].orderId,700);assert.equal(page.state.groups[0].verifyStatus,'VERIFIED')
})
test('费用来源已变化或读回未确认时不能显示核对成功',async()=>{
  const page=await setup({async saveFeeTodos(){throw new Error('费用来源已变化')}},{groups:[group]})
  assert.equal(await page.saveFeeTodos(page.state.groups[0],[{sourceRowIds:[1],scope:'ORDER',amount:'29.10',currency:'USD',reason:'整单费用一次',confirm:true}]),false)
  assert.match(page.state.error,/费用来源已变化/)
})
test('尚有费用来源待核对时不发送草稿创建请求',async()=>{
  const page=await setup({async createDraft(){throw new Error('不得调用')}},{groups:[group]})
  // 使用工作流的已加载状态，避免坏费用合同绕过正式批次解析。
  page.state.groups=[{...group,feeTodos:[{reviewStatus:'UNRESOLVED'}]}]
  assert.equal(await page.createDraft(page.state.groups[0]),false);assert.equal(page.state.error,'')
})
