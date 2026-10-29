/** 仅供PurchaseImportDraftIT隔离库使用；业务夹具先准备，浏览器真实点击保存，不模拟HTTP成功。 */
import { chromium, expect } from '@playwright/test'
import assert from 'node:assert/strict'
const [origin,batchId,screenshot]=process.argv.slice(2)
assert.match(origin,/^https:\/\/(?:localhost|127\.0\.0\.1):\d+$/);assert.match(batchId,/^[a-f0-9-]{36}$/)
const browser=await chromium.launch({headless:true})
const context=await browser.newContext({ignoreHTTPSErrors:true,locale:'zh-CN',viewport:{width:1500,height:1000}})
await context.addInitScript(()=>{localStorage.setItem('jxc.token','purchase-import-source-test');localStorage.setItem('jxc.countryId','101')})
const page=await context.newPage();let creates=0,actual=null;const forbidden=[],errors=[]
page.on('pageerror',error=>errors.push(error.message))
page.on('request',request=>{if(request.method()!=='GET'&&/\/api\/v1\/(lgs|inv|cst)\//.test(new URL(request.url()).pathname))forbidden.push(request.url())})
page.on('response',async response=>{if(response.request().method()==='POST'&&response.url().endsWith('/drafts')){creates++;const body=await response.json();assert.equal(body.code,'OK');actual=body.data.actualOrder}})
try{
  await page.goto(origin+'/purchase/orders/import?batchId='+batchId)
  const save=page.getByRole('button',{name:'保存',exact:true})
  await expect(save).toBeEnabled({timeout:30000});await save.click()
  const drawer=page.getByRole('dialog',{name:'完整采购草稿预览',exact:true});await expect(drawer).toBeVisible();assert.equal(creates,0)
  async function select(name,label){await drawer.getByRole('combobox',{name,exact:true}).locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," el-select ")][1]').click();await page.getByRole('option',{name:label,exact:true}).click()}
  await select('费用归属','整单一次');await select('费用原币','USD')
  await drawer.getByRole('textbox',{name:'费用金额',exact:true}).fill('29.10')
  await drawer.getByRole('textbox',{name:'费用核对原因',exact:true}).fill('隔离夹具明确指定的整单测试费用29.10，仅测试来源关联')
  await drawer.locator('.el-checkbox').click()
  const feeResponse=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/fee-todos'))
  await drawer.getByRole('button',{name:'保存费用核对',exact:true}).click()
  const fee=(await (await feeResponse).json()).data.feeTodos[0];assert.equal(fee.reviewStatus,'CONFIRMED');assert.equal(fee.sourceRowIds.length,1)
  await expect(drawer.getByRole('button',{name:'保存',exact:true})).toBeEnabled()
  await drawer.locator('.el-drawer__close-btn').click();await expect(drawer).toBeHidden()
  await save.click()
  const result=page.getByRole('region',{name:'采购单保存结果',exact:true})
  await expect(result).toContainText('读回核对一致',{timeout:30000})
  await expect.poll(()=>actual?.status).toBe('DRAFT');assert.equal(actual.lines.length,1)
  const orderId=actual.id,docNo=actual.docNo;await expect(result.getByRole('link',{name:docNo,exact:true})).toHaveAttribute('href',`/purchase/orders/${orderId}`)
  await page.reload();await expect(save).toBeEnabled();await save.click();await expect(page.getByText('已保存 1 张采购单草稿，已读回核对一致',{exact:true})).toBeVisible()
  assert.equal(creates,1);assert.deepEqual(forbidden,[]);assert.deepEqual(errors,[])
  if(screenshot)await page.screenshot({path:screenshot,fullPage:true})
  console.log(JSON.stringify({status:'SAVE_UI_VERIFIED',orderId,docNo,nativeStatus:actual.status,lines:actual.lines.length,createRequests:creates,repeatSave:'READ_ONLY',fixture:'isolated database and session'}))
}catch(error){console.error(JSON.stringify({status:'SAVE_UI_FAILED',alerts:await page.locator('.el-alert').allTextContents(),createRequests:creates,pageErrors:errors}));if(screenshot)await page.screenshot({path:screenshot.replace(/\.png$/,'-failure.png'),fullPage:true});throw error}
finally{await context.close();await browser.close()}
