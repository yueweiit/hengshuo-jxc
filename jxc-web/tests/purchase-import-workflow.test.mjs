import test from 'node:test'
import { watch, ref, nextTick } from 'vue'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'
import { loadVueScript } from './contracts/load-vue-script.mjs'
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

function scoredRun(textScore = 0.8) {
  const candidate = { productId:501, product:{id:501,productCode:'ABXY',name:'coat',spec:'S',units:[]}, visualScore:1, textEvidence:[],visualEvidence:[],conflicts:[] }
  const fields = [{field:'productCode',label:'商品编号',weight:40,source:'ABCD',target:'ABXY',score:0.5},{field:'spec',label:'规格',weight:40,source:'S',target:'S',score:1},{field:'name',label:'商品名',weight:20,source:'coat',target:'coat',score:1}]
  return {format:'MatchRunV1',runId:batchId,inputRevision:1,status:'OK',text:{status:'NO_INPUT',reason:'缓存'},image:{status:'FOUND',reason:'照片候选'},candidates:[candidate],explanation:{status:'NOT_REQUESTED',message:'缓存重算'},ranking:{format:'CandidateRankingV1',policyVersion:'photo-first-text-40-40-20-v1',completePhotoGroup:true,status:'RECOMMENDED',reason:'通过门槛',photoThreshold:0.8,textThreshold:0.8,weights:{productCode:40,spec:40,name:20},highestPhotoIds:[501],recommendedIds:[501],scores:[{productId:501,photoScore:1,textScore,fields,reason:'通过门槛'}]}}
}

test('读取恢复批次保留后台加权分及字段依据，不在前端重新算分', async()=>{
  const page=await setup({}, {rows:[{...row,matchTaskId:batchId,matchResult:scoredRun()}]})
  assert.equal(page.state.error,'');assert.equal(page.state.rows[0].matchResult.ranking.scores[0].textScore,0.8)
  assert.deepEqual(page.state.rows[0].matchResult.ranking.recommendedIds,[501])
})

test('后台把不足门槛或照片组不完整的候选标成推荐时拒绝错误响应',async()=>{
  for(const run of [scoredRun(0.79), {...scoredRun(),ranking:{...scoredRun().ranking,completePhotoGroup:false}}]) {
    const page=await setup({}, {rows:[{...row,matchResult:run}]})
    assert.match(page.state.error,/加权评分/);assert.equal(page.state.rows.length,0)
  }
})

test('AI图文核对只登记未确认行且后台运行时重复点击不另建任务',async()=>{
  let calls=0
  const task='22222222-2222-4333-8444-555555555555'
  const page=await setup({async startMatches(_id,_version,ids){calls++;assert.deepEqual(ids,[1]);return {batchId,version:1,status:'REVIEW',header,rows:[{...row,matchTaskId:task},{...row,id:2,rowNo:2,readiness:'READY'}],tasks:[{id:task,kind:'MATCH',status:'QUEUED',result:{rowId:1}}],taskIds:[task]}}},{rows:[row,{...row,id:2,rowNo:2,readiness:'READY'}]})
  assert.equal(await page.startImageReview(),true);assert.equal(await page.startImageReview(),false);assert.equal(calls,1)
  assert.deepEqual(page.imageReviewProgress(),{total:1,completed:0,succeeded:0,failed:0,attention:0,pending:1,running:true})
  page.state.tasks[0].status='SUCCEEDED';assert.deepEqual(page.imageReviewProgress(),{total:1,completed:1,succeeded:0,failed:0,attention:1,pending:0,running:false})
})

test('重新打开已有运行任务的批次能恢复按钮进度，不重启自动化',async()=>{
  const task='22222222-2222-4333-8444-555555555555'
  const page=await setup({}, {rows:[{...row,matchTaskId:task}],tasks:[{id:task,kind:'MATCH',status:'RUNNING',result:{rowId:1}}]})
  assert.deepEqual(page.imageReviewProgress(),{total:1,completed:0,succeeded:0,failed:0,attention:0,pending:1,running:true});assert.equal(await page.startImageReview(),false)
})

