import test from 'node:test'
import assert from 'node:assert/strict'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

function detailPage(get = async () => ({})) {
  const route = reactive({ params: { id: 483 } })
  const page = loadVueScript(new URL('../src/modules/logistics/ShipmentDetail.vue', import.meta.url), {
    computed, nextTick, reactive, ref, watch, onMounted() {},
    useRoute: () => route, useRouter: () => ({ push() {} }),
    useCountryStore: () => ({ timezone: 'America/Mexico_City' }),
    useUserStore: () => ({ hasPerm: () => true }),
    countryDateTimeInput: value => value, nowMs: () => 1, createCommandIntent: () => ({}),
    http: { get },
  }, ['sh', 'related', 'load', 'loading', 'loadError', 'lineQuery', 'linePage', 'linePageSize', 'filteredLines', 'pagedLines', 'summary', 'tab', 'expandedNodeIds', 'allNodesExpanded', 'toggleAllNodes', 'setNodeExpanded'])
  return { ...page, route }
}

const rows = Array.from({ length: 23 }, (_, index) => ({
  id: index + 1, productCode: `P${index + 1}`, productName: index === 22 ? '透明手机壳' : '充电器',
  poNo: index === 22 ? 'PO-LATE' : 'PO-1', sourceNo: index === 22 ? 'EXP-FINAL' : 'EXP-1',
  boxes: index === 22 ? null : 1, baseQty: 10, shippedQty: 10, pendingDeliveryQty: 10,
}))

test('商品筛选覆盖完整明细及编码、名称、采购单和出口单，翻页不遗漏末页商品', async () => {
  const page = detailPage()
  page.sh.value = { lines: rows }
  assert.equal(page.pagedLines.value.length, 10)
  page.linePage.value = 3
  assert.deepEqual(page.pagedLines.value.map(row => row.id), [21, 22, 23])
  for (const query of [' p23 ', '手机壳', 'po-late', 'exp-final']) {
    page.lineQuery.value = query
    await nextTick()
    assert.equal(page.linePage.value, 1)
    assert.deepEqual(page.filteredLines.value.map(row => row.id), [23])
  }
  page.lineQuery.value = '不存在'
  await nextTick()
  assert.equal(page.filteredLines.value.length, 0)
  assert.equal(page.pagedLines.value.length, 0)
})

test('合计覆盖筛选后的全部页，未知箱数不被计为零，换页大小与刷新后校正页码', async () => {
  const page = detailPage()
  page.sh.value = { lines: rows }
  const columns = [{ property: '' }, { property: 'boxes' }, { property: 'baseQty' }]
  assert.deepEqual(page.summary({ columns }), ['合计', '未维护', '230'])
  page.linePage.value = 3
  page.linePageSize.value = 20
  await nextTick()
  assert.equal(page.linePage.value, 1)
  page.lineQuery.value = 'P23'
  await nextTick()
  assert.deepEqual(page.summary({ columns }), ['合计', '未维护', '10'])
  page.lineQuery.value = ''
  await nextTick()
  page.linePage.value = 2
  page.sh.value = { lines: rows.slice(0, 2) }
  await nextTick()
  assert.equal(page.linePage.value, 1)
  assert.deepEqual(page.summary({ columns }), ['合计', '2', '20'])
})

test('节点保留逐项展开并可统一展开和收起，包括已更正事件', () => {
  const page = detailPage()
  page.sh.value = { nodes: [{ id: 1, corrected: true }, { id: 2 }] }
  page.setNodeExpanded(1, { target: { open: true } })
  assert.deepEqual(page.expandedNodeIds.value, [1])
  assert.equal(page.allNodesExpanded.value, false)
  page.toggleAllNodes()
  assert.equal(page.allNodesExpanded.value, true)
  page.setNodeExpanded(2, { target: { open: false } })
  assert.equal(page.allNodesExpanded.value, false)
  page.toggleAllNodes()
  page.toggleAllNodes()
  assert.deepEqual(page.expandedNodeIds.value, [])
})

test('切换批次重置筛选、页码、记录标签及展开节点，并读取新批次', async () => {
  const calls = []
  const page = detailPage(async path => { calls.push(path); return path.endsWith('/related') ? {} : { id: 484, lines: [] } })
  page.sh.value = { lines: rows }
  page.lineQuery.value = 'P'
  await nextTick()
  page.linePage.value = 2
  page.tab.value = 'fees'
  page.expandedNodeIds.value = [17]
  page.route.params.id = 484
  await nextTick()
  await Promise.resolve()
  assert.equal(page.lineQuery.value, '')
  assert.equal(page.linePage.value, 1)
  assert.equal(page.tab.value, 'deliveries')
  assert.deepEqual(page.expandedNodeIds.value, [])
  assert.deepEqual(calls, ['/lgs/shipments/484', '/lgs/shipments/484/related'])
})

test('读取失败保留原因并可重试，失败不等同于无记录', async () => {
  let fail = true
  const page = detailPage(async path => {
    if (fail) throw new Error('无权访问此运输批次')
    return path.endsWith('/related') ? { fees: [] } : { id: 483, lines: [] }
  })
  await page.load()
  assert.equal(page.loadError.value, '无权访问此运输批次')
  assert.equal(page.loading.value, false)
  fail = false
  await page.load()
  assert.equal(page.loadError.value, '')
  assert.equal(page.sh.value.id, 483)
  assert.deepEqual(page.related.value.fees, [])
})

for (const outcome of ['成功', '失败']) test(`迟到的旧批次${outcome}不能覆盖新批次或结束其加载状态`, async () => {
  const pending = []
  const page = detailPage(path => new Promise((resolve, reject) => pending.push({ path, resolve, reject })))
  const old = page.load()
  page.route.params.id = 484
  await nextTick()
  if (outcome === '成功') pending[0].resolve({ id: 483, lines: rows })
  else pending[0].reject(new Error('旧批次失败'))
  pending[1].resolve({})
  await old
  assert.equal(page.loading.value, true)
  assert.equal(page.loadError.value, '')
  pending[2].resolve({ id: 484, lines: [] })
  pending[3].resolve({ fees: [] })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(page.sh.value.id, 484)
  assert.equal(page.loading.value, false)
})
