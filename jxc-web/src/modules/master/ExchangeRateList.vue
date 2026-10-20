<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import StatusTag from '@/components/StatusTag.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import OptionText from '@/components/crud/OptionText.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { CURRENCY_SOURCE, RATE_SCOPES } from './options'
import { todayIn } from '@/utils/format'

interface Rate {
  id: number
  status?: string
  version?: number
  fromCcy?: string
  toCcy?: string
  rate?: number
  rateDate?: string
  scope?: string
  versionNo?: number
  createdByName?: string
  confirmedByName?: string
  confirmedAt?: string
}

const country = useCountryStore()
const user = useUserStore()
const confirmationIntent = createCommandIntent()
const context = () => JSON.stringify([country.currentId, country.epoch, user.token])
const STATUS = [
  { label: '待确认', value: 'DRAFT' },
  { label: '已确认', value: 'CONFIRMED' },
  { label: '已替代', value: 'RETIRED' },
]

const columns: ColumnDef[] = [
  { prop: 'pair', label: '币种', width: 120 },
  { prop: 'rate', label: '汇率', width: 120 },
  { prop: 'rateDate', label: '汇率日期', type: 'date', width: 110 },
  { prop: 'scope', label: '适用范围', type: 'option', options: RATE_SCOPES, width: 100 },
  { prop: 'versionNo', label: '版本', width: 70 },
  { prop: 'status', label: '状态', type: 'status', width: 90 },
  { prop: 'createdByName', label: '录入人', width: 130 },
  { prop: 'confirmed', label: '确认', minWidth: 200 },
]

const searchFields: FieldDef[] = [
  { prop: 'fromCcy', label: '原币', type: 'select', options: CURRENCY_SOURCE },
  { prop: 'scope', label: '适用范围', type: 'select', options: RATE_SCOPES },
  { prop: 'status', label: '状态', type: 'select', options: STATUS },
]

const formFields: FieldDef[] = [
  { prop: 'fromCcy', label: '原币', type: 'select', options: CURRENCY_SOURCE, required: true, editDisabled: true, default: 'CNY' },
  { prop: 'toCcy', label: '目标币', type: 'select', options: CURRENCY_SOURCE, required: true, editDisabled: true },
  { prop: 'rateDate', label: '汇率日期', type: 'date', required: true, editDisabled: true },
  { prop: 'scope', label: '适用范围', type: 'select', options: RATE_SCOPES, required: true, editDisabled: true, default: 'PURCHASE_COST' },
  { prop: 'rate', label: '汇率', type: 'number', min: 0, precision: 6, required: true, tip: '1 原币 = N 目标币' },
  { prop: 'remark', label: '备注' },
]

function beforeOpen(row: Partial<Rate>, mode: 'create' | 'edit') {
  if (mode === 'create') return { ...row, toCcy: country.currency, rateDate: todayIn(country.timezone) }
  if (row.status === 'CONFIRMED') {
    ElMessage.info('已确认的汇率不会被覆盖：保存后生成一个待确认的新版本，已确认单据不重算。')
  }
  return row
}

async function confirm(row: Rate, reload: () => void) {
  const expectedContext = context(), id = row.id, version = row.version
  await ElMessageBox.confirm(
    `确认 ${row.fromCcy}→${row.toCcy} ${row.rate}（${row.rateDate}）？确认后可用于成本确认和记账，同范围的旧版本将被替代。`,
    '确认汇率',
    { type: 'warning' },
  )
  if (expectedContext !== context() || !user.hasPerm('md:rate:confirm')) return
  const res = await http.postIdem<Rate & { sameUser: boolean }>(`/md/exchange-rates/${id}/confirm`, { version }, confirmationIntent)
  if (expectedContext !== context()) return
  if (res.sameUser) ElMessage.warning('已确认。建议汇率的录入和确认由不同的人执行。')
  else ElMessage.success('已确认')
  reload()
}

const versions = ref<Rate[]>([])
const versionsVisible = ref(false)
async function openVersions(row: Rate) {
  versions.value = await http.get<Rate[]>(`/md/exchange-rates/${row.id}/versions`)
  versionsVisible.value = true
}
</script>

<template>
  <CrudPage
    title="汇率"
    resource="/md/exchange-rates"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    edit-perm="md:rate:edit"
    audit-type="exchange-rate"
    :can-toggle="false"
    :before-open="beforeOpen"
  >
    <template #header>
      <p class="muted">
        取值规则：同一适用范围内，取汇率日期不晚于业务日期的最近一条<strong>已确认</strong>汇率；没有时业务提示「待补汇率」并拦截成本确认。
      </p>
    </template>
    <template #col-pair="{ row }">
      <span class="mono">{{ row.fromCcy }} → {{ row.toCcy }}</span>
    </template>
    <template #col-confirmed="{ row }">
      <span v-if="row.confirmedAt">{{ row.confirmedByName }} · <DateTimeText :value="row.confirmedAt" /></span>
      <span v-else class="muted">-</span>
    </template>
    <template #row-actions="{ row, reload }">
      <el-button v-if="row.status === 'DRAFT' && user.hasPerm('md:rate:confirm')" link type="success" @click="confirm(row, reload)">
        确认
      </el-button>
      <el-button link @click="openVersions(row)">版本</el-button>
    </template>
  </CrudPage>

  <el-drawer v-model="versionsVisible" title="版本历史" size="520px">
    <el-table :data="versions" size="small" border>
      <el-table-column prop="versionNo" label="版本" width="60" />
      <el-table-column prop="rate" label="汇率" width="100" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }"><StatusTag :status="row.status" /></template>
      </el-table-column>
      <el-table-column label="范围" width="90">
        <template #default="{ row }"><OptionText :value="row.scope" :options="RATE_SCOPES" /></template>
      </el-table-column>
      <el-table-column label="确认时间" min-width="160">
        <template #default="{ row }"><DateTimeText :value="row.confirmedAt" /></template>
      </el-table-column>
    </el-table>
  </el-drawer>
</template>
