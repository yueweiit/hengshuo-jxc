<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'
import CrudPage from '@/components/crud/CrudPage.vue'
import StatusTag from '@/components/StatusTag.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { DOC_STATUS } from '@/modules/shared/bizOptions'
import { confirmAction } from '@/utils/action'
import { todayIn } from '@/utils/format'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const user = useUserStore()
const country = useCountryStore()
const page = ref<CrudPageExpose>()

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '出口单号', width: 170, fixed: 'left' },
  { prop: 'declarationNo', label: '报关单号', width: 170 },
  { prop: 'exportPort', label: '出口口岸', width: 110 },
  { prop: 'exportDate', label: '出口日期', type: 'date', width: 105 },
  { prop: 'productSummary', label: '商品', minWidth: 120 },
  { prop: 'totalQty', label: '数量', type: 'qty', width: 80 },
  { prop: 'status', label: '状态', type: 'status', width: 90 },
  { prop: 'createdByName', label: '登记人', width: 120 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号 / 报关单 / 口岸' },
  { prop: 'status', label: '状态', type: 'select', options: DOC_STATUS },
]

const edit = reactive({ visible: false, id: 0, version: 0, declarationNo: '', exportPort: '', exportDate: '', remark: '', sources: [] as Row[], saving: false })
const totalQty = computed(() => edit.sources.reduce((s, x) => s + (x.qty ?? 0), 0))

async function open(r?: Row) {
  const sources = await http.get<Row[]>('/pur/export-nodes/sources')
  const prefill = new Map<number, number>((r?.lines ?? []).map((l: Row) => [l.receiptLineId, l.qty]))
  Object.assign(edit, {
    visible: true, id: r?.id ?? 0, version: r?.version ?? 0, declarationNo: r?.declarationNo ?? '', exportPort: r?.exportPort ?? '',
    exportDate: r?.exportDate ?? todayIn(country.timezone), remark: r?.remark ?? '',
    sources: sources.map((s) => ({ ...s, qty: prefill.get(s.receiptLineId) ?? 0 })),
  })
}

async function save(confirm: boolean) {
  if (!edit.declarationNo.trim()) return ElMessage.warning('请填写报关单号')
  const lines = edit.sources.filter((s) => s.qty > 0).map((s) => ({ receiptLineId: s.receiptLineId, qty: s.qty }))
  if (!lines.length) return ElMessage.warning('请至少一行填写出口数量')
  edit.saving = true
  try {
    const body = { declarationNo: edit.declarationNo, exportPort: edit.exportPort, exportDate: edit.exportDate, remark: edit.remark, lines, version: edit.version }
    if (edit.id) {
      await http.put(`/pur/export-nodes/${edit.id}`, body)
      if (confirm) await http.postIdem(`/pur/export-nodes/${edit.id}/confirm`, undefined, supplyCommandIntent)
    } else {
      await http.postIdem('/pur/export-nodes', { ...body, confirm }, supplyCommandIntent)
    }
    ElMessage.success(confirm ? '已确认，可以在运输批次中选择这些出口行发运' : '已保存草稿')
    edit.visible = false
    page.value?.reload()
  } finally {
    edit.saving = false
  }
}

async function confirmNode(r: Row) {
  await confirmAction(`确认出口 ${r.docNo}？确认后这些数量可用于创建运输批次。`, () => http.postIdem(`/pur/export-nodes/${r.id}/confirm`, undefined, supplyCommandIntent), { success: '已确认' })
  page.value?.reload()
}
async function voidNode(r: Row) {
  await confirmAction(`作废草稿 ${r.docNo}？`, () => http.postIdem(`/pur/export-nodes/${r.id}/void`, undefined, supplyCommandIntent), { success: '已作废' })
  page.value?.reload()
}

const detail = ref<Row | null>(null)
const detailVisible = ref(false)
function openDetail(r: Row) {
  detail.value = r
  detailVisible.value = true
}
</script>

