import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const shipmentDetailSource = readFileSync(new URL('../src/modules/logistics/ShipmentDetail.vue', import.meta.url), 'utf8')
const shipmentDetailSetup = shipmentDetailSource.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]

function detailPage(get = async () => ({})) {
  const route = reactive({ params: { id: 483 } })
  const exports = ['sh', 'related', 'load', 'loading', 'loadError', 'lineQuery', 'linePage', 'linePageSize', 'filteredLines', 'pagedLines', 'summary', 'tab', 'expandedNodeIds', 'allNodesExpanded', 'toggleAllNodes', 'setNodeExpanded']
  for (const name of ['nodeQuantityInfo', 'nodeQuantityValues', 'auditVisible', 'auditContext', 'openAudit']) {
    if (new RegExp(`\\b(?:function|const|let|var)\\s+${name}\\b`).test(shipmentDetailSetup)) exports.push(name)
  }
  const page = loadVueScript(new URL('../src/modules/logistics/ShipmentDetail.vue', import.meta.url), {
    computed, nextTick, reactive, ref, watch, onMounted() {},
    useRoute: () => route, useRouter: () => ({ push() {} }),
    useCountryStore: () => ({ timezone: 'America/Mexico_City' }),
    useUserStore: () => ({ hasPerm: () => true }),
    countryDateTimeInput: value => value, nowMs: () => 1, createCommandIntent: () => ({}),
    http: { get },
  }, exports)
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

test('派送节点只展示唯一关联派送单的商品数量', () => {
  const page = detailPage()
  assert.equal(typeof page.nodeQuantityInfo, 'function')
  assert.equal(typeof page.nodeQuantityValues, 'function')
  const node = { id: 1, nodeType: 'DISPATCHED', actualAt: '2026-10-22T10:00:00.000Z' }
  const delivery = { id: 2, docNo: 'DEL-2', status: 'DISPATCHED', dispatchedAt: node.actualAt, lines: [{ id: 3, productCode: 'P-1', dispatchQty: 8 }] }
  page.sh.value = { nodes: [node] }
  page.related.value = { deliveries: [delivery] }

  assert.deepEqual(page.nodeQuantityInfo(node), { state: 'linked', label: '派送单', records: [delivery] })
  assert.deepEqual(page.nodeQuantityValues('DISPATCHED', delivery.lines[0]), [{ label: '派送', value: 8 }])
})

test('派送单实收后仍保留其派送节点数量', () => {
  const page = detailPage()
  const node = { id: 1, nodeType: 'DISPATCHED', actualAt: '2026-10-22T10:00:00.000Z' }
  const delivery = { id: 2, docNo: 'DEL-2', status: 'RECEIVED', dispatchedAt: node.actualAt, lines: [{ id: 3, dispatchQty: 8 }] }
  page.sh.value = { nodes: [node] }
  page.related.value = { deliveries: [delivery] }

  assert.deepEqual(page.nodeQuantityInfo(node), { state: 'linked', label: '派送单', records: [delivery] })
  assert.deepEqual(page.nodeQuantityValues('DISPATCHED', delivery.lines[0]), [{ label: '派送', value: 8 }])
})

test('暂缓、换柜和实收节点分别读取对应单据的实际明细字段', () => {
  const page = detailPage()
  assert.equal(typeof page.nodeQuantityInfo, 'function')
  assert.equal(typeof page.nodeQuantityValues, 'function')
  const at = '2026-10-22T10:00:00.000Z'
  const nodes = [
    { id: 1, nodeType: 'HOLD', actualAt: at },
    { id: 2, nodeType: 'TRANSSHIPPED', actualAt: at },
    { id: 3, nodeType: 'RECEIVED', actualAt: at },
  ]
  const sources = [
    { node: nodes[0], record: { id: 4, status: 'ACTIVE', createdAt: at, lines: [{ holdQty: 4 }] }, key: 'holds', fields: [{ label: '暂缓', value: 4 }] },
    { node: nodes[1], record: { id: 5, status: 'CONFIRMED', transshipAt: at, lines: [{ movedQty: 3, diffQty: 1 }] }, key: 'transships', fields: [{ label: '转移', value: 3 }, { label: '差异', value: 1 }] },
    { node: nodes[2], record: { id: 6, status: 'CONFIRMED', confirmedAt: at, lines: [{ dispatchQty: 6, goodQty: 4, damagedQty: 1, pendingInspectQty: 1, shortQty: 0 }] }, key: 'receipts', fields: [
      { label: '派送', value: 6 }, { label: '合格', value: 4 }, { label: '破损', value: 1 }, { label: '待检', value: 1 }, { label: '短缺', value: 0 },
    ] },
  ]
  page.sh.value = { nodes }
  page.related.value = Object.fromEntries(sources.map(source => [source.key, [source.record]]))

  for (const source of sources) {
    assert.deepEqual(page.nodeQuantityInfo(source.node).records, [source.record])
    assert.deepEqual(page.nodeQuantityValues(source.node.nodeType, source.record.lines[0]), source.fields)
  }
})

test('纯里程碑不从当前数量分桶推算历史数量', () => {
  const page = detailPage()
  assert.equal(typeof page.nodeQuantityInfo, 'function')
  const node = { id: 1, nodeType: 'CUSTOMS_RELEASED', actualAt: '2026-10-22T10:00:00.000Z' }
  page.sh.value = { nodes: [node], lines: [{ baseQty: 12, intlQty: 4, pendingDeliveryQty: 8 }] }
  page.related.value = { deliveries: [{ id: 2, status: 'DISPATCHED', totalQty: 8 }] }

  assert.deepEqual(page.nodeQuantityInfo(node), { state: 'unrecorded', label: '节点本身未记录数量', records: [] })
})

test('存在多个无法区分的派送单时不把任意数量挂到节点上', () => {
  const page = detailPage()
  assert.equal(typeof page.nodeQuantityInfo, 'function')
  const node = { id: 1, nodeType: 'DISPATCHED', actualAt: '2026-10-22T10:00:00.000Z' }
  page.sh.value = { nodes: [node] }
  page.related.value = { deliveries: [
    { id: 2, docNo: 'DEL-2', status: 'DISPATCHED', dispatchedAt: '2026-10-22T09:00:00.000Z', lines: [{ dispatchQty: 8 }] },
    { id: 3, docNo: 'DEL-3', status: 'DISPATCHED', dispatchedAt: '2026-10-22T11:00:00.000Z', lines: [{ dispatchQty: 5 }] },
  ] }

  assert.deepEqual(page.nodeQuantityInfo(node), { state: 'ambiguous', label: '未能唯一关联数量明细', records: [] })
})

test('数量分桶和关联记录默认展开且可由原生 details 收起', () => {
  assert.ok(/<details\s+open\s+class="shipment-section shipment-quantities"/.test(shipmentDetailSource), '数量分桶应使用默认展开的 details')
  assert.ok(/<details\s+open\s+class="shipment-section shipment-records"/.test(shipmentDetailSource), '关联记录应使用默认展开的 details')
  assert.ok(/<summary class="shipment-section-heading shipment-collapse-summary">/.test(shipmentDetailSource), '区域标题应提供原生折叠入口')
})

test('节点关联数量复用统一数量格式组件', () => {
  assert.match(shipmentDetailSource, /import QtyText from '@\/components\/QtyText\.vue'/)
  assert.match(shipmentDetailSource, /<QtyText :value="quantity\.value"\s*\/>/)
})

test('运输批次操作日志打开既有 AuditDrawer 并带上单号与状态上下文', () => {
  const page = detailPage()
  assert.equal(typeof page.openAudit, 'function')
  assert.ok(page.auditContext)
  page.sh.value = { docNo: 'SHIP-483', status: 'RELEASED' }
  assert.equal(page.auditContext.value.identifier, 'SHIP-483')
  assert.equal(page.auditContext.value.status, 'RELEASED')
  page.openAudit()
  assert.equal(page.auditVisible.value, true)
  assert.ok(/<AuditDrawer v-if="auditVisible"/.test(shipmentDetailSource), '用户打开日志前不应提前加载审计记录')
  assert.ok(/<AuditDrawer\b/.test(shipmentDetailSource), '操作日志应复用统一抽屉')
  assert.ok(!/<AuditTimeline resource-type="shipment"/.test(shipmentDetailSource), '运输批次详情不应保留旧的内嵌日志样式')
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
  page.openAudit()
  page.route.params.id = 484
  await nextTick()
  await Promise.resolve()
  assert.equal(page.lineQuery.value, '')
  assert.equal(page.linePage.value, 1)
  assert.equal(page.tab.value, 'deliveries')
  assert.equal(page.auditVisible.value, false)
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
