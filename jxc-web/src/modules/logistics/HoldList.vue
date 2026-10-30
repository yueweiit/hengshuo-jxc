<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { HOLD_STATUS, HOLD_OWNER_SOURCE } from '@/modules/shared/bizOptions'
import { formatDate } from '@/utils/format'
import { queryDefaults } from '@/utils/action'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const page = ref<CrudPageExpose>()

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '暂缓单', width: 185, fixed: 'left' },
  { prop: 'shipmentNo', label: '运输批次', width: 185 },
  { prop: 'reasonLabel', label: '原因', width: 120 },
  { prop: 'parkLocation', label: '停放地点', minWidth: 170 },
  { prop: 'ownerName', label: '责任人', width: 100 },
  { prop: 'reviewDate', label: '复查日期', width: 112 },
  { prop: 'qty', label: '暂缓 / 已恢复 / 暂缓中', width: 160 },
  { prop: 'createdAt', label: '暂缓时间', type: 'datetime', width: 170 },
  { prop: 'status', label: '状态', type: 'status', statusDomain: 'hold', width: 100 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号 / 批次 / 地点' },
  { prop: 'status', label: '状态', type: 'select', options: HOLD_STATUS },
  { prop: 'ownerId', label: '责任人', type: 'select', options: HOLD_OWNER_SOURCE },
]

const rel = reactive({ visible: false, saving: false, hold: {} as Row, qty: {} as Record<number, number>, remark: '' })
function openRelease(h: Row) {
  Object.assign(rel, { visible: true, hold: h, remark: '', qty: Object.fromEntries(h.lines.map((l: Row) => [l.id, l.holdQty - l.releasedQty])) })
}
async function submitRelease() {
  rel.saving = true
  try {
    await http.postIdem(`/lgs/holds/${rel.hold.id}/release`, { remark: rel.remark, lines: Object.entries(rel.qty).map(([k, v]) => ({ holdLineId: Number(k), qty: v })) }, supplyCommandIntent)
    ElMessage.success('已恢复，数量回到当地待派送')
    rel.visible = false
    page.value?.reload()
  } finally {
    rel.saving = false
  }
}
</script>

<template>
  <CrudPage
    ref="page"
    title="暂缓派送"
    resource="/lgs/holds"
    :columns="columns"
    :search-fields="searchFields"
    :default-query="queryDefaults(route.query)"
    :can-create="false"
    :can-toggle="false"
  >
    <template #header>
      <p class="muted">暂缓在运输批次详情中发起（只能暂缓当地待派送的数量）。恢复派送需要单独授权，可以部分恢复；到复查日期仍未恢复会提醒责任人。</p>
    </template>
    <template #col-shipmentNo="{ row }">
      <el-link type="primary" @click="router.push(`/logistics/shipments/${row.shipmentId}`)">{{ row.shipmentNo }}</el-link>
    </template>
    <template #col-reviewDate="{ row }">
      <span :class="{ warn: row.overdue }">{{ formatDate(row.reviewDate) }}</span>
      <el-tag v-if="row.overdue" size="small" type="danger" class="ml">到期</el-tag>
    </template>
    <template #col-qty="{ row }"><span class="mono">{{ row.holdQty }} / {{ row.releasedQty }} / {{ row.activeQty }}</span></template>
    <template #row-actions="{ row }">
      <el-button v-if="row.status !== 'RELEASED' && user.hasPerm('lgs:hold:release')" link type="primary" @click="openRelease(row)">恢复派送</el-button>
    </template>
  </CrudPage>

  <el-dialog v-model="rel.visible" :title="`恢复派送 ${rel.hold.docNo}`" width="600px" append-to-body>
    <el-table :data="rel.hold.lines ?? []" border size="small">
      <el-table-column label="商品" min-width="160"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
      <el-table-column label="暂缓中" width="80" align="right"><template #default="{ row }">{{ row.holdQty - row.releasedQty }}</template></el-table-column>
      <el-table-column label="本次恢复" width="130">
        <template #default="{ row }"><el-input-number v-model="rel.qty[row.id]" :min="0" :max="row.holdQty - row.releasedQty" :controls="false" style="width: 100%" /></template>
      </el-table-column>
    </el-table>
    <el-input v-model="rel.remark" class="mt" placeholder="备注，例如：清关资料已补齐" />
    <template #footer>
      <el-button @click="rel.visible = false">取消</el-button>
      <el-button type="primary" :loading="rel.saving" @click="submitRelease">确认恢复</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.warn {
  color: var(--el-color-danger);
}

.ml {
  margin-left: 4px;
}

.mt {
  margin-top: 10px;
}
</style>