test('核对排队时锁住编辑照片与确认，但仍能读回后台进度',async()=>{
  const task='22222222-2222-4333-8444-555555555555';let reads=0,decisions=0
  const running={batchId,version:1,status:'REVIEW',header,rows:[{...row,matchTaskId:task}],tasks:[{id:task,kind:'MATCH',status:'QUEUED',result:{rowId:1}}]}
  const page=await setup({async load(){reads++;return structuredClone(running)},async decide(){decisions++;throw new Error('不应确认')}},running)
  assert.equal(page.busy(),true)
  assert.equal(page.startEdit(page.state.rows[0]),false)
  assert.equal(page.grid.edit(1,'productSpec','M'),false)
  assert.equal(page.grid.selectPhoto(1,new File(['image'],'照片.png',{type:'image/png'})),false)
  assert.equal(await page.decideProduct(page.state.rows[0],{decision:'NEW'}),false)
  assert.equal(decisions,0)
  assert.equal(await page.refreshTasks(),true);assert.ok(reads>=2)
  page.state.tasks[0].status='FAILED'
  assert.equal(page.busy(),false)
})

test('文件暂存成功后自动核对已保存行，保留未保存的表头草稿',async()=>{
  const task='22222222-2222-4333-8444-555555555555', calls=[]
  const saved={batchId,version:1,status:'REVIEW',header,rows:[row],tasks:[]}
  const page=await setup({async upload(){return structuredClone(saved)},async startMatches(id,version,ids,key){calls.push({id,version,ids,key});return {...saved,rows:[{...row,matchTaskId:task}],tasks:[{id:task,kind:'MATCH',status:'QUEUED',result:{rowId:1}}],taskIds:[task]}}})
  page.state.header.paymentTerms='尚未保存的账期'
  assert.equal(await page.importFile(new File(['xlsx'],'采购.xlsx')),true)
  assert.deepEqual(calls.map(call=>[call.id,call.version,call.ids]),[[batchId,1,[1]]])
  assert.equal(page.state.header.paymentTerms,'尚未保存的账期');assert.equal(page.headerDirty(),true)
  assert.equal(page.state.tasks[0].kind,'MATCH')
})

test('自动核对仅提交没有当前任务的行，失败行保留原任务供人工重试',async()=>{
  const task='22222222-2222-4333-8444-555555555555', next='33333333-2222-4333-8444-555555555555', calls=[]
  const rows=[{...row,matchTaskId:task},{...row,id:2,rowNo:2},{...row,id:3,rowNo:3,readiness:'READY'}]
  const page=await setup({async startMatches(_id,_version,ids){calls.push(ids);return {batchId,version:1,status:'REVIEW',header,rows:rows.map(r=>r.id===2?{...r,matchTaskId:next}:r),tasks:[{id:task,kind:'MATCH',status:'FAILED',result:{rowId:1}},{id:next,kind:'MATCH',status:'QUEUED',result:{rowId:2}}],taskIds:[next]}}},{rows,tasks:[{id:task,kind:'MATCH',status:'FAILED',errorMessage:'图片服务连接失败',result:{rowId:1}}]})
  assert.equal(await page.startImageReview(),true);assert.deepEqual(calls,[[2]])
  assert.equal(await page.startImageReview(),false);assert.equal(calls.length,1)
})

test('人工补规格保存后沿原自动入口重算候选，不预确认照片',async()=>{
  const calls=[],next='33333333-2222-4333-8444-555555555555',run=scoredRun()
  run.ranking.status='NEEDS_REVIEW';run.ranking.recommendedIds=[];run.ranking.scores[0].textScore=null
  for(const field of run.ranking.scores[0].fields){field.source=null;field.score=null}
  let saved={batchId,version:1,status:'REVIEW',header,groups:[],sources:[{id:7,fileName:'原表.xlsx',fileSha256:'a'.repeat(64),status:'READY'}],rows:[{...row,productSpec:null,sourceId:7,sourceItemKey:'B3',matchTaskId:batchId,matchResult:run,images:[{id:8,status:'UNCONFIRMED',sha256:'b'.repeat(64)}]}],tasks:[{id:batchId,kind:'MATCH',status:'SUCCEEDED'}]}
  const page=await setup({async confirmReview(_id,body){calls.push('review');saved={...saved,version:2,rows:saved.rows.map(r=>({...r,version:2,productSpec:body.changes[0].values.productSpec}))};return structuredClone(saved)},async startMatches(_id,version,ids){calls.push('match');assert.equal(version,2);assert.deepEqual(ids,[1]);return {...saved,rows:saved.rows.map(r=>({...r,matchTaskId:next})),tasks:[...saved.tasks,{id:next,kind:'MATCH',status:'QUEUED'}],taskIds:[next]}}},saved)
  const review=loadTsModule(new URL('../src/modules/purchase/purchaseImportReview.ts',import.meta.url)),question=review.reviewQuestions(page.state.rows,page.state.sources).find(q=>q.field==='productSpec')
  assert.ok(question,page.state.error);assert.equal(await page.confirmReview(review.reviewProposal(batchId,1,question,{B:'S'})),true)
  assert.deepEqual(calls,['review','match']);assert.equal(page.state.rows[0].images[0].status,'UNCONFIRMED')
})

