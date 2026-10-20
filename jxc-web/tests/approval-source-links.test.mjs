import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as Vue from 'vue'
import { compile as compileTemplate } from '@vue/compiler-dom'
import { computed, createRenderer, defineComponent, h, reactive, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'
const helperCode = ts.transpileModule(readFileSync(new URL('../src/utils/finance-source.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { financeSourcePath } = await import('data:text/javascript;base64,' + Buffer.from(helperCode).toString('base64'))
const approvalFile = new URL('../src/modules/approval/ApprovalTaskList.vue', import.meta.url)
function clickSource(type) {
 const source = readFileSync(approvalFile, 'utf8'), calls = []
 const bindings = ['detail', 'DOC_LINKS', ...(source.includes('function documentLink(') ? ['documentLink'] : [])]
 const page = loadVueScript(approvalFile, { reactive, ref, onMounted() {}, defineProps: () => ({ mode: 'todo' }), useTodoStore: () => ({}), useUserStore:()=>({fieldAccess:()=> 'READ',hasPerm:()=>true}),financeSourcePath }, bindings)
 page.detail.value = { docType: type, docId: 44 }
 const template = source.match(/<div v-if="(?:DOC_LINKS|documentLink)[\s\S]*?(?=<h4>审批记录)/)[0]
 const renderer = createRenderer({ createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: text => ({ comment: text }), setText: (n,t) => { n.text=t }, setElementText: (n,t) => { n.text=t }, insert: (n,p) => { p.children.push(n) }, remove() {}, patchProp: (n,k,_previous,value) => { n[k]=value }, parentNode: () => null, nextSibling: () => null })
 const app = renderer.createApp({ setup: () => page, render: new Function('Vue', ts.transpileModule(compileTemplate(`<div>${template}</div>`, { mode:'function', prefixIdentifiers:true, expressionPlugins:['typescript'] }).code, { compilerOptions:{ target:ts.ScriptTarget.ES2022 } }).outputText)(Vue) })
 app.config.globalProperties.$router = { push: route => calls.push(route) }
 app.component('ElButton', defineComponent({ setup: (_, ctx) => () => h('button', ctx.attrs, ctx.slots.default?.()) }))
 app.component('ElAlert', defineComponent({ props: ['title'], setup: p => () => h('p', p.title) }))
 const root = { children: [] }; app.mount(root)
 function walk(n) { return [n, ...(n.children ?? []).flatMap(walk)] }
 const nodes = walk(root), button = nodes.find(n => n.tag === 'button'); button?.onClick?.()
 const text = nodes.map(n => n.text ?? '').join(''); app.unmount(); return { calls, text }
}
test('actual approval source button navigates to the registered sales detail route', () => {
 assert.deepEqual(clickSource('SALES_ORDER').calls, [{ path: '/sales/orders/44', query: {} }])
})
test('actual approval source button reuses the registered refund source reference', () => {
 assert.deepEqual(clickSource('REFUND').calls, [{ path: '/returns/refunds', query: { sourceId: 44 } }])
})
test('unregistered workflow sources show an explicit unavailable page instead of inventing a route', () => {
 const result=clickSource('FUTURE_UNREGISTERED'); assert.deepEqual(result.calls, []); assert.match(result.text, /暂无独立页面/)
})
async function refundSource(sourceId, denied=false) {
 const calls=[], pending=[]
 const page=loadVueScript(new URL('../src/modules/returns/RefundList.vue', import.meta.url), { computed, reactive, ref, getCountryId:()=>3,getToken:()=> 'session',createCommandIntent: () => ({}), useUserStore: () => ({fieldAccess:()=> 'HIDDEN',hasPerm:()=>true}), useCountryStore: () => ({epoch:1}), useRoute: () => ({ query: { sourceId } }), watch: (source, callback, options) => { if(options?.immediate)pending.push(Promise.resolve(callback(source()))) }, http: { get: async url => { calls.push(['GET',url]); if(denied)throw new Error('native owner denied'); return { id:44,docNo:'RF-44',currency:'CNY',amount:14,status:'PENDING_APPROVAL' } } } }, ['pay'])
 await Promise.allSettled(pending); return { calls, pay:page.pay }
}
test('refund source reference loads only the original owner GET and opens read-only detail', async () => {
 const actual=await refundSource('44'); assert.deepEqual(actual.calls,[['GET','/rtn/refunds/44']]); assert.equal(actual.pay.visible,true); assert.equal(actual.pay.readonly,true); assert.equal(actual.pay.row.id,44)
})
test('a denied refund source never opens stale detail or a payment form', async () => {
 const actual=await refundSource('44',true); assert.deepEqual(actual.calls,[['GET','/rtn/refunds/44']]); assert.equal(actual.pay.visible,false); assert.equal(actual.pay.row,null)
})
function deferredRefund(field='READ') {
 const pending=[],context={country:3,token:'first'},country=reactive({epoch:1}),route=reactive({query:{}})
 const page=loadVueScript(new URL('../src/modules/returns/RefundList.vue',import.meta.url),{computed,reactive,ref,createCommandIntent:()=>({}),getCountryId:()=>context.country,getToken:()=>context.token,useUserStore:()=>({fieldAccess:()=>field,hasPerm:()=>true}),useCountryStore:()=>country,useRoute:()=>route,watch(){},http:{get:url=>new Promise(resolve=>pending.push({url,resolve}))}},['pay','openDetail','openPay',...(readFileSync(new URL('../src/modules/returns/RefundList.vue',import.meta.url),'utf8').includes('canReadRefundProof')?['canReadRefundProof']:[])])
 return {page,pending,context,country,route}
}
test('an earlier refund GET cannot replace the latest requested source',async()=>{
 const x=deferredRefund(),first=x.page.openDetail(44),second=x.page.openDetail(45)
 x.pending[1].resolve({id:45});await second;x.pending[0].resolve({id:44});await first
 assert.equal(x.page.pay.row.id,45)
})
test('country or session changes discard pending refund detail',async()=>{
 for(const key of ['country','token']){const x=deferredRefund(),request=x.page.openDetail(44);x.context[key]=key==='country'?183:'second';x.pending[0].resolve({id:44});await request;assert.equal(x.page.pay.visible,false);assert.equal(x.page.pay.row,null)}
})
test('opening a native payment form cancels an earlier read-only detail request',async()=>{
 const x=deferredRefund(),request=x.page.openDetail(44);x.page.openPay({id:45,status:'APPROVED'});x.pending[0].resolve({id:44});await request
 assert.equal(x.page.pay.row.id,45);assert.equal(x.page.pay.readonly,false)
})
test('refund proof attachment never mounts without BANK_INFO read permission',()=>{
 const file=new URL('../src/modules/returns/RefundList.vue',import.meta.url),source=readFileSync(file,'utf8'),start=source.indexOf('<DocAttachment v-if="pay.row'),end=source.indexOf('<ApprovalPanel',start),template=source.slice(start,end)
 for(const [field,expected] of [['HIDDEN',0],['READ',1]]){
  const x=deferredRefund(field);x.page.pay.row={id:44};x.page.pay.readonly=true;let mounted=0
  const renderer=createRenderer({createElement:tag=>({tag,children:[]}),createText:text=>({text}),createComment:text=>({comment:text}),setText(){},setElementText(){},insert:(n,p)=>p.children.push(n),remove(){},patchProp(){},parentNode:()=>null,nextSibling:()=>null})
  const app=renderer.createApp({setup:()=>x.page,render:new Function('Vue',ts.transpileModule(compileTemplate(`<div>${template}</div>`,{mode:'function',prefixIdentifiers:true,expressionPlugins:['typescript']}).code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(Vue)})
  app.component('DocAttachment',defineComponent({setup(){mounted++;return()=>h('span','attachment')}}));app.mount({children:[]});assert.equal(mounted,expected);app.unmount()
 }
})
function taskAttachment(type,{fieldAccess=()=> 'READ',hasPerm=()=>true}={}){
 const source=readFileSync(approvalFile,'utf8'),bindingNames=['detail',...(source.includes('const ATTACHMENT_CATEGORY')?['ATTACHMENT_CATEGORY']:['attachment','canReadAttachment','canWriteAttachment'])]
 const page=loadVueScript(approvalFile,{reactive,ref,onMounted(){},defineProps:()=>({mode:'todo'}),useTodoStore:()=>({}),useUserStore:()=>({fieldAccess,hasPerm}),financeSourcePath},bindingNames);page.detail.value={docType:type,docId:44}
 const template=source.slice(source.indexOf('<h4>单据附件</h4>'),source.indexOf('<div v-if="mode === \'todo\'" class="drawer-actions">')),calls=[]
 const renderer=createRenderer({createElement:tag=>({tag,children:[]}),createText:text=>({text}),createComment:text=>({comment:text}),setText(){},setElementText:(n,t)=>n.text=t,insert:(n,p)=>p.children.push(n),remove(){},patchProp(){},parentNode:()=>null,nextSibling:()=>null})
 const app=renderer.createApp({setup:()=>({...page,mode:'todo'}),render:new Function('Vue',ts.transpileModule(compileTemplate(`<div>${template}</div>`,{mode:'function',prefixIdentifiers:true,expressionPlugins:['typescript']}).code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(Vue)})
 app.component('DocAttachment',defineComponent({props:['bizType','bizId','category','readonly'],setup:p=>{calls.push({...p});return()=>h('span','attachment')}}));const root={children:[]};app.mount(root)
 const text=n=>(n.text??'')+(n.children??[]).map(text).join('');const result={calls,text:text(root)};app.unmount();return result
}
test('approval drawer uses exact registered sales and refund attachment identities with read-only field access',()=>{
 for(const [type,bizType,category]of [['SALES_ORDER','SAL_ORDER','SALES_DOC'],['REFUND','REFUND','REFUND_PROOF']])assert.deepEqual(taskAttachment(type).calls,[{bizType,bizId:44,category,readonly:true}])
})
test('approval drawer never mounts a source attachment without its field and source read permissions',()=>{
 for(const [type,hidden]of [['SALES_ORDER','CUSTOMER_PRICE'],['REFUND','BANK_INFO'],['REFUND','ORDER_TOTAL'],['PURCHASE_ORDER','COST']])assert.deepEqual(taskAttachment(type,{fieldAccess:g=>g===hidden?'HIDDEN':'READ'}).calls,[])
 assert.deepEqual(taskAttachment('PURCHASE_ORDER',{hasPerm:()=>false}).calls,[])
})
test('unregistered workflow attachment categories remain explicitly unavailable',()=>{
 const result=taskAttachment('FUTURE_UNREGISTERED');assert.deepEqual(result.calls,[]);assert.match(result.text,/未提供附件入口/)
})
