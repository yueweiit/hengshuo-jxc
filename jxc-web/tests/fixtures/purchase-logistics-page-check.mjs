// 与原生服务测试共用当轮隔离PG和随机后端端口；每次关闭自己的Vite和浏览器。
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [snapshotPath, backendPort, frontendDir, playwrightModule] = process.argv.slice(2)
const { chromium } = await import(pathToFileURL(playwrightModule).href)
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
const output = join(dirname(snapshotPath), `${snapshot.scenario}-pages`)
await mkdir(output, { recursive: true })
const base = 'http://127.0.0.1:15182'
process.chdir(frontendDir)
process.env.VITE_API_TARGET = `http://127.0.0.1:${backendPort}`
const { createServer } = await import(pathToFileURL(join(frontendDir, 'node_modules/vite/dist/node/index.js')).href)
const server = await createServer({ configFile: join(frontendDir, 'vite.config.ts'), configLoader: 'runner',
  root: frontendDir, cacheDir: join(output, 'vite-cache'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 15182, strictPort: true },
})
let browser
const results = []
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const checks = [
    ...snapshot.pur_order.map(row => ({ role: 'buyer', token: 'supply-fixture', route: `/purchase/orders/${row.id}`, doc: row.doc_no })),
    ...(snapshot.pur_domestic_receipt.length ? [{ role: 'logistics', token: 'AI02-TEST-211', route: '/purchase/domestic-receipts', doc: snapshot.pur_domestic_receipt[0].doc_no }] : []),
    ...(snapshot.pur_export_node.length ? [{ role: 'logistics', token: 'AI02-TEST-211', route: '/purchase/export-nodes', doc: snapshot.pur_export_node[0].doc_no }] : []),
    ...snapshot.lgs_shipment.map(row => ({ role: 'logistics', token: 'AI02-TEST-211', route: `/logistics/shipments/${row.id}`, doc: row.doc_no })),
    ...snapshot.lgs_receipt.map(row => ({ role: 'warehouse', token: 'AI02-TEST-221', route: `/logistics/receipts/${row.id}`, doc: row.doc_no, receipt: row })),
    ...(snapshot.lgs_hold.length ? [{ role: 'logistics', token: 'AI02-TEST-211', route: '/logistics/holds', doc: snapshot.lgs_hold[0].doc_no }] : []),
    ...(snapshot.lgs_fee.length ? [{ role: 'logistics', token: 'AI02-TEST-211', route: '/logistics/fees', doc: snapshot.lgs_fee[0].doc_no }] : []),
  ]
  for (const [index, check] of checks.entries()) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(({ token }) => { localStorage.setItem('jxc.token', token); localStorage.setItem('jxc.countryId', '101') }, { token: check.token })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`) })
    await page.goto(base + check.route, { waitUntil: 'networkidle' })
    await page.getByText(check.doc, { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 })
    const action = snapshot.uiAction
    let actionPath
    if (action === 'submitPurchase' && check.role === 'buyer') {
      actionPath = `/pur/orders/${snapshot.pur_order[0].id}/submit`
      await page.getByRole('button', { name: '提交', exact: true }).click()
    } else if (action === 'confirmDomestic' && check.route === '/purchase/domestic-receipts') {
      actionPath = `/pur/domestic-receipts/${snapshot.pur_domestic_receipt[0].id}/confirm`
      await page.locator('.el-table__row').filter({ hasText: check.doc }).first().getByRole('button', { name: '确认', exact: true }).click()
    } else if (action === 'confirmReceipt' && check.role === 'warehouse') {
      actionPath = `/lgs/receipts/${check.receipt.id}/confirm`
      await page.getByRole('button', { name: '确认实收', exact: true }).click()
    }
    if (actionPath) {
      const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(actionPath))
      await page.locator('.el-message-box').getByRole('button', { name: '确定', exact: true }).click()
      assert.equal((await response).status(), 200, `实际页面命令失败：${actionPath}`)
      await page.waitForLoadState('networkidle')
      if (action === 'confirmReceipt') await page.getByText('已入库', { exact: false }).first().waitFor({ state: 'visible' })
    }
    const text = await page.locator('body').innerText()
    await writeFile(join(output, `${index}-${check.role}.txt`), text, 'utf8')
    await page.screenshot({ path: join(output, `${index}-${check.role}.png`), fullPage: true })
    assert.deepEqual(errors, [], `${check.route}出现页面或接口错误`)
    if (check.receipt) {
      assert.ok(text.includes('已入库'), '真实确认的实收页面应显示已入库')
      const lines = snapshot.lgs_receipt_line.filter(line => line.receipt_id === check.receipt.id)
      for (const line of lines) {
        const cells = page.locator(`#line-${line.id} td`)
        for (const [column, field] of ['good_qty', 'damaged_qty', 'pending_inspect_qty', 'short_qty'].entries()) {
          const displayed = (await cells.nth(4 + column).innerText()).trim().replaceAll(',', '')
          assert.equal(Number(displayed), Number(line[field]), `实收行${line.id}的${field}与原生事实不同`)
        }
        const batchText = (await cells.nth(9).innerText()).trim()
        if (actionPath && action === 'confirmReceipt') {
          assert.ok(batchText && !['确认后生成', '未生成'].includes(batchText), '页面确认必须返回真实入库批次')
        } else {
          const batch = snapshot.inv_batch.find(row => row.id === line.inv_batch_id)
          assert.ok(batch, `实收行${line.id}缺少真实入库批次`)
          assert.equal(batchText, batch.batch_no)
        }
      }
    }
    results.push({ role: check.role, route: check.route, docNo: check.doc, action: actionPath, status: 'passed', apiErrors: errors })
    await context.close()
  }
  await writeFile(join(output, 'result.json'), JSON.stringify({ scenario: snapshot.scenario, status: 'passed',
    browserVersion: browser.version(), backendOrigin: `http://127.0.0.1:${backendPort}`, pages: results }, null, 2), 'utf8')
  console.log(JSON.stringify({ status: 'passed', scenario: snapshot.scenario, pages: results.length }))
} catch (error) {
  await writeFile(join(output, 'result.json'), JSON.stringify({ scenario: snapshot.scenario, status: 'failed', pages: results, error: error.message }, null, 2), 'utf8')
  throw error
} finally {
  await browser?.close()
  await server.close()
}
