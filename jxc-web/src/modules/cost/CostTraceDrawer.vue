<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Close, Refresh } from '@element-plus/icons-vue'
import { http } from '@/api/http'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { getCountryId, getToken } from '@/utils/session'
import { financeSourcePath } from '@/utils/finance-source'
import MoneyText from '@/components/MoneyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import StatusTag from '@/components/StatusTag.vue'
import { SOURCE_TYPES, optionText } from '@/modules/shared/bizOptions'
import { formatDate } from '@/utils/format'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const router = useRouter(), country = useCountryStore(), user = useUserStore()
const visible = ref(false), loading = ref(false)
const selectedBatch = ref<number>()
const loadError = ref('')
const t = ref<Row>({})
const history = computed<Row[] | undefined>(() => Array.isArray(t.value.valuationHistory) ? t.value.valuationHistory : undefined)
const sources = [
  ...SOURCE_TYPES,
  { value: 'SALES_RETURN', label: '销售退货' },
  { value: 'FEE_ALLOCATION', label: '费用分摊' },
  { value: 'MANUAL', label: '手工调整' },
  { value: 'RETURN_COST', label: '退货成本调整' },
]
const sourceLabel = (value: unknown) => optionText(sources, value)
const identifier = (value: unknown) => value == null ? '-' : `#${value}`
let request = 0
const context = () => `${country.epoch}:${getCountryId()}:${getToken()}`

function close() {
  request++
  visible.value = false
  loading.value = false
  selectedBatch.value = undefined
  loadError.value = ''
  t.value = {}
}
async function open(batchId: number) {
  const current = ++request, scope = context()
  const isCurrent = () => current === request && scope === context() && visible.value
  selectedBatch.value = batchId
  visible.value = true
  loading.value = true
  loadError.value = ''
  t.value = {}
  try {
    const data = await http.get<Row>(`/cst/batches/${batchId}/cost-trace`, undefined, { silent: true })
    if (isCurrent()) t.value = data
  } catch (error) {
    if (isCurrent()) {
      loadError.value = feedbackMessage(error, '成本追溯读取失败，请重试')
    }
  } finally {
    if (isCurrent()) loading.value = false
  }
}
async function reload() {
  if (loading.value || selectedBatch.value == null) return
  await open(selectedBatch.value)
}
function go(reference: Row) {
  const path = financeSourcePath(reference)
  if (!path) return
  close()
  router.push(path)
}
watch(() => [country.epoch, user.token], close)
defineExpose({ open })
</script>

