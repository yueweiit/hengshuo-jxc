import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium, expect } from '@playwright/test'

test('真实RevoGrid空表粘贴、编辑中切换、已有数据往返和失败重试', async () => {
  const root=fileURLToPath(new URL('..',import.meta.url)), output=`${root}/../runtime/grid-verification`
  await mkdir(output,{recursive:true})
  const server=await createServer({configFile:false,root:fileURLToPath(new URL('./fixtures',import.meta.url)),cacheDir:`${output}/vite-cache`,optimizeDeps:{entries:['purchase-import-grid.html']},plugins:[vue()],resolve:{alias:{'@':`${root}/src`}},server:{host:'127.0.0.1',port:0,fs:{allow:[root]}}})
  await server.listen(); let browser
  try {
    // Windows下LevelDB会继续拼接目录，使用短临时路径验证真实持久存储。
    const profile=await mkdtemp(join(tmpdir(),'jxc-import-grid-')),options={headless:true,viewport:{width:1440,height:900},permissions:['clipboard-read','clipboard-write']}
    browser=await chromium.launchPersistentContext(profile,options)
    let page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message))
    await page.goto(`${server.resolvedUrls.local[0]}purchase-import-grid.html`)
    await page.getByRole('button',{name:'切换到粘贴模板视图',exact:true}).click()
    await expect(page.locator('revo-grid')).toBeVisible()
    await expect(page.locator('revo-grid').getByText('采购单号',{exact:true})).toBeVisible()
    await page.locator('revogr-data[type="rgRow"][col-type="rgCol"] [data-rgrow="0"][data-rgcol="0"]').click()
    await page.locator('revo-grid').evaluate(grid=>grid.dispatchEvent(new ClipboardEvent('paste',{clipboardData:new DataTransfer(),bubbles:true,cancelable:true})))
    await expect(page.getByRole('alert')).toContainText('未读取到剪贴板内容')
    // Windows headless的可信paste事件未携带OS剪贴板内容；在真实组件边界提供原生DataTransfer，仍由RevoGrid解析。
    await page.locator('revo-grid').evaluate(grid=>{
      const clipboardData=new DataTransfer();clipboardData.setData('text/plain','PO-A\t商品甲\t\tM\t2\nPO-A\t商品乙\t\tL\t3')
      grid.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}))
    })
    await expect.poll(()=>page.evaluate(()=>window.gridFixture.model.grid.rows().filter(r=>r.sourceOrderNo).length)).toBe(2)
    await page.locator('revo-grid').evaluate(async grid=>{
      await grid.setCellsFocus({x:11,y:0},{x:11,y:0})
      const clipboardData=new DataTransfer();clipboardData.setData('text/plain','10\t超出列')
      grid.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}))
    })
    await expect(page.getByRole('alert')).toContainText('超过固定列范围')
    assert.equal(await page.evaluate(()=>window.gridFixture.model.grid.rows()[0].usdTotal),null)
    const copied=await page.locator('revo-grid').evaluate(async grid=>{
      await grid.setCellsFocus({x:1,y:0},{x:1,y:0})
      const clipboardData=new DataTransfer()
      grid.dispatchEvent(new ClipboardEvent('copy',{clipboardData,bubbles:true,cancelable:true}))
      return new Promise(resolve=>requestAnimationFrame(()=>resolve(clipboardData.getData('text/plain'))))
    })
    assert.equal(copied,'商品甲')
    await page.locator('revo-grid').evaluate(async grid=>{
      await grid.setCellsFocus({x:4,y:2},{x:4,y:2})
      const zero=new DataTransfer();zero.setData('text/plain','0\n0.00')
      grid.dispatchEvent(new ClipboardEvent('paste',{clipboardData:zero,bubbles:true,cancelable:true}))
    })
    await page.locator('revo-grid').evaluate(async grid=>{
      await grid.setCellsFocus({x:2,y:0},{x:2,y:0})
      const clipboardData=new DataTransfer(),bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHE0AAAAASUVORK5CYII='),c=>c.charCodeAt(0))
      clipboardData.items.add(new File([bytes],'粘贴.png',{type:'image/png'}))
      grid.dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}))
    })
    await expect.poll(()=>page.evaluate(()=>!!window.gridFixture.model.grid.photo(window.gridFixture.model.grid.rows()[0].id))).toBe(true)
    await page.getByRole('button',{name:'完成编辑',exact:true}).click()
    assert.equal(await page.evaluate(()=>window.gridFixture.model.grid.rows().length),2)
    assert.equal(await page.evaluate(()=>window.gridFixture.calls.length),0)
    await page.evaluate(()=>window.gridFixture.local.flush())
    await browser.close()
    browser=await chromium.launchPersistentContext(profile,options)
    page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message))
    await page.goto(`${server.resolvedUrls.local[0]}purchase-import-grid.html`)
    await expect(page.getByText('商品甲',{exact:true})).toBeVisible()
    assert.equal(await page.evaluate(()=>window.gridFixture.model.grid.photo(window.gridFixture.model.grid.rows()[0].id).name),'粘贴.png')
    assert.equal(await page.evaluate(()=>window.gridFixture.calls.length),0)
    await expect(page.locator('th').filter({hasText:'商品名'})).toBeVisible()
    await expect(page.getByText('商品甲',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'上传',exact:true}).click()
    await expect.poll(()=>page.evaluate(()=>window.gridFixture.model.grid.hasChanges())).toBe(false)
    assert.equal(await page.evaluate(()=>window.gridFixture.model.state.rows.length),2)
    assert.equal(await page.evaluate(()=>window.gridFixture.photoCalls.length),1)

    await page.evaluate(()=>window.gridFixture.loadExisting())
    await page.getByRole('button',{name:'切换到粘贴模板视图',exact:true}).click()
    await page.locator('revo-grid').getByText('采购单号',{exact:true}).waitFor()
    await page.locator('revo-grid').evaluate(async grid=>grid.setCellEdit(0,'suppliedProductName'))
    await page.locator('revo-grid input').last().fill('Esc取消的文字')
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(()=>window.gridFixture.model.grid.rows()[0].suppliedProductName),'来源商品')
    await page.locator('revogr-data[type="rgRow"][col-type="rgCol"] [data-rgrow="0"][data-rgcol="3"]').click()
    await page.keyboard.press('Delete')
    await expect.poll(()=>page.evaluate(()=>window.gridFixture.model.grid.rows()[0].productSpec)).toBe(null)
    await page.locator('revo-grid').evaluate(async grid=>grid.setCellEdit(0,'suppliedProductName'))
    const input=page.locator('revo-grid input').last();await expect(input).toBeVisible();await input.fill('输入未结束的商品名')
    await page.evaluate(()=>window.gridFixture.local.flush())
    await page.reload()
    await expect(page.locator('revo-grid').getByText('输入未结束的商品名',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'完成编辑',exact:true}).click()
    await expect(page.getByText('输入未结束的商品名',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'切换到粘贴模板视图',exact:true}).click()
    assert.equal(await page.evaluate(()=>window.gridFixture.model.grid.rows()[0].purchaseUnitPrice),'53.0606250000')
    await expect(page.locator('revo-grid').getByText('输入未结束的商品名',{exact:true})).toBeVisible()
    await page.screenshot({path:`${output}/excel-desktop.png`})
    await page.evaluate(()=>window.gridFixture.fail=true)
    await page.getByRole('button',{name:'上传',exact:true}).click()
    await expect(page.getByRole('alert')).toContainText('测试保存失败')
    await page.getByRole('button',{name:'完成编辑',exact:true}).click()
    await expect(page.getByText('输入未结束的商品名',{exact:true})).toBeVisible()
    await page.evaluate(()=>window.gridFixture.fail=false)
    await page.getByRole('button',{name:'重试上传',exact:true}).click()
    await expect.poll(()=>page.evaluate(()=>window.gridFixture.model.grid.hasChanges())).toBe(false)
    const keys=await page.evaluate(()=>window.gridFixture.calls.slice(-2).map(c=>c.key));assert.equal(keys[0],keys[1])
    await page.setViewportSize({width:390,height:844})
    await expect(page.getByRole('button',{name:'切换到粘贴模板视图',exact:true})).toBeVisible()
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
    await page.screenshot({path:`${output}/table-narrow.png`});assert.deepEqual(errors,[])
  } finally {await browser?.close();await server.close()}
})
