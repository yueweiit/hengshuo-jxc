/** 真实前端组件，全部API由隔离夹具拦截；不连接业务数据库或算法服务。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium, expect } from '@playwright/test'

const root=fileURLToPath(new URL('../',import.meta.url)),evidence=`${root}/../runtime/purchase-auto-review`
for(const width of [1280,390])test(`自动逐行核对与单一人工入口，${width}宽度`,async()=>{
  await mkdir(evidence,{recursive:true})
  const server=await createServer({configFile:false,root,cacheDir:`${evidence}/vite-cache`,plugins:[vue()],optimizeDeps:{entries:['e2e/fixtures/purchase-import-auto-review.html']},resolve:{alias:{'@':`${root}/src`}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,'C:/project/jxc/jxc-web/node_modules']}}})
  await server.listen();let browser
  try{
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],unexpected=[];page.setDefaultTimeout(10000)
    page.on('pageerror',error=>errors.push(error.message))
    const batchId='11111111-2222-4333-8444-555555555555',parseId='22222222-2222-4333-8444-555555555555',runIds=['33333333-2222-4333-8444-555555555555','44444444-2222-4333-8444-555555555555']
    const header={bookId:1,supplierId:2,currency:'USD',orderDate:'2026-10-29',expectedDate:null,paymentTerms:'',prepayRatio:null,termDays:null}
    const rows=[1,2].map(id=>({id,version:1,rowNo:id,sourceId:8,sourceOrderNo:'隔离采购单',sourceSheet:'Sheet1',sourceRow:id+1,photo:null,productSpec:'S',purchaseQty:'1',purchaseUnitPrice:'2',saleUnitPrice:null,saleTotal:null,freight:null,landedUnitCost:null,usdUnitCost:null,usdTotal:null,readiness:'UNRESOLVED',images:[{id:10+id,status:'CONFIRMED',sha256:'a'.repeat(64)}]}))
    let data={batchId,version:1,status:'PARSING',header,rows:[],sources:[{id:8,fileName:'隔离采购.xlsx',fileSha256:'b'.repeat(64),status:'READY'}],tasks:[{id:parseId,kind:'PARSE',sourceId:8,fileName:'隔离采购.xlsx',status:'RUNNING'}],groups:[]},matchRequests=0,decisions=0
    await page.route('**/api/v1/**',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname.slice('/api/v1'.length),method=request.method(),ok=value=>route.fulfill({json:{code:'OK',data:value}})
      if(method==='GET'&&path==='/org/books')return ok([{id:1,name:'隔离账套',baseCurrency:'USD',status:'ACTIVE'}])
      if(method==='GET'&&path==='/md/partners')return ok([{id:2,name:'隔离供应商',status:'ENABLED',settleCurrency:'USD'}])
      if(method==='GET'&&path==='/md/currencies')return ok([{code:'USD',name:'美元',status:'ENABLED'}])
      if(method==='GET'&&path==='/pur/order-imports/capabilities')return ok({draftCreationEnabled:false,recognitionEnabled:true})
      if(method==='POST'&&path==='/pur/order-imports')return ok({...data,taskId:parseId})
      if(method==='GET'&&path===`/pur/order-imports/tasks/${parseId}`){data={...data,status:'REVIEW',rows,tasks:[{...data.tasks[0],status:'SUCCEEDED',result:{rows:2,images:2}}]};return ok(data.tasks[0])}
      if(method==='GET'&&path===`/pur/order-imports/${batchId}`)return ok(data)
      if(method==='PUT'&&path===`/pur/order-imports/${batchId}`){data={...data,version:data.version+1,header:request.postDataJSON().header};return ok(data)}
      if(method==='POST'&&path===`/pur/order-imports/${batchId}/matches`){
        matchRequests++;assert.deepEqual(request.postDataJSON(),{batchVersion:1,rowIds:[1,2],topK:5});assert.ok(request.headers()['idempotency-key'])
        data={...data,rows:rows.map((row,index)=>({...row,matchTaskId:runIds[index]})),tasks:[...data.tasks,...runIds.map((id,index)=>({id,kind:'MATCH',status:'RUNNING',result:{rowId:index+1}}))]};return ok({...data,taskIds:runIds})
      }
      if(method==='PUT'&&path===`/pur/order-imports/${batchId}/rows/1/decision`){decisions++;const body=request.postDataJSON();assert.equal(body.productId,501);assert.equal(body.unit,'件');data.rows[0]={...data.rows[0],version:2,readiness:'READY',matchedProductId:501,purchaseUnit:'件',decision:'EXISTING'};return ok(data.rows[0])}
      if(method==='GET'&&/\/images\/\d+\/content$|\/product-images\/\d+\/content$/.test(path))return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5mUAAAAASUVORK5CYII=','base64')})
      unexpected.push(`${method} ${path}`);return route.abort()
    })
    await page.goto(`${server.resolvedUrls.local[0]}e2e/fixtures/purchase-import-auto-review.html`)
    await page.getByRole('button',{name:'导入文件',exact:true}).click();await page.locator('#purchase-import-file').setInputFiles({name:'隔离采购.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('isolated fixture')})
    await page.getByRole('button',{name:'导入数据',exact:true}).click()
    await expect.poll(()=>matchRequests).toBe(1)
    await expect(page.locator('.import-progress:visible')).toContainText('AI已处理 0 / 2 行')
    const dialog=page.getByRole('dialog',{name:'核对商品与原图',exact:true});await expect(dialog).toBeHidden()
    await page.getByRole('button',{name:'关闭',exact:true}).click()
    await expect(page.getByRole('dialog',{name:'导入采购文件',exact:true})).toBeHidden()
    const entry=page.getByRole('button',{name:'待确定是否为新商品，2行待确认',exact:true});await expect(entry).toHaveClass(/el-button--danger/)
    await expect(page.locator('.pending-product-trigger .el-badge__content')).toHaveText('2')
    await expect(page.locator('.workflow-actions button')).toHaveCount(2)
    data.tasks=data.tasks.map(task=>({...task,status:'SUCCEEDED'}));data.rows=data.rows.map((row,index)=>({...row,matchResult:{format:'MatchRunV1',runId:runIds[index],inputRevision:1,status:'OK',text:{status:'FOUND',reason:'隔离文字候选'},image:{status:'FOUND',reason:'隔离图片候选'},candidates:[{productId:501,product:{id:501,productCode:'TEST-501',name:'隔离候选商品',spec:'S',units:[{unit:'件'}]},visualScore:0.91,textEvidence:[],visualEvidence:[{queryAssetId:row.images[0].id,imageId:701,featureId:801,score:0.91}],conflicts:[]}],explanation:{status:'NOT_REQUESTED',message:'未调用真实算法'}}}))
    await expect(page.getByRole('region',{name:'采购明细',exact:true}).locator('.import-progress')).toContainText('AI已处理 2 / 2 行')
    // 暂存保留页面表头草稿；人工确认商品仍遵守原有“先保存基础信息”约束。
    await page.getByRole('combobox',{name:'币种',exact:true}).click();await page.getByRole('option',{name:'USD · 美元',exact:true}).click()
    const saveHeader=page.getByRole('button',{name:'保存基础信息',exact:true})
    if(await saveHeader.isEnabled())await saveHeader.click()
    await expect(dialog).toBeHidden();await entry.click();await expect(dialog.getByRole('tab',{name:'辅助识别',exact:true})).toHaveAttribute('aria-selected','true')
    await expect(dialog).toContainText('外观相似度 0.9100');assert.equal(matchRequests,1)
    await dialog.getByRole('button',{name:'选择此候选后核对单位',exact:true}).click();await dialog.getByRole('combobox',{name:'确认采购单位',exact:true}).click();await page.getByRole('option',{name:'件',exact:true}).click()
    await dialog.getByRole('button',{name:'确认商品与单位',exact:true}).click();await expect.poll(()=>decisions).toBe(1)
    await dialog.getByRole('button',{name:'返回待确认事项',exact:true}).click();await expect(dialog.getByRole('region',{name:'来源资料核对',exact:true})).toBeVisible()
    await dialog.getByRole('button',{name:'返回明细',exact:true}).click();await expect(page.locator('.pending-product-trigger .el-badge__content')).toHaveText('1')
    await page.locator('.workflow-actions').scrollIntoViewIfNeeded();await page.screenshot({path:`${evidence}/entry-${width}.png`,animations:'disabled'})
    const buttonBox=await page.getByRole('button',{name:'待确定是否为新商品，1行待确认',exact:true}).boundingBox(),badgeBox=await page.locator('.pending-product-trigger .el-badge__content').boundingBox()
    assert.ok(badgeBox.x>buttonBox.x&&badgeBox.y<buttonBox.y+8);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[])
  }finally{await browser?.close();await server.close()}
})
