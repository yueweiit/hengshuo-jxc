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
  let available=false,creates=0
  const page=await setup({async previews(){throw new Error('不得刷新已建预览')},async createDraft(){creates++;throw new Error('不得重建')},async creation(_id,g){return {...g,verifyStatus:available?'VERIFIED':'READ_FAILED'}}},{rows:[{...row,groupId:8,targetOrderLineId:701}],groups:[{...group,createStatus:'CREATED',orderId:700,verifyStatus:'READ_FAILED'}]})
  assert.equal(await page.createDraft(page.state.groups[0]),false)
  assert.equal(await page.saveOrders(),false);assert.match(page.state.error,/读回核对失败/)
  available=true;assert.equal(await page.saveOrders(),true);assert.equal(page.state.groups[0].orderId,700);assert.equal(page.state.groups[0].verifyStatus,'VERIFIED');assert.equal(creates,0)
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

async function saveScenario(planned=[group]){
  const server={batchId,version:1,status:'REVIEW',header:structuredClone(header),rows:planned.map((g,n)=>({...row,id:n+1,rowNo:n+1,sourceOrderNo:g.sourceOrderNo,readiness:'READY'})),groups:[]}
  const calls=[]
  const api={
    async load(){calls.push(['load']);return structuredClone(server)},
    async saveHeader(_id,value){calls.push(['header']);server.header=structuredClone(value);server.version++;return structuredClone(server)},
    async previews(){calls.push(['preview']);server.groups=planned.map(g=>structuredClone(server.groups.find(x=>x.id===g.id)??g));server.rows.forEach((r,n)=>{r.groupId=planned[n].id});return structuredClone(server)},
    async createDraft(_id,g,body,key){calls.push(['create',g.id,structuredClone(body),key]);const saved=server.groups.find(x=>x.id===g.id);Object.assign(saved,{createStatus:'CREATED',orderId:700+g.id,docNo:`PO-SAVE-${g.id}`,verifyStatus:'VERIFIED'});server.rows.filter(r=>r.groupId===g.id).forEach(r=>{r.targetOrderLineId=800+r.id});return structuredClone(saved)},
    async creation(_id,g){calls.push(['read',g.id]);return structuredClone(server.groups.find(x=>x.id===g.id))},
  }
  let sequence=0
  const page=createPurchaseImportModel(api,'2026-10-29',()=>`11111111-2222-4333-8444-${String(++sequence).padStart(12,'0')}`)
  await page.loadBatch(batchId);calls.length=0
  return {page,api,server,calls,planned}
}
test('主保存先保存已修改表头，再生成采购单并读回单号',async()=>{
  const {page,calls}=await saveScenario();page.state.header.paymentTerms='已确认测试账期'
  assert.equal(await page.saveOrders(),true)
  assert.deepEqual(calls.map(c=>c[0]),['header','preview','create','load','read'])
  assert.equal(page.state.groups[0].docNo,'PO-SAVE-8');assert.match(page.state.success,/已保存.*1.*采购单/)
})
test('多采购分组保存后分别显示原订单，再次保存只读回不重建',async()=>{
  const {page,calls}=await saveScenario([group,{...group,id:9,sourceOrderNo:'NY-052'}])
  assert.equal(await page.saveOrders(),true);assert.equal(await page.saveOrders(),true)
  assert.deepEqual(calls.filter(c=>c[0]==='create').map(c=>c[1]),[8,9])
  assert.equal(page.state.groups.length,2);assert.ok(page.state.groups.every(g=>g.orderId&&g.verifyStatus==='VERIFIED'))
})
test('任一分组资料或费用待核对时整次保存不提前创建其他组',async()=>{
  const fee={format:'FeeTodoV1',todoId:batchId,status:'PENDING',registeredReference:null,reviewStatus:'UNRESOLVED',sourceRowIds:[1],sourceRows:[{rowId:1}],amount:null,currency:null,scope:null}
  for(const invalid of [
    {...group,id:9,createStatus:'DRAFT',previewToken:null,preview:null,errors:[{message:'采购税率未核对'}]},
    {...group,id:9,feeTodos:[fee],feeTodosVersion:1,sourceBasisHash:'a'.repeat(64),sourceEvidence:[{rowId:1,currentValues:{}}]},
    {...group,id:9,createStatus:'UNKNOWN'},
  ]){
    const {page,calls}=await saveScenario([group,invalid]);assert.equal(await page.saveOrders(),false)
    assert.equal(calls.filter(c=>c[0]==='create').length,0);assert.match(page.state.error,/核对/)
  }
})
test('保存响应丢失但服务端已建单时，重试先查询原请求且不刷新预览或重建',async()=>{
  const {page,api,calls}=await saveScenario();const create=api.createDraft
  api.createDraft=async(...args)=>{await create(...args);throw new Error('连接中断，结果未确认')}
  assert.equal(await page.saveOrders(),false);assert.equal(await page.saveOrders(),true)
  assert.equal(calls.filter(c=>c[0]==='create').length,1);assert.equal(calls.filter(c=>c[0]==='preview').length,1)
  assert.equal(page.state.groups[0].orderId,708)
})
test('多组部分成功后只继续失败组并保留其原保存请求',async()=>{
  const {page,api,calls}=await saveScenario([group,{...group,id:9,sourceOrderNo:'NY-052'}]);const create=api.createDraft;let failed=false
  api.createDraft=async(...args)=>{if(args[1].id===9&&!failed){failed=true;calls.push(['failed',9,structuredClone(args[2]),args[3]]);throw new Error('第二组连接中断')}return create(...args)}
  assert.equal(await page.saveOrders(),false);assert.equal(page.state.groups[0].orderId,708)
  assert.equal(await page.saveOrders(),true)
  assert.deepEqual(calls.filter(c=>c[0]==='create').map(c=>c[1]),[8,9])
  const previous=calls.find(c=>c[0]==='failed'),retry=calls.find(c=>c[0]==='create'&&c[1]===9);assert.deepEqual(previous.slice(2),retry.slice(2))
})
test('采购单创建后批次读取失败不能报告保存完成，后续只查询已建订单',async()=>{
  const {page,api,calls}=await saveScenario();api.load=async()=>{throw new Error('批次读取失败')}
  assert.equal(await page.saveOrders(),false);assert.equal(page.state.groups[0].orderId,708);assert.match(page.state.error,/读取失败/)
  assert.equal(await page.saveOrders(),true);assert.equal(calls.filter(c=>c[0]==='create').length,1)
})
test('保存过程中切换批次后不再创建后续组或覆盖新页面',async()=>{
  const {page,api,calls}=await saveScenario([group,{...group,id:9,sourceOrderNo:'NY-052'}]);const create=api.createDraft;let release
  api.createDraft=async(...args)=>{await new Promise(r=>{release=r});return create(...args)}
  const saving=page.saveOrders();while(!release)await new Promise(r=>setImmediate(r));page.invalidate();release()
  assert.equal(await saving,false);assert.equal(calls.filter(c=>c[0]==='create').length,1);assert.equal(page.state.batchId,null)
})
test('同一保存进行中重复点击只执行一轮分组创建',async()=>{
  const {page,api,calls}=await saveScenario();const previews=api.previews;let release
  api.previews=async()=>{await new Promise(r=>{release=r});return previews()}
  const saving=page.saveOrders();assert.equal(await page.saveOrders(),false);release();assert.equal(await saving,true)
  assert.equal(calls.filter(c=>c[0]==='create').length,1)
})
test('已建单批次追加未分组来源后保存仍生成新组，不遗漏新增行',async()=>{
  const {page,server,calls,planned}=await saveScenario();assert.equal(await page.saveOrders(),true)
  planned.push({...group,id:9,sourceOrderNo:'NY-052'});server.rows.push({...row,id:2,rowNo:2,sourceOrderNo:'NY-052',readiness:'READY'})
  await page.loadBatch(batchId);assert.equal(await page.saveOrders(),true)
  assert.deepEqual(calls.filter(c=>c[0]==='create').map(c=>c[1]),[8,9])
})
test('保存所需接口缺失时明确说明，不能静默失败或显示保存完成',async()=>{
  const page=await setup();assert.equal(await page.saveOrders(),false);assert.match(page.state.error,/接口尚未接入/)
})
