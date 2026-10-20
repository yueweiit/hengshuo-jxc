<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import StatusTag from '@/components/StatusTag.vue'
import { financeSourcePath as sourcePath } from '@/utils/finance-source'
type Row = Record<string, any>
const route = useRoute()
const selectedEventId = ref(route.query.eventId ? Number(route.query.eventId) : undefined)
const actionIntent = createCommandIntent()
const rows = ref<Row[]>([]), books = ref<Row[]>([]), bookId = ref<number>(), status = ref('')
async function load() { rows.value = (await allRecords<Row>('/fin/events', { bookId: bookId.value, status: status.value, eventId: selectedEventId.value })) }
async function gen(row: Row) {
  const res = await http.postIdem<Row>('/fin/events/' + row.id + '/generate', { bookId: bookId.value }, actionIntent)
  ElMessage.success(res.status === 'NO_VOUCHER' ? '已保存复核后的无会计影响解释' : res.duplicate ? '这张事件已经有凭证' : '已生成待审凭证 ' + res.voucherNo)
  await load()
}
onMounted(async () => { books.value = await http.get<Row[]>('/fin/books'); bookId.value = route.query.bookId ? Number(route.query.bookId) : (books.value.filter(b => b.status === 'ACTIVE').length === 1 ? books.value.find(b => b.status === 'ACTIVE')!.id : undefined); await load() })
</script>
<template>
  <el-card>
    <template #header>业务事件</template>
    <p class="muted">应收已形成与凭证审核、记账分别显示。同一事件生成一次；修复来源或映射后可重试。列表读取不会补建事件。</p>
    <div class="toolbar"><el-select v-model="bookId" placeholder="账套" @change="load"><el-option v-for="b in books" :key="b.id" :value="b.id" :label="b.name" /></el-select><el-select v-model="status" clearable placeholder="全部状态" @change="load"><el-option value="PENDING" label="待生成" /><el-option value="FAILED" label="生成失败" /><el-option value="GENERATED" label="已生成" /><el-option value="NO_VOUCHER" label="无会计影响" /></el-select><el-button @click="load">刷新</el-button><el-button v-if="selectedEventId" @click="selectedEventId = undefined; load()">显示全部事件</el-button><span v-if="selectedEventId">来源事件 #{{ selectedEventId }}</span></div>
    <el-table :data="rows" size="small">
      <el-table-column label="账套" width="130"><template #default="{ row }">{{ books.find(b => b.id === row.bookId)?.name }}</template></el-table-column>
      <el-table-column prop="eventType" label="事件" min-width="210" />
      <el-table-column label="来源" min-width="170"><template #default="{ row }"><router-link v-if="sourcePath(row)" :to="sourcePath(row)!">{{ row.sourceNo }}</router-link><span v-else>{{ row.sourceNo }}</span></template></el-table-column>
      <el-table-column prop="eventSeq" label="序号" width="65" />
      <el-table-column prop="bizDate" label="日期" width="110" />
      <el-table-column label="状态" width="115"><template #default="{ row }"><el-tag v-if="row.status === 'NO_VOUCHER'" type="info">无会计影响</el-tag><StatusTag v-else :status="row.status" /></template></el-table-column>
      <el-table-column label="凭证" min-width="170"><template #default="{ row }"><router-link v-if="row.voucherId" :to="{ path: '/finance/vouchers', query: { voucherId: row.voucherId, bookId: row.bookId } }">{{ row.voucherNo }}</router-link></template></el-table-column>
      <el-table-column prop="voucherStatus" label="凭证状态" width="120" />
      <el-table-column prop="failReason" label="失败诊断" min-width="160" />
      <el-table-column label="无会计影响依据" min-width="180"><template #default="{ row }">{{ row.status === 'NO_VOUCHER' ? (row.reason === 'SOURCE_CONFIRMATION_ZERO_POSTING' ? '来源已确认且本次记账金额为零，未重复生成凭证。' : row.reason) : '—' }}</template></el-table-column>
      <el-table-column width="80"><template #default="{ row }"><el-button v-if="['PENDING','FAILED'].includes(row.status)" link type="primary" @click="gen(row)">{{ row.status === 'FAILED' ? '重试' : '生成' }}</el-button></template></el-table-column>
    </el-table>
  </el-card>
</template>
<style scoped>.toolbar { display: flex; gap: 12px; margin: 12px 0; }</style>
