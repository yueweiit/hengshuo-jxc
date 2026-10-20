<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, CrudPageExpose } from '@/components/crud/types'
import DateTimeText from '@/components/DateTimeText.vue'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const page = ref<CrudPageExpose>()
const columns: ColumnDef[] = [
  { prop: 'outboundNo', label: '出库单', width: 180 },
  { prop: 'orderNo', label: '订单', width: 180 },
  { prop: 'signerName', label: '签收人', width: 140 },
  { prop: 'signedAt', label: '签收时间', type: 'datetime', minWidth: 170 },
  { prop: 'diffQty', label: '差异数量', type: 'qty', width: 100 },
]
async function resolve(row: Row) {
  const line = (row.lines ?? []).find((l: Row) => l.diffQty > 0 && l.diffStatus !== 'RESOLVED')
  if (!line) return ElMessage.info('没有待处理差异')
  const { value } = await ElMessageBox.prompt('处理方式：补发、退款或记索赔', '处理签收差异', { inputValue: '补发' })
  await http.postIdem(`/sal/sign-diffs/${line.outboundLineId}/resolve`, { resolution: value }, supplyCommandIntent)
  ElMessage.success('已记录处理方式')
  page.value?.reload()
}
</script>

<template>
  <CrudPage ref="page" title="签收登记" resource="/sal/signs" :columns="columns" :can-create="false" :can-toggle="false" :actions-width="120">
    <template #header><p class="muted">签收不改变应收发生时点。实收少于出库时记为短少，需要单独处理。</p></template>
    <template #col-signedAt="{ row }"><DateTimeText :value="row.signedAt" /></template>
    <template #row-actions="{ row }">
      <el-button v-if="row.diffQty > 0" link type="primary" @click="resolve(row)">处理差异</el-button>
    </template>
  </CrudPage>
</template>
