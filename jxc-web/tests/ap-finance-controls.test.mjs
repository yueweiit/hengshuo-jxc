import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
const base={ref:vue.ref,reactive:vue.reactive,computed:vue.computed,onMounted(){},onBeforeUnmount(){},watch(){},useRouter:()=>({push:async()=>{}}),useRoute:()=>({params:{id:801},query:{}}),useCountryStore:()=>({currency:'MXN'}),useUserStore:()=>({hasPerm:()=>true}),createCommandIntent:()=>({reset(){}}),ElMessage:{success(){},warning(){}},AP_BILL_STATUS:[],PARTNER_SOURCE:[]}
test('original AP receipt selection submits its remaining base quantity instead of its full original quantity',async()=>{
 const calls=[];const receipt={sourceType:'PUR_RECEIPT_LINE',sourceId:1394,sourceNo:'国内收货行 #1394',partnerId:81,qty:80,openQty:30,unit:'PCS',unitPrice:10,currency:'CNY',amount:800}
 const p=loadVueScript(new URL('../src/modules/ap/ApBillList.vue',import.meta.url),{...base,http:{get:async()=>({poLines:[receipt],fees:[]}),postIdem:async(path,body)=>calls.push({path,body})}},['open','pickSources','create','sources'])
 await p.open();p.pickSources(p.sources.poLines);await p.create();assert.equal(calls[0].path,'/ap/bills/from-sources');assert.equal(calls[0].body.sources[0].sourceType,'PUR_RECEIPT_LINE');assert.equal(calls[0].body.sources[0].sourceId,1394);assert.equal(calls[0].body.sources[0].qty,30);assert.equal(receipt.qty,80,'selector must not mutate its owner-provided original basis')
})
test('AP recognition editor submits explicit subject and current configuration version',async()=>{
 const calls=[];const p=loadVueScript(new URL('../src/modules/ap/ApBillList.vue',import.meta.url),{...base,allRecords:async()=>[{id:201,displayName:'Accountant',status:'ENABLED'}],http:{get:async path=>({id:1,version:4,mode:'RECEIPT_CONFIRMED',executionSubjectUserId:201}),putIdem:async(path,body)=>calls.push({path,body})}},['showRecognition','saveRecognition','recognitionForm'])
 await p.showRecognition();p.recognitionForm.mode='MANUAL';await p.saveRecognition();assert.equal(calls[0].body.version,4);assert.equal(calls[0].body.executionSubjectUserId,null);assert.equal(calls[0].body.mode,'MANUAL')
})
test('AP statement export uses the saved statement book and id',async()=>{
 const calls=[];const p=loadVueScript(new URL('../src/modules/ap/PartnerLedger.vue',import.meta.url),{...base,allRecords:async()=>[],http:{postIdem:async(path,body)=>calls.push({path,body})}},['form','exportStatement'])
 p.form.result={id:999,bookId:601};p.form.bookId=602;await p.exportStatement();assert.equal(calls[0].path,'/ap/statements/999/export');assert.equal(calls[0].body.bookId,601)
})
test('AP funding selectors read complete references and require an explicit book when multiple books are available',async()=>{
 for(const component of ['ApPaymentList','ApPrepaymentList']){
  const calls=[];const p=loadVueScript(new URL(`../src/modules/ap/${component}.vue`,import.meta.url),{...base,todayIn:()=> '2026-10-15',allRecords:async(path,q)=>{calls.push({path,q});if(path==='/fin/books')throw new Error('AP-only actor cannot read financial setup');if(path==='/org/books')return [{id:601,entityId:301,status:'ACTIVE'},{id:602,entityId:302,status:'ACTIVE'},{id:603,entityId:301,status:'DISABLED'}];if(path==='/md/partners')return Array.from({length:230},(_,i)=>({id:i+1}));if(path==='/md/fund-accounts')return [{id:901,bookId:601,entityId:301,currency:'MXN'},{id:902,bookId:602,entityId:302,currency:'MXN'}];return [{code:'MXN'}]},http:{get:async()=>({records:[]})}},['open','form','partners','accounts','bookChanged'])
  await p.open();assert.equal(p.partners.value.length,230);assert.equal(p.form.bookId,undefined);assert.equal(p.form.fundAccountId,undefined)
  p.form.bookId=601;p.bookChanged();assert.deepEqual(p.accounts.value.map(x=>x.id),[901]);p.form.fundAccountId=901;p.form.bookId=602;p.bookChanged();assert.equal(p.form.fundAccountId,undefined);assert.deepEqual(p.accounts.value.map(x=>x.id),[902]);assert.ok(calls.some(c=>c.path==='/org/books'))
 }
})
test('AP settlement reads all current-book funding rows and discards delayed prior-partner results',async()=>{
 let release;const delayed=new Promise(r=>{release=r});const calls=[]
 const p=loadVueScript(new URL('../src/modules/ap/ApSettlementList.vue',import.meta.url),{...base,allRecords:async(path,q)=>{calls.push({path,q});if(q?.partnerId===801){await delayed;return [{id:1,bookId:601,partnerId:801,status:'CONFIRMED',openAmount:5}]};return Array.from({length:210},(_,i)=>({id:i+100,bookId:601,partnerId:802,status:'CONFIRMED',openAmount:5}))},http:{get:async(path,q)=>path==='/ap/payments'||path==='/ap/prepayments'?{records:Array.from({length:50},(_,i)=>({id:i,bookId:601,partnerId:802,status:'CONFIRMED',openAmount:5}))}:[{id:q?.partnerId,bookId:601,partnerId:q?.partnerId,openAmount:5}]}},['form','load','payments'])
 p.form.bookId=601;p.form.partnerId=801;const old=p.load();p.form.partnerId=802;await p.load();release();await old;assert.equal(p.payments.value.length,210);assert.ok(p.payments.value.every(r=>r.partnerId===802));assert.ok(calls.some(c=>c.path==='/ap/payments'&&c.q.partnerId===802&&c.q.bookId===601))
})
test('AP settlement offers only active books and can select the single active book',async()=>{
 const p=loadVueScript(new URL('../src/modules/ap/ApSettlementList.vue',import.meta.url),{...base,allRecords:async path=>path==='/org/books'?[{id:601,status:'ACTIVE'},{id:602,status:'DISABLED'}]:[],http:{}},['open','books','form'])
 await p.open();assert.deepEqual(p.books.value.map(b=>b.id),[601]);assert.equal(p.form.bookId,601)
})
