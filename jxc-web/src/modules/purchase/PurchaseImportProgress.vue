<script setup lang="ts">
import { computed } from 'vue'
import type { PurchaseImportModel } from './purchaseImportModel'
import { importProgressView } from './purchaseImportProgress'
const props = defineProps<{ page: PurchaseImportModel }>()
const display = computed(() => importProgressView(props.page.state))
const steps = computed(() => ['上传文件', '读取文件', '解析明细', '校验与照片', '保存明细', ...(props.page.state.imageReviewEnabled ? ['AI图文核对', '待人工确认'] : ['暂存完成'])])
</script>
<template>
  <section v-if="display" class="import-progress" role="status" aria-live="polite" :aria-label="`导入进度：${display.title}`">
    <div class="progress-heading"><strong>{{ display.title }}</strong><span>{{ display.fileName }}</span></div>
    <ol class="progress-steps"><li v-for="(step, index) in steps" :key="step" :class="{ active: display.step === index, done: display.step > index }">{{ step }}</li></ol>
    <!-- 未知总量时条宽只承载等待动画，不向用户或辅助技术声称完成百分比。 -->
    <el-progress :percentage="display.percentage ?? 100" :aria-valuenow="display.percentage ?? undefined" :indeterminate="display.percentage === null && !display.failed" :show-text="display.percentage !== null" :status="display.failed ? 'exception' : display.complete ? 'success' : undefined" :aria-label="page.state.upload ? '文件上传进度' : '当前步骤进度'" />
    <p v-if="display.percentage === null && !display.failed">处理中，进度待统计</p>
    <div class="progress-counts"><span>{{ page.state.upload ? '文件传输进度' : '当前步骤进度' }}</span><span>{{ display.rows }}<template v-if="display.images"> · {{ display.images }}</template></span></div>
    <p :class="{ 'progress-error': display.failed }">{{ display.message }}</p>
    <div v-if="page.state.progressError" class="progress-error">进度查询中断：{{ page.state.progressError }}。将继续重连。<el-button link type="primary" :disabled="page.state.progressReading" @click="page.refreshTasks()">重新查询</el-button></div>
  </section>
</template>
<style scoped>
.import-progress { border: 1px solid var(--el-border-color-light); border-radius: 4px; padding: 14px; margin: 12px 0; background: var(--el-fill-color-lighter); font-size: 13px; }
.progress-heading, .progress-counts { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 16px; }
.progress-heading span, .progress-counts, p { color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
.progress-steps { display: flex; flex-wrap: wrap; padding: 0; list-style: none; gap: 8px 16px; color: var(--el-text-color-secondary); font-size: 12px; }
.progress-steps .active { color: var(--el-color-primary); font-weight: 600; }
.progress-steps .done { color: var(--el-color-success); }
.progress-counts { margin-top: 7px; font-size: 12px; }
p { margin: 8px 0 0; line-height: 1.6; }
.progress-error { color: var(--el-color-danger); line-height: 1.6; }
@media (prefers-reduced-motion: reduce) { :deep(.el-progress-bar__inner) { transition: none; animation: none; } }
</style>
