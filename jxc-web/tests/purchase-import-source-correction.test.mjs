import test from 'node:test'
import assert from 'node:assert/strict'
import {loadTsModule} from './contracts/load-ts-module.mjs'
const moduleUrl=new URL('../src/modules/purchase/purchaseImportSourceMapping.ts',import.meta.url)
test('按确认数量列拆分映射，保留原格价款和原对象，不推测规格',()=>{
 const {splitSupplierMapping}=loadTsModule(moduleUrl),mapping={format:'SupplierMappingV1',fileSha256:'a'.repeat(64),sheet:'Sheet1',needsReview:false,reasons:[],ignoredRows:[],lines:[3,4].map(sourceRow=>({sourceRow,cells:{purchaseQty:'E'+sourceRow,purchaseUnitPrice:'H'+sourceRow,sourceOrderNo:'A1'}}))},before=JSON.stringify(mapping)
 const split=splitSupplierMapping(mapping,'B,C,D');assert.equal(split.lines.length,6);assert.deepEqual(split.lines.slice(0,3).map(l=>l.cells.purchaseQty),['B3','C3','D3']);assert.ok(split.lines.every(l=>l.cells.purchaseUnitPrice==='H'+l.sourceRow&&l.cells.sourceOrderNo==='A1'&&l.cells.productSpec==null));assert.equal(JSON.stringify(mapping),before)
 for(const columns of ['', 'B,B','B3,C','B;C'])assert.throws(()=>splitSupplierMapping(mapping,columns))
 assert.throws(()=>splitSupplierMapping({...mapping,lines:[mapping.lines[0],{...mapping.lines[0],cells:{...mapping.lines[0].cells,purchaseUnitPrice:'J3'}}]},'B,C,D'))
})
test('创建纠正批次成功才切换模型，失败保留原批次并复用原意图',async()=>{
 const {createPurchaseImportModel}=loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts',import.meta.url)),old='11111111-2222-4333-8444-555555555555',next='22222222-2222-4333-8444-555555555555',task='33333333-2222-4333-8444-555555555555',header={bookId:null,supplierId:null,currency:null,orderDate:null,expectedDate:null,paymentTerms:'',prepayRatio:null,termDays:null},calls=[]
 let fail=true;const api={async load(){return {batchId:old,version:2,status:'REVIEW',header,rows:[],sources:[],tasks:[],groups:[]}},async correctSource(...args){calls.push(args);if(fail)throw new Error('纠正请求失败');return {batchId:next,version:1,status:'PARSING',header,rows:[],sources:[],tasks:[{id:task,kind:'PARSE',status:'QUEUED'}],taskId:task}}},page=createPurchaseImportModel(api,'2026-10-29',()=> 'same-intent')
 await page.loadBatch(old);const input={mapping:{},specLabels:{},confirm:true};assert.equal(await page.correctSource(8,2,input),false);assert.equal(page.state.batchId,old);assert.match(page.state.error,/纠正请求失败/)
 fail=false;assert.equal(await page.correctSource(8,2,input),true);assert.equal(page.state.batchId,next);assert.equal(page.state.activeTaskId,task);assert.equal(calls[0][4],calls[1][4]);assert.equal(calls[1][2],2)
})
