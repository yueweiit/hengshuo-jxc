<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { http } from '@/api/http'
import { allRecords } from '@/api/pagination'
import StatusTag from '@/components/StatusTag.vue'

const router = useRouter()
const rows = ref<Record<string, any>[]>([])
const orders = ref<Record<string, any>[]>([])
const current = ref<Record<string, any> | null>(null)
const open = ref(false)

async function load() {
  rows.value = await allRecords<Record<string, any>>('/inv/classify-results')
}

async function show(row: Record<string, any>) {
  current.value = row
  orders.value = await http.get('/inv/classify-results/' + row.id + '/orders')
  open.value = true
}

onMounted(load)
</script>

<template>
  <el-card>
    <template #header>库存与订单联合分析</template>
    <p class="muted">分类取自当前国家的已生效联合规则与周期。库存为 0 且没有订单不会自动变成畅销。件数和订单张数分开显示。</p>
    <el-table :data="rows" size="small" @row-click="show">
      <template #empty><el-empty description="待判断：尚无已生效规则或计算结果，请检查当前国家规则及统计周期" /></template>
      <el-table-column prop="dimName" label="仓店" width="150" />
      <el-table-column prop="productCode" label="商品" width="100" />
      <el-table-column prop="productName" label="名称" min-width="140" />
      <el-table-column prop="availableQty" label="可售" width="80" />
      <el-table-column prop="onHandQty" label="实物" width="80" />
      <el-table-column prop="inTransitQty" label="在途" width="80" />
      <el-table-column prop="returnedQty" label="已退货" width="80" />
      <el-table-column prop="ruleVersionNo" label="规则版本" width="90" />
      <el-table-column prop="orderQty" label="有效订购件数" width="120" />
      <el-table-column prop="orderCount" label="订单张数" width="90" />
      <el-table-column prop="outboundQty" label="已出库" width="80" />
      <el-table-column prop="unassignedQty" label="未分仓" width="80" />
      <el-table-column label="分类" width="110"><template #default="{ row }"><StatusTag :status="row.label" /></template></el-table-column>
      <el-table-column prop="hitText" label="命中依据" min-width="180" />
      <el-table-column label="" width="80"><template #default="{ row }"><el-button link type="primary" @click.stop="show(row)">订单</el-button></template></el-table-column>
    </el-table>
    <el-drawer v-model="open" title="计入的有效订单" size="480px">
      <p v-if="current">{{ current.productCode }} · 规则版本 {{ current.ruleVersionNo }} · {{ current.periodStart }} 至 {{ current.periodEnd }}</p>
      <el-table :data="orders" size="small">
        <el-table-column prop="docNo" label="订单" />
        <el-table-column prop="customerName" label="客户" />
        <el-table-column prop="qty" label="有效件数" width="90" />
        <el-table-column prop="outboundQty" label="已出库" width="80" />
        <el-table-column width="70"><template #default="{ row }"><el-button link type="primary" @click="router.push('/sales/orders/' + row.id)">打开</el-button></template></el-table-column>
      </el-table>
    </el-drawer>
  </el-card>
</template>
