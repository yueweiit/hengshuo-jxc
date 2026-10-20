import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

test('cost confirmation uses the explicit current-country command date for single and batch without moving source dates',async()=>{
 const calls=[],prompts=[]
 const p=loadVueScript(new URL('../src/modules/cost/InboundCostList.vue',import.meta.url),{
  ref:vue.ref,reactive:vue.reactive,computed:vue.computed,onMounted(){},watch(){},useRoute:()=>({query:{}}),useRouter:()=>({}),useUserStore:()=>({hasPerm:()=>true}),useCountryStore:()=>({timezone:'America/Mexico_City'}),getCountryId:()=>3,getToken:()=> 'session-A',todayIn:zone=>{assert.equal(zone,'America/Mexico_City');return '2026-10-16'},createCommandIntent:()=>({reset(){}}),ElMessage:{success(){},warning(){}},ElMessageBox:{confirm:async text=>{prompts.push(text)}},http:{get:async()=>({records:[],counts:{},total:0}),postIdem:async(path,body)=>{calls.push({path,body});return {confirmed:[8],failed:[]}}},
 },['confirmOne','confirmBatch','selection','confirmationDate'])
 const opening={id:7,batchNo:'OPENING',unitCost:10,baseCurrency:'MXN',bizDate:'2026-09-30'}
 await p.confirmOne(opening);p.confirmationDate.value='2026-10-20';p.selection.value=[{id:8,bizDate:'2026-09-30'}];await p.confirmBatch()
 assert.deepEqual(calls,[{path:'/cst/inbound-costs/7/confirm',body:{bizDate:'2026-10-16'}},{path:'/cst/inbound-costs/batch-confirm',body:{ids:[8],bizDate:'2026-10-20'}}])
 assert.equal(opening.bizDate,'2026-09-30');assert.ok(prompts[0].includes('2026-10-16'));assert.ok(prompts[1].includes('2026-10-20'))
})

test('native cost rows expose credible source identifiers and allow server-validated confirmation without a rateAvailable DTO field',async()=>{
 const calls=[],prompts=[]
 const native={id:7,batchId:405,productId:44,warehouseId:12,sourceType:'OPENING_STOCK',sourceLineId:1,bizDate:'2026-09-30',qty:10,basePurchaseAmount:100,rate:1,unitCost:10,baseCurrency:'MXN',status:'ESTIMATED'}
 const p=loadVueScript(new URL('../src/modules/cost/InboundCostList.vue',import.meta.url),{
  ref:vue.ref,reactive:vue.reactive,computed:vue.computed,onMounted(){},watch(){},useRoute:()=>({query:{}}),useRouter:()=>({}),useUserStore:()=>({hasPerm:()=>true}),useCountryStore:()=>({timezone:'America/Mexico_City'}),getCountryId:()=>3,getToken:()=> 'session-A',todayIn:()=> '2026-10-16',createCommandIntent:()=>({reset(){}}),ElMessage:{success(){},warning(){}},ElMessageBox:{confirm:async text=>{prompts.push(text)}},http:{get:async()=>({records:[native,{...native,id:8,status:'PENDING_RATE',rate:null,unitCost:null,basePurchaseAmount:null},{...native,id:9,status:'CONFIRMED'}],counts:{},total:3}),postIdem:async(path,body)=>{calls.push({path,body});throw new Error('CST_RATE_PENDING')}},
 },['load','rows','confirmOne'])
 await p.load()
 assert.equal(p.rows.value[0].canAttemptConfirmation,true)
 assert.equal(p.rows.value[0].batchNo,'#405')
 assert.equal(p.rows.value[0].productCode,'#44')
 assert.equal(p.rows.value[0].warehouseName,'#12')
 assert.equal(p.rows.value[0].poNo,'OPENING_STOCK')
 assert.equal(p.rows.value[0].receiptNo,'#1')
 assert.equal(p.rows.value[1].canAttemptConfirmation,true)
 assert.equal(p.rows.value[2].canAttemptConfirmation,false)
 await assert.rejects(p.confirmOne(p.rows.value[1]),/CST_RATE_PENDING/)
 assert.ok(prompts[0].includes('单位成本 待补 MXN'))
 assert.deepEqual(calls,[{path:'/cst/inbound-costs/8/confirm',body:{bizDate:'2026-10-16'}}])
 assert.equal(native.bizDate,'2026-09-30')
})

test('original allocation setup preserves business references and falls back to real fee and batch IDs from the native DTO',async()=>{
 const native={id:2813,feeId:2736,baseAmount:250,status:'CONFIRMED',lines:[{batchId:2521,qty:30,amount:156.25},{batchId:2582,batchNo:'SEA-SECOND',qty:18,amount:93.75}]}
 const p=loadVueScript(new URL('../src/modules/cost/AllocationList.vue',import.meta.url),{
  ref:vue.ref,reactive:vue.reactive,onMounted(){},useUserStore:()=>({hasPerm:()=>true}),createCommandIntent:()=>({reset(){}}),ElMessage:{success(){},warning(){},info(){}},
  allRecords:async()=>[native,{...native,id:2833,feeNo:'MX-LGS-FEE-000002'}],http:{postIdem:async()=>native},
 },['load','rows','run','preview','form'])
 await p.load();assert.equal(p.rows.value[0].feeNo,'#2736');assert.equal(p.rows.value[1].feeNo,'MX-LGS-FEE-000002')
 p.form.feeId=2736;await p.run(false)
 assert.equal(p.preview.value.lines[0].batchNo,'#2521');assert.equal(p.preview.value.lines[1].batchNo,'SEA-SECOND')
 assert.deepEqual(p.preview.value.lines.map(x=>x.amount),[156.25,93.75]);assert.equal(native.feeNo,undefined);assert.equal(native.lines[0].batchNo,undefined)
})