test('核对中修改资料等旧任务明确过期后补发，真实失败不自动循环重试',async()=>{
  const next='33333333-2222-4333-8444-555555555555',calls=[],run=scoredRun()
  const saved={batchId,version:2,status:'REVIEW',header,rows:[{...row,version:2,matchTaskId:batchId,matchResult:null}],tasks:[{id:batchId,kind:'MATCH',status:'RUNNING'}]}
  const page=await setup({async startMatches(_id,version,ids){calls.push(ids);assert.equal(version,2);return {...saved,rows:[{...saved.rows[0],matchTaskId:next}],tasks:[{id:next,kind:'MATCH',status:'QUEUED'}],taskIds:[next]}}},saved)
  assert.equal(await page.startImageReview(),false)
  page.state.tasks[0].status='FAILED';page.state.rows[0].matchResult=run;assert.equal(await page.startImageReview(),false)
  page.state.rows[0].matchResult=null;page.state.tasks[0].status='STALE';page.state.tasks[0].errorCode='INPUT_CHANGED'
  assert.equal(await page.startImageReview(),true);assert.deepEqual(calls,[[1]]);assert.equal(await page.startImageReview(),false)
})

test('确认照片归属后沿原自动入口重算当前行，保留最终商品未确认',async()=>{
  const calls=[],next='33333333-2222-4333-8444-555555555555'
  let saved={batchId,version:1,status:'REVIEW',header,rows:[{...row,sourceId:7,matchTaskId:batchId,matchResult:scoredRun(),images:[{id:8,status:'UNCONFIRMED',sha256:'b'.repeat(64)}]}],tasks:[{id:batchId,kind:'MATCH',status:'SUCCEEDED'}]}
  const page=await setup({async associate(_id,r,imageId,association){calls.push('associate');assert.equal(imageId,8);saved={...saved,version:2,rows:[{...r,version:2,images:[{...r.images[0],status:association}]}]};return {...saved.rows[0],batchVersion:2}},async startMatches(_id,version,ids){calls.push('match');assert.equal(version,2);assert.deepEqual(ids,[1]);return {...saved,rows:saved.rows.map(r=>({...r,matchTaskId:next})),tasks:[...saved.tasks,{id:next,kind:'MATCH',status:'QUEUED'}],taskIds:[next]}}},saved)
  assert.equal(await page.associate(page.state.rows[0],8,'CONFIRMED'),true);assert.deepEqual(calls,['associate','match']);assert.equal(page.state.rows[0].readiness,'UNRESOLVED')
})

test('自动核对请求失败保留已暂存行及明确错误，不显示导入失败',async()=>{
  const page=await setup({async upload(){return {batchId,version:1,status:'REVIEW',header,rows:[row]}},async startMatches(){throw new Error('核对服务不可用')}})
  assert.equal(await page.importFile(new File(['xlsx'],'采购.xlsx')),true)
  assert.equal(page.state.rows.length,1);assert.equal(page.state.status,'REVIEW')
  assert.match(page.state.imageReviewError,/核对服务不可用/)
})

