// Real browser readback of the same native-service source chain; no mocked routes or APIs.
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, extname, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const [backendPort, distPath, evidenceFile] = process.argv.slice(2)
assert(backendPort && distPath && evidenceFile && process.env.AI01_PLAYWRIGHT_MODULE, 'Explicit AI01 runtime and Playwright module are required')
const { chromium } = await import(pathToFileURL(process.env.AI01_PLAYWRIGHT_MODULE).href)
const facts = JSON.parse(await readFile(evidenceFile, 'utf8'))
const root = resolve(distPath)
const output = resolve(dirname(evidenceFile), `${basename(evidenceFile, '.json')}-pages`)
await mkdir(output, { recursive: true })
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) {
    const proxy = request({ host: '127.0.0.1', port: Number(backendPort), path: req.url, method: req.method, headers: req.headers }, incoming => {
      res.writeHead(incoming.statusCode, incoming.headers)
      incoming.pipe(res)
    })
    proxy.on('error', error => { res.writeHead(502); res.end(error.message) })
    req.pipe(proxy)
    return
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    let file = resolve(root, `.${pathname}`)
    assert(file === root || file.startsWith(`${root}\\`) || file.startsWith(`${root}/`), 'Static path escaped dist')
    if (!extname(file)) file = resolve(root, 'index.html')
    const bytes = await readFile(file)
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' })
    res.end(bytes)
  } catch (error) { res.writeHead(404); res.end(error.message) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const orders = facts.sal_order
assert(orders.length, 'Scenario must retain actual source orders')
const order = orders.at(-1)
const plan = []
const add = (user, path, api, expected) => plan.push({ user, path, api, expected })
const name = facts.method || basename(evidenceFile)
if (/pricePriority/.test(name)) add(201, '/sales/prices', '/sal/prices', '价格')
if (/twoWarehouse/.test(name)) {
  add(214, `/sales/orders/${order.id}`, `/sal/orders/${order.id}`, order.doc_no)
  add(215, `/sales/orders/${order.id}`, `/sal/orders/${order.id}`, order.doc_no)
} else if (/cashBank|writeoffReversal/.test(name)) {
  add(216, '/ar/receipts', '/ar/receipts', facts.ar_receipt[0].doc_no)
  add(216, '/ar/statements', '/ar/statements', '客户对账单')
  add(216, '/ar/customers/1801', '/ar/customers/1801/balances', '未结应收')
} else if (/creditVersion/.test(name)) add(216, '/ar/credit-rules', '/ar/credit-rules', '授信规则')
else if (/overduePolicy|countryTimezone/.test(name)) add(216, '/ar/receivables', '/ar/receivables', facts.ar_receivable[0].doc_no)
else if (/signDifferences/.test(name)) add(214, '/sales/signs', '/sal/signs', facts.sal_outbound[0].doc_no)
else if (/salespersonAndStore/.test(name)) add(212, '/sales/orders', '/sal/orders', order.doc_no)
add(211, `/sales/orders/${order.id}`, `/sal/orders/${order.id}`, order.doc_no)

const results = []
let browser
try {
  browser = await chromium.launch({ headless: true, channel: process.env.AI01_BROWSER_CHANNEL || 'msedge' })
  for (const [index, item] of plan.entries()) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    const page = await context.newPage()
    const responses = []
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', async response => {
      if (response.url().includes('/api/v1/')) {
        try { responses.push({ url: new URL(response.url()).pathname, status: response.status(), body: await response.json() }) }
        catch (error) { responses.push({ url: response.url(), status: response.status(), parseError: error.message }) }
      }
    })
    try {
      await context.addInitScript(({ token }) => {
        localStorage.setItem('jxc.token', token)
        localStorage.setItem('jxc.countryId', '101')
      }, { token: item.user === 201 ? 'supply-fixture' : `ai01-${item.user}` })
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1${item.api}`, { timeout: 25000 })
      await page.goto(`${origin}${item.path}`, { waitUntil: 'networkidle', timeout: 30000 })
      const response = await responsePromise
      assert.equal(response.status(), 200, await response.text())
      await page.getByText(item.expected, { exact: false }).first().waitFor({ state: 'visible', timeout: 10000 })
      assert(!/\/(403|login)(\?|$)/.test(new URL(page.url()).pathname), 'Authorized page redirected')
      assert.deepEqual(errors, [], 'Browser script errors')
      const failed = responses.filter(response => response.status >= 400)
      assert.deepEqual(failed, [], 'Authorized page API errors must be fixed, not hidden')
      const text = await page.locator('body').innerText()
      await page.screenshot({ path: resolve(output, `${index}-${item.user}.png`), fullPage: true })
      await writeFile(resolve(output, `${index}-${item.user}.txt`), text, 'utf8')
      results.push({ ...item, status: 'PASS', pageUrl: item.path, responses, errors })
    } catch (error) {
      await page.screenshot({ path: resolve(output, `${index}-${item.user}-failure.png`), fullPage: true }).catch(screenshotError => errors.push(`Failure screenshot: ${screenshotError.message}`))
      results.push({ ...item, status: 'ERROR', message: error.stack, responses, errors })
      throw error
    } finally { await context.close() }
  }
} finally {
  if (browser) await browser.close()
  await new Promise(resolve => server.close(resolve))
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ test: facts.test, mode: 'native service commands plus real browser readback', results }, null, 2), 'utf8')
}