<template>
  <el-drawer v-model="visible" title="批次成本追溯" aria-label="批次成本追溯" :with-header="false" size="min(880px, 100vw)" append-to-body class="cost-trace-drawer" @close="close">
    <div class="trace-layout">
      <header class="trace-header">
        <div class="trace-heading">
          <h2>批次成本追溯</h2>
          <div class="trace-actions">
            <el-button link type="primary" :disabled="loading" aria-label="刷新批次成本" @click="reload"><el-icon><Refresh /></el-icon>刷新</el-button>
            <el-button text class="trace-close" aria-label="关闭批次成本追溯" @click="close"><el-icon><Close /></el-icon></el-button>
          </div>
        </div>
        <div class="trace-context">
          <span>批次 <strong class="mono">{{ identifier(selectedBatch) }}</strong></span>
          <StatusTag v-if="t.cost?.status" :status="t.cost.status" />
          <span v-if="t.asOf" class="trace-as-of">截至 {{ formatDate(t.asOf) }}</span>
        </div>
      </header>

      <main class="trace-content" :aria-busy="loading">
        <div v-if="loading" v-loading="loading" class="trace-loading" role="status">正在读取批次成本…</div>
        <div v-else-if="loadError" class="trace-error" role="alert">
          <div  class="request-state" role="status"><p class="muted">尚未加载成功</p></div>
          <el-button type="primary" plain aria-label="重新加载批次成本" @click="reload">重新加载</el-button>
        </div>
        <template v-else-if="t.batchId != null">
          <el-alert v-if="!t.cost" type="info" :closable="false" show-icon title="成本字段未返回，可能受字段权限限制。" />
          <template v-else>
            <el-alert v-if="t.costMissing" class="trace-warning" type="warning" :closable="false" show-icon title="成本尚未完整，未知金额与单位成本保持待补。" />

            <dl class="trace-summary" aria-label="批次成本摘要">
              <div class="trace-summary-primary">
                <dt>截至日单位成本</dt>
                <dd class="mono">{{ t.unitCost ?? '待补' }} <span class="trace-currency">{{ t.cost.baseCurrency || '币种未返回' }}</span></dd>
              </div>
              <div><dt>基础数量</dt><dd class="mono">{{ t.cost.qty ?? '待补' }}</dd></div>
              <div>
                <dt>本位币采购额</dt>
                <dd>
                  <MoneyText v-if="t.cost.baseCurrency && t.cost.basePurchaseAmount != null" :value="t.cost.basePurchaseAmount" :currency="t.cost.baseCurrency" />
                  <span v-else class="mono">{{ t.cost.basePurchaseAmount ?? '待补' }}<span v-if="t.cost.basePurchaseAmount != null" class="trace-missing"> · 币种未返回</span></span>
                </dd>
              </div>
            </dl>

            <section class="trace-section" aria-label="批次与来源">
              <h3>批次与来源</h3>
              <dl class="trace-fields">
                <div><dt>成本来源</dt><dd>{{ sourceLabel(t.cost.sourceType) }}<span class="trace-secondary">来源行 {{ identifier(t.cost.sourceLineId) }}</span></dd></div>
                <div><dt>成本记录</dt><dd><el-link v-if="t.cost.id != null" type="primary" @click="go({ sourceType: 'CST_INBOUND_COST', sourceId: t.cost.id, bookId: t.cost.bookId })">{{ identifier(t.cost.id) }}</el-link><span v-else>-</span></dd></div>
                <div><dt>采购单</dt><dd><el-link v-if="t.cost.poId != null" type="primary" @click="go({ sourceType: 'PURCHASE_ORDER', sourceId: t.cost.poId, bookId: t.cost.bookId })">{{ identifier(t.cost.poId) }}</el-link><span v-else>未关联采购单</span></dd></div>
                <div><dt>账套</dt><dd class="mono">{{ identifier(t.cost.bookId) }}</dd></div>
                <div><dt>仓库</dt><dd>{{ t.cost.warehouseId == null ? '未记录' : '仓库 ' + identifier(t.cost.warehouseId) }}</dd></div>
                <div><dt>商品</dt><dd>{{ t.cost.productId == null ? '未记录' : '商品 ' + identifier(t.cost.productId) }}</dd></div>
                <div><dt>原入库日期</dt><dd>{{ formatDate(t.cost.bizDate) }}</dd></div>
              </dl>
              <details class="trace-raw"><summary>查看来源标识</summary><p>来源类型 <code>{{ t.cost.sourceType ?? '未返回' }}</code></p></details>
            </section>

            <section class="trace-section" aria-label="采购与汇率">
              <h3>采购与汇率</h3>
              <dl class="trace-fields">
                <div>
                  <dt>原采购单位价</dt>
                  <dd><MoneyText v-if="t.cost.srcCurrency && t.cost.srcUnitPrice != null" :value="t.cost.srcUnitPrice" :currency="t.cost.srcCurrency" /><span v-else class="mono">{{ t.cost.srcUnitPrice ?? '待补' }}<span v-if="t.cost.srcUnitPrice != null" class="trace-missing"> · 币种未返回</span></span> / {{ t.cost.srcUnit ?? '单位未返回' }}</dd>
                </div>
                <div>
                  <dt>原币金额</dt>
                  <dd><MoneyText v-if="t.cost.srcCurrency && t.cost.srcAmount != null" :value="t.cost.srcAmount" :currency="t.cost.srcCurrency" /><span v-else class="mono">{{ t.cost.srcAmount ?? '待补' }}<span v-if="t.cost.srcAmount != null" class="trace-missing"> · 币种未返回</span></span></dd>
                </div>
                <div><dt>换算系数</dt><dd class="mono">{{ t.cost.srcFactor ?? '待补' }}</dd></div>
                <div><dt>采购汇率</dt><dd class="mono">{{ t.cost.rate ?? '待补' }}<span class="trace-secondary">{{ t.cost.srcCurrency || '原币币种未返回' }} → {{ t.cost.baseCurrency || '本位币币种未返回' }}</span></dd></div>
                <div><dt>汇率日期</dt><dd>{{ formatDate(t.cost.rateDate) }}</dd></div>
                <div><dt>汇率版本</dt><dd class="mono">{{ t.cost.rateVersion ?? '未记录' }}</dd></div>
              </dl>
            </section>

            <section class="trace-section" aria-label="确认信息">
              <h3>确认信息</h3>
              <dl class="trace-fields">
                <div><dt>确认人</dt><dd>{{ t.cost.confirmedBy == null ? '未记录' : identifier(t.cost.confirmedBy) }}</dd></div>
                <div><dt>确认时间</dt><dd><DateTimeText :value="t.cost.confirmedAt" /></dd></div>
              </dl>
            </section>

            <section class="trace-section" aria-label="截至日估值变动">
              <div class="trace-section-heading"><h3>截至日估值变动</h3><span v-if="history != null" class="trace-count">{{ history.length }} 条记录</span></div>
              <p class="trace-note">按业务日期查看已保存的估值变动；来源行编号不作为收货单编号。</p>
              <el-alert v-if="history == null" type="info" :closable="false" show-icon title="估值变动明细未返回，暂无法核对变动记录。" />
              <div v-else class="trace-table-scroll" tabindex="0" role="region" aria-label="估值变动明细，可横向滚动">
                <el-table :data="history" stripe size="small" class="trace-history">
                  <el-table-column label="业务日期" width="110"><template #default="{ row }">{{ formatDate(row.bizDate) }}</template></el-table-column>
                  <el-table-column label="调整来源" min-width="180">
                    <template #default="{ row }">
                      <el-link v-if="row.adjustmentId != null" type="primary" @click="go({ sourceType: 'CST_ADJUSTMENT', sourceId: row.adjustmentId, bookId: row.bookId })">{{ identifier(row.adjustmentId) }}</el-link><span v-else>-</span>
                      <span class="trace-secondary">{{ sourceLabel(row.sourceType) }} · {{ identifier(row.sourceId) }}</span>
                      <details v-if="sourceLabel(row.sourceType) !== row.sourceType" class="trace-raw"><summary>来源标识</summary><code>{{ row.sourceType ?? '未返回' }}</code></details>
                    </template>
                  </el-table-column>
                  <el-table-column label="数量基础" width="100" align="right"><template #default="{ row }"><span class="mono">{{ row.qtyBasis ?? '待补' }}</span></template></el-table-column>
                  <el-table-column v-for="column in [{ key: 'amount', label: '变动额' }, { key: 'inventoryAmount', label: '库存部分' }, { key: 'soldAmount', label: '已售部分' }]" :key="column.key" :label="column.label" min-width="125" align="right">
                    <template #default="{ row }"><MoneyText v-if="t.cost.baseCurrency && row[column.key] != null" :value="row[column.key]" :currency="t.cost.baseCurrency" /><span v-else class="mono">{{ row[column.key] ?? '待补' }}<span v-if="row[column.key] != null" class="trace-missing"> · 币种未返回</span></span></template>
                  </el-table-column>
                  <el-table-column label="单位成本变动" min-width="170" align="right"><template #default="{ row }"><span class="mono">{{ row.unitDelta ?? '待补' }}</span></template></el-table-column>
                  <template #empty><el-empty :image-size="48" description="截至该日暂无估值变动" /></template>
                </el-table>
              </div>
            </section>
          </template>
        </template>
        <el-empty v-else :image-size="64" description="没有找到批次成本" />
      </main>
    </div>
  </el-drawer>
