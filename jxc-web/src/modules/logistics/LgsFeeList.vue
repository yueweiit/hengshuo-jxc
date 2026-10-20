<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import MoneyText from '@/components/MoneyText.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { CURRENCY_SOURCE, COST_TREATMENTS } from '@/modules/master/options'
import { CARRIER_SOURCE, ESTIMATE_FLAGS, FEE_REF_TYPES, FEE_STATUS, optionText } from '@/modules/shared/bizOptions'
import { confirmAction, queryDefaults } from '@/utils/action'
import FeeForm from './FeeForm.vue'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const page = ref<CrudPageExpose>()
const form = ref<InstanceType<typeof FeeForm>>()

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '费用单', width: 185, fixed: 'left' },
  { prop: 'shipmentNo', label: '运输批次', width: 185 },
  { prop: 'ref', label: '关联', width: 210 },
  { prop: 'carrierName', label: '物流商', minWidth: 130 },
  { prop: 'expenseItemName', label: '费用项目', minWidth: 140 },
  { prop: 'amount', label: '金额', type: 'money', currencyProp: 'currency', width: 150 },
  { prop: 'estimateFlag', label: '暂估/实际', width: 150 },
  { prop: 'bizDate', label: '业务日期', type: 'date', width: 112 },
  { prop: 'status', label: '状态', type: 'status', width: 95 },
  { prop: 'costStatus', label: '成本折算', width: 110 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号 / 关联单 / 备注' },
  { prop: 'status', label: '状态', type: 'select', options: FEE_STATUS },
  { prop: 'estimateFlag', label: '暂估/实际', type: 'select', options: ESTIMATE_FLAGS },
  { prop: 'refType', label: '关联类型', type: 'select', options: FEE_REF_TYPES },
  { prop: 'carrierId', label: '物流商', type: 'select', options: CARRIER_SOURCE },
  { prop: 'currency', label: '币种', type: 'select', options: CURRENCY_SOURCE },
]

async function confirmFee(f: Row) {
  await confirmAction(`确认费用 ${f.docNo}（${f.currency} ${f.amount}）？确认后不能修改。`, () => http.postIdem(`/lgs/fees/${f.id}/confirm`, undefined, supplyCommandIntent), { success: '已确认' })
  page.value?.reload()
}
async function retryCost(f: Row) {
  await confirmAction(`重试费用 ${f.docNo} 的成本折算与实际差额处理？`, () => http.postIdem(`/lgs/fees/${f.id}/confirm`, undefined, supplyCommandIntent), { success: '已重试成本折算' })
  page.value?.reload()
}
async function voidFee(f: Row) {
  await confirmAction(`作废草稿 ${f.docNo}？`, () => http.postIdem(`/lgs/fees/${f.id}/void`, undefined, supplyCommandIntent), { success: '已作废' })
  page.value?.reload()
}
</script>

<template>
  <CrudPage
    ref="page"
    title="物流费用"
    resource="/lgs/fees"
    :columns="columns"
    :search-fields="searchFields"
    :default-query="queryDefaults(route.query)"
    :can-create="false"
    :can-toggle="false"
    audit-type="lgs-fee"
    :actions-width="250"
  >
    <template #toolbar>
      <el-button v-if="user.hasPerm('lgs:fee:create')" type="primary" @click="form?.open()"><el-icon><Plus /></el-icon>登记费用</el-button>
    </template>
    <template #header>
      <p class="muted">费用可以关联运输批次、换柜、暂缓或派送单。暂估先确认入账，实际费用到达后关联暂估，差额由成本调整处理，不覆盖历史成本。</p>
    </template>
    <template #col-shipmentNo="{ row }">
      <el-link type="primary" @click="router.push(`/logistics/shipments/${row.shipmentId}`)">{{ row.shipmentNo }}</el-link>
    </template>
    <template #col-ref="{ row }">{{ row.refTypeLabel }} · <span class="mono">{{ row.refNo }}</span></template>
    <template #col-expenseItemName="{ row }">
      {{ row.expenseItemName }}
      <div class="muted">{{ optionText(COST_TREATMENTS, row.costTreatment) }}</div>
    </template>
    <template #col-estimateFlag="{ row }">
      <el-tag :type="row.estimateFlag === 'ESTIMATE' ? 'warning' : 'success'" size="small">{{ optionText(ESTIMATE_FLAGS, row.estimateFlag) }}</el-tag>
      <div v-if="row.actualNo" class="muted">实际：{{ row.actualNo }}</div>
      <div v-if="row.estimateNo" class="muted">冲抵：{{ row.estimateNo }}</div>
      <div v-if="row.diffAmount != null" class="muted">差额 <MoneyText :value="row.diffAmount" :currency="row.currency" /></div>
    </template>
    <template #col-costStatus="{ row }"><el-tag v-if="row.costStatus === 'PENDING_RATE'" type="warning" size="small">待补汇率</el-tag><span v-else>{{ row.costStatus === 'READY' ? '已折算' : '—' }}</span></template>
    <template #row-actions="{ row }">
      <el-button v-if="row.status === 'CONFIRMED' && row.costStatus === 'PENDING_RATE' && user.hasPerm('lgs:fee:confirm')" link type="primary" @click="retryCost(row)">重试成本折算</el-button>
      <template v-if="row.status === 'DRAFT'">
        <el-button v-if="user.hasPerm('lgs:fee:create')" link type="primary" @click="form?.open({}, row)">编辑</el-button>
        <el-button v-if="user.hasPerm('lgs:fee:confirm')" link type="success" @click="confirmFee(row)">确认</el-button>
        <el-button v-if="user.hasPerm('lgs:fee:create')" link type="danger" @click="voidFee(row)">作废</el-button>
      </template>
      <el-button v-if="row.status === 'CONFIRMED' && row.estimateFlag === 'ESTIMATE' && user.hasPerm('lgs:fee:create')" link type="primary" @click="form?.open({ refType: row.refType, refId: row.refId, estimateFlag: 'ACTUAL', estimateFeeId: row.id, carrierId: row.carrierId, expenseItemId: row.expenseItemId, currency: row.currency })">登记实际</el-button>
    </template>
  </CrudPage>
  <FeeForm ref="form" @saved="page?.reload()" />
</template>
