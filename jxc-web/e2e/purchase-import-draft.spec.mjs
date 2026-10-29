/** 独立执行：node e2e/purchase-import-draft.spec.mjs。真实页面写入；断点批次/创建意图保存在runtime。 */
import { chromium, expect } from '@playwright/test'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const dir=process.env.JXC_DUAL_DRAFT_EVIDENCE ?? 'C:/project/jxc/runtime/purchase-import-dual-draft'
const origin=process.env.JXC_DUAL_DRAFT_ORIGIN ?? 'http://127.0.0.1:60'
const file=dir+'/page-state.private.json'
const state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{template:{},supplier:{}}
const save=()=>writeFileSync(file,JSON.stringify(state,null,2),'utf8')
const accounts=JSON.parse(readFileSync('C:/project/jxc/runtime/jxc-env/jxc-test-01.accounts.secret.json','utf8'))
const account=accounts.find(a=>a.username==='mx02_admin');assert.ok(account,'缺少已有测试账号')
const browser=await chromium.launch({headless:true})
const context=await browser.newContext({viewport:{width:1600,height:1000},locale:'zh-CN',timezoneId:'Asia/Shanghai'})
const page=await context.newPage();page.setDefaultTimeout(20000)
let active='',latest=null,books=[],suppliers=[];const forbidden=[]
page.on('request',request=>{
  const path=new URL(request.url()).pathname
  if(request.method()!=='GET' && /\/api\/v1\/(lgs|inv|cst)\//.test(path) || request.method()!=='GET' && /\/(submit|approve)(\/|$)/.test(path))forbidden.push({method:request.method(),path})
})
page.on('response',async response=>{
  const path=new URL(response.url()).pathname,method=response.request().method()
  if(!path.startsWith('/api/v1/')||path.startsWith('/api/v1/auth/'))return
  if(response.headers()['content-type']?.includes('application/json')){
    const body=await response.json().catch(()=>null);if(!body)return
    if(active && latest && /^\/api\/v1\/pur\/order-imports\/tasks\//.test(path)){
      const index=latest.tasks.findIndex(t=>t.id===body.data?.id)
      if(index>=0){latest.tasks[index]={...latest.tasks[index],...body.data};if(latest.tasks[index].kind==='PARSE'&&['FAILED','NEEDS_REAUTH','STALE'].includes(body.data.status))latest.status='FAILED'}
    }
    if(path==='/api/v1/org/books')books=body.data
    if(path==='/api/v1/md/partners')suppliers.push(...(body.data?.records ?? []))
    if(active && body.data?.batchId && Array.isArray(body.data.rows)){
      latest=body.data;state[active].batchId=body.data.batchId;const created=body.data.groups?.find(g=>g.orderId);if(created)state[active].orderId=created.orderId;save()
    }
    if(method!=='GET'||response.status()>=400)appendFileSync(dir+'/page-network.private.jsonl',JSON.stringify({at:new Date().toISOString(),branch:active,method,path,status:response.status(),body})+'\n','utf8')
  }
})
const announce=message=>console.log(JSON.stringify({at:new Date().toISOString(),branch:active,message}))
async function command(path,action){
  const result=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1${path}`&&r.request().method()!=='GET',{timeout:180000})
  await action();const response=await result,body=await response.json();assert.equal(body.code,'OK',`${path}: ${body.message}`);
  if(body.data?.batchId&&Array.isArray(body.data.rows))latest=body.data
  else if(latest&&body.data?.id&&body.data.status==='QUEUED'&&path.endsWith('/retry')){const task=latest.tasks.find(t=>t.id===body.data.id);if(task){task.status='QUEUED';if(task.kind==='PARSE')latest.status='PARSING'}}
  else if(latest&&body.data?.rowNo){const index=latest.rows.findIndex(r=>r.id===body.data.id);if(index>=0)latest.rows[index]=body.data}
  return body.data
}
async function select(locator,text){
  await locator.click();const menu=page.locator('.el-select__popper:visible').last()
  await menu.getByRole('option').filter({hasText:text}).first().click()
}
async function refresh(){
  await page.getByRole('button',{name:'重新读取',exact:true}).click()
  await expect(page.locator('.purchase-import-workspace')).toHaveAttribute('aria-busy','false')
}
async function waitParsed(){
  for(let n=0;n<240;n++){
    if(latest?.status==='REVIEW'&&latest.rows.length)return
    if(latest?.tasks.some(t=>t.kind==='PARSE'&&['FAILED','NEEDS_REAUTH','STALE'].includes(t.status)))return
    if(n%12===0)announce('等待原文件解析')
    await page.waitForTimeout(2000)
  }throw Error('原文件解析超时，保留原批次')
}
async function header(){
  const existing=latest.header
  if(existing.bookId===6&&existing.supplierId===211&&existing.currency==='USD'&&existing.orderDate==='2026-10-29'&&existing.prepayRatio!==null&&Number(existing.prepayRatio)===0&&existing.termDays===0)return
  const book=books.find(b=>b.id===6),supplier=suppliers.find(s=>s.id===211);assert.ok(book);assert.ok(supplier)
  await select(page.getByRole('combobox',{name:'账套',exact:true}),book.name)
  await select(page.getByRole('combobox',{name:'供应商',exact:true}),supplier.name)
  await select(page.getByRole('combobox',{name:'币种',exact:true}),/^USD/)
  await page.locator('.import-header-form .el-form-item').filter({has:page.locator('label').filter({hasText:/^下单日期$/})}).locator('input').fill('2026-10-29');await page.locator('.import-header-form .el-form-item').filter({has:page.locator('label').filter({hasText:/^下单日期$/})}).locator('input').press('Tab')
  await page.getByLabel('预付比例',{exact:true}).fill('0');await page.getByLabel('账期天数',{exact:true}).fill('0')
  const button=page.getByRole('button',{name:'保存基础信息',exact:true});if(await button.isEnabled())await command(`/pur/order-imports/${state[active].batchId}`,()=>button.click());assert.equal(latest.header.bookId,6);assert.equal(latest.header.supplierId,211);assert.equal(latest.header.currency,'USD');assert.equal(latest.header.orderDate,'2026-10-29')
}
async function reviewDialog(rowNo){
  const d=page.getByRole('dialog',{name:'核对商品与原图',exact:true})
  if(!await d.isVisible())await page.getByRole('button',{name:'核对商品',exact:true}).click()
  await select(d.getByRole('combobox',{name:'选择待核对采购行',exact:true}),new RegExp(`^第${rowNo}行 `));return d
}
async function photos(){
  for(const original of [...latest.rows]){
    if(!original.images?.some(i=>i.status!=='CONFIRMED'))continue
    const d=await reviewDialog(original.rowNo)
    while(await d.getByRole('button',{name:'确认原图属于本行',exact:true}).count())await command(`/pur/order-imports/${state[active].batchId}/rows/${original.id}/images/${latest.rows.find(r=>r.id===original.id).images.find(i=>i.status!=='CONFIRMED').id}/association`,()=>d.getByRole('button',{name:'确认原图属于本行',exact:true}).first().click())
    // 单行响应由页面模型更新；重新读取取得下一幅照片的最新版本与状态。
    await d.getByRole('button',{name:'返回明细',exact:true}).click();await refresh()
    if(original.rowNo%10===0)announce(`原图核对 ${original.rowNo}/60`)
  }
}
async function match(){
  if(latest.rows.every(r=>r.matchResult))return
  const result=await command(`/pur/order-imports/${state[active].batchId}/matches`,()=>page.getByRole('button',{name:'识别商品',exact:true}).click())
  assert.equal(result.taskIds.length,60)
  for(let n=0;n<900;n++){
    const tasks=latest.tasks.filter(t=>result.taskIds.includes(t.id)),done=tasks.filter(t=>!['QUEUED','RUNNING'].includes(t.status))
    if(done.length===60){assert.ok(tasks.every(t=>t.status==='SUCCEEDED'),JSON.stringify(tasks.filter(t=>t.status!=='SUCCEEDED')));break}
    if(n%10===0)announce(`真实候选识别 ${done.length}/60`)
    await page.waitForTimeout(2000)
    if(n===899)throw Error('候选识别超时，保留原任务')
  }
  await refresh();state[active].modelSummary=latest.rows.map(r=>({rowNo:r.rowNo,runId:r.matchResult?.runId,image:r.matchResult?.image,text:r.matchResult?.text,explanation:r.matchResult?.explanation}));save()
}
async function products(){
  for(const original of [...latest.rows]){
    if(original.readiness==='READY')continue
    const d=await reviewDialog(original.rowNo)
    if(active==='supplier'&&original.sourceItemKey==='B3'){
      await d.getByText('确认新品',{exact:true}).click()
      const resume=d.getByRole('button',{name:'继续原新品操作',exact:true})
      if(await resume.isVisible())await command(`/pur/order-imports/${state[active].batchId}/rows/${original.id}/products`,()=>resume.click())
      else{
        for(const [label,value] of [['商品编码','NY051-DRAFT-TEST'],['商品名称','NY051页面草稿测试商品'],['基础单位','PCS'],['商品规格','S']])await d.locator('.el-form-item').filter({has:page.locator('label').filter({hasText:new RegExp(`^${label}$`)})}).locator('input').fill(value)
        await d.getByRole('button',{name:'核对并确认新增',exact:true}).click()
        await command(`/pur/order-imports/${state[active].batchId}/rows/${original.id}/products`,()=>page.getByRole('button',{name:'确认新增',exact:true}).click())
      }
    }else{
      const index=active==='supplier'?original.sourceRow-2:Math.floor((original.sourceRow-2)/3)+1,code=`NY051-TEST-${String(index).padStart(2,'0')}-${original.productSpec}`
      await d.getByLabel('检索真实商品').fill(code)
      const catalogRead=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/md/products'&&new URL(r.url()).searchParams.get('keyword')===code)
      await d.getByRole('button',{name:'查询商品',exact:true}).click();const catalog=(await (await catalogRead).json()).data;assert.ok(catalog.records.some(p=>p.productCode===code))
      await select(d.getByRole('combobox',{name:'已有商品',exact:true}),new RegExp(`^${code} ·`))
      await d.getByRole('combobox',{name:'确认采购单位',exact:true}).fill('PCS');await d.getByRole('combobox',{name:'确认采购单位',exact:true}).press('Enter')
      await command(`/pur/order-imports/${state[active].batchId}/rows/${original.id}/decision`,()=>d.getByRole('button',{name:'确认商品与单位',exact:true}).click())
    }
    await d.getByRole('button',{name:'返回明细',exact:true}).click();await refresh()
    assert.equal(latest.rows.find(r=>r.id===original.id).readiness,'READY')
    if(original.rowNo%10===0)announce(`商品人工确认 ${original.rowNo}/60`)
  }
}
async function previewAndDraft(){
  await command(`/pur/order-imports/${state[active].batchId}/previews`,()=>page.getByRole('button',{name:'预览采购草稿',exact:true}).click())
  const drawer=page.getByRole('dialog',{name:'完整采购草稿预览',exact:true});await expect(drawer).toBeVisible()
  let g=latest.groups[0];assert.equal(latest.groups.length,1)
  if(!g.preview){
    await drawer.getByRole('button',{name:'核对表头／拆单',exact:true}).click()
    await drawer.locator('.el-form-item').filter({has:page.locator('label').filter({hasText:/^税率$/})}).locator('input').fill('0')
    await select(drawer.locator('.el-form-item').filter({has:page.locator('label').filter({hasText:/^单价口径$/})}).locator('.el-select'),'已核对：未含税单价')
    await command(`/pur/order-imports/${state[active].batchId}/groups/${g.id}`,()=>drawer.getByRole('button',{name:'保存并重新核对',exact:true}).click())
    await command(`/pur/order-imports/${state[active].batchId}/previews`,()=>drawer.getByRole('button',{name:'核对并生成预览',exact:true}).click());g=latest.groups[0]
  }
  assert.equal(g.preview.lines.length,60);assert.equal(Number(g.preview.totalAmount),25440);assert.equal(Number(g.preview.totalQty),480)
  if(!g.feeTodos.every(t=>t.reviewStatus==='CONFIRMED')){
    await select(drawer.getByRole('combobox',{name:'费用归属',exact:true}),'整单一次');await select(drawer.getByRole('combobox',{name:'费用原币',exact:true}),/^USD$/)
    await drawer.getByLabel('费用金额',{exact:true}).fill('29.10');await drawer.getByLabel('费用核对原因',{exact:true}).fill('NY051测试口径：整单美元运费29.10一次，原行重复值不累加，后续另行登记')
    await drawer.getByLabel('确认费用来源',{exact:true}).check()
    const saved=await command(`/pur/order-imports/${state[active].batchId}/groups/${g.id}/fee-todos`,()=>drawer.getByRole('button',{name:'保存费用核对',exact:true}).click());assert.equal(saved.feeTodos[0].sourceRowIds.length,60);assert.equal(saved.feeTodos[0].reviewStatus,'CONFIRMED')
  }
  await expect(drawer.locator('.preview-scroll tbody tr')).toHaveCount(60)
  await page.screenshot({path:dir+`/${active}-preview.png`,fullPage:true})
  if(!state[active].orderId){
    await drawer.getByRole('button',{name:/确认创建采购草稿|继续原创建请求/}).click()
    const created=await command(`/pur/order-imports/${state[active].batchId}/groups/${g.id}/drafts`,()=>page.getByRole('button',{name:'确认创建草稿',exact:true}).click())
    assert.equal(created.createStatus,'CREATED');state[active].orderId=created.orderId;save()
  }
  const reading=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/v1/pur/order-imports/${state[active].batchId}/groups/${g.id}/creation`&&r.request().method()==='GET')
  await drawer.getByRole('button',{name:'查询原创建结果',exact:true}).click();const verified=(await (await reading).json()).data
  assert.equal(verified.verifyStatus,'VERIFIED');assert.equal(verified.actualOrder.status,'DRAFT');assert.equal(verified.actualOrder.lines.length,60)
  state[active].docNo=verified.actualOrder.docNo;state[active].verified=verified;save();await page.screenshot({path:dir+`/${active}-created.png`,fullPage:true});announce(`草稿已核对 ${state[active].docNo}`)
}
try{
  await page.goto(origin+'/login');await page.locator('#login-language').selectOption('zh-CN');await page.locator('#account').fill(account.username);await page.locator('#password').fill(account.password)
  await page.locator('button[type=submit]').click();await page.waitForURL(url=>url.pathname!=='/login');state.technicalSessionClosed=false;save()
  for(const [label,source] of [['template','D:/downlaoad/NY-051-采购导入.xlsx'],['supplier','C:/Users/JT/Pictures/Screenshots/NY-051.xlsx']]){
    active=label;latest=null
    await page.goto(origin+'/purchase/orders/import'+(state[label].batchId?'?batchId='+state[label].batchId:''))
    await expect(page.locator('.purchase-import-workspace')).toBeVisible()
    if(!state[label].batchId){
      await page.getByRole('button',{name:'导入文件',exact:true}).click();await page.locator('#purchase-import-file').setInputFiles(source)
      await command('/pur/order-imports',()=>page.getByRole('button',{name:'导入数据',exact:true}).click())
    }else await expect.poll(()=>latest?.batchId).toBe(state[label].batchId)
    await waitParsed()
    if(label==='supplier'&&latest.status!=='REVIEW'){
      const task=latest.tasks.find(t=>t.kind==='PARSE'&&t.result?.mapping);assert.ok(task,'供应商解析失败且没有字段核对建议')
      await page.getByRole('button',{name:'核对原列与规格',exact:true}).click();const d=page.getByRole('dialog',{name:'核对供应商原列与规格',exact:true})
      for(const [col,spec] of [['B','S'],['C','M'],['D','L']])await d.getByLabel(`${col}列规格`,{exact:true}).fill(spec)
      await d.getByLabel('确认原列与规格',{exact:true}).check()
      await command(`/pur/order-imports/tasks/${task.id}/retry`,()=>d.getByRole('button',{name:'确认字段并重试原任务',exact:true}).click());await waitParsed()
    }
    assert.equal(latest.status,'REVIEW');assert.equal(latest.rows.length,60);assert.equal(latest.rows.reduce((s,r)=>s+Number(r.purchaseQty),0),480)
    assert.equal(new Set(latest.rows.flatMap(r=>r.images.map(i=>i.id))).size,label==='template'?20:21)
    if(!state[label].orderId){await header();await photos();await match();await products()}
    await previewAndDraft();assert.deepEqual(forbidden,[])
  }
  state.status='VERIFIED';save();announce('两份Excel页面草稿均通过')
}catch(error){state.lastError={branch:active,message:error.message,at:new Date().toISOString()};save();await page.screenshot({path:dir+'/page-first-failure.png',fullPage:true});throw error}
finally{
  if(new URL(page.url()).pathname !== '/login')try{
    await page.locator('.header .el-dropdown').last().getByRole('button').click()
    await page.getByRole('menuitem',{name:'退出登录',exact:true}).click();await page.waitForURL(url=>url.pathname==='/login');state.technicalSessionClosed=true;save()
  }catch(error){state.sessionCloseError=error.message;save()}
  await context.close();await browser.close()
}
