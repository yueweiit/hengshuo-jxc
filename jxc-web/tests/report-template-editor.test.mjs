import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
test('account map editor sends controlled account and prior-row formulas in a reviewed-version draft',async()=>{
 const calls=[]
 const scope=loadVueScript(new URL('../src/modules/finance/ReportView.vue',import.meta.url),{ ref:vue.ref,reactive:vue.reactive,computed:vue.computed,onMounted(){},allRecords:async()=>[],useRouter:()=>({}),useCountryStore:()=>({}),useUserStore:()=>({hasPerm:()=>true}),createCommandIntent:()=>({}),ElMessage:{success(){}},ElMessageBox:{confirm:async()=>{}},http:{get:async()=>({records:[]}),postIdem:async(path,body)=>calls.push({path,body}),put:async()=>{} }},['bookId','tab','templateForm','createTemplate','editTemplate'])
 scope.bookId.value=601;scope.tab.value='INCOME'
 scope.editTemplate({id:9,version:4,status:'ACTIVE',name:'Reviewed',rule:'ACCOUNT_MAP_V1',lines:[{code:'REVENUE',name:'收入',formula:'PERIOD_NET',sign:-1,accountIds:[1],terms:[]},{code:'PROFIT',name:'利润',formula:'LINE_SUM',sign:1,accountIds:[],terms:[{code:'REVENUE',sign:1}]}]})
 scope.templateForm.name='Next version';await scope.createTemplate()
 assert.equal(calls[0].path,'/fin/report-templates');assert.equal(calls[0].body.rule,'ACCOUNT_MAP_V1');assert.equal(calls[0].body.lines[1].terms[0].code,'REVENUE');assert.equal(calls[0].body.lines[0].accountIds[0],1);assert.equal(calls[0].body.version,undefined)
})