<template>
  <CrudPage
    ref="page"
    title="出口节点"
    resource="/pur/export-nodes"
    :columns="columns"
    :search-fields="searchFields"
    :can-create="false"
    :can-toggle="false"
    audit-type="export-node"
    :actions-width="220"
  >
    <template #toolbar>
      <el-button v-if="user.hasPerm('pur:export:create')" type="primary" @click="open()"><el-icon><Plus /></el-icon>登记出口</el-button>
    </template>
    <template #header>
      <p class="muted">从已确认国内收货的合格数量登记报关出口；本国配置要求出口节点，运输批次只能选择已确认的出口行。</p>
    </template>
    <template #col-docNo="{ row }"><el-link type="primary" @click="openDetail(row)">{{ row.docNo }}</el-link></template>
    <template #row-actions="{ row }">
      <el-button link @click="openDetail(row)">详情</el-button>
      <template v-if="row.status === 'DRAFT'">
        <el-button v-if="user.hasPerm('pur:export:create')" link type="primary" @click="open(row)">编辑</el-button>
        <el-button v-if="user.hasPerm('pur:export:confirm')" link type="success" @click="confirmNode(row)">确认</el-button>
        <el-button v-if="user.hasPerm('pur:export:create')" link type="danger" @click="voidNode(row)">作废</el-button>
      </template>
    </template>
  </CrudPage>

  <el-dialog v-model="edit.visible" :title="edit.id ? '编辑出口节点' : '登记出口'" width="900px" append-to-body destroy-on-close class="crud-dialog">
    <el-form label-width="90px">
      <el-row :gutter="12">
        <el-col :xs="24" :span="8"><el-form-item label="报关单号" required><el-input v-model="edit.declarationNo" /></el-form-item></el-col>
        <el-col :xs="12" :span="8"><el-form-item label="出口口岸"><el-input v-model="edit.exportPort" placeholder="深圳盐田" /></el-form-item></el-col>
        <el-col :xs="12" :span="8"><el-form-item label="出口日期"><el-date-picker v-model="edit.exportDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item></el-col>
      </el-row>
    </el-form>
    <div class="table-scroll">
      <el-table :data="edit.sources" border size="small" max-height="380" empty-text="没有可出口的合格数量，请先确认国内收货">
        <el-table-column prop="receiptNo" label="国内收货" width="160" />
        <el-table-column prop="orderNo" label="采购单" width="160" />
        <el-table-column label="商品" min-width="170"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
        <el-table-column prop="exportableQty" label="可出口" width="80" align="right" />
        <el-table-column label="本次出口" width="130">
          <template #default="{ row }"><el-input-number v-model="row.qty" :min="0" :max="row.exportableQty" :controls="false" style="width: 100%" /></template>
        </el-table-column>
        <el-table-column width="70">
          <template #default="{ row }"><el-button link type="primary" @click="row.qty = row.exportableQty">全部</el-button></template>
        </el-table-column>
      </el-table>
    </div>
    <el-input v-model="edit.remark" class="mt" placeholder="备注" />
    <template #footer>
      <span class="muted foot-total">合计 {{ totalQty }}</span>
      <el-button @click="edit.visible = false">取消</el-button>
      <el-button :loading="edit.saving" @click="save(false)">保存草稿</el-button>
      <el-button v-if="user.hasPerm('pur:export:confirm')" type="primary" :loading="edit.saving" @click="save(true)">保存并确认</el-button>
    </template>
  </el-dialog>

  <el-drawer v-model="detailVisible" :title="detail?.docNo" size="640px" destroy-on-close>
    <template v-if="detail">
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="报关单号">{{ detail.declarationNo }}</el-descriptions-item>
        <el-descriptions-item label="状态"><StatusTag :status="detail.status" /></el-descriptions-item>
        <el-descriptions-item label="口岸">{{ detail.exportPort || '-' }}</el-descriptions-item>
        <el-descriptions-item label="出口日期">{{ detail.exportDate }}</el-descriptions-item>
      </el-descriptions>
      <h4>明细</h4>
      <el-table :data="detail.lines" border size="small">
        <el-table-column prop="orderNo" label="采购单" width="160" />
        <el-table-column label="商品" min-width="160"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
        <el-table-column prop="qty" label="出口" width="70" align="right" />
        <el-table-column prop="shippedQty" label="已发运" width="80" align="right" />
      </el-table>
      <h4>报关单证</h4>
      <DocAttachment biz-type="EXPORT_NODE" :biz-id="detail.id" category="CUSTOMS_DOC" />
    </template>
  </el-drawer>
</template>

<style scoped>
.mt {
  margin-top: 10px;
}

.foot-total {
  margin-right: 12px;
}
</style>
