// Native read-only browser acceptance. The caller owns the isolated Vite/API stack.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const { chromium } = await import(process.env.AI04_PLAYWRIGHT_MODULE || 'playwright')
const [baseURL, documentId, docNo, expectedHash, outputDir] = process.argv.slice(2)
assert.ok(baseURL && documentId && docNo && expectedHash && outputDir)
assert.equal(new URL(baseURL).hostname, '127.0.0.1')
await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.AI04_BROWSER, headless: true, args: ['--disable-gpu', '--renderer-process-limit=2'] })
const checks = [], mutations = [], failures = []
try {
  for (const entry of ['list-after-login', 'source-after-relogin']) {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    try {
      const page = await context.newPage(); page.setDefaultTimeout(20000)
      await page.route('**/api/v1/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !['/api/v1/auth/login', '/api/v1/auth/logout'].includes(path)) {
          mutations.push({ method: request.method(), path }); await route.abort(); return
        }
        await route.continue()
      })
      page.on('pageerror', error => failures.push(error.message))
      await page.goto(baseURL + '/login?redirect=%2Fap%2Fpayments'); await page.locator('#account').fill(process.env.AI04_TEST_USER)
      await page.locator('#password').fill(process.env.AI04_TEST_PASSWORD)
      const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/me')
      await page.locator('button[type=submit]').click(); const me = await (await loaded).json()
      assert.equal(me.code, 'OK'); assert.equal(me.data.user.isPlatformAdmin, false)
      assert.ok(me.data.permissions.includes('ap:payment:create'))
      await page.waitForURL(url => url.pathname !== '/login')
      await page.goto(baseURL + '/ap/payments' + (entry.startsWith('source') ? '?sourceId=' + documentId : ''))
      if (entry.startsWith('list')) {
        const row = page.locator('.el-table__body tr').filter({ hasText: docNo })
        await row.getByRole('button', { name: '查看凭证', exact: true }).click()
      }
      const dialog = page.getByRole('dialog', { name: '付款凭证', exact: true })
      await dialog.getByText(docNo, { exact: false }).waitFor()
      assert.equal(await dialog.getByRole('button', { name: '上传', exact: true }).count(), 0)
      assert.equal(await dialog.getByRole('button', { name: '删除', exact: true }).count(), 0)
      const downloadPromise = page.waitForEvent('download')
      await dialog.getByRole('button', { name: '下载', exact: true }).click()
      const download = await downloadPromise, file = join(outputDir, entry + '-' + download.suggestedFilename())
      await download.saveAs(file)
      const hash = createHash('sha256').update(await readFile(file)).digest('hex'); assert.equal(hash, expectedHash)
      await page.screenshot({ path: join(outputDir, entry + '.png'), fullPage: true })
      checks.push({ entry, documentId, docNo, username: me.data.user.username, userId: me.data.user.id, isPlatformAdmin: false, hash, readonly: true, status: 'PASS' })
    } finally { await context.close() }
  }
  const pageChecks = JSON.parse(process.env.AI04_PAGE_CHECKS || '[]')
  if (pageChecks.length) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    try {
      const page = await context.newPage(); page.setDefaultTimeout(20000)
      await page.route('**/api/v1/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && path !== '/api/v1/auth/login') { mutations.push({ method: request.method(), path }); await route.abort(); return }
        await route.continue()
      })
      await page.goto(baseURL + '/login?redirect=%2Fap%2Fbills'); await page.locator('#account').fill(process.env.AI04_VIEWER_USER); await page.locator('#password').fill(process.env.AI04_VIEWER_PASSWORD)
      const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/me'); await page.locator('button[type=submit]').click()
      const me = await (await loaded).json(); assert.equal(me.code, 'OK'); assert.equal(me.data.user.isPlatformAdmin, false)
      await page.waitForURL(url => url.pathname !== '/login')
      for (const [index, item] of pageChecks.entries()) {
        await page.goto(baseURL + item.path); const row = page.locator(item.selector || '.el-table__body tr').filter({ hasText: item.docNo }); await row.waitFor({ state: 'visible' })
        const actual = await row.innerText(); assert.ok(actual.includes(item.docNo))
        if (item.expectedText) assert.ok(actual.includes(item.expectedText), 'native source page must show ' + item.expectedText)
        await page.screenshot({ path: join(outputDir, 'native-source-page-' + index + '.png'), fullPage: true })
        checks.push({ entry: 'native-source-page', path: item.path, docNo: item.docNo, actual, userId: me.data.user.id, status: 'PASS' })
      }
    } finally { await context.close() }
  }
  assert.deepEqual(mutations, []); assert.deepEqual(failures, [])
  await writeFile(join(outputDir, 'browser-result.json'), JSON.stringify({ status: 'PASS', checks, mutations, failures }, null, 2), 'utf8')
  console.log('AI04_PAYMENT_EVIDENCE_BROWSER_PASS ' + checks.length)
} catch (error) {
  await writeFile(join(outputDir, 'browser-result.json'), JSON.stringify({ status: 'ERROR', checks, mutations, failures, error: error.message }, null, 2), 'utf8')
  throw error
} finally { await browser.close() }
