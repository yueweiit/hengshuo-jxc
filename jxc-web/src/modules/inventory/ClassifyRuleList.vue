<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http } from '@/api/http'
import { allRecords } from '@/api/pagination'
import StatusTag from '@/components/StatusTag.vue'
import { useUserStore } from '@/stores/user'
import { formatDate } from '@/utils/format'

const user = useUserStore()
const rows = ref<Record<string, any>[]>([])
const open = ref(false)
const saving = ref(false)
const form = reactive<Record<string, any>>({ id: null, name: '', dimType: 'WAREHOUSE', periodType: 'ROLLING_DAYS', periodDays: 90, orderMetric: 'QTY', stockMetric: 'AVAILABLE', effectiveFrom: undefined, conditions: [] })
const dimensions = [
  { label: '仓库', value: 'WAREHOUSE' }, { label: '门店', value: 'STORE' }, { label: '国家', value: 'COUNTRY' },
]
const periods = [
  { label: '滚动天数', value: 'ROLLING_DAYS' }, { label: '本地自然月', value: 'CALENDAR_MONTH' }, { label: '本地自然周', value: 'CALENDAR_WEEK' },
]
const orderMetrics = [{ label: '有效件数', value: 'QTY' }, { label: '订单张数', value: 'ORDER_COUNT' }]
const stockMetrics = [{ label: '可售', value: 'AVAILABLE' }, { label: '实物', value: 'ON_HAND' }]
const labels = [
  { label: '畅销候选', value: 'HOT_CANDIDATE' }, { label: '滞销候选', value: 'SLOW_CANDIDATE' },
  { label: '观察', value: 'WATCH' }, { label: '普通', value: 'NORMAL' },
]
const operators = [
  { label: '小于', value: 'LT' }, { label: '小于等于', value: 'LTE' },
  { label: '大于', value: 'GT' }, { label: '大于等于', value: 'GTE' },
  { label: '区间', value: 'BETWEEN' }, { label: '不限', value: 'ANY' },
]
const conditionMetrics = [{ key: 'stock', label: '库存条件' }, { key: 'order', label: '订单条件' }]

async function load() {
  rows.value = await allRecords<Record<string, any>>('/inv/classify-rules')
}

function edit(row: Record<string, any>) {
  Object.assign(form, { id: null, versionNo: undefined, name: '', dimType: 'WAREHOUSE', periodType: 'ROLLING_DAYS', periodDays: 90, orderMetric: 'QTY', stockMetric: 'AVAILABLE', effectiveFrom: undefined, conditions: [] }, JSON.parse(JSON.stringify(row)))
  open.value = true
}

function addCond() {
  form.conditions.push({ label: 'NORMAL', priority: 1, stockOp: 'GTE', stockValue: 0, stockValue2: 0, orderOp: 'GTE', orderValue: 0, orderValue2: 0 })
}

async function save() {
  if (saving.value) return
  saving.value = true
  try {
    if (form.id) await http.put('/inv/classify-rules/' + form.id, form)
    else await http.post('/inv/classify-rules', form)
    ElMessage.success('已保存并生成新版本')
    open.value = false
    await load()
  } finally {
    saving.value = false
  }
}

async function recalc(row: Record<string, any>) {
  const res = await http.post<{ count: number }>('/inv/classify-rules/' + row.id + '/recalculate', {})
  ElMessage.success(`已按版本 ${row.versionNo} 重算 ${res.count} 条`)
}

onMounted(load)
</script>

