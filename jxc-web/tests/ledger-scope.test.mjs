import test from 'node:test'
import assert from 'node:assert/strict'
import * as vue from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
function deferred(){let resolve; const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
function page(http){return loadVueScript(new URL('../src/modules/finance/LedgerView.vue',import.meta.url),{ ref:vue.ref,computed:vue.computed,onMounted(){},http,createCommandIntent:()=>({reset(){}}),ElMessage:{success(){}},useUserStore:()=>({hasPerm:()=>true}),allRecords:async(path,q)=>(await http.get(path,q)).records,useCountryStore:()=>({}),useRouter:()=>({push(){}}),useRoute:()=>({query:{}})},['bookId','periodId','accountId','fundAccountId','auxKey','books','accounts','periods','detail','general','balance','journal','fundAccounts','changeBook','load','loadDetail'])}
test('ledger discards old book account responses and clears all old scoped filters',async()=>{
 const old=deferred();const p=page({get:async(path,q)=>q.bookId===1?old.promise:{records:[{id:20}]}})
 p.books.value=[{id:1,periods:[]},{id:2,periods:[]}];p.bookId.value=1;p.fundAccountId.value=11;p.auxKey.value='old';p.fundAccounts.value=[{id:11}]
 const first=p.changeBook();p.bookId.value=2;await p.changeBook();old.resolve({records:[{id:10}]});await first
 assert.deepEqual(p.accounts.value,[{id:20}]);assert.equal(p.fundAccountId.value,undefined);assert.equal(p.auxKey.value,'');assert.deepEqual(p.fundAccounts.value,[])
})
test('ledger discards delayed prior-period and prior-account or aux detail responses',async()=>{
 const old=deferred(),oldDetail=deferred();const p=page({get:async(path,q)=>{if(path.endsWith('/detail'))return q.accountId===10?oldDetail.promise:{account:{id:20},lines:[{id:'new-detail'}]};if(q.periodId===1)return old.promise;return path.endsWith('/journal')?{lines:[{id:'new',aux:{fundAccountId:22}}]}:{rows:[{id:'new'}]}}})
 p.bookId.value=1;p.periodId.value=1;const first=p.load();p.periodId.value=2;await p.load();old.resolve({rows:[{id:'old'}],lines:[{id:'old'}]});await first
 assert.equal(p.general.value.rows[0].id,'new');assert.equal(p.journal.value[0].id,'new')
 p.accountId.value=10;p.auxKey.value='A';const d1=p.loadDetail();p.accountId.value=20;p.auxKey.value='B';await p.loadDetail();oldDetail.resolve({account:{id:10},lines:[{id:'old-detail'}]});await d1
 assert.equal(p.detail.value.account.id,20)
 p.accountId.value=undefined;await p.loadDetail();assert.equal(p.detail.value,null)
})
test('journal fund filtering retains all available funds and never carries old-period selection',async()=>{
 const calls=[];const p=page({get:async(path,q)=>{calls.push({path,q});return path.endsWith('/journal')?{lines:[{id:1,aux:{fundAccountId:11}},{id:2,aux:{fundAccountId:22}}]}:{rows:[]}}})
 p.bookId.value=1;p.periodId.value=1;p.fundAccountId.value=11;await p.load();assert.deepEqual(p.fundAccounts.value.map(f=>f.id),[11,22]);assert.deepEqual(p.journal.value.map(r=>r.id),[1]);assert.ok(calls.filter(c=>c.path.endsWith('/journal')).every(c=>!c.q.fundAccountId))
})

test('journal uses the same selected account filter as its export without narrowing the fund choices',async()=>{
 const p=page({get:async(path,q)=>path.endsWith('/journal')?{lines:[{id:1,accountId:10,aux:{fundAccountId:11}},{id:2,accountId:20,aux:{fundAccountId:22}}]}:{rows:[]}})
 p.bookId.value=1;p.periodId.value=1;await p.load();p.accountId.value=20;assert.deepEqual(p.journal.value.map(r=>r.id),[2]);assert.deepEqual(p.fundAccounts.value.map(r=>r.id),[11,22])
})
