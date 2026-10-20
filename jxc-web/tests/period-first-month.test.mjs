import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

test('period generator sends the explicitly selected first fiscal month while preserving January default', async () => {
  const calls=[]
  const scope=loadVueScript(new URL('../src/modules/finance/BookList.vue',import.meta.url), {
    ref:vue.ref,reactive:vue.reactive,onMounted(){},ElMessage:{success(){}},ElMessageBox:{confirm:async()=>{}},createCommandIntent:()=>({reset(){}}),useUserStore:()=>({hasPerm:()=>true}),
    http:{get:async()=>[],postIdem:async(path,body)=>{calls.push({path,body});return {created:3}}},
  }, ['fiscalYear','firstMonth','gen'])
  assert.equal(scope.firstMonth.value,1)
  scope.fiscalYear.value=2026;scope.firstMonth.value=10
  await scope.gen(601)
  assert.deepEqual(calls,[{path:'/fin/periods?bookId=601',body:{fiscalYear:2026,firstMonth:10}}])
})

test('period generation respects configuration permission before sending a command', async () => {
  const calls=[]
  const scope=loadVueScript(new URL('../src/modules/finance/BookList.vue',import.meta.url), {
    ref:vue.ref,reactive:vue.reactive,onMounted(){},ElMessage:{success(){}},ElMessageBox:{confirm:async()=>{}},createCommandIntent:()=>({reset(){}}),useUserStore:()=>({hasPerm:()=>false}),
    http:{get:async()=>[],postIdem:async(...args)=>{calls.push(args);return {created:0}}},
  }, ['gen'])
  await scope.gen(601)
  assert.deepEqual(calls,[])
})

function bookPage(http, { permitted = true, confirm = async () => {} } = {}) {
  return loadVueScript(new URL('../src/modules/finance/BookList.vue',import.meta.url), {
    ref:vue.ref,reactive:vue.reactive,onMounted(){},ElMessage:{success(){}},ElMessageBox:{confirm},
    createCommandIntent:()=>({reset(){}}),useUserStore:()=>({hasPerm:()=>permitted}),http,
  }, ['edit','save','activate','form','dialog','busy'])
}

test('book edit sends only the name and version captured when its dialog opened', async () => {
  const calls=[], row={id:601,version:4,name:'Before',baseCurrency:'MXN',entityId:301,status:'ACTIVE'}
  const scope=bookPage({get:async()=>[],putIdem:async(path,body)=>{calls.push({path,body})}})
  scope.edit(row); row.version=9; scope.form.name='After'
  await scope.save()
  assert.deepEqual(calls,[{path:'/fin/books/601',body:{name:'After',version:4}}])
  assert.equal(scope.dialog.value,false)
})

test('book activation confirms the original version without submitting opening data or generating periods', async () => {
  const calls=[], confirmations=[]
  const scope=bookPage({get:async()=>[],postIdem:async(path,body)=>{calls.push({path,body})}}, {confirm:async message=>confirmations.push(message)})
  await scope.activate({id:603,version:2,status:'DRAFT',name:'Draft'})
  assert.deepEqual(calls,[{path:'/fin/books/603/activate',body:{version:2}}])
  assert.match(confirmations[0],/不录入期初/)
  assert.equal(scope.busy.value,false)
})

test('book activation cancels without a command and rejects permission or state changes', async () => {
  const calls=[], http={get:async()=>[],postIdem:async(...args)=>calls.push(args)}
  const denied=bookPage(http,{permitted:false})
  await denied.activate({id:603,version:1,status:'DRAFT'})
  const scope=bookPage(http,{confirm:async()=>{throw new Error('cancel')}})
  await assert.rejects(scope.activate({id:603,version:1,status:'DRAFT'}),/cancel/)
  assert.equal(scope.busy.value,false)
  await scope.activate({id:603,version:1,status:'ACTIVE'})
  assert.deepEqual(calls,[])
})
