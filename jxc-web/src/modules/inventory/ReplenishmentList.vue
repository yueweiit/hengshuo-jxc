<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import FieldInput from '@/components/crud/FieldInput.vue'
import { ALL_WAREHOUSE_SOURCE, PRODUCT_SOURCE } from '@/modules/shared/bizOptions'
import StatusTag from '@/components/StatusTag.vue'
import { useUserStore } from '@/stores/user'

const intent = createCommandIntent()
const user = useUserStore()
const rows = ref<Record<string, any>[]>([])
const open = ref(false)
const executionDocs = ref<Record<string, any>[]>([])
const mode = ref<'create' | 'decide' | 'link'>('create')
const current = ref<Record<string, any> | null>(null)
const form = reactive<Record<string, any>>({ warehouseId: null, productId: null, reqQty: 1, reason: '', decidedSource: 'TRANSFER', execDocType: 'INV_TRANSFER', execDocId: null, note: '' })

async function load() {
  rows.value = await allRecords<Record<string, any>>('/inv/replenishments')
}
async function show(next: 'create' | 'decide' | 'link', row?: Record<string, any>) {
  intent.reset()
  mode.value = next
  current.value = row ?? null
  Object.assign(form, { warehouseId: null, productId: null, reqQty: 1, reason: '', decidedSource: row?.decidedSource || 'TRANSFER', execDocType: row?.decidedSource === 'PURCHASE' ? 'PUR_ORDER' : 'INV_TRANSFER', execDocId: null, note: '' })
  if (next === 'link') await loadExecutionDocs()
  open.value = true
}
async function loadExecutionDocs() {
  const transfer = form.execDocType === 'INV_TRANSFER'
  const listed = await allRecords<Record<string, any>>(transfer ? '/inv/transfers' : '/pur/orders')
  executionDocs.value = listed.filter(r => transfer ? Number(r.toWarehouseId) === Number(current.value?.warehouseId) && ['APPROVED','IN_TRANSIT','PARTIAL_RECEIVED','RECEIVED','CLOSED'].includes(r.status) : ['CONFIRMED','PARTIAL_DELIVERED','DELIVERED','CLOSED'].includes(r.status))
}
async function submit() {
  if (mode.value === 'create') await http.postIdem('/inv/replenishments', form, intent)
  if (mode.value === 'decide' && current.value) await http.postIdem(`/inv/replenishments/${current.value.id}/decide`, { decidedSource: form.decidedSource, note: form.note }, intent)
  if (mode.value === 'link' && current.value) await http.postIdem(`/inv/replenishments/${current.value.id}/link`, { execDocType: form.execDocType, execDocId: Number(form.execDocId) }, intent)
  ElMessage.success('已保存')
  open.value = false
  load()
}
async function suggest() {
  intent.reset()
  const res = await http.postIdem<{ created: number }>('/inv/replenishments/suggest', {}, intent)
  ElMessage.success(`新生成 ${res.created} 条，未关闭的相同预警不会重复`)
  load()
}
async function close(row: Record<string, any>) {
  intent.reset()
  await http.postIdem(`/inv/replenishments/${row.id}/close`, { note: '手工关闭' }, intent)
  load()
}
onMounted(load)
</script>

<template>
  <el-card>
    <template #header>
      <div class="row">
        <span>补货待办</span>
        <span>
          <el-button v-if="user.hasPerm('inv:replenish:create')" @click="suggest">从预警生成</el-button>
          <el-button v-if="user.hasPerm('inv:replenish:create')" type="primary" @click="show('create')">手工申请</el-button>
        </span>
      </div>
    </template>
    <p class="muted">批准并选择调拨或中国采购后才能关联执行单。系统不会自动下采购单。</p>
    <el-table :data="rows" size="small">
      <el-table-column prop="docNo" label="单号" width="160" />
      <el-table-column prop="warehouseName" label="仓库" width="140" />
      <el-table-column prop="productCode" label="商品" width="90" />
      <el-table-column prop="reqQty" label="需求" width="70" />
      <el-table-column prop="fulfilledQty" label="已满足" width="80" />
      <el-table-column prop="suggestedSource" label="建议来源" width="110" />
      <el-table-column prop="decidedSource" label="决定来源" width="110" />
      <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
      <el-table-column min-width="180">
        <template #default="{ row }">
          <el-button v-if="user.hasPerm('inv:replenish:decide') && row.status === 'PENDING'" link type="primary" @click="show('decide', row)">处理</el-button>
          <el-button v-if="user.hasPerm('inv:replenish:decide') && ['APPROVED','LINKED','PARTIAL'].includes(row.status)" link type="primary" @click="show('link', row)">关联</el-button>
          <el-button v-if="user.hasPerm('inv:replenish:decide') && row.status !== 'CLOSED'" link @click="close(row)">关闭</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-dialog v-model="open" title="补货" width="480px">
      <el-form v-if="mode === 'create'" label-width="90px">
        <el-form-item label="仓库"><FieldInput v-model="form.warehouseId" :field="{ prop: 'warehouseId', label: '仓库', type: 'select', options: ALL_WAREHOUSE_SOURCE }" /></el-form-item>
        <el-form-item label="商品"><FieldInput v-model="form.productId" :field="{ prop: 'productId', label: '商品', type: 'select', options: PRODUCT_SOURCE }" /></el-form-item>
        <el-form-item label="数量"><el-input-number v-model="form.reqQty" :min="1" /></el-form-item>
        <el-form-item label="原因"><el-input v-model="form.reason" /></el-form-item>
      </el-form>
      <el-form v-else-if="mode === 'decide'" label-width="90px">
        <el-form-item label="来源"><el-select v-model="form.decidedSource"><el-option label="内部调拨" value="TRANSFER" /><el-option label="中国采购" value="PURCHASE" /></el-select></el-form-item>
        <el-form-item label="说明"><el-input v-model="form.note" /></el-form-item>
      </el-form>
      <el-form v-else label-width="90px">
        <el-form-item label="单据类型"><el-select v-model="form.execDocType" disabled><el-option label="调拨单" value="INV_TRANSFER" /><el-option label="采购单" value="PUR_ORDER" /></el-select></el-form-item>
        <el-form-item label="执行单"><el-select v-model="form.execDocId" filterable style="width:100%"><el-option v-for="doc in executionDocs" :key="doc.id" :value="doc.id" :label="doc.docNo" /></el-select></el-form-item>
      </el-form>
      <template #footer><el-button type="primary" @click="submit">确定</el-button></template>
    </el-dialog>
  </el-card>
</template>

<style scoped>
.row { display: flex; justify-content: space-between; }
</style>
