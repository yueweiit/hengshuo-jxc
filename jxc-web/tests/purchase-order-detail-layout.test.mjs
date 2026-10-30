import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const moduleUrl = new URL('../src/modules/purchase/purchaseOrderDetailLayout.ts', import.meta.url)
const layout = existsSync(moduleUrl) ? loadTsModule(moduleUrl) : {}

function required(name) {
  assert.equal(typeof layout[name], 'function', `purchase detail layout must export ${name}`)
  return layout[name]
}

test('drag position keeps the product pane within its minimum and maximum ratios', () => {
  const ratioAtPosition = required('ratioAtPosition')
  assert.equal(ratioAtPosition(100, 100, 410, 10), 35)
  assert.equal(ratioAtPosition(500, 100, 410, 10), 72)
  assert.equal(ratioAtPosition(100 + 5 + 400 * 0.58, 100, 410, 10), 58)
})

test('drag ratio excludes the workspace vertical padding', () => {
  const workspaceContentBounds = required('workspaceContentBounds')
  const ratioAtPosition = required('ratioAtPosition')
  const content = workspaceContentBounds(100, 0, 410, 12, 12)
  const targetY = content.top + 5 + (content.height - 10) * 0.65

  assert.equal(ratioAtPosition(targetY, content.top, content.height, 10), 65)
})

test('keyboard adjustment changes the product pane by three points and reaches both limits', () => {
  const stepProductRatio = required('stepProductRatio')
  assert.equal(stepProductRatio(58, 'ArrowUp'), 61)
  assert.equal(stepProductRatio(58, 'ArrowDown'), 55)
  assert.equal(stepProductRatio(58, 'Home'), 35)
  assert.equal(stepProductRatio(58, 'End'), 72)
  assert.equal(stepProductRatio(58, 'Enter'), null)
})

test('focus can switch panes and clicking the focused pane restores the shared view', () => {
  const toggleFocusedPane = required('toggleFocusedPane')
  assert.equal(toggleFocusedPane(null, 'products'), 'products')
  assert.equal(toggleFocusedPane('products', 'records'), 'records')
  assert.equal(toggleFocusedPane('records', 'records'), null)
})

test('narrow or short viewports use natural document flow', () => {
  const shouldUseNaturalFlow = required('shouldUseNaturalFlow')
  assert.equal(shouldUseNaturalFlow(900, 900), true)
  assert.equal(shouldUseNaturalFlow(1280, 700), true)
  assert.equal(shouldUseNaturalFlow(1280, 800), false)
})
