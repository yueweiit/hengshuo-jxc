import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, ref } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/workbench/JobList.vue', import.meta.url)
const job = (id, extra = {}) => ({ id, jobType: 'FIN_REPORT_EXPORT', status: 'SUCCESS', bookId: 1, createdAt: '2026-10-23T06:00:00Z', expiresAt: '2099-10-30T06:00:00Z', lastError: null, ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function setup(options = {}) {
  const calls = [], hooks = { mounted: [], unmounted: [] }
  const country = { epoch: 1, current: { id: 1 }, timezone: 'America/Mexico_City' }
  const user = { hasPerm: value => Array.isArray(value) ? options.allowed !== false : options.diagnosticAccess === true }
  const intent = { reset: () => calls.push(['reset-intent']) }
  const page = loadVueScript(file, {
    computed, ref, onMounted: fn => hooks.mounted.push(fn), onBeforeUnmount: fn => hooks.unmounted.push(fn),
    statusDef: status => ({ label: status || '-', type: status === 'FAILED' ? 'danger' : 'info' }),
    useCountryStore: () => country, useUserStore: () => user,
    createCommandIntent: () => intent,
    allRecords: async (url, query, assertCurrent) => { calls.push(['records', url]); const result = await (options.records?.() ?? []); assertCurrent?.(); return result },
    http: {
      get: async url => { calls.push(['get', url]); if (!options.get) throw new Error(`Unexpected GET: ${url}`); return await options.get(url) },
      postIdem: async (...args) => { calls.push(['retry', ...args]); return await options.post?.(...args) },
    },
    ElMessage: { success: message => calls.push(['success', message]) },
    window: { matchMedia: () => ({ matches:false, addEventListener(){}, removeEventListener(){} }) },
    document: { createElement: () => ({ click: () => calls.push(['download-click']) }) },
    URL: { createObjectURL: blob => { calls.push(['blob',blob]); return 'blob:test' }, revokeObjectURL: value => calls.push(['revoke',value]) },
    Blob, setTimeout: fn => { fn(); return 1 },
  }, ['rows','page','size','keyword','typeFilter','activeStatus','filteredRows','pageRows','statusTabs','loading','listError','listForbidden','actionError','retryingId','downloadingId','selectedRow','loadJobs','search','resetFilters','changePage','changeSize','canDownload','canRetry','retry','download','openDetail','jobLabel','jobState','processingHint'])
  return { ...page, calls, hooks, country, user, intent }
}

test('jobs paginate the complete authorized collection and retain the existing allRecords endpoint', async () => {
  const p=setup({records:()=>Array.from({length:36},(_,i)=>job(1068-i))})
  await p.loadJobs()
  assert.deepEqual(p.calls[0],['records','/sys/jobs'])
  assert.equal(p.pageRows.value.length,20)
  p.changePage(2)
  assert.equal(p.pageRows.value.length,16)
  assert.equal(p.pageRows.value[0].id,1048)
  p.changeSize(50)
  assert.equal(p.page.value,1)
  assert.equal(p.pageRows.value.length,36)
  p.changeSize(100)
  assert.equal(p.pageRows.value.length,36)
})

test('keyword, type and status filters cover records beyond the initial page and reset page', async () => {
  const p=setup({records:()=>[...Array.from({length:25},(_,i)=>job(100+i)),job(999,{jobType:'AP_STATEMENT_EXPORT',status:'FAILED'})]})
  await p.loadJobs(); p.page.value=2
  p.keyword.value='999'; p.typeFilter.value='AP_STATEMENT_EXPORT'; p.activeStatus.value='FAILED'; p.search()
  assert.equal(p.page.value,1)
  assert.deepEqual(p.pageRows.value.map(row=>row.id),[999])
  assert.equal(p.statusTabs.value.find(tab=>tab.value==='all').count,26)
  p.resetFilters()
  assert.equal(p.filteredRows.value.length,26)
  assert.equal(p.keyword.value,'')
})

test('status groups include queued and legacy successful statuses without guessing unknown states', async () => {
  const p=setup({records:()=>['QUEUED','RUNNING','SUCCESS','COMPLETED','SUCCEEDED','UNRECOGNIZED'].map((status,i)=>job(i+1,{status}))})
  await p.loadJobs()
  assert.equal(p.statusTabs.value.find(tab=>tab.value==='active').count,2)
  assert.equal(p.statusTabs.value.find(tab=>tab.value==='SUCCESS').count,3)
  assert.equal(p.jobState('UNRECOGNIZED').label,'UNRECOGNIZED')
  assert.equal(p.jobState('UNRECOGNIZED').type,'info')
  assert.equal(p.jobLabel('NEW_EXPORT'),'NEW_EXPORT')
})

test('a successful refresh clamps a page after the authorized collection shrinks', async () => {
  let records=Array.from({length:36},(_,i)=>job(i+1)); const p=setup({records:()=>records})
  await p.loadJobs(); p.changePage(2); records=[job(1)]; await p.loadJobs()
  assert.equal(p.page.value,1); assert.equal(p.pageRows.value.length,1)
})

test('list failures and forbidden responses remain distinct from successful empty results', async () => {
  for (const error of [new Error('网络超时'),Object.assign(new Error('没有该操作权限'),{code:'SYS_FORBIDDEN'})]) {
    const p=setup({records:()=>{throw error}}); await p.loadJobs()
    assert.equal(p.listError.value,error.message); assert.equal(p.listForbidden.value,error.code==='SYS_FORBIDDEN')
    assert.equal(p.loading.value,false)
  }
  const p=setup(); await p.loadJobs(); assert.equal(p.listError.value,''); assert.deepEqual(p.rows.value,[])
})

test('mount and refresh read only export jobs even when the user can view global diagnostics', async () => {
  let records=[job(1,{status:'FAILED',lastError:'EXPORT_FAILED'})]
  const p=setup({diagnosticAccess:true,records:()=>records})
  await p.hooks.mounted[0]()
  records=[job(2)]
  await p.loadJobs()
  assert.deepEqual(p.calls,[['records','/sys/jobs'],['records','/sys/jobs']])
  assert.deepEqual(p.pageRows.value.map(row=>row.id),[2])
  assert.equal(p.listError.value,'')
})

test('missing page permission or country prevents protected reads', async () => {
  for (const mode of ['permission','country']) {
    const p=setup({allowed:mode!=='permission'}); if(mode==='country')p.country.current=null
    await p.loadJobs(); assert.deepEqual(p.calls,[])
  }
})

test('late list responses cannot replace the latest authorized collection or loading state', async () => {
  const first=deferred(),second=deferred(); let n=0; const p=setup({records:()=>++n===1?first.promise:second.promise})
  const old=p.loadJobs(), latest=p.loadJobs(); first.resolve([job(1)]); await old
  assert.equal(p.loading.value,true); assert.deepEqual(p.rows.value,[])
  second.resolve([job(2)]); await latest; assert.equal(p.rows.value[0].id,2); assert.equal(p.loading.value,false)
})

test('country changes and unmount discard pending export list responses', async () => {
  for (const stop of [p=>p.country.epoch++,p=>p.hooks.unmounted.forEach(fn=>fn())]) {
    const result=deferred(); const p=setup({records:()=>result.promise})
    const pending=p.loadJobs(); stop(p); result.resolve([job(1)]); await pending
    assert.deepEqual(p.rows.value,[])
  }
})

test('download and retry guards preserve successful, context-changed and expired rules', async () => {
  const p=setup()
  for (const status of ['SUCCESS','COMPLETED','SUCCEEDED']) assert.equal(p.canDownload(job(1,{status})),true)
  for (const status of ['QUEUED','FAILED']) assert.equal(p.canRetry(job(1,{status})),true)
  for (const row of [job(1,{status:'EXPIRED'}),job(2,{status:'RUNNING'}),job(3,{status:'FAILED',lastError:'JOB_CONTEXT_CHANGED'})]) {
    assert.equal(p.canDownload(row),false); assert.equal(p.canRetry(row),false); await p.retry(row); await p.download(row)
  }
  assert.deepEqual(p.calls,[])
})

test('retry is serialized, uses the existing intent, and refreshes authoritative status', async () => {
  const pending=deferred(); const row=job(1,{status:'FAILED'}); const p=setup({post:()=>pending.promise,records:()=>[row]})
  const retry=p.retry(row); await p.retry(row)
  assert.equal(p.calls.filter(call=>call[0]==='retry').length,1)
  assert.equal(p.calls[0][1],'/sys/jobs/1/retry'); assert.equal(p.calls[0][3],p.intent)
  pending.resolve({status:'QUEUED'}); await retry
  assert.equal(p.calls.some(call=>call[0]==='reset-intent'),true)
  assert.equal(p.rows.value[0].status,'FAILED')
  assert.equal(p.retryingId.value,null)
})

test('failed retries retain their command intent and visible reason without claiming success', async () => {
  const p=setup({post:()=>{throw new Error('会话已失效')}}); await p.retry(job(1,{status:'FAILED'}))
  assert.match(p.actionError.value,/会话已失效/)
  assert.equal(p.calls.some(call=>call[0]==='reset-intent'||call[0]==='success'),false)
  assert.equal(p.retryingId.value,null)
})

test('downloads keep the server-provided content and filename and revoke the temporary object URL', async () => {
  const p=setup({get:()=>({filename:'财务报表.csv',content:'标题,金额\n报表,123',contentType:'text/csv;charset=UTF-8'})})
  await p.download(job(1))
  assert.equal(p.calls.find(call=>call[0]==='get')[1],'/sys/jobs/1/download')
  assert.equal(await p.calls.find(call=>call[0]==='blob')[1].text(),'标题,金额\n报表,123')
  assert.equal(p.calls.some(call=>call[0]==='download-click'),true)
  assert.equal(p.calls.some(call=>call[0]==='revoke'),true)
})

test('malformed or rejected downloads surface an error without generating an empty file', async () => {
  for (const get of [()=>({filename:'x.csv'}),()=>{throw new Error('导出已过期，请重新发起')}]) {
    const p=setup({get}); await p.download(job(1))
    assert.notEqual(p.actionError.value,''); assert.equal(p.calls.some(call=>call[0]==='download-click'),false)
  }
})

test('pending actions after country changes do not download files or reset another context intent', async () => {
  for (const action of ['download','retry']) {
    const result=deferred(); const p=setup({get:()=>result.promise,post:()=>result.promise})
    const pending=p[action](job(1,{status:action==='retry'?'FAILED':'SUCCESS'})); p.country.epoch++
    result.resolve({filename:'old.csv',content:'old country'}); await pending
    assert.equal(p.calls.some(call=>['download-click','reset-intent','success'].includes(call[0])),false)
  }
})

test('details use existing fields and stay consistent after a reload', async () => {
  let records=[job(1,{status:'FAILED',lastError:'JOB_CONTEXT_CHANGED'})];const p=setup({records:()=>records})
  await p.loadJobs(); p.openDetail(records[0]); assert.match(p.processingHint(p.selectedRow.value).text,/会计期间/)
  records=[]; await p.loadJobs(); assert.equal(p.selectedRow.value,null)
})