<template>
  <div class="page">
    <section class="page-card">
      <div class="page-title">
        <h2>畅销滞销规则</h2>
        <el-button v-if="user.hasPerm('inv:classify:config')" type="primary" @click="edit({ name: '联合分类', dimType: 'WAREHOUSE', periodType: 'ROLLING_DAYS', periodDays: 90, orderMetric: 'QTY', stockMetric: 'AVAILABLE', conditions: [] })">新增</el-button>
      </div>
      <p class="muted rule-description">修改规则只影响当前国家，并生成新版本；生效后按所选周期参与分类。</p>
      <el-table :data="rows" size="small" border stripe>
        <el-table-column prop="name" label="名称" min-width="160" show-overflow-tooltip />
        <el-table-column label="维度" width="90"><template #default="{ row }">{{ dimensions.find(item => item.value === row.dimType)?.label ?? row.dimType }}</template></el-table-column>
        <el-table-column label="统计周期" min-width="140"><template #default="{ row }">{{ row.periodType === 'ROLLING_DAYS' ? `滚动 ${row.periodDays} 天` : periods.find(item => item.value === row.periodType)?.label ?? row.periodType }}</template></el-table-column>
        <el-table-column label="订单指标" width="100"><template #default="{ row }">{{ orderMetrics.find(item => item.value === row.orderMetric)?.label ?? row.orderMetric }}</template></el-table-column>
        <el-table-column label="库存指标" width="90"><template #default="{ row }">{{ stockMetrics.find(item => item.value === row.stockMetric)?.label ?? row.stockMetric }}</template></el-table-column>
        <el-table-column prop="versionNo" label="版本" width="70" />
        <el-table-column label="生效日期" width="120"><template #default="{ row }">{{ formatDate(row.effectiveFrom) }}</template></el-table-column>
        <el-table-column label="状态" width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button v-if="user.hasPerm('inv:classify:config') && row.status === 'ACTIVE'" link type="primary" @click="edit(row)">编辑</el-button>
            <el-button v-if="user.hasPerm('inv:classify:config') && row.status === 'ACTIVE'" link @click="recalc(row)">重算</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
    <el-dialog v-model="open" title="分类条件" width="min(1040px, 96vw)" top="5vh" class="classify-rule-dialog" :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving">
      <div class="classify-rule-body">
        <el-form :model="form" label-position="top" :disabled="saving">
          <div class="settings-grid">
            <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
            <el-form-item label="生效日期"><el-date-picker v-model="form.effectiveFrom" type="date" value-format="YYYY-MM-DD" clearable placeholder="未选时使用当前国家日期" /></el-form-item>
            <p class="muted effective-tip">生效日前不参与计算；未选时使用当前国家业务日期。保存新版本会将原版本退役。</p>
            <el-form-item label="维度">
              <el-select v-model="form.dimType"><el-option v-for="item in dimensions" :key="item.value" :label="item.label" :value="item.value" /></el-select>
            </el-form-item>
            <el-form-item label="周期">
              <el-select v-model="form.periodType"><el-option v-for="item in periods" :key="item.value" :label="item.label" :value="item.value" /></el-select>
            </el-form-item>
            <el-form-item v-if="form.periodType === 'ROLLING_DAYS'" label="滚动天数"><el-input-number v-model="form.periodDays" :min="1" controls-position="right" /></el-form-item>
            <el-form-item label="订单指标"><el-select v-model="form.orderMetric"><el-option v-for="item in orderMetrics" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
            <el-form-item label="库存指标"><el-select v-model="form.stockMetric"><el-option v-for="item in stockMetrics" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
          </div>
          <div class="conditions-heading">
            <h3>分类条件</h3>
            <el-button :disabled="saving" @click="addCond">加一条条件</el-button>
          </div>
          <p class="muted condition-tip">每条条件同时匹配库存和订单指标。同一优先级下，区间重叠且标签不同时不能保存。</p>
          <el-empty v-if="!form.conditions.length" description="尚未配置条件，点击“加一条条件”开始配置" :image-size="64" />
          <div v-for="(condition, index) in form.conditions" :key="index" class="classify-condition" role="group" :aria-label="`条件 ${Number(index) + 1}`">
            <div class="condition-identity">
              <el-form-item label="标签"><el-select v-model="condition.label"><el-option v-for="item in labels" :key="item.value" :label="item.label" :value="item.value" /></el-select></el-form-item>
              <el-form-item label="优先级"><el-input-number v-model="condition.priority" :min="1" controls-position="right" /></el-form-item>
            </div>
            <div class="condition-metrics">
              <el-form-item v-for="metric in conditionMetrics" :key="metric.key" :label="metric.label" :class="`condition-${metric.key}`">
                <div class="condition-comparison">
                  <el-select v-model="condition[metric.key + 'Op']" :aria-label="`${metric.label}比较方式`"><el-option v-for="op in operators" :key="op.value" :label="op.label" :value="op.value" /></el-select>
                  <div v-if="condition[metric.key + 'Op'] !== 'ANY'" class="condition-values">
                    <el-input-number v-model="condition[metric.key + 'Value']" controls-position="right" :aria-label="`${metric.label}${condition[metric.key + 'Op'] === 'BETWEEN' ? '下限' : '数值'}`" />
                    <template v-if="condition[metric.key + 'Op'] === 'BETWEEN'">
                      <span class="muted">至</span>
                      <el-input-number v-model="condition[metric.key + 'Value2']" controls-position="right" :aria-label="`${metric.label}上限`" />
                    </template>
                  </div>
                </div>
              </el-form-item>
            </div>
          </div>
        </el-form>
      </div>
      <template #footer>
        <el-button :disabled="saving" @click="open = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.rule-description { margin: 0 0 16px; line-height: 1.6; }
.classify-rule-body { max-height: calc(90vh - 128px); overflow-y: auto; }
.classify-rule-body :deep(.el-form-item) { min-width: 0; margin-bottom: 16px; }
.classify-rule-body :deep(.el-form-item__label) { margin-bottom: 8px; line-height: 20px; }
.classify-rule-body :deep(.el-input-number),
.classify-rule-body :deep(.el-date-editor),
.classify-rule-body :deep(.el-select) { width: 100%; min-width: 0; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 16px; }
.effective-tip { grid-column: 1 / -1; margin: -4px 0 16px; line-height: 1.6; }
.conditions-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-top: 8px; border-top: 1px solid var(--el-border-color-light); }
.conditions-heading h3 { margin: 0; font-size: 15px; font-weight: 600; }
.condition-tip { margin: 8px 0 16px; line-height: 1.6; }
.classify-condition { padding: 16px; border: 1px solid var(--el-border-color-light); border-radius: 6px; margin-bottom: 12px; }
.classify-condition:last-child { margin-bottom: 0; }
.condition-identity { display: grid; grid-template-columns: minmax(0, 1fr) 112px; gap: 16px; }
.condition-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.condition-metrics :deep(.el-form-item) { margin-bottom: 0; }
.condition-comparison { display: grid; grid-template-columns: 126px minmax(0, 1fr); gap: 8px; width: 100%; }
.condition-values { display: flex; align-items: center; gap: 8px; min-width: 0; }
.condition-values :deep(.el-input-number) { flex: 1; width: 0; }
@media (max-width: 820px) {
  .condition-metrics { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 520px) {
  .settings-grid, .condition-comparison { grid-template-columns: minmax(0, 1fr); }
  .classify-condition { padding: 12px; }
  .condition-identity { grid-template-columns: minmax(0, 1fr) 96px; gap: 12px; }
}
</style>
