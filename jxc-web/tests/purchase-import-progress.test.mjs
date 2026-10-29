import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { computed, compile, createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { loadVueScript } from './contracts/load-vue-script.mjs'
import { loadTsModule } from './contracts/load-ts-module.mjs'
const path = new URL('../src/modules/purchase/purchaseImportModel.ts', import.meta.url)
const taskId = '11111111-2222-4333-8444-555555555555', batchId = '22222222-2222-4333-8444-555555555555'
const header = { bookId: null, supplierId: null, currency: null, orderDate: null, expectedDate: null, paymentTerms: '', prepayRatio: null, termDays: null }
const task = (status = 'RUNNING', progress = null) => ({ id: taskId, sourceId: 8, fileName: '采购.xlsx', kind: 'PARSE', attemptCount: 1, status, progress })
const progress = (phase = 'PARSING', n = 1, total = 2) => ({ phase, processedRows: n, totalRows: total, processedImages: 0, totalImages: null, sourceSheet: '采购', sourceRow: 2, attemptCount: 1, updatedAt: '2026-10-29T10:00:00Z' })
function setup(overrides = {}) {
  let saved = { batchId, header, version: 1, status: 'PARSING', rows: [], tasks: [task()] }
  const calls = []
  const api = { async upload(_file, _batch, _key, report) { if(report)report(100,100); return { ...saved, taskId } }, async load() { calls.push('batch'); return saved }, async readTask() { calls.push('task'); return saved.tasks[0] }, ...overrides }
  const page = loadTsModule(path).createPurchaseImportModel(api, '2026-10-29')
  return { page, calls, set: value => { saved = value }, batch: () => saved }
}
function view(state) {
  const url = new URL('../src/modules/purchase/purchaseImportProgress.ts', import.meta.url)
  assert.ok(existsSync(url), '缺少真实进度显示模型')
  return loadTsModule(url).importProgressView(state)
}
test('上传100%只表示等待接收，收到任务后行数未知不得显示导入成功', async () => {
  let finish
  const { page } = setup({ upload: async (_file,_batch,_key,report) => { assert.equal(typeof report,'function'); report(10,10); return new Promise(resolve=>{finish=resolve}) } })
  const sending=page.importFile(new File(['xlsx'],'采购.xlsx'))
  assert.match(view(page.state).title,/接收|确认/); assert.equal(view(page.state).complete,false)
  finish({ batchId,header,rows:[],status:'PARSING',tasks:[task()],taskId }); await sending
  assert.equal(view(page.state).percentage,null); assert.equal(view(page.state).complete,false)
})
test('真实行数表示当前步骤，保存中的100%仍不表示任务完成', () => {
  const { page }=setup(); Object.assign(page.state,{batchId,status:'PARSING',tasks:[task('RUNNING',progress('SAVING',2,2))],activeTaskId:taskId})
  assert.equal(view(page.state).percentage,100); assert.equal(view(page.state).complete,false); assert.match(view(page.state).title,/保存/)
})
test('图片处理中按真实图片计数显示，行数已满时仍不能代替图片进度', () => {
  const {page}=setup();Object.assign(page.state,{tasks:[task('RUNNING',progress('EXTRACTING_IMAGES',2,2))]})
  assert.equal(view(page.state).percentage,null);assert.match(view(page.state).images,/待统计/)
  Object.assign(page.state.tasks[0].progress,{phase:'PREPARING_IMAGES',processedImages:1,totalImages:4})
  assert.equal(view(page.state).percentage,25);assert.equal(view(page.state).complete,false)
})
test('进度读取失败保留上一计数，下次查询可恢复，不重复提交文件', async () => {
  let fail=true
  const { page,calls }=setup({ async readTask(){calls.push('task');if(fail)throw new Error('查询超时');return task('RUNNING',progress())} })
  await page.loadBatch(batchId); assert.equal(await page.refreshTasks(),false)
  assert.match(page.state.progressError,/超时/); assert.equal(page.state.status,'PARSING')
  fail=false; assert.equal(await page.refreshTasks(),true); assert.equal(page.state.progressError,''); assert.equal(page.state.tasks[0].progress.processedRows,1)
  assert.deepEqual(calls,['batch','task','task'])
})
test('失败保持实际步骤，处理过的行数不能当成已保存行数', () => {
  const { page }=setup(); Object.assign(page.state,{batchId,status:'FAILED',tasks:[{...task('FAILED',progress('SAVING',1,2)),errorMessage:'第3行保存失败'}],activeTaskId:taskId})
  const display=view(page.state); assert.equal(display.complete,false); assert.match(display.message,/未保存/); assert.match(display.message,/第3行/)
})
test('完成摘要使用当前任务结果，刷新后可恢复，不采用整个批次累计行数', () => {
  const { page }=setup(); Object.assign(page.state,{batchId,status:'REVIEW',rows:Array(100).fill({}),tasks:[{...task('SUCCEEDED',progress('LINKING',2,2)),result:{rows:2,images:1}}]})
  const display=view(page.state); assert.equal(display.complete,true); assert.match(display.message,/2.*1/); assert.doesNotMatch(display.message,/100/)
})
test('切换上下文后的旧进度响应不会覆盖新页面', async () => {
  let finish
  const { page }=setup({ readTask: async()=>new Promise(resolve=>{finish=resolve}) }); await page.loadBatch(batchId)
  const pending=page.refreshTasks(); page.invalidate(); finish(task('RUNNING',progress()))
  assert.equal(await pending,false); assert.equal(page.state.batchId,null); assert.equal(page.state.tasks.length,0)
})
test('任务成功后仅刷新一次明细，刷新失败明确保留后台完成事实并重试读取', async () => {
  let reads=0
  const { page,calls,batch }=setup({ async readTask(){calls.push('task');return {...task('SUCCEEDED',progress('LINKING',2,2)),result:{rows:2,images:0}}}, async load(){reads++;if(reads===2)throw new Error('明细读取失败');return reads===1?batch():{...batch(),status:'REVIEW',tasks:[{...task('SUCCEEDED'),result:{rows:2,images:0}}]}} })
  await page.loadBatch(batchId)
  assert.equal(await page.refreshTasks(),false); assert.equal(page.state.tasks[0].status,'SUCCEEDED'); assert.equal(page.state.progressReloadNeeded,true)
  assert.equal(await page.refreshTasks(),true); assert.equal(page.state.progressReloadNeeded,false); assert.equal(page.state.status,'REVIEW')
  assert.deepEqual(calls,['task'])
})
test('重试清除旧计数，先前尝试的迟到读取不能恢复旧状态', async () => {
  let finish
  const { page,batch }=setup({readTask:async()=>new Promise(resolve=>{finish=resolve}),async retryTask(){return {id:taskId,status:'QUEUED'}}})
  await page.loadBatch(batchId);const pending=page.refreshTasks()
  page.state.tasks[0].status='FAILED'; page.state.status='FAILED';page.state.tasks[0].progress=progress()
  assert.equal(await page.retryTask(page.state.tasks[0]),true)
  finish(task('RUNNING',progress('SAVING',2,2)));assert.equal(await pending,false)
  assert.equal(page.state.tasks[0].status,'QUEUED');assert.equal(page.state.tasks[0].progress,null)
})
test('解析已完成时后续商品任务沿用批次查询，不重复读取已完成解析任务', async () => {
  const {page,calls,batch,set}=setup()
  set({...batch(),status:'REVIEW',tasks:[task('SUCCEEDED'),{id:'33333333-2222-4333-8444-555555555555',kind:'MATCH',status:'RUNNING'}]})
  await page.loadBatch(batchId);await page.refreshTasks()
  assert.deepEqual(calls,['batch','batch'])
})
test('真实进度模板呈现当前步骤、行数与未保存提示', async () => {
  const { page }=setup();Object.assign(page.state,{batchId,status:'FAILED',activeTaskId:taskId,tasks:[{...task('FAILED',progress('SAVING',1,2)),errorMessage:'第3行保存失败'}]})
  const source=new URL('../src/modules/purchase/PurchaseImportProgress.vue',import.meta.url)
  const {importProgressView}=loadTsModule(new URL('../src/modules/purchase/purchaseImportProgress.ts',import.meta.url))
  const state=loadVueScript(source,{computed,importProgressView,defineProps:()=>({page})},['display','steps'])
  const template=readFileSync(source,'utf8').match(/<template>([\s\S]*)<\/template>/)[1]
  const app=createSSRApp({setup:()=>({...state,page}),render:compile(template)})
  app.component('ElProgress',defineComponent({props:['percentage'],setup:(props)=>()=>h('div',{'role':'progressbar','aria-valuenow':props.percentage})}))
  app.component('ElButton',defineComponent({setup:(_,ctx)=>()=>h('button',ctx.slots.default?.())}))
  const html=await renderToString(app)
  assert.match(html,/当前步骤进度/);assert.match(html,/1 \/ 2/);assert.match(html,/aria-valuenow="50"/);assert.match(html,/本次未保存明细/);assert.match(html,/第3行保存失败/);assert.match(html,/保存采购明细/);assert.match(html,/采购!2/)
})
