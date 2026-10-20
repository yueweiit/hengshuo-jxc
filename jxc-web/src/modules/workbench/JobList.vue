<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import StatusTag from '@/components/StatusTag.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import { useUserStore } from '@/stores/user'

const user = useUserStore(), worker = ref<Record<string, any> | null>(null)
const rows = ref<Record<string, any>[]>([])
const file = ref<Record<string, any> | null>(null)
async function load() { file.value = null; rows.value = (await allRecords<Record<string, any>>('/sys/jobs', { })); if (user.hasPerm('sys:worker:view')) worker.value = await http.get('/sys/jobs/worker-status') }
const retryIntent = createCommandIntent()
async function retry(row: Record<string, any>) { await http.postIdem('/sys/jobs/' + row.id + '/retry', {}, retryIntent); retryIntent.reset(); await load() }
async function download(row: Record<string, any>) {
  file.value = null
  const result = await http.get<Record<string, any>>('/sys/jobs/' + row.id + '/download')
  file.value = result
  const url = URL.createObjectURL(new Blob([result.content], { type: result.contentType || 'text/csv; charset=UTF-8' }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
onMounted(load)
</script>

<template>
  <el-card>
    <template #header>
      <div class="row"><span>导出任务</span><el-button @click="load">刷新任务</el-button></div>
    </template>
    <p class="muted">导出使用和列表相同的国家与权限。请从已选择账套、期间的业务页面发起导出；下载时会重新核验当前权限。</p>
    <template v-if="worker"><p>后台任务：{{ worker.enabled ? '已启用' : '未启用' }} · 恢复间隔 {{ worker.delayMs / 1000 }} 秒 · 每批 {{ worker.recoveryLimit }}</p><el-alert v-for="(alert, index) in worker.alerts" :key="index" :type="alert.severity === 'ERROR' ? 'error' : 'warning'" :title="alert.code + ' · ' + (alert.kind || alert.consumer || '') + ' ' + (alert.lastError || alert.message || '')" :closable="false" show-icon /><el-collapse><el-collapse-item title="后台任务运行状态"><el-table :data="worker.runs" size="small"><el-table-column prop="kind" label="任务" /><el-table-column prop="status" label="状态" /><el-table-column label="最近开始"><template #default="{ row }"><DateTimeText :value="row.lastStartedAt" /></template></el-table-column><el-table-column label="最近完成"><template #default="{ row }"><DateTimeText :value="row.lastCompletedAt" /></template></el-table-column><el-table-column prop="lastError" label="诊断代码" /></el-table></el-collapse-item></el-collapse></template>
    <el-table :data="rows" size="small">
      <el-table-column prop="jobType" label="类型" width="100" />
      <el-table-column label="发起时间"><template #default="{ row }"><DateTimeText :value="row.createdAt" /></template></el-table-column>
      <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
      <el-table-column label="处理提示"><template #default="{ row }"><span v-if="row.lastError === 'JOB_CONTEXT_CHANGED'">会计期间或结账代次已变化，请返回业务页面重新发起导出。</span><span v-else>{{ row.lastError }}</span></template></el-table-column>
      <el-table-column width="130"><template #default="{ row }"><el-button v-if="['SUCCESS', 'COMPLETED', 'SUCCEEDED'].includes(row.status)" link type="primary" @click="download(row)">下载</el-button><el-button v-if="['QUEUED', 'FAILED'].includes(row.status) && row.lastError !== 'JOB_CONTEXT_CHANGED'" link type="primary" @click="retry(row)">重试</el-button></template></el-table-column>
    </el-table>
    <pre v-if="file">{{ file.filename }}{{ '\n' }}{{ file.content }}</pre>
  </el-card>
</template>

<style scoped>
.row { display: flex; justify-content: space-between; }
</style>
