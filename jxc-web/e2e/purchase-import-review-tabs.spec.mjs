/** 隔离组件交互验证；不登录、不连接真实业务 API、不写业务数据。 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium, expect } from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))
const evidence = fileURLToPath(new URL('../../runtime/purchase-review-tabs/', import.meta.url))
let server, browser, origin
before(async () => {
  await mkdir(evidence, { recursive: true })
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } }); await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
})
after(async () => { await browser?.close(); await server?.close() })
async function fixture(t, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN' }), page = await context.newPage(), errors = [], forbidden = []
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); assert.deepEqual(forbidden, []) })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/v1/**', route => {
    if (route.request().method() === 'GET' && route.request().url().endsWith('/pur/order-imports/capabilities')) return route.fulfill({ json: { code: 'OK', data: { recognitionEnabled: true } } })
    forbidden.push(route.request().url()); return route.abort()
  })
  await page.goto(origin + '/e2e/fixtures/purchase-import-review-tabs.html')
  const dialog = page.getByRole('dialog', { name: '核对商品与原图', exact: true })
  await expect(dialog).toBeVisible()
  return { page, dialog }
}
const tab = (dialog, name) => dialog.getByRole('tab', { name, exact: true })

test('真实标签页默认待办首页，配置待办跳到对应行并显示明确维护入口', async t => {
  const { page, dialog } = await fixture(t)
  await expect(tab(dialog, '待确认事项')).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByRole('tab')).toHaveCount(4)
  await expect(dialog).toContainText('待处理 2 行，共 5 项待办')
  await dialog.getByRole('button', { name: '处理第2行：商品尚未在本国启用', exact: true }).click()
  await expect(tab(dialog, '商品与单位')).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.locator('.review-picker')).toContainText('第2行')
  await expect(dialog.getByRole('link', { name: '在测试国家启用商品', exact: true })).toHaveAttribute('href', '/master/country-skus')
  await expect(dialog.getByRole('link', { name: '商品资料与单位换算', exact: true })).toBeVisible()
  await page.screenshot({ path: evidence + '/product.png', animations: 'disabled' })
})

test('延迟原图只在对应图片区显示加载图标，切页和其他输入仍可操作', async t => {
  const { page, dialog } = await fixture(t)
  await dialog.getByRole('button', { name: '处理第1行：原图归属待确认', exact: true }).first().click()
  await expect(tab(dialog, '原图核对')).toHaveAttribute('aria-selected', 'true')
  const frame = dialog.locator('.original-image-frame').first(), mask = frame.locator('.el-loading-mask')
  await expect(mask).toBeVisible(); await expect(frame).toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('.el-loading-mask:visible')).toHaveCount(1)
  const region = await frame.boundingBox(), loading = await mask.boundingBox()
  assert.ok(region.width <= 182 && region.height <= 182)
  assert.ok(Math.abs(region.x - loading.x) <= 2 && Math.abs(region.y - loading.y) <= 2)
  assert.ok(loading.width <= region.width && loading.height <= region.height)
  await page.screenshot({ path: evidence + '/image-loading.png', animations: 'disabled' })
  await tab(dialog, '辅助识别').click(); await dialog.getByRole('textbox', { name: '补充商品名称', exact: true }).fill('加载中仍可输入')
  await tab(dialog, '原图核对').click(); await expect(mask).toBeVisible()
  await page.evaluate(() => window.reviewFixture.releaseImage())
  await expect(frame.locator('.el-image__inner')).toBeVisible(); await expect(mask).toBeHidden()
})

test('原图失败明确原因且局部重试成功，确认后只消除该图片待办', async t => {
  const { page, dialog } = await fixture(t)
  await tab(dialog, '原图核对').click(); await page.evaluate(() => window.reviewFixture.releaseImage())
  await expect(dialog.getByText('隔离夹具：原图读取失败，请重试', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '重试加载原图', exact: true }).click()
  await expect(dialog.locator('.el-image__inner')).toHaveCount(2)
  await expect(dialog.getByText('隔离夹具：原图读取失败，请重试', { exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: '确认原图属于本行', exact: true }).first().click()
  await expect(dialog.getByText('原图归属已确认', { exact: true })).toBeVisible()
  await tab(dialog, '待确认事项').click(); await expect(dialog).toContainText('待处理 2 行，共 4 项待办')
})

test('真实切页保留补充文字和新品草稿，关闭再打开恢复默认首页', async t => {
  const { page, dialog } = await fixture(t)
  await tab(dialog, '辅助识别').click(); await dialog.getByRole('textbox', { name: '补充商品名称', exact: true }).fill('人工文字')
  await tab(dialog, '商品与单位').click(); await dialog.getByText('确认新品', { exact: true }).click()
  await expect(dialog.getByRole('radio', { name: '确认新品', exact: true })).toBeChecked()
  await dialog.locator('.new-review .el-form-item').filter({ has: page.locator('label').filter({ hasText: /^商品名称$/ }) }).locator('input').fill('人工新品草稿')
  await tab(dialog, '辅助识别').click(); await expect(dialog.getByRole('textbox', { name: '补充商品名称', exact: true })).toHaveValue('人工文字')
  await tab(dialog, '商品与单位').click(); await expect(dialog.locator('.new-review input').nth(1)).toHaveValue('人工新品草稿')
  await dialog.getByRole('button', { name: '返回明细', exact: true }).click(); await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: '打开核对', exact: true }).click(); await expect(tab(dialog, '待确认事项')).toHaveAttribute('aria-selected', 'true')
})

test('窄屏可进入原图页，固定图片加载范围不撑开页面', async t => {
  const { page, dialog } = await fixture(t, { width: 390, height: 844 })
  await dialog.getByRole('button', { name: '原图核对', exact: true }).click()
  await expect(dialog.locator('.original-image-frame .el-loading-mask').first()).toBeVisible()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await page.screenshot({ path: evidence + '/narrow.png', animations: 'disabled' })
})
