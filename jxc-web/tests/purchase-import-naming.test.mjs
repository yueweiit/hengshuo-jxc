import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const display=loadTsModule(new URL('../src/modules/purchase/purchaseImportDisplay.ts',import.meta.url))
const runId='11111111-2222-4333-8444-555555555555'
const row=()=>({id:1,version:2,matchTaskId:runId,productSpec:'S',suppliedProductName:'NY-051验收商品08',images:[{id:7,status:'UNCONFIRMED',sha256:'a'.repeat(64)}],matchResult:{runId,inputRevision:2,candidates:[],explanation:{status:'READY',productNameSuggestion:{status:'READY',category:'裤子',baseName:'黑色条纹裤子',productSpec:'S',name:'S码黑色条纹裤子',sourceKeys:['SOURCE:7'],reason:'来源图片为黑色条纹裤子'}}}})
test('图片名称替代验收占位名用于展示和新品预填，保留原始匹配输入',()=>{
  const source=row(),before=JSON.stringify(source)
  assert.equal(display.importProductNameDisplay(source)?.text,'S码黑色条纹裤子')
  assert.equal(display.importProductNameDraft(source),'S码黑色条纹裤子')
  assert.equal(JSON.stringify(source),before)
})
test('明确手填名称保持优先，匹配档案占位名不能作为命名建议',()=>{
  const source=row();source.suppliedProductName='用户确认的裤子名称'
  assert.equal(display.importProductNameDisplay(source),null);assert.equal(display.importProductNameDraft(source),'用户确认的裤子名称')
  source.suppliedProductName=null;delete source.matchResult.explanation.productNameSuggestion
  Object.assign(source,{matchedProductId:501,decision:'EXISTING',productSnapshot:{id:501,name:'NY-051验收商品08'}})
  assert.equal(display.importProductNameDraft(source),'');assert.equal(display.importProductNameDisplay(source)?.label,'验收占位名、待更名')
})
test('过期任务、照片排除和尺码改变都不能沿用旧图片名称',()=>{
  for(const mutate of [r=>r.version++,r=>r.matchTaskId='other',r=>r.images[0].status='REJECTED',r=>r.productSpec='M']){
    const source=row();mutate(source);assert.equal(display.importProductNameDraft(source),'')
    assert.notEqual(display.importProductNameDisplay(source)?.text,'S码黑色条纹裤子')
  }
})
test('类别不确定保留原因，不把空名或验收占位名填入新品',()=>{
  const source=row();Object.assign(source.matchResult.explanation.productNameSuggestion,{status:'NEEDS_REVIEW',category:null,baseName:null,name:null,reason:'无法分清杯垫或餐垫'})
  assert.equal(display.importProductNameDraft(source),'')
  assert.match(display.importProductNameDisplay(source)?.title,/无法分清杯垫或餐垫/)
})
