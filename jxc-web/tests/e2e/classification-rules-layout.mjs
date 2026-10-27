import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// 仅使用浏览器内拦截的隔离夹具；不会访问真实业务API。
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.JXC_TEST_PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.JXC_UI_BASE_URL || 'http://127.0.0.1:15187'
const output = process.env.JXC_UI_OUTPUT
assert.ok(output, '请指定独立的截图与结果目录 JXC_UI_OUTPUT')
await mkdir(output, { recursive: true })
const rule = {
  id: 42, name: '联合分类', dimType: 'WAREHOUSE', periodType: 'ROLLING_DAYS', periodDays: 90,
  orderMetric: 'QTY', stockMetric: 'AVAILABLE', versionNo: 7, effectiveFrom: '2026-10-27', status: 'ACTIVE',
  conditions: [
    { label: 'HOT_CANDIDATE', priority: 1, stockOp: 'GTE', stockValue: 100, stockValue2: 0, orderOp: 'GTE', orderValue: 20, orderValue2: 0 },
    { label: 'SLOW_CANDIDATE', priority: 2, stockOp: 'BETWEEN', stockValue: 100, stockValue2: 500, orderOp: 'LTE', orderValue: 5, orderValue2: 0 },
    { label: 'WATCH', priority: 3, stockOp: 'ANY', stockValue: 12, stockValue2: 24, orderOp: 'ANY', orderValue: 9, orderValue2: 18 },
  ],
}
const country = { id: 101, code: 'UI', name: '界面测试', status: 'ACTIVE', defaultCurrency: 'CNY', timezone: 'Asia/Shanghai', locale: 'zh-CN', dateFormat: 'YYYY-MM-DD', numberFormat: '1,234.56', isTest: true, enabledModules: ['inventory'] }
const report = { status: 'error', scope: '真实前端与Element Plus控件；API为隔离夹具，不代表真实后端业务验收', viewports: [], checks: [] }
const browser = await chromium.launch({ headless: true, channel: process.env.JXC_TEST_BROWSER_CHANNEL || 'msedge' })
const context = await browser.newContext()
const errors = [], commands = []
let pendingSave, confirmSave
try {
  await context.addInitScript(() => { localStorage.setItem('jxc.token', 'isolated-ui-fixture'); localStorage.setItem('jxc.countryId', '101'); localStorage.setItem('jxc.locale', 'zh-CN') })
  await context.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const ok = data => route.fulfill({ json: { code: 'OK', message: '', data, traceId: 'isolated-ui' } })
    if (path === '/api/v1/auth/me') return ok({ user: { id: 1, username: 'ui-fixture', displayName: '界面测试', isPlatformAdmin: false, locale: 'zh-CN' }, countries: [country], currentCountryId: 101, permissions: ['inv:classify:config'], fieldGroups: {} })
    if (path === '/api/v1/sys/workbench/summary') return ok({ items: [], unreadNotifications: 0 })
    if (path === '/api/v1/inv/classify-rules' && request.method() === 'GET') return ok({ records: [rule, { ...rule, id: 43, name: '门店周规则', dimType: 'STORE', periodType: 'CALENDAR_WEEK', status: 'RETIRED' }], total: 2, page: 1, size: 200 })
    if (path === '/api/v1/inv/classify-rules/42' && request.method() === 'PUT') {
      commands.push(request.postDataJSON())
      if (pendingSave) await pendingSave
      return ok({ id: 42 })
    }
    errors.push(`未声明的API：${request.method()} ${path}`)
    return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  async function openRule(width) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(`${base}/inventory/classify-rules`)
    await page.getByRole('button', { name: '编辑', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '分类条件', exact: true })
    await dialog.waitFor()
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'))
    return dialog
  }
  // 检查实际控件边界和交叠，不依赖某一种网格或表格的实现。
  for (const width of [1440, 1024, 768, 375, 320]) {
    const dialog = await openRule(width)
    const geometry = await dialog.evaluate(root => {
      const bounds = root.getBoundingClientRect()
      const selectors = '.el-select, .el-input-number, .el-date-editor, .el-input'
      const controls = [...root.querySelectorAll(selectors)].filter(el => !el.parentElement.closest(selectors) && el.getBoundingClientRect().width > 0)
      const boxes = controls.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom } })
      const outside = boxes.filter(r => r.x < bounds.left - 1 || r.right > bounds.right + 1)
      const overlaps = boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 2).map(b => ({ a, b })))
      const footer = root.querySelector('.el-dialog__footer').getBoundingClientRect()
      return { dialogWidth: bounds.width, viewportWidth: innerWidth, outside, overlaps, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, footerBottom: footer.bottom, viewportHeight: innerHeight }
    })
    await page.screenshot({ path: join(output, `classify-rules-${width}.png`), fullPage: true })
    assert.ok(geometry.dialogWidth <= width, `弹窗超出${width}px窗口`)
    assert.deepEqual(geometry.outside, [], `${width}px有控件超出弹窗`)
    assert.deepEqual(geometry.overlaps, [], `${width}px条件控件互相重叠`)
    assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, `${width}px弹窗存在水平溢出`)
    assert.ok(geometry.footerBottom <= geometry.viewportHeight, `${width}px保存按钮被挤出窗口`)
    if (width === 375) {
      await dialog.locator('.classify-rule-body').evaluate(body => { body.scrollTop = body.scrollHeight })
      await page.screenshot({ path: join(output, 'classify-rules-375-conditions.png'), fullPage: true })
    }
    report.viewports.push({ width, status: 'ok' })
  }
  const dialog = await openRule(1440)
  const groups = dialog.locator('.classify-condition')
  assert.equal(await groups.count(), 3)
  const stock = groups.nth(1).locator('.condition-stock')
  assert.equal(await stock.getByRole('spinbutton').count(), 2, '区间必须可编辑起止值')
  assert.equal(await stock.getByRole('spinbutton').nth(0).inputValue(), '100')
  assert.equal(await stock.getByRole('spinbutton').nth(1).inputValue(), '500')
  const any = groups.nth(2).locator('.condition-stock')
  assert.equal(await any.getByRole('spinbutton').count(), 0, '不限时隐藏无作用的数字输入')
  await any.locator('.el-select').click()
  await page.getByRole('option', { name: '大于等于', exact: true }).click()
  assert.equal(await any.getByRole('spinbutton').inputValue(), '12', '切换比较方式保留原值')
  await any.locator('.el-select').click()
  await page.getByRole('option', { name: '不限', exact: true }).click()
  report.checks.push('区间起止值与不限切换保留数据')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(commands.length, 0, '取消不能提交规则')
  await page.screenshot({ path: join(output, 'classify-rules-list.png'), fullPage: true })
  report.checks.push('取消不发出保存请求')
  const editing = await openRule(1440)
  pendingSave = new Promise(resolve => { confirmSave = resolve })
  await editing.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.el-dialog__footer .el-button.is-loading'))
  assert.equal(await editing.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape')
  assert.equal(await editing.isVisible(), true, '提交中不能误关弹窗')
  assert.equal(commands.length, 1)
  assert.deepEqual(commands[0], rule, '中文呈现不得改变原生保存字段与运算符')
  confirmSave()
  await editing.waitFor({ state: 'hidden' })
  report.checks.push('提交中状态与原生保存参数')
  const row = page.getByRole('row').filter({ hasText: '门店周规则' })
  assert.ok((await row.innerText()).includes('门店'))
  assert.ok((await row.innerText()).includes('本地自然周'))
  assert.ok(!(await row.innerText()).includes('90'), '自然周规则不能误显示为滚动90天')
  report.checks.push('列表中文维度与实际统计周期')
  assert.deepEqual(errors, [])
  report.status = 'ok'
} catch (error) {
  report.reason = error.message
  throw error
} finally {
  confirmSave?.()
  await context.close()
  await browser.close()
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2), 'utf8')
}
console.log(JSON.stringify(report))
