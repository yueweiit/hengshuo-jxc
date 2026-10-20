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
const form = reactive<Record<string, any>>({ id: null, name: '', dimType: 'WAREHOUSE', periodType: 'ROLLING_DAYS', periodDays: 90, orderMetric: 'QTY', stockMetric: 'AVAILABLE', effectiveFrom: undefined, conditions: [] })

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
  if (form.id) await http.put('/inv/classify-rules/' + form.id, form)
  else await http.post('/inv/classify-rules', form)
  ElMessage.success('已保存并生成新版本')
  open.value = false
  load()
}

async function recalc(row: Record<string, any>) {
  const res = await http.post<{ count: number }>('/inv/classify-rules/' + row.id + '/recalculate', {})
  ElMessage.success(`已按版本 ${row.versionNo} 重算 ${res.count} 条`)
}

onMounted(load)
</script>

<template>
  <el-card>
    <template #header>
      <div class="row"><span>畅销滞销规则</span><el-button v-if="user.hasPerm('inv:classify:config')" type="primary" @click="edit({ name: '联合分类', dimType: 'WAREHOUSE', periodType: 'ROLLING_DAYS', periodDays: 90, orderMetric: 'QTY', stockMetric: 'AVAILABLE', conditions: [] })">新增</el-button></div>
    </template>
    <p class="muted">同一优先级下，库存区间和订单区间重叠且标签不同时不能保存。修改规则只影响当前国家，并生成新版本。</p>
    <el-table :data="rows" size="small">
      <el-table-column prop="name" label="名称" />
      <el-table-column prop="dimType" label="维度" width="120" />
      <el-table-column prop="periodDays" label="滚动天数" width="100" />
      <el-table-column prop="versionNo" label="版本" width="70" />
      <el-table-column label="生效日期" width="110"><template #default="{ row }">{{ formatDate(row.effectiveFrom) }}</template></el-table-column>
      <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
      <el-table-column width="180">
        <template #default="{ row }">
          <el-button v-if="user.hasPerm('inv:classify:config') && row.status === 'ACTIVE'" link type="primary" @click="edit(row)">编辑</el-button>
          <el-button v-if="user.hasPerm('inv:classify:config') && row.status === 'ACTIVE'" link @click="recalc(row)">重算</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-dialog v-model="open" title="分类条件" width="760px">
      <el-form label-width="90px">
        <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="生效日期"><el-date-picker v-model="form.effectiveFrom" type="date" value-format="YYYY-MM-DD" clearable placeholder="未选时使用当前国家日期" /><div class="muted">生效日前不参与计算；未选时使用当前国家业务日期。保存新版本会将原版本退役。</div></el-form-item>
        <el-form-item label="维度">
          <el-select v-model="form.dimType"><el-option label="仓库" value="WAREHOUSE" /><el-option label="门店" value="STORE" /><el-option label="国家" value="COUNTRY" /></el-select>
        </el-form-item>
        <el-form-item label="周期"><el-select v-model="form.periodType"><el-option label="滚动天数" value="ROLLING_DAYS" /><el-option label="本地自然月" value="CALENDAR_MONTH" /><el-option label="本地自然周" value="CALENDAR_WEEK" /></el-select></el-form-item>
        <el-form-item v-if="form.periodType === 'ROLLING_DAYS'" label="滚动天数"><el-input-number v-model="form.periodDays" :min="1" /></el-form-item>
        <el-form-item label="订单指标"><el-select v-model="form.orderMetric"><el-option label="有效件数" value="QTY" /><el-option label="订单张数" value="ORDER_COUNT" /></el-select></el-form-item>
        <el-form-item label="库存指标"><el-select v-model="form.stockMetric"><el-option label="可售" value="AVAILABLE" /><el-option label="实物" value="ON_HAND" /></el-select></el-form-item>
      </el-form>
      <el-button @click="addCond">加一条条件</el-button>
      <el-table :data="form.conditions" size="small">
        <el-table-column label="标签" width="150"><template #default="{ row }"><el-select v-model="row.label"><el-option label="畅销候选" value="HOT_CANDIDATE" /><el-option label="滞销候选" value="SLOW_CANDIDATE" /><el-option label="观察" value="WATCH" /><el-option label="普通" value="NORMAL" /></el-select></template></el-table-column>
        <el-table-column label="优先级" width="90"><template #default="{ row }"><el-input-number v-model="row.priority" :min="1" /></template></el-table-column>
        <el-table-column label="库存" width="200"><template #default="{ row }"><el-select v-model="row.stockOp" style="width: 90px"><el-option v-for="op in ['LT','LTE','GT','GTE','BETWEEN','ANY']" :key="op" :label="op" :value="op" /></el-select><el-input-number v-model="row.stockValue" /><el-input-number v-if="row.stockOp === 'BETWEEN'" v-model="row.stockValue2" /></template></el-table-column>
        <el-table-column label="订单指标"><template #default="{ row }"><el-select v-model="row.orderOp" style="width: 90px"><el-option v-for="op in ['LT','LTE','GT','GTE','BETWEEN','ANY']" :key="op" :label="op" :value="op" /></el-select><el-input-number v-model="row.orderValue" /><el-input-number v-if="row.orderOp === 'BETWEEN'" v-model="row.orderValue2" /></template></el-table-column>
      </el-table>
      <template #footer><el-button type="primary" @click="save">保存</el-button></template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.row { display: flex; justify-content: space-between; align-items: center; }
</style>