</template>

<style scoped>
:global(.cost-trace-drawer .el-drawer__body) { display: flex; padding: 0; min-height: 0; overflow: hidden; }
.trace-layout { display: flex; flex-direction: column; width: 100%; min-width: 0; min-height: 0; color: var(--el-text-color-primary); font-size: 14px; line-height: 1.6; }
.trace-header { flex-shrink: 0; padding: 20px 24px 16px; border-bottom: 1px solid var(--el-border-color-lighter); }
.trace-heading, .trace-actions, .trace-context, .trace-section-heading { display: flex; align-items: center; gap: 12px; }
.trace-heading, .trace-section-heading { justify-content: space-between; }
.trace-heading h2 { margin: 0; font-size: 18px; font-weight: 600; }
.trace-actions { flex-shrink: 0; gap: 8px; }
.trace-actions .el-button { margin-left: 0; }
.trace-actions .el-icon { margin-right: 4px; }
.trace-actions .trace-close { padding: 6px; }
.trace-close .el-icon { margin: 0; font-size: 18px; }
.trace-context { margin-top: 12px; flex-wrap: wrap; font-size: 13px; }
.trace-as-of { margin-left: auto; color: var(--el-text-color-regular); }
.trace-content { flex: 1; min-height: 0; padding: 20px 24px 24px; overflow: auto; }
.trace-loading { position: relative; display: flex; align-items: flex-end; justify-content: center; min-height: 160px; padding-bottom: 24px; color: var(--el-text-color-secondary); font-size: 13px; }
.trace-error .el-button { margin-top: 12px; }
.trace-error p { margin: 4px 0 0; overflow-wrap: anywhere; }
.trace-warning { margin-bottom: 16px; }
.trace-summary { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, .7fr) minmax(0, 1fr); gap: 16px; margin: 0; padding: 16px; border-radius: 6px; background: var(--el-fill-color-light); }
.trace-summary > div, .trace-fields > div { min-width: 0; }
.trace-summary dt, .trace-fields dt { margin-bottom: 4px; color: var(--el-text-color-regular); font-size: 13px; }
.trace-summary dd, .trace-fields dd { margin: 0; overflow-wrap: anywhere; }
.trace-summary dd { font-size: 16px; font-weight: 600; }
.trace-summary-primary dd { font-size: 22px; }
.trace-currency { font-size: 13px; font-weight: 400; }
.trace-section { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--el-border-color-lighter); }
.trace-section h3 { margin: 0 0 16px; font-size: 14px; font-weight: 600; }
.trace-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 24px; margin: 0; }
.trace-secondary { display: block; margin-top: 2px; color: var(--el-text-color-regular); font-size: 12px; overflow-wrap: anywhere; }
.trace-raw { margin-top: 12px; font-size: 12px; color: var(--el-text-color-regular); }
.trace-raw summary { width: fit-content; cursor: pointer; }
.trace-raw p { margin: 8px 0 0; }
.trace-raw code { white-space: normal; overflow-wrap: anywhere; }
.trace-count, .trace-note, .trace-missing { color: var(--el-text-color-secondary); font-size: 12px; font-weight: 400; }
.trace-section-heading { margin-bottom: 8px; }
.trace-section-heading h3 { margin-bottom: 0; }
.trace-note { margin: 0 0 12px; }
.trace-table-scroll { max-width: 100%; overflow-x: auto; }
.trace-history { min-width: 960px; }
.trace-history .trace-raw { margin-top: 4px; }
.trace-history :deep(.el-empty) { padding: 24px 0; }
.trace-actions :deep(.el-button:focus-visible), .trace-raw summary:focus-visible, .trace-table-scroll:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
@media (max-width: 768px) {
  .trace-header { padding: 16px; }
  .trace-content { padding: 16px; }
  .trace-fields, .trace-summary { grid-template-columns: minmax(0, 1fr); }
  .trace-summary { gap: 12px; }
  .trace-summary > div + div { padding-top: 12px; border-top: 1px solid var(--el-border-color-lighter); }
  .trace-as-of { width: 100%; margin-left: 0; }
}
@media (max-width: 380px) {
  .trace-header, .trace-content { padding: 12px; }
  .trace-heading, .trace-actions { gap: 8px; }
}
@media (pointer: coarse) { .trace-actions .trace-close { min-width: 44px; min-height: 44px; } }
</style>
