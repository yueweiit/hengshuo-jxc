import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium, expect } from '@playwright/test'

test('真实核对组件桌面/窄屏可操作，预览后才确认写入',async()=>{
 const root=fileURLToPath(new URL('../..',import.meta.url))
 const server=await createServer({configFile:false,root:fileURLToPath(new URL('./fixtures',import.meta.url)),cacheDir:`${root}/runtime/review-verification/vite-cache`,plugins:[vue()],resolve:{alias:{'@':fileURLToPath(new URL('../src',import.meta.url))}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,'C:/project/jxc/jxc-web/node_modules']}}})
 await server.listen();let browser
 try{
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[]
  page.on('pageerror',e=>errors.push(e.message));await page.goto(`${server.resolvedUrls.local[0]}purchase-import-review.html`)
  await expect(page.getByText('原表中的“TEST-ORDER”',{exact:false})).toBeVisible();await page.getByRole('button',{name:'本文件采购单号',exact:true}).click()
  await expect(page.getByText('待确认：将“TEST-ORDER”',{exact:false})).toBeVisible()
  assert.equal(await page.evaluate(()=>window.reviewFixture.calls.length),0)
  await page.getByRole('button',{name:'确认本次核对'}).click()
  await expect.poll(()=>page.evaluate(()=>window.reviewFixture.model.state.rows[0].sourceOrderNo)).toBe('TEST-ORDER')
  assert.equal(await page.evaluate(()=>window.reviewFixture.calls.length),1)
  await expect(page.getByText('原列名为“cost usd”',{exact:false})).toBeVisible();await page.getByRole('button',{name:'是，这一列以美元计价',exact:true}).click();await page.getByRole('button',{name:'确认本次核对',exact:true}).click();assert.equal(await page.evaluate(()=>window.reviewFixture.model.state.header.currency),null)
  await page.screenshot({path:`${root}/runtime/review-verification/assistant-desktop.png`})
  await page.setViewportSize({width:390,height:844});await expect(page.getByRole('button',{name:'整理修改建议'})).toBeVisible()
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
  await page.screenshot({path:`${root}/runtime/review-verification/assistant-narrow.png`});assert.deepEqual(errors,[])
 }finally{await browser?.close();await server.close()}
})
