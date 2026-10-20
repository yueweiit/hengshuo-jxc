import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { COST_TREATMENTS } from '../src/modules/master/options.ts'

test('native expense-item form offers direct selling and period treatments while retaining the existing expense alias',()=>{
 const p=loadVueScript(new URL('../src/modules/master/ExpenseItemList.vue',import.meta.url),{
  ref:vue.ref,computed:vue.computed,onMounted(){},COST_TREATMENTS,ALLOC_BASES:[],FEE_CATEGORIES:[],STATUS_OPTIONS:[],http:{},allRecords:async()=>[],
 },['formFields'])
 const values=p.formFields.value.find(f=>f.prop==='costTreatment').options.map(o=>o.value)
 for(const value of ['CAPITALIZE','EXPENSE','PERIOD_EXPENSE','DIRECT_SELLING'])assert.ok(values.includes(value),`Missing native treatment ${value}`)
})
