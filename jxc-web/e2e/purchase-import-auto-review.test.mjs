/** 真实前端组件，全部API由隔离夹具拦截；不连接业务数据库或算法服务。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium, expect } from '@playwright/test'

const root=fileURLToPath(new URL('../',import.meta.url)),evidence=`${root}/../runtime/purchase-auto-review`
for(const width of [1280,390])test(`商品自动就绪与未命中人工入口，${width}宽度`,async()=>{
  await mkdir(evidence,{recursive:true})
  const server=await createServer({configFile:false,root,cacheDir:`${evidence}/vite-cache`,plugins:[vue()],optimizeDeps:{entries:['e2e/fixtures/purchase-import-auto-review.html']},resolve:{alias:{'@':`${root}/src`}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,'C:/project/jxc/jxc-web/node_modules']}}})
  await server.listen();let browser
  try{
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],unexpected=[];page.setDefaultTimeout(10000)
    page.on('pageerror',error=>errors.push(error.message))
    const batchId='11111111-2222-4333-8444-555555555555',parseId='22222222-2222-4333-8444-555555555555',runIds=['33333333-2222-4333-8444-555555555555','44444444-2222-4333-8444-555555555555']
    const header={bookId:1,supplierId:2,currency:'USD',orderDate:'2026-10-29',expectedDate:null,paymentTerms:'',prepayRatio:null,termDays:null}
    const rows=[1,2].map(id=>({id,version:1,rowNo:id,sourceId:8,sourceOrderNo:'隔离采购单',sourceSheet:'Sheet1',sourceRow:id+1,photo:null,productSpec:'S',purchaseQty:'1',purchaseUnitPrice:'2',saleUnitPrice:null,saleTotal:null,freight:null,landedUnitCost:null,usdUnitCost:null,usdTotal:null,readiness:'UNRESOLVED',images:[{id:10+id,status:'UNCONFIRMED',sha256:'a'.repeat(64)}]}))
    const correctedId='55555555-2222-4333-8444-555555555555',correctedTask='66666666-2222-4333-8444-555555555555'
    let data={batchId,version:1,status:'PARSING',header,rows:[],sources:[{id:8,fileName:'隔离采购.xlsx',fileSha256:'b'.repeat(64),parserVersion:'docling-n8n-supplier-v1',status:'READY'}],tasks:[{id:parseId,kind:'PARSE',sourceId:8,fileName:'隔离采购.xlsx',status:'RUNNING'}],groups:[]},matchRequests=0,decisions=0,correctionRequest,originalAtCorrection
    await page.route('**/api/v1/**',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname.slice('/api/v1'.length),method=request.method(),ok=value=>route.fulfill({json:{code:'OK',data:value}})
      if(method==='GET'&&path==='/org/books')return ok([{id:1,name:'隔离账套',baseCurrency:'USD',status:'ACTIVE'}])
      if(method==='GET'&&path==='/md/partners')return ok([{id:2,name:'隔离供应商',status:'ENABLED',settleCurrency:'USD'}])
      if(method==='GET'&&path==='/md/currencies')return ok([{code:'USD',name:'美元',status:'ENABLED'}])
      if(method==='GET'&&path==='/pur/order-imports/capabilities')return ok({draftCreationEnabled:false,recognitionEnabled:true})
      if(method==='GET'&&path===`/pur/order-imports/${batchId}/sources/8/mapping`)return ok({batchVersion:data.version,sourceCells:[],mapping:{format:'SupplierMappingV1',fileSha256:'b'.repeat(64),sheet:'Sheet1',needsReview:false,reasons:[],ignoredRows:[],lines:[2,3].map(sourceRow=>({sourceRow,cells:{purchaseQty:'E'+sourceRow,purchaseUnitPrice:'H'+sourceRow}}))}})
      if(method==='POST'&&path===`/pur/order-imports/${batchId}/sources/8/corrections`){correctionRequest=request.postDataJSON();originalAtCorrection=structuredClone(data);data={batchId:correctedId,version:1,status:'PARSING',header,rows:[],sources:[],tasks:[{id:correctedTask,kind:'PARSE',status:'QUEUED'}],groups:[]};return ok({...data,taskId:correctedTask})}
      if(method==='GET'&&path===`/pur/order-imports/${correctedId}`)return ok(data)
      if(method==='GET'&&path===`/pur/order-imports/tasks/${correctedTask}`)return ok(data.tasks[0])
      if(method==='POST'&&path==='/pur/order-imports')return ok({...data,taskId:parseId})
      if(method==='GET'&&path===`/pur/order-imports/tasks/${parseId}`){data={...data,status:'REVIEW',rows,tasks:[{...data.tasks[0],status:'SUCCEEDED',result:{rows:2,images:2}}]};return ok(data.tasks[0])}
      if(method==='GET'&&path===`/pur/order-imports/${batchId}`)return ok(data)
      if(method==='PUT'&&path===`/pur/order-imports/${batchId}`){data={...data,version:data.version+1,header:request.postDataJSON().header};return ok(data)}
      if(method==='POST'&&path===`/pur/order-imports/${batchId}/matches`){
        matchRequests++;assert.deepEqual(request.postDataJSON(),{batchVersion:1,rowIds:[1,2],topK:5});assert.ok(request.headers()['idempotency-key'])
        data={...data,rows:rows.map((row,index)=>({...row,matchTaskId:runIds[index]})),tasks:[...data.tasks,...runIds.map((id,index)=>({id,kind:'MATCH',status:'RUNNING',result:{rowId:index+1}}))]};return ok({...data,taskIds:runIds})
      }
      if(method==='PUT'&&path===`/pur/order-imports/${batchId}/rows/1/decision`){decisions++;return route.abort()}
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
    const entry=page.locator('.pending-product-trigger button');await expect(entry).toHaveClass(/el-button--danger/)
    await expect(entry).toBeDisabled();await expect(page.locator('[inert]')).toHaveCount(1)
    await expect(page.locator('.el-loading-mask:visible')).toHaveCount(1)
    assert.equal(await page.evaluate(()=>{const input=document.querySelector('[inert] input');input?.focus();return !!input&&document.activeElement===input}),false)
    await expect(page.locator('.pending-product-trigger .el-badge__content')).toHaveText('2')
    await expect(page.locator('.workflow-actions button')).toHaveCount(2)
    const product={id:501,productCode:'TEST-501',name:'隔离候选商品',spec:'S',baseUnit:'件',units:[{unit:'件'}]}
    const candidate={productId:501,product,visualScore:0.91,textEvidence:[],visualEvidence:[{queryAssetId:11,imageId:701,featureId:801,score:0.91}],conflicts:[]}
    const score={productId:501,photoScore:0.91,textScore:1,reason:'相似度最高',fields:[{field:'productCode',label:'商品编号',weight:40,source:null,target:'TEST-501',score:null},{field:'spec',label:'规格',weight:40,source:'S',target:'S',score:1},{field:'name',label:'商品名',weight:20,source:null,target:'隔离候选商品',score:null}]}
    data={...data,version:2,tasks:data.tasks.map(task=>({...task,status:'SUCCEEDED'})),rows:data.rows.map((row,index)=>({...row,...(index===0?{version:2,readiness:'READY',decision:'EXISTING',matchedProductId:501,purchaseUnit:'件',productSnapshot:product}:{}),matchResult:{format:'MatchRunV1',runId:runIds[index],inputRevision:index===0?2:1,status:'OK',text:{status:'NO_INPUT',reason:'无文字'},image:{status:index===0?'FOUND':'NOT_FOUND',reason:'隔离图片匹配'},candidates:index===0?[candidate]:[],ranking:{format:'CandidateRankingV1',policyVersion:'photo-best-or-first-text-v2',completePhotoGroup:true,status:index===0?'RECOMMENDED':'NEEDS_REVIEW',reason:index===0?'已自动选定商品':'没有符合条件的商品',photoThreshold:0.8,textThreshold:null,weights:{productCode:40,spec:40,name:20},highestPhotoIds:index===0?[501]:[],recommendedIds:index===0?[501]:[],scores:index===0?[score]:[]},explanation:{status:'NOT_REQUESTED',message:'隔离夹具不调用真实算法'}}}))}
    await expect(page.getByRole('region',{name:'采购明细',exact:true}).locator('.import-progress')).toContainText('AI已处理 2 / 2 行')
    await expect(entry).toBeEnabled();await expect(page.locator('[inert]')).toHaveCount(0)
    await expect(page.getByRole('button',{name:'编辑第1行商品名',exact:true})).toContainText('隔离候选商品')
    await expect(page.getByRole('button',{name:'编辑第1行商品名',exact:true})).toContainText('已核对商品')
    assert.equal(data.rows[0].suppliedProductName,undefined);assert.equal(data.rows[0].matchedProductId,501);assert.equal(data.rows[0].images[0].status,'UNCONFIRMED');assert.equal(decisions,0)
    await page.getByRole('button',{name:'切换到粘贴模板视图',exact:true}).click()
    await expect(page.locator('revo-grid').getByText('隔离候选商品',{exact:true}).first()).toBeVisible()
    await expect(page.locator('revo-grid').getByText('已核对商品',{exact:true}).first()).toBeVisible()
    await page.getByRole('button',{name:'完成编辑',exact:true}).click()
    // 后台已自动就绪，前端不能再次请求人工确认；仅第二行留在人工入口。
    await page.getByRole('combobox',{name:'币种',exact:true}).click();await page.getByRole('option',{name:'USD · 美元',exact:true}).click()
    const saveHeader=page.getByRole('button',{name:'保存基础信息',exact:true})
    if(await saveHeader.isEnabled())await saveHeader.click()
    await expect(dialog).toBeHidden();await page.getByRole('button',{name:'待确定是否为新商品，1行待确认',exact:true}).click();await expect(dialog.getByRole('tab',{name:'辅助识别',exact:true})).toHaveAttribute('aria-selected','true')
    await expect(dialog).toContainText('当前没有可核实候选');assert.equal(matchRequests,1);assert.equal(decisions,0)
    await dialog.getByRole('tab',{name:'商品与单位',exact:true}).click();await expect(dialog.getByText('确认新品',{exact:true})).toBeVisible()
    await dialog.getByRole('button',{name:'返回待确认事项',exact:true}).click();await expect(dialog.getByRole('region',{name:'来源资料核对',exact:true})).toBeVisible()
    await dialog.getByRole('button',{name:'返回明细',exact:true}).click();await expect(page.locator('.pending-product-trigger .el-badge__content')).toHaveText('1')
    await page.locator('.workflow-actions').scrollIntoViewIfNeeded();await page.screenshot({path:`${evidence}/entry-${width}.png`,animations:'disabled'})
    const buttonBox=await page.getByRole('button',{name:'待确定是否为新商品，1行待确认',exact:true}).boundingBox(),badgeBox=await page.locator('.pending-product-trigger .el-badge__content').boundingBox()
    assert.ok(badgeBox.x>buttonBox.x&&badgeBox.y<buttonBox.y+8);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[])
    await page.getByRole('button',{name:'纠正原列并保留当前批次',exact:true}).click()
    const mappingDialog=page.getByRole('dialog',{name:'核对供应商原列与规格',exact:true});await expect(mappingDialog).toContainText('当前批次保留')
    await mappingDialog.getByRole('textbox',{name:'拆分数量列',exact:true}).fill('B,C,D');await mappingDialog.getByRole('button',{name:'按数量列拆分建议',exact:true}).click()
    await expect(mappingDialog.getByRole('textbox',{name:'B列规格',exact:true})).toBeVisible()
    await page.screenshot({path:`${evidence}/correction-${width}.png`,animations:'disabled'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
    await mappingDialog.getByText('我已核对原列对应、规格和排除行，按上述来源重新解析',{exact:true}).click();await mappingDialog.getByRole('button',{name:'确认字段并创建纠正批次',exact:true}).click()
    await expect.poll(()=>new URL(page.url()).searchParams.get('batchId')).toBe(correctedId)
    assert.equal(correctionRequest.mappingOverrides.mapping.lines.length,6);assert.deepEqual(correctionRequest.mappingOverrides.specLabels,{});assert.equal(originalAtCorrection.rows.length,2);assert.equal(data.rows.length,0);assert.equal(data.batchId,correctedId);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[])
  }finally{await browser?.close();await server.close()}
})
