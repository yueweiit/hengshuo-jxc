import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {extname, resolve, sep} from 'node:path';
import {createRequire} from 'node:module';
const [backend,directory,fee,distInput,playwrightModule,mode='WRITE']=process.argv.slice(2);
const dist=resolve(distInput);
const require=createRequire(resolve(playwrightModule,'package.json'));
const {chromium}=require('playwright');
assert.ok(backend&&directory&&fee&&process.env.JXC_AI05_TEST_TOKEN);
const results=[],responses=[],errors=[],skippedReads=[];
await mkdir(directory,{recursive:true});
const server=http.createServer(async(req,res)=>{
  if(req.url.startsWith('/api/')){
    const upstream=http.request({host:'127.0.0.1',port:Number(backend),path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});
    upstream.on('error',e=>{res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({status:'error',error:e.message}))});req.pipe(upstream);return;
  }
  try{
    let name=resolve(dist,'.'+decodeURIComponent(req.url.split('?')[0]));
    assert.ok(name===dist||name.startsWith(dist+sep));
    if(!extname(name))name=resolve(dist,'index.html');
    const data=await readFile(name);res.writeHead(200,{'content-type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(name)]||'application/octet-stream'});res.end(data);
  }catch(e){res.writeHead(404);res.end(e.message)}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
let browser,page;
async function shot(name){await page.waitForLoadState('networkidle');await page.screenshot({path:resolve(directory,name+'.png'),fullPage:true,animations:'disabled'});await writeFile(resolve(directory,name+'.txt'),await page.locator('body').innerText(),'utf8')}
async function api(path){const r=await fetch(origin+'/api/v1/'+path,{headers:{Authorization:'Bearer '+process.env.JXC_AI05_TEST_TOKEN,'X-Country-Id':'101'}});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b.data}
async function action(name,fn){try{await fn();results.push({name,status:'ok'})}catch(e){results.push({name,status:'error',error:e.stack});if(page)await shot('failure-'+results.length);throw e}}
async function command(suffix,click){const waiting=page.waitForResponse(r=>r.url().includes('/api/v1/cst/')&&r.url().endsWith(suffix)&&r.request().method()==='POST');await click();const r=await waiting,b=await r.json();assert.equal(r.status(),200,JSON.stringify(b));return b.data}
async function loadProfit(){
  const books=await api('fin/books');if(!books.length){skippedReads.push({path:'cst/profit',reason:'No accessible book is selectable in this scope'});return;}
  const select=page.locator('.profit-filters .el-select');await select.nth(0).click();await page.getByRole('option',{name:books[0].name+' · '+books[0].baseCurrency,exact:true}).click();
  await select.nth(1).click();const reading=page.waitForResponse(r=>r.url().includes('/api/v1/cst/profit?'));await page.getByRole('option').filter({hasText:'2026'}).filter({hasText:'10'}).first().click();const response=await reading;assert.equal(response.status(),200);await page.waitForLoadState('networkidle');
  const profit=(await response.json()).data;
  for(const row of profit.rows)await page.getByText(row.productName,{exact:true}).first().waitFor();
  if(profit.rows.length){assert.ok(Array.isArray(profit.rows[0].sources),'Synthetic PROFIT READ role must receive source details');await page.locator('.profit-table .el-table__expand-icon').first().click();await page.locator('.profit-sources').first().waitFor();for(const source of profit.rows[0].sources)if(source.sourceNo)assert.ok((await page.locator('.profit-sources').first().innerText()).includes(source.sourceNo));}
  return profit;
}
try{
  browser=await chromium.launch({headless:true,...(process.env.JXC_AI05_CHROMIUM?{executablePath:process.env.JXC_AI05_CHROMIUM}:{}),args:['--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1600,height:1100},locale:'zh-CN',timezoneId:'America/Mexico_City'});
  await context.addInitScript(token=>{localStorage.setItem('jxc.token',token);localStorage.setItem('jxc.countryId','101')},process.env.JXC_AI05_TEST_TOKEN);
  page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',async r=>{if(r.url().includes('/api/v1/cst/'))try{responses.push({path:r.url().split('/api/v1/')[1],method:r.request().method(),status:r.status(),body:await r.json()})}catch(e){errors.push('response parse: '+e.message)}});
  if(mode==='READ'){
    await action('native scenario cost source readback',async()=>{
      const costs=(await api('cst/inbound-costs?size=200')).records;
      await page.goto(origin+'/cost/inbound');await page.waitForLoadState('networkidle');
      if(costs.length){for(const row of costs){assert.ok(row.batchNo);await page.getByText(row.batchNo,{exact:true}).first().waitFor()}}
      else await page.getByText('暂无数据',{exact:true}).first().waitFor();
      await shot('state-costs');
      if(costs.length){const first=costs[0],reading=page.waitForResponse(r=>r.url().includes('/cst/batches/'+first.batchId+'/cost-trace'));await page.getByText(first.batchNo,{exact:true}).first().click();const response=await reading;assert.equal(response.status(),200);const trace=(await response.json()).data;assert.equal(trace.batchId,first.batchId);await page.getByText('截至日单位成本',{exact:true}).waitFor();if(trace.costMissing)await page.getByText('成本尚未完整，未知金额与单位成本保持待补。',{exact:true}).waitFor();await shot('state-trace');await page.getByRole('button',{name:'关闭批次成本追溯',exact:true}).click();}
    });
    for(const [route,title] of [['/cost/allocations','费用分摊'],['/cost/adjustments','成本调整'],['/cost/expenses','费用登记'],['/analysis/profit','单品利润']]){
      await action(title+' original page readback',async()=>{await page.goto(origin+route);await page.waitForLoadState('networkidle');await page.getByRole('heading',{name:title,exact:true}).first().waitFor();if(route==='/analysis/profit')await loadProfit();else if(route==='/cost/adjustments'||route==='/cost/expenses'){for(const row of (await api('cst/'+route.split('/').at(-1))).records)if(row.docNo)await page.getByText(row.docNo,{exact:true}).first().waitFor();}await shot('state-'+route.split('/').at(-1))});
    }
    assert.ok(responses.every(r=>r.method==='GET'),'state readback must not create business commands');
    if(fee==='NATIVE_SMOKE')await action('Docker retains the same native source and amounts',async()=>{
      const costs=(await api('cst/inbound-costs?bookId=601')).records;
      assert.equal(costs.length,1);assert.equal(costs[0].status,'ADJUSTED');assert.equal(Number(costs[0].allocFeeAmount),9);assert.equal(Number(costs[0].unitCost),2.9);assert.ok(costs[0].poNo&&costs[0].receiptNo&&costs[0].batchNo);
      const allocations=(await api('cst/allocations')).records;assert.equal(allocations.filter(row=>row.status==='CONFIRMED').length,1);
      const profit=await api('cst/profit?bookId=601&periodId=701');const product=profit.rows.find(row=>row.productId===501);
      assert.equal(Number(product.netSalesAmount),80);assert.equal(Number(product.cogsAmount),11.6);
    });
  }else{
  const [cost]= (await api('cst/inbound-costs?bookId=601')).records;
  await action('GAP-05 source labels and literal batch keyword',async()=>{
    await page.goto(origin+'/cost/inbound');await page.getByText(cost.batchNo,{exact:true}).first().waitFor();
    assert.ok((await page.locator('body').innerText()).includes(cost.poNo));assert.ok((await page.locator('body').innerText()).includes(cost.receiptNo));await shot('01-source-labels');
    const input=page.locator('.el-form-item').filter({has:page.locator('.el-form-item__label',{hasText:'批次'})}).locator('input').first();
    await input.fill('AI05-NO-SUCH-BATCH');await page.getByRole('button',{name:'查询',exact:true}).click();await page.getByText('暂无数据',{exact:true}).first().waitFor();await shot('02-empty-search');
    await input.fill(cost.batchNo);await page.getByRole('button',{name:'查询',exact:true}).click();await page.getByText(cost.batchNo,{exact:true}).first().waitFor();
  });
  await action('CST-01/15 original cost confirmation and trace',async()=>{
    const pending=page.waitForResponse(r=>r.url().endsWith('/'+cost.id+'/confirm'));
    await page.getByRole('button',{name:'确认',exact:true}).first().click();await page.locator('.el-message-box .el-button--primary').click();assert.equal((await pending).status(),200);
    const tracing=page.waitForResponse(r=>r.url().includes('/cst/batches/'+cost.batchId+'/cost-trace'));
    await page.getByText(cost.batchNo,{exact:true}).first().click();assert.equal((await tracing).status(),200);await page.locator('.el-drawer').waitFor();await shot('03-cost-trace');await page.getByRole('button',{name:'关闭批次成本追溯',exact:true}).click();
  });
  await action('CST-04/09 preview confirm reverse and reallocate through original page',async()=>{
    await page.goto(origin+'/cost/allocations');await page.getByRole('heading',{name:'费用分摊',exact:true}).waitFor();
    async function allocate(){const input=page.locator('.fee-field input').first();await input.fill(fee);await input.press('Enter');await page.getByRole('button',{name:'预览分摊',exact:true}).click();await page.locator('.allocation-preview').waitFor();await command('/confirm',()=>page.getByRole('button',{name:'确认分摊',exact:true}).click())}
    await allocate();await shot('04-confirmed-allocation');
    await command('/reverse',()=>page.getByRole('button',{name:'撤销',exact:true}).first().click());await shot('05-reversed-allocation');
    await allocate();await shot('06-reallocated');
    const rows=(await api('cst/allocations')).records;assert.equal(rows.filter(r=>r.status==='CONFIRMED').length,1);
  });
  await action('CST-15 structured profit and original sale source',async()=>{
    await page.goto(origin+'/analysis/profit');await page.getByRole('heading',{name:'单品利润',exact:true}).waitFor();
    await loadProfit();
    await page.getByText('未包含线下营销费用',{exact:false}).first().waitFor();await shot('07-profit');
    const profit=await api('cst/profit?bookId=601&periodId=701');const row=profit.rows.find(r=>r.productId===501);assert.equal(Number(row.netSalesAmount),80);assert.equal(Number(row.cogsAmount),11.6);assert.equal(row.completeness,'ESTIMATED');
    const source=row.sources.find(item=>item.sourceType==='SAL_OUTBOUND');assert.ok(source?.sourceNo);
    await Promise.all([page.waitForURL(url=>url.pathname==='/sales/outbounds'),page.locator('.profit-sources').getByRole('button',{name:source.sourceNo,exact:true}).first().click()]);await page.waitForLoadState('networkidle');const target=new URL(page.url());assert.equal(target.pathname,'/sales/outbounds');assert.equal(target.searchParams.get('sourceId'),String(source.sourceId));await page.getByText(source.sourceNo,{exact:true}).first().waitFor();await shot('07-profit-source-outbound');
  });
  await action('GAP-05 AP selector searches the exact displayed source identifier',async()=>{
    const source=(await api('ap/bill-sources')).poLines[0];assert.ok(source?.sourceNo);
    await page.goto(origin+'/ap/bills');await page.getByRole('button',{name:'从来源生成',exact:true}).click();
    const search=page.locator('#ap-source-search');await search.fill(source.sourceNo);await page.getByText(source.sourceNo,{exact:true}).first().waitFor();await shot('08-ap-source-identifier');
    await search.fill('AI05-NO-SUCH-SOURCE');await page.getByText('没有匹配的来源，请调整查找条件',{exact:true}).waitFor();await shot('09-ap-empty-search');
  });
  }
  assert.ok(responses.length>=4,'original pages must actually read the cost APIs');
  for(const response of responses)assert.equal(response.status,200,JSON.stringify(response));
  assert.deepEqual(errors,[]);
}catch(e){process.exitCode=1;console.error(e.stack)}finally{
  await writeFile(resolve(directory,'browser-result.json'),JSON.stringify({status:process.exitCode?'error':'ok',backendPort:Number(backend),frontendPort:server.address()?.port,results,responses,errors,skippedReads},null,2),'utf8');
  if(browser)await browser.close();await new Promise(r=>server.close(r));
}
