import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const { reviewQuestions, reviewProposal, reviewProposalCurrent }=loadTsModule(new URL('../src/modules/purchase/purchaseImportReview.ts',import.meta.url))
const rows=[1,2].map(id=>({id,rowNo:id,version:1,sourceId:7,sourceRow:id+2,sourceItemKey:`B${id+2}`,sourceOrderNo:null,productSpec:null,purchaseQty:'10',purchaseUnitPrice:'53'}))
const sources=[{id:7,fileName:'供应商.xlsx',fileSha256:'a'.repeat(64),status:'READY'}]
const batch='11111111-2222-4333-8444-555555555555'
test('同一来源数量列的规格问题集中一次询问，其他文件独立',()=>{
 const qs=reviewQuestions([...rows,{...rows[0],id:3,sourceId:8}], [...sources,{...sources[0],id:8}])
 const specs=qs.filter(q=>q.field==='productSpec');assert.equal(specs.length,2);assert.equal(specs[0].rows.length,2)
})
test('明确答案只产生修改预览，未确认不改变原数据',()=>{
 const q=reviewQuestions(rows,sources).find(q=>q.field==='sourceOrderNo')
 const p=reviewProposal(batch,1,q,'采购单号是NY-051')
 assert.equal(p.changes.length,2);assert.equal(p.changes[0].values.sourceOrderNo,'NY-051');assert.equal(rows[0].sourceOrderNo,null)
 assert.throws(()=>reviewProposal(batch,1,q,'好的'),/明确/)
})
test('旧预览不能应用到其他批次、版本、文件或已修改明细',()=>{
 const q=reviewQuestions(rows,sources)[0],p=reviewProposal(batch,1,q,'NY-051')
 assert.equal(reviewProposalCurrent(p,batch,1,rows,sources),true)
 assert.equal(reviewProposalCurrent(p,batch,2,rows,sources),false)
 assert.equal(reviewProposalCurrent(p,'other',1,rows,sources),false)
 assert.equal(reviewProposalCurrent(p,batch,1,[{...rows[0],version:2},rows[1]],sources),false)
 assert.equal(reviewProposalCurrent(p,batch,1,rows,[{...sources[0],fileSha256:'b'.repeat(64)}]),false)
})
test('已有人工值和已建草稿不进入自动补充范围',()=>{
 assert.deepEqual(reviewQuestions([{...rows[0],sourceOrderNo:'人工单号',productSpec:'人工规格'},{...rows[1],targetOrderLineId:91}],sources),[])
})
test('横向多规格可以一次回答各列，按原数量格分别预览补充',()=>{
 const combined=[...rows,{...rows[0],id:3,rowNo:3,sourceItemKey:'C3'}]
 const qs=reviewQuestions(combined,sources).filter(q=>q.field==='productSpec');assert.equal(qs.length,1)
 const p=reviewProposal(batch,1,qs[0],{B:'S',C:'M'});assert.equal(p.changes.length,3)
 assert.deepEqual(p.changes.map(c=>c.values.productSpec),['S','S','M'])
 assert.throws(()=>reviewProposal(batch,1,qs[0],'B=S，C=M'),/逐组/)
})
const semanticSource={...sources[0],sheets:[{name:'Sheet1',role:'PURCHASE',reviewContext:{format:'SourceReviewContextV1',imageCount:20,columns:[{key:'B',header:'Talla',examples:['10'],fields:['purchaseQty']},{key:'C',header:'Talla',examples:['4'],fields:['purchaseQty']}],subjects:[{id:'title:A1',kind:'IDENTIFIER',label:'NY-051',examples:['NY-051']},{id:'column:A',kind:'PHOTO',label:'Foto',examples:[]},{id:'column:K',kind:'USD_AMOUNT',label:'cost usd',examples:['12.2537313432836']}]}}]}
test('围绕原表编号列名和数值询问含义，美元成本确认不修改账套',()=>{
 const qs=reviewQuestions(rows,[semanticSource]);const title=qs.find(q=>q.subject?.kind==='IDENTIFIER')
 assert.match(title.prompt,/NY-051/);const number=reviewProposal(batch,1,title,'ORDER_NUMBER');assert.equal(number.changes[0].values.sourceOrderNo,'NY-051')
 const photo=qs.find(q=>q.subject?.kind==='PHOTO');assert.match(photo.prompt,/Foto/);assert.match(photo.prompt,/20/)
 const usd=qs.find(q=>q.subject?.kind==='USD_AMOUNT');assert.match(usd.prompt,/cost usd/);assert.match(usd.prompt,/12.2537313432836/)
 const p=reviewProposal(batch,1,usd,'USD_AMOUNT');assert.deepEqual(p.changes,[]);assert.equal(p.interpretation.meaning,'USD_AMOUNT');assert.equal('currency'in p,false);assert.equal('bookId'in p,false)
})
