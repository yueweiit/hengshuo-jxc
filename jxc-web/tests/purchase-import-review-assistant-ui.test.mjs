import test from 'node:test'
import assert from 'node:assert/strict'
import { ref, computed, watch, nextTick } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const model=loadTsModule(new URL('../src/modules/purchase/purchaseImportModel.ts',import.meta.url))
const review=loadTsModule(new URL('../src/modules/purchase/purchaseImportReview.ts',import.meta.url))
const batch='11111111-2222-4333-8444-555555555555'
async function setup(fail=false){
 const values=Object.fromEntries(model.importColumns.map(c=>[c.key,null]));const calls=[]
 let data={batchId:batch,version:1,header:{bookId:null,supplierId:null,currency:null,orderDate:null,expectedDate:null,paymentTerms:'',prepayRatio:null,termDays:null},sources:[{id:7,fileName:'供应商.xlsx',fileSha256:'a'.repeat(64),status:'READY'}],rows:[1,2].map(id=>({...values,id,rowNo:id,version:1,sourceId:7,sourceItemKey:`B${id+2}`}))}
 const page=model.createPurchaseImportModel({async load(){return structuredClone(data)},async confirmReview(id,body,key){calls.push({id,body,key});if(fail){fail=false;throw new Error('保存超时，请按原确认重试')};data={...data,version:3,rows:data.rows.map(r=>({...r,...body.changes.find(c=>c.rowId===r.id).values,version:2}))};return structuredClone(data)}},'2026-10-29',()=>batch)
 await page.loadBatch(batch)
 const ui=loadVueScript(new URL('../src/modules/purchase/PurchaseImportReviewAssistant.vue',import.meta.url),{ref,computed,watch,defineProps:()=>({page}),defineEmits:()=>()=>{},...review},['answer','proposal','prepare','confirm','feedback'])
 return {ui,page,calls}
}
test('实际核对组件先展示建议，点击确认才批量更新原暂存行',async()=>{
 const {ui,page,calls}=await setup();ui.answer.value='单号是NY-051';ui.prepare()
 assert.equal(ui.proposal.value.changes.length,2);assert.equal(calls.length,0);assert.equal(page.state.rows[0].sourceOrderNo,null)
 await ui.confirm();await nextTick();assert.equal(calls.length,1);assert.equal(page.state.rows.length,2);assert.equal(page.state.rows[0].sourceOrderNo,'NY-051');await ui.confirm();assert.equal(calls.length,1)
})
test('确认失败保留输入和预览，原请求重试沿用幂等键',async()=>{
 const {ui,page,calls}=await setup(true);ui.answer.value='NY-051';ui.prepare();await ui.confirm()
 assert.equal(ui.answer.value,'NY-051');assert.ok(ui.proposal.value);assert.match(page.state.error,/超时/)
 await ui.confirm();assert.equal(calls.length,2);assert.equal(calls[0].key,calls[1].key);assert.deepEqual(calls[0].body,calls[1].body)
})
test('切换批次后原对话建议不能写入新文件',async()=>{
 const {ui,page,calls}=await setup();ui.answer.value='NY-051';ui.prepare();page.invalidate();await ui.confirm();assert.equal(calls.length,0)
})
