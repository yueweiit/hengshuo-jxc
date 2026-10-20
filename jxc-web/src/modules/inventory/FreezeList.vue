<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { ALL_WAREHOUSE_SOURCE, FREEZE_STATUS, FREEZE_TYPES, PRODUCT_SOURCE } from '@/modules/shared/bizOptions'
import FreezeForm from './FreezeForm.vue'
import { queryDefaults } from '@/utils/action'

const intent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const route = useRoute()
const user = useUserStore()
const page = ref<CrudPageExpose>()
const form = ref<InstanceType<typeof FreezeForm>>()
const initial = queryDefaults(route.query)

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '冻结单', width: 185, fixed: 'left' },
  { prop: 'freezeTypeLabel', label: '类型', width: 100 },
  { prop: 'warehouseName', label: '仓库', width: 130 },
  { prop: 'product', label: '商品', minWidth: 170 },
  { prop: 'batchNo', label: '批次', width: 170 },
  { prop: 'qty', label: '冻结 / 已解冻 / 冻结中', width: 170 },
  { prop: 'reason', label: '原因 / 来源', minWidth: 200 },
  { prop: 'createdAt', label: '冻结时间', type: 'datetime', width: 170 },
  { prop: 'status', label: '状态', type: 'status', statusDomain: 'freeze', width: 100 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号 / 来源 / 原因' },
  { prop: 'status', label: '状态', type: 'select', options: FREEZE_STATUS },
  { prop: 'freezeType', label: '类型', type: 'select', options: FREEZE_TYPES },
  { prop: 'warehouseId', label: '仓库', type: 'select', options: ALL_WAREHOUSE_SOURCE },
  { prop: 'productId', label: '商品', type: 'select', options: PRODUCT_SOURCE },
]

const rel = reactive({ visible: false, saving: false, row: {} as Row, qty: 0, remark: '' })
function openRelease(r: Row) {
  intent.reset()
  Object.assign(rel, { visible: true, row: r, qty: r.activeQty, remark: '' })
}
async function submitRelease() {
  if (!rel.remark.trim()) return ElMessage.warning('请填写解冻说明')
  rel.saving = true
  try {
    await http.postIdem(`/inv/freezes/${rel.row.id}/release`, { qty: rel.qty, remark: rel.remark }, intent)
    ElMessage.success('已解冻，可售数量已增加')
    rel.visible = false
    page.value?.reload()
  } finally {
    rel.saving = false
  }
}
</script>

<template>
  <CrudPage ref="page" title="冻结管理" resource="/inv/freezes" :columns="columns" :search-fields="searchFields" :default-query="initial" :can-create="false" :can-toggle="false">
    <template #toolbar>
      <el-button v-if="user.hasPerm('inv:freeze:create')" type="primary" @click="form?.open()"><el-icon><Plus /></el-icon>手工冻结</el-button>
    </template>
    <template #header>
      <p class="muted">实收时的破损、待检自动冻结；手工冻结用于质量排查等场景。解冻可以部分解冻，每次解冻生成一条流水。</p>
    </template>
    <template #col-docNo="{ row }"><span class="mono">{{ row.docNo || '#' + row.id }}</span></template>
    <template #col-product="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template>
    <template #col-qty="{ row }"><span class="mono">{{ row.qty }} / {{ row.releasedQty }} / <b>{{ row.activeQty }}</b></span></template>
    <template #col-reason="{ row }">
      {{ row.reason || '-' }}
      <div v-if="row.sourceNo" class="muted mono">{{ row.sourceNo }}</div>
    </template>
    <template #row-actions="{ row }">
      <el-button v-if="row.status !== 'RELEASED' && user.hasPerm('inv:freeze:release')" link type="primary" @click="openRelease(row)">解冻</el-button>
    </template>
  </CrudPage>

  <el-dialog v-model="rel.visible" :title="`解冻 ${rel.row.docNo || '#' + rel.row.id}`" width="460px" append-to-body>
    <el-form label-width="90px">
      <el-form-item label="商品"><ProductCell :code="rel.row.productCode" :name="rel.row.productName" /></el-form-item>
      <el-form-item label="冻结中">{{ rel.row.activeQty }}（{{ rel.row.freezeTypeLabel }}）</el-form-item>
      <el-form-item label="解冻数量"><el-input-number v-model="rel.qty" :min="1" :max="rel.row.activeQty" style="width: 100%" /></el-form-item>
      <el-form-item label="说明" required><el-input v-model="rel.remark" type="textarea" :rows="2" placeholder="例如：复检合格" /></el-form-item>
    </el-form>
    <p v-if="rel.row.freezeType === 'DAMAGED'" class="muted">破损品通常走报废或索赔，确认可以销售后再解冻。</p>
    <template #footer>
      <el-button @click="rel.visible = false">取消</el-button>
      <el-button type="primary" :loading="rel.saving" @click="submitRelease">解冻</el-button>
    </template>
  </el-dialog>
  <FreezeForm ref="form" @saved="page?.reload()" />
</template>
