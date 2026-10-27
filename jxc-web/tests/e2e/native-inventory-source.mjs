// 由 NativeInventorySourceIT 提供原生来源数据和随机 API 端口；独立浏览器，无 mock。
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const [apiPort, webRoot, output] = process.argv.slice(2)
assert(apiPort && webRoot && output, '必须提供隔离 API 端口、前端目录和证据目录')
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.JXC_TEST_PLAYWRIGHT_MODULE || 'playwright')
const { createServer } = await import(pathToFileURL(resolve(webRoot, 'node_modules/vite/dist/node/index.js')))
const config = JSON.parse(await readFile(join(output, 'ui-input.json'), 'utf8'))
await mkdir(output, { recursive: true })
const apiBase = `http://127.0.0.1:${apiPort}/api/v1`
const events = [], checks = [], consoleErrors = [], apiCalls = []
const server = await createServer({ root: webRoot, cacheDir: join(output, 'vite-cache'),
  server: { host: '127.0.0.1', port: 57303, strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } } } })
let browser
async function api(path, { method = 'GET', body, reviewer = false } = {}) {
  const response = await fetch(apiBase + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${reviewer ? 'AI03-REVIEW-TOKEN' : 'AI03-TEST-TOKEN'}`, 'X-Country-Id': '101', 'Content-Type': 'application/json' } })
  const envelope = await response.json()
  apiCalls.push({ path, method, reviewer, status: response.status, ...envelope })
  assert.equal(response.status, 200, JSON.stringify(envelope))
  assert.equal(envelope.code, 'OK', JSON.stringify(envelope))
  return envelope.data
}
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, ...(process.env.JXC_TEST_CHROMIUM_EXECUTABLE ? { executablePath: process.env.JXC_TEST_CHROMIUM_EXECUTABLE } : {}) })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  await context.addInitScript(() => {
    localStorage.setItem('jxc.token', 'AI03-TEST-TOKEN')
    localStorage.setItem('jxc.countryId', '101')
  })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  page.on('response', response => { if (response.url().includes('/api/v1/')) events.push({ url: response.url(), status: response.status() }) })
  page.on('pageerror', error => consoleErrors.push(error.message))
  async function snapshot(name) {
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: true })
    await writeFile(join(output, `${name}.txt`), await page.locator('body').innerText(), 'utf8')
  }
  async function check(name, work) {
    try { await work(); checks.push({ name, status: 'PASS' }) }
    catch (error) { checks.push({ name, status: 'FAIL', error: error.stack }); await snapshot(name+'-failure') }
  }
  async function goto(path, text) {
    const endpoint = path.endsWith('/analysis') ? '/inv/classify-results' : path.replace('/inventory/', '/inv/')
    await Promise.all([
      page.waitForResponse(response => response.url().includes('/api/v1'+endpoint) && response.status() === 200),
      page.goto(`http://127.0.0.1:57303${path}`)
    ])
    await page.getByText(text, { exact: true }).first().waitFor()
    await page.locator('.el-loading-mask:visible').first().waitFor({ state: 'hidden' })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    assert(!page.url().includes('/403') && !page.url().includes('/login'), page.url())
  }
  async function holdOrders(pattern = '**/api/v1/inv/classify-results/*/orders') {
    let announceArrival, releaseResponse, announceDelivery
    const arrived = new Promise(resolve => { announceArrival = resolve })
    const held = new Promise(resolve => { releaseResponse = resolve })
    const delivered = new Promise(resolve => { announceDelivery = resolve })
    const evidence = { requestCountry: null, responseStatus: null, body: null, delivery: null }
    await page.route(pattern, async route => {
      try {
        // 只延迟真实后端响应；保留原状态、正文和业务数据。
        const response = await route.fetch()
        evidence.requestCountry = route.request().headers()['x-country-id']
        evidence.responseStatus = response.status()
        evidence.body = await response.json()
        announceArrival()
        await held
        try {
          await route.fulfill({ response })
          evidence.delivery = { status: 'fulfilled-original-response' }
        } catch (error) {
          const failure = route.request().failure()?.errorText
          evidence.delivery = /abort|cancel/i.test(failure || '')
            ? { status: 'cancelled-by-country-switch', failure }
            : { status: 'error', reason: error.message, failure }
        }
      } catch (error) {
        evidence.delivery = { status: 'error', reason: error.message }
        announceArrival()
      } finally { announceDelivery() }
    })
    return { evidence, release: releaseResponse, delivered,
      wait: () => Promise.race([arrived, new Promise((_, reject) => setTimeout(() => reject(new Error('未收到真实订单依据响应')), 12000))]),
      dispose: async name => {
        releaseResponse()
        await page.unroute(pattern)
        await writeFile(join(output, name), JSON.stringify(evidence, null, 2), 'utf8')
      } }
  }
  await check('01-transfer-partial-receipt', async () => {
    await goto('/inventory/transfers', '调拨单')
    let row = page.getByRole('row').filter({ hasText: config.transferNo }).first()
    await row.getByRole('button', { name: '调出', exact: true }).click()
    await page.getByRole('button', { name: '确定', exact: true }).last().click()
    await row.getByRole('button', { name: '实收', exact: true }).waitFor()
    await row.getByRole('button', { name: '实收', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: `调拨实收 ${config.transferNo}` })
    await dialog.getByRole('spinbutton').fill('1')
    await dialog.getByRole('button', { name: '确认实收', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const partial = await api(`/inv/transfers/${config.transferId}`)
    assert.equal(partial.status, 'PARTIAL_RECEIVED')
    assert.equal(Number(partial.inTransitQty), 3)
    assert.equal(Number(partial.totalReceived), 1)
    await snapshot('01-transfer-partial-receipt')
    row = page.getByRole('row').filter({ hasText: config.transferNo }).first()
    await row.getByRole('button', { name: '实收', exact: true }).click()
    dialog = page.getByRole('dialog', { name: `调拨实收 ${config.transferNo}` })
    await dialog.getByRole('button', { name: '确认实收', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal((await api(`/inv/transfers/${config.transferId}`)).status, 'RECEIVED')
  })
  await check('02-freeze-partial-release', async () => {
    await goto('/inventory/freezes', '冻结管理')
    await page.getByRole('button', { name: '解冻', exact: true }).first().click()
    const dialog = page.getByRole('dialog').filter({ hasText: '解冻数量' })
    await dialog.getByRole('spinbutton').fill('1')
    await dialog.getByRole('textbox').fill('AI03 TEST 复检合格')
    await dialog.getByRole('button', { name: '解冻', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const freezes = await api('/inv/freezes')
    assert.equal(Number(freezes.records[0].activeQty), 1)
    await snapshot('02-freeze-partial-release')
  })
  await check('03-transfer-difference-approved-loss', async () => {
    await goto('/inventory/transfers', '调拨单')
    const pendingRow = page.getByRole('row').filter({ hasText: config.shortageNo }).first()
    assert(await pendingRow.getByRole('button', { name: '差异待审批', exact: true }).isDisabled())
    const pending = await api(`/inv/transfers/${config.shortageId}`)
    assert.equal(Number(pending.inTransitQty), 2)
    const tasks = await api('/wf/tasks/mine?docType=TRANSFER_DIFFERENCE', { reviewer: true })
    assert(Array.isArray(tasks.records), JSON.stringify(tasks))
    const task = tasks.records.find(task => Number(task.docId) === Number(pending.differenceId))
    assert(task, '调拨差异必须进入独立审批原单')
    await api(`/wf/tasks/${task.id}/approve`, { method: 'POST', body: { comment: 'AI03 TEST 独立复核报损' }, reviewer: true })
    await goto('/inventory/transfers', '调拨单')
    await page.getByRole('row').filter({ hasText: config.shortageNo }).first().getByRole('button', { name: '确认差异处理', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `关闭调拨单 ${config.shortageNo}` })
    await dialog.getByRole('button', { name: '确认处理并关闭', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const closed = await api(`/inv/transfers/${config.shortageId}`)
    assert.equal(closed.status, 'CLOSED')
    assert.equal(Number(closed.inTransitQty), 0)
    assert.equal(Number(closed.totalDiff), 2)
    await snapshot('03-transfer-difference-approved-loss')
  })
  await check('04-stocktake-count-approval-post', async () => {
    await goto('/inventory/stocktakes', '盘点单')
    let row = page.getByRole('row').filter({ hasText: config.stocktakeNo }).first()
    await row.getByRole('button', { name: '开始', exact: true }).click()
    await page.getByRole('button', { name: '确定', exact: true }).last().click()
    await row.getByRole('button', { name: '录入实盘', exact: true }).click()
    const drawer = page.locator('.el-drawer:visible')
    await drawer.getByRole('spinbutton').first().fill('4')
    await drawer.getByRole('spinbutton').first().press('Tab')
    await drawer.getByPlaceholder('有差异必须填写').fill('AI03 TEST 实盘短缺一件')
    await drawer.getByRole('button', { name: '提交', exact: true }).click()
    await drawer.getByRole('button', { name: '提交', exact: true }).waitFor({ state: 'hidden' })
    const pending = await api(`/inv/stocktakes/${config.stocktakeId}`)
    assert.equal(pending.status, 'SUBMITTED')
    const tasks = await api('/wf/tasks/mine?docType=STOCKTAKE', { reviewer: true })
    assert(Array.isArray(tasks.records), JSON.stringify(tasks))
    const task = tasks.records.find(task => Number(task.docId) === Number(config.stocktakeId))
    assert(task, '必须进入独立审批人的原生待办')
    await api(`/wf/tasks/${task.id}/approve`, { method: 'POST', body: { comment: 'AI03 TEST 独立复核实盘' }, reviewer: true })
    await drawer.locator('.el-drawer__close-btn').click()
    await goto('/inventory/stocktakes', '盘点单')
    row = page.getByRole('row').filter({ hasText: config.stocktakeNo }).first()
    await row.getByRole('button', { name: '过账', exact: true }).click()
    await page.getByRole('button', { name: '确定', exact: true }).last().click()
    await row.getByRole('button', { name: '过账', exact: true }).waitFor({ state: 'hidden' })
    assert.equal((await api(`/inv/stocktakes/${config.stocktakeId}`)).status, 'POSTED')
    await snapshot('04-stocktake-count-approval-post')
  })
  for (const [path, text] of [
    ['/inventory/stocks', '库存查询'], ['/inventory/txns', '库存流水'],
    ['/inventory/stocktakes', '盘点单'], ['/inventory/limits', '库存上下限'],
    ['/inventory/alerts', '库存预警'], ['/inventory/replenishments', '补货待办'],
    ['/inventory/classify-rules', '畅销滞销规则'], ['/inventory/analysis', '库存与订单联合分析']
  ]) await check('read-'+path.split('/').at(-1), async () => {
    await goto(path, text)
    if (path.endsWith('/classify-rules')) {
      await Promise.all([
        page.waitForResponse(response => response.url().includes('/recalculate') && response.status() === 200),
        page.getByRole('button', { name: '重算', exact: true }).first().click()
      ])
    }
    if (path.endsWith('/limits')) {
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Warehouse', exact: true }) }).first()
      await row.getByRole('combobox').click()
      await page.getByRole('option', { name: 'Inventory', exact: true }).click()
      await Promise.all([
        page.waitForResponse(response => response.url().includes('/inv/limits') && response.request().method() === 'PUT' && response.status() === 200),
        page.getByRole('button', { name: '保存修改', exact: true }).click()
      ])
    }
    await snapshot('read-'+path.split('/').at(-1))
    if (path.endsWith('/replenishments')) {
      const item = (await api('/inv/replenishments')).records.find(row => row.reason)
      assert(item, '原生补货原因必须存在')
      await page.getByText(item.reason, { exact: true }).first().waitFor()
      assert((await page.locator('body').innerText()).includes(item.reason), '已有原生补货原因必须在列表可见')
    }
    if (path.endsWith('/analysis')) {
      await page.getByRole('button', { name: '订单', exact: true }).first().click()
      await page.getByText('计入的有效订单', { exact: true }).waitFor()
      await snapshot('analysis-order-evidence')
    }
  })
  await check('13-rule-version-period-and-threshold', async () => {
    const previous = (await api('/inv/classify-rules')).records.find(row => row.status === 'ACTIVE')
    assert(previous, '必须有原生规则可供修改')
    await goto('/inventory/classify-rules', '畅销滞销规则')
    await page.getByRole('button', { name: '编辑', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: '分类条件', exact: true })
    const field = label => dialog.locator('.el-form-item').filter({ has: page.locator('.el-form-item__label').getByText(label, { exact: true }) })
    await field('滚动天数').getByRole('spinbutton').fill('7')
    await field('周期').locator('.el-select').click()
    await page.getByRole('option', { name: '本地自然周', exact: true }).click()
    await field('订单指标').locator('.el-select').click()
    await page.getByRole('option', { name: '订单张数', exact: true }).click()
    for (const row of await dialog.locator('.classify-condition').all()) {
      const inputs = row.locator('.condition-order').getByRole('spinbutton')
      if (await inputs.count()) await inputs.first().fill('1')
    }
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const rules = (await api('/inv/classify-rules')).records
    const current = rules.find(row => row.status === 'ACTIVE')
    assert.equal(Number(current.versionNo), Number(previous.versionNo) + 1)
    assert.equal(current.periodType, 'CALENDAR_WEEK')
    assert.equal(current.orderMetric, 'ORDER_COUNT')
    assert(current.conditions.every(condition => Number(condition.orderValue) === 1))
    assert.equal(rules.find(row => Number(row.id) === Number(previous.id)).status, 'RETIRED')
    const results = (await api('/inv/classify-results')).records
    assert.equal(results.length, 2)
    assert(results.every(row => Number(row.ruleVersionNo) === 2))
    await writeFile(join(output, 'rule-version-evidence.json'), JSON.stringify({ previous, current, rules, results }, null, 2), 'utf8')
    await snapshot('13-rule-version-period-and-threshold')
  })
  await check('14-country-switch-rejects-late-order-basis', async () => {
    await goto('/inventory/analysis', '库存与订单联合分析')
    const held = await holdOrders()
    const delayed = held.evidence
    try {
      await page.getByRole('button', { name: '订单', exact: true }).first().click()
      await held.wait()
      assert.equal(delayed.requestCountry, '101')
      assert.equal(delayed.responseStatus, 200)
      assert.equal(delayed.body.code, 'OK')
      const originalOrder = delayed.body.data[0]
      assert(originalOrder?.docNo, '真实第一国家响应必须包含原生订单')
      await page.locator('.country-switcher').click()
      await Promise.all([
        page.waitForResponse(response => response.url().includes('/inv/classify-results') && !response.url().endsWith('/orders') && response.request().headers()['x-country-id'] === '102' && response.status() === 200),
        page.getByRole('option', { name: /AI03 TEST 第二国家/ }).click()
      ])
      await page.getByText('待判断：尚无已生效规则或计算结果，请检查当前国家规则及统计周期', { exact: true }).waitFor()
      held.release()
      await held.delivered
      assert.notEqual(delayed.delivery?.status, 'error', JSON.stringify(delayed.delivery))
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(await page.evaluate(() => localStorage.getItem('jxc.countryId')), '102')
      assert(!(await page.locator('body').innerText()).includes(originalOrder.docNo), '旧国家的迟到订单依据不能回填')
      assert.equal(await page.getByText('计入的有效订单', { exact: true }).isVisible(), false)
      await snapshot('14-country-switch-rejects-late-order-basis')
      await page.locator('.country-switcher').click()
      await Promise.all([
        page.waitForResponse(response => response.url().includes('/inv/classify-results') && !response.url().endsWith('/orders') && response.request().headers()['x-country-id'] === '101' && response.status() === 200),
        page.getByRole('option', { name: /^Mexico/ }).click()
      ])
      await page.getByRole('button', { name: '订单', exact: true }).first().waitFor()
    } finally {
      await held.dispose('country-late-response-evidence.json')
    }
  })
  await check('15-warehouse-switch-rejects-late-order-basis', async () => {
    await goto('/inventory/analysis', '库存与订单联合分析')
    const results = (await api('/inv/classify-results')).records
    const source = results.find(row => Number(row.dimId) === 401)
    assert(source, '第一仓必须有原生分类结果')
    const held = await holdOrders(`**/api/v1/inv/classify-results/${source.id}/orders`)
    try {
      const row = name => page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) }).first()
      await row('Warehouse').getByRole('button', { name: '订单', exact: true }).click()
      await held.wait()
      assert.equal(held.evidence.responseStatus, 200)
      assert.equal(held.evidence.body.code, 'OK')
      const originalOrder = held.evidence.body.data[0]
      assert(originalOrder?.docNo, '第一仓真实响应必须包含原生订单')
      await row('Warehouse 2').getByRole('button', { name: '订单', exact: true }).click()
      const drawer = page.locator('.el-drawer:visible')
      await drawer.waitFor()
      assert(!(await drawer.innerText()).includes(originalOrder.docNo), '第二仓没有第一仓订单')
      held.release()
      await held.delivered
      assert.notEqual(held.evidence.delivery?.status, 'error', JSON.stringify(held.evidence.delivery))
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert(!(await drawer.innerText()).includes(originalOrder.docNo), '旧仓库的迟到订单依据不能覆盖当前仓库')
      await snapshot('15-warehouse-switch-rejects-late-order-basis')
    } finally { await held.dispose('warehouse-late-response-evidence.json') }
  })
  assert.deepEqual(consoleErrors, [], JSON.stringify(consoleErrors))
  const failures = checks.filter(check => check.status === 'FAIL')
  assert.equal(failures.length, 0, JSON.stringify(failures))
} finally {
  await writeFile(join(output, 'ui-results.json'), JSON.stringify({ checks, events, apiCalls, consoleErrors }, null, 2), 'utf8')
  if (browser) await browser.close()
  await server.close()
}
