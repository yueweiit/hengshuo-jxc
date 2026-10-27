// 复用本轮原生服务测试的临时端口和数据；只启动本组Vite与无界面浏览器。
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [snapshotPath, backendPort, frontendDir, playwrightModule, countryId, operator] = process.argv.slice(2)
const { chromium } = await import(pathToFileURL(playwrightModule).href)
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
const output = snapshotPath.replace(/\.json$/, '-pages')
await mkdir(output, { recursive: true })
process.chdir(frontendDir)
process.env.VITE_API_TARGET = `http://127.0.0.1:${backendPort}`
const { createServer } = await import(pathToFileURL(join(frontendDir, 'node_modules/vite/dist/node/index.js')).href)
const server = await createServer({ configFile: join(frontendDir, 'vite.config.ts'), configLoader: 'runner', root: frontendDir,
  cacheDir: join(output, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 15188, strictPort: true } })
let browser
const results = []
try {
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(({ countryId, operator }) => {
    localStorage.setItem('jxc.token', `AI08-${operator}`)
    localStorage.setItem('jxc.countryId', countryId)
  }, { countryId, operator })
  const checks = snapshot.target ? [
    { route: `/settings/countries/${snapshot.targetId}`, doc: 'AI08 clone test' },
  ] : [
    { route: `/purchase/orders/${snapshot.purchaseOrder.id}`, doc: snapshot.purchaseOrder.docNo },
    { route: `/logistics/receipts/${snapshot.receipt.id}`, doc: snapshot.receipt.docNo, status: '已入库' },
    { route: `/sales/orders/${snapshot.order.id}`, doc: snapshot.order.docNo },
    { route: '/returns/refunds', doc: snapshot.refund.docNo },
    { route: `/finance/vouchers?bookId=${snapshot.purchaseOrder.bookId}`, doc: snapshot.vouchers[0].voucher_no },
  ]
  for (const [index, check] of checks.entries()) {
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => {
      if (response.url().includes('/api/') && response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
    })
    await page.goto(`http://127.0.0.1:15188${check.route}`, { waitUntil: 'networkidle' })
    await page.getByText(check.doc, { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 })
    if (check.status) await page.getByText(check.status, { exact: false }).first().waitFor({ state: 'visible' })
    const text = await page.locator('body').innerText()
    await writeFile(join(output, `${index}.txt`), text, 'utf8')
    await page.screenshot({ path: join(output, `${index}.png`), fullPage: true })
    assert.deepEqual(errors, [], `${check.route} 页面或接口错误`)
    results.push({ ...check, countryId: Number(countryId), status: 'passed', apiErrors: errors })
    await page.close()
  }
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'passed', browserVersion: browser.version(), countryId: Number(countryId), pages: results }, null, 2), 'utf8')
  console.log(JSON.stringify({ status: 'passed', pages: results.length, countryId: Number(countryId) }))
} catch (error) {
  await writeFile(join(output, 'result.json'), JSON.stringify({ status: 'failed', countryId: Number(countryId), pages: results, error: error.message }, null, 2), 'utf8')
  throw error
} finally {
  await browser?.close()
  await server.close()
}