test('编辑器上传所有草稿后再核对，提交的是后台返回的新行版本',async()=>{
  const task='22222222-2222-4333-8444-555555555555', calls=[]
  let saved={batchId,version:1,status:'REVIEW',header,rows:[row]}
  const page=await setup({async saveGrid(input){calls.push('upload');assert.equal(input.rows[0].matchInputs.suppliedProductName,'已上传名称');saved={...saved,version:2,rows:[{...row,version:2,suppliedProductName:'已上传名称'}]};return structuredClone(saved)},async startMatches(_id,version,ids){calls.push('match');assert.equal(version,2);assert.deepEqual(ids,[1]);return {...saved,rows:saved.rows.map(r=>({...r,matchTaskId:task})),tasks:[{id:task,kind:'MATCH',status:'QUEUED',result:{rowId:1}}],taskIds:[task]}}})
  page.grid.setMode('excel');page.grid.applyPaste(0,'suppliedProductName',[['已上传名称']]);page.grid.setMode('table')
  assert.equal(await page.startImageReview(),false);assert.deepEqual(calls,[])
  const editor=loadVueScript(new URL('../src/modules/purchase/PurchaseImportEditor.vue',import.meta.url),{ref,nextTick,defineProps:()=>({page,disabled:false}),defineEmits:()=>()=>{}},['save'])
  await editor.save();assert.deepEqual(calls,['upload','match']);assert.equal(page.grid.hasChanges(),false);assert.equal(page.state.rows[0].version,2)
})

test('自动核对响应迟到时不能恢复已清空页面或发布旧错误',async()=>{
  const task='22222222-2222-4333-8444-555555555555';let release
  const saved={batchId,version:1,status:'REVIEW',header,rows:[row]}
  const page=await setup({async upload(){return structuredClone(saved)},async startMatches(){return new Promise(resolve=>{release=resolve})}})
  const pending=page.importFile(new File(['xlsx'],'采购.xlsx'));await new Promise(resolve=>setTimeout(resolve,0))
  assert.equal(typeof release,'function');page.invalidate()
  release({...saved,rows:[{...row,matchTaskId:task}],tasks:[{id:task,kind:'MATCH',status:'QUEUED',result:{rowId:1}}],taskIds:[task]})
  assert.equal(await pending,false);assert.equal(page.state.batchId,null);assert.deepEqual(page.state.rows,[]);assert.equal(page.state.imageReviewError,'');assert.equal(page.state.success,'')
})

test('图片尚未确认同款时拒绝声称规格已经一致的响应',async()=>{
  const candidate={productId:501,product:{id:501,productCode:'SKU',name:'衣服',spec:'S',units:[]},visualScore:null,textEvidence:[],visualEvidence:[],conflicts:[]}
  const page=await setup({}, {rows:[{...row,matchResult:{format:'MatchRunV1',runId:batchId,inputRevision:1,status:'OK',text:{status:'FOUND',reason:'目录'},image:{status:'NO_INPUT',reason:'无图'},candidates:[candidate],explanation:{status:'READY',message:'说明',candidateChecks:[{productId:501,imageMatch:'NO_INPUT',imageReason:'无图',specMatch:'MATCH',specReason:'猜测'}]}}}]})
  assert.match(page.state.error,/图文核对/);assert.equal(page.state.rows.length,0)
})
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
test('统一保存的处理中状态覆盖表头保存和建单，结束时只有最终成功反馈', async () => {
  const { page } = await saveScenario(); page.state.header.paymentTerms = '本轮核实账期'
  const notifications = [], intermediate = []
  const stop = watch(() => [page.state.success, page.saveOrdersPending()], ([message, pending]) => {
    if (message && pending) intermediate.push(message)
    if (message && !pending) notifications.push(message)
  }, { flush: 'sync' })
  assert.equal(await page.saveOrders(), true); stop()
  assert.ok(intermediate.includes('基础信息已保存')); assert.deepEqual(notifications, ['已保存 1 张采购单草稿，已读回核对一致'])
  assert.equal(page.saveOrdersPending(), false)
})
test('切换上下文取消统一保存时不会发布已暂存表头的旧成功反馈', async () => {
  const { page } = await saveScenario(); page.state.header.paymentTerms = '本轮核实账期'
  let cancelled = false; const notifications = []
  const stop = watch(() => [page.state.success, page.saveOrdersPending()], ([message, pending]) => {
    if (message && !pending) notifications.push(message)
    if (message === '基础信息已保存' && pending && !cancelled) { cancelled = true; page.invalidate() }
  }, { flush: 'sync' })
  assert.equal(await page.saveOrders(), false); stop(); assert.equal(cancelled, true); assert.deepEqual(notifications, [])
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
