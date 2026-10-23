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
  <div class="page voucher-monitor">
    <section class="page-card" aria-labelledby="voucher-monitor-title">
      <div class="page-title">
        <h2 id="voucher-monitor-title">凭证生成监控</h2>
      </div>
      <p class="muted event-note">应收已形成与凭证审核、记账分别显示。同一事件生成一次；修复来源或映射后可重试。列表读取不会补建事件。</p>
      <div class="toolbar event-toolbar">
        <div class="event-filter event-filter--book">
          <span>账套</span>
          <el-select v-model="bookId" placeholder="请选择账套" aria-label="账套" @change="load">
            <el-option v-for="b in books" :key="b.id" :value="b.id" :label="b.name" />
          </el-select>
        </div>
        <div class="event-filter event-filter--status">
          <span>状态</span>
          <el-select v-model="status" clearable placeholder="全部状态" aria-label="状态" @change="load">
            <el-option value="PENDING" label="待生成" />
            <el-option value="FAILED" label="生成失败" />
            <el-option value="GENERATED" label="已生成" />
            <el-option value="NO_VOUCHER" label="无会计影响" />
          </el-select>
        </div>
        <el-button @click="load">刷新</el-button>
        <el-button v-if="selectedEventId" @click="selectedEventId = undefined; load()">显示全部事件</el-button>
        <span v-if="selectedEventId" class="muted">来源事件 #{{ selectedEventId }}</span>
      </div>
      <el-table class="event-table" :data="rows" size="small" border stripe row-key="id">
        <el-table-column label="账套" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ books.find(b => b.id === row.bookId)?.name }}</template>
        </el-table-column>
        <el-table-column prop="eventType" label="事件" min-width="210" show-overflow-tooltip />
        <el-table-column label="来源" min-width="210" show-overflow-tooltip>
          <template #default="{ row }">
            <router-link v-if="sourcePath(row)" :to="sourcePath(row)!" class="event-link mono">{{ row.sourceNo }}</router-link>
            <span v-else class="mono">{{ row.sourceNo }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="eventSeq" label="序号" width="56" align="center" />
        <el-table-column prop="bizDate" label="日期" width="108" />
        <el-table-column label="状态" width="104">
          <template #default="{ row }">
            <el-tag v-if="row.status === 'NO_VOUCHER'" type="info" size="small" disable-transitions>无会计影响</el-tag>
            <StatusTag v-else :status="row.status" />
          </template>
        </el-table-column>
        <el-table-column label="凭证" min-width="190" show-overflow-tooltip>
          <template #default="{ row }">
            <router-link v-if="row.voucherId" :to="{ path: '/finance/vouchers', query: { voucherId: row.voucherId, bookId: row.bookId } }" class="event-link mono">{{ row.voucherNo }}</router-link>
          </template>
        </el-table-column>
        <el-table-column prop="voucherStatus" label="凭证状态" width="100" show-overflow-tooltip />
        <el-table-column prop="failReason" label="失败诊断" min-width="160" show-overflow-tooltip />
        <el-table-column label="无会计影响依据" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{ row.status === 'NO_VOUCHER' ? (row.reason === 'SOURCE_CONFIRMATION_ZERO_POSTING' ? '来源已确认且本次记账金额为零，未重复生成凭证。' : row.reason) : '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="80" fixed="right" align="center">
          <template #default="{ row }">
            <el-button v-if="['PENDING','FAILED'].includes(row.status)" link type="primary" @click="gen(row)">{{ row.status === 'FAILED' ? '重试' : '生成' }}</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>
<style scoped>
.voucher-monitor {
  min-width: 0;
}

.event-note {
  margin: 0 0 12px;
  line-height: 20px;
}

.event-toolbar {
  align-items: center;
}

.event-toolbar > .el-button {
  margin-left: 0;
}

.event-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--el-text-color-regular);
  font-size: 14px;
}

.event-filter > span {
  flex-shrink: 0;
}

.event-filter--book :deep(.el-select) {
  width: 240px;
}

.event-filter--status :deep(.el-select) {
  width: 160px;
}

.event-table {
  /* stripe 复用此变量，仅在本表格中加深隔行底色。 */
  --el-fill-color-lighter: var(--el-fill-color-light);
  --el-table-header-bg-color: var(--el-fill-color-light);
  --el-table-row-hover-bg-color: var(--el-color-primary-light-9);
  font-size: 13px;
}

.event-table :deep(.el-table__cell) {
  height: 32px;
  padding: 4px 0;
}

.event-table :deep(.cell) {
  padding: 0 8px;
  line-height: 22px;
}

.event-table :deep(th.el-table__cell) {
  color: var(--el-text-color-regular);
  font-weight: 600;
}

.event-link {
  color: var(--el-color-primary);
  text-decoration: none;
}

.event-link:hover {
  text-decoration: underline;
}

.event-link:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .event-filter {
    flex: 1 1 100%;
  }

  .event-filter :deep(.el-select) {
    flex: 1;
    width: auto;
    min-width: 0;
  }
}
</style>
