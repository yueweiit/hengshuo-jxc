<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { DISCREPANCY_STATUS, DISCREPANCY_TYPES, MX_WAREHOUSE_SOURCE, RESOLUTIONS } from '@/modules/shared/bizOptions'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const page = ref<CrudPageExpose>()
const { id: focusId, ...initialQuery } = route.query

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '差异单', width: 185, fixed: 'left' },
  { prop: 'typeLabel', label: '类型', width: 95 },
  { prop: 'product', label: '商品', minWidth: 170 },
  { prop: 'qty', label: '数量', type: 'qty', width: 80 },
  { prop: 'shipmentNo', label: '运输批次', width: 185 },
  { prop: 'sourceNo', label: '来源单', width: 185 },
  { prop: 'warehouseName', label: '仓库', width: 130 },
  { prop: 'resolution', label: '处理结论', minWidth: 200 },
  { prop: 'status', label: '状态', type: 'status', statusDomain: 'discrepancy', width: 100 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号 / 批次 / 来源' },
  { prop: 'status', label: '状态', type: 'select', options: DISCREPANCY_STATUS },
  { prop: 'discrepancyType', label: '类型', type: 'select', options: DISCREPANCY_TYPES },
  { prop: 'warehouseId', label: '仓库', type: 'select', options: MX_WAREHOUSE_SOURCE },
]

const dlg = reactive({ visible: false, saving: false, row: {} as Row, resolution: 'LATER_ARRIVED', remark: '' })
function openResolve(row: Row) {
  Object.assign(dlg, { visible: true, row, resolution: 'LATER_ARRIVED', remark: '' })
}
async function submit() {
  if (!dlg.remark.trim()) return ElMessage.warning('请填写处理说明')
  dlg.saving = true
  try {
    const res = await http.postIdem<Row>(`/lgs/discrepancies/${dlg.row.id}/resolve`, { resolution: dlg.resolution, remark: dlg.remark }, supplyCommandIntent)
    ElMessage.success(res.status === 'PENDING_APPROVAL' ? '核销已提交审批' : '已处理')
    dlg.visible = false
    page.value?.reload()
  } finally {
    dlg.saving = false
  }
}

const HINT: Record<string, string> = {
  LATER_ARRIVED: '数量从差异桶回到当地待派送，可以再次派送并补做实收。',
  CLAIM: '转为索赔，由退货与索赔模块（第 3 批）跟进；差异数量保留在差异桶。',
  WRITE_OFF: '核销需要按审批规则审批，审批通过后差异关闭；财务影响由成本与总账处理。',
  SUPPLIER_CREDIT: '登记供应商贷项，由应付模块跟进抵扣。',
}

onMounted(async () => {
  if (focusId) openResolve(await http.get<Row>(`/lgs/discrepancies/${focusId}`))
})
</script>

<template>
  <CrudPage
    ref="page"
    title="到货差异"
    resource="/lgs/discrepancies"
    :columns="columns"
    :search-fields="searchFields"
    :default-query="initialQuery"
    :can-create="false"
    :can-toggle="false"
    audit-type="discrepancy"
  >
    <template #header>
      <p class="muted">实收短缺、换柜差异自动生成差异单，数量进入运输批次的“差异”桶。差异全部处理后批次才能完成。</p>
    </template>
    <template #col-product="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template>
    <template #col-shipmentNo="{ row }">
      <el-link type="primary" @click="router.push(`/logistics/shipments/${row.shipmentId}`)">{{ row.shipmentNo }}</el-link>
    </template>
    <template #col-resolution="{ row }">
      <template v-if="row.resolution">
        <b>{{ row.resolutionLabel }}</b>
        <div class="muted">{{ row.resolutionRef || row.approvalMessage }}</div>
        <div v-if="row.resolvedByName" class="muted">{{ row.resolvedByName }} · <DateTimeText :value="row.resolvedAt" /></div>
      </template>
      <span v-else class="muted">-</span>
    </template>
    <template #row-actions="{ row }">
      <el-button v-if="row.status === 'OPEN' && user.hasPerm('lgs:discrepancy:handle')" link type="primary" @click="openResolve(row)">处理</el-button>
    </template>
  </CrudPage>

  <el-dialog v-model="dlg.visible" :title="`处理差异 ${dlg.row.docNo ?? ''}`" width="560px" append-to-body>
    <el-descriptions :column="2" border size="small">
      <el-descriptions-item label="类型">{{ dlg.row.typeLabel }}</el-descriptions-item>
      <el-descriptions-item label="数量">{{ dlg.row.qty }}</el-descriptions-item>
      <el-descriptions-item label="商品" :span="2"><ProductCell :code="dlg.row.productCode" :name="dlg.row.productName" /></el-descriptions-item>
      <el-descriptions-item label="来源" :span="2">{{ dlg.row.shipmentNo }} · {{ dlg.row.sourceNo }}</el-descriptions-item>
    </el-descriptions>
    <template v-if="dlg.row.status === 'OPEN'">
      <el-radio-group v-model="dlg.resolution" class="mt">
        <el-radio-button v-for="o in RESOLUTIONS" :key="String(o.value)" :value="o.value">{{ o.label }}</el-radio-button>
      </el-radio-group>
      <p class="muted">{{ HINT[dlg.resolution] }}</p>
      <el-input v-model="dlg.remark" type="textarea" :rows="3" placeholder="处理说明（必填）" />
    </template>
    <el-alert v-else type="info" :closable="false" class="mt" :title="`这张差异单当前状态：${dlg.row.status === 'RESOLVED' ? '已处理' : '审批中'}`" />
    <template #footer>
      <el-button @click="dlg.visible = false">关闭</el-button>
      <el-button v-if="dlg.row.status === 'OPEN' && user.hasPerm('lgs:discrepancy:handle')" type="primary" :loading="dlg.saving" @click="submit">提交</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.mt {
  margin-top: 12px;
}
</style>
