<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { http } from '@/api/http'
import AuditTimeline from '@/components/AuditTimeline.vue'
import PurchaseOrderAuditRecords from './PurchaseOrderAuditRecords.vue'
const props = defineProps<{ resourceId: number | string; order?: Record<string, unknown> }>()
const audit = ref<InstanceType<typeof AuditTimeline>>()
const reference = ref<Record<string, unknown>>()
const referenceError = ref('')
const current = computed(() => props.order ?? reference.value)
let sequence = 0
async function loadReference() {
  const request = ++sequence
  reference.value = undefined
  referenceError.value = ''
  if (props.order !== undefined) return
  try {
    const result = await http.get<{ order: Record<string, unknown> }>(`/pur/orders/${props.resourceId}/progress`, undefined, { silent: true })
    if (request !== sequence) return
    if (!result || !result.order || typeof result.order !== 'object' || Array.isArray(result.order)) throw new Error('当前商品资料返回格式不正确')
    reference.value = result.order
  } catch (error) {
    if (request === sequence) referenceError.value = error instanceof Error ? error.message : '当前商品资料读取失败'
  }
}
watch(() => [props.resourceId, props.order], loadReference, { immediate: true })
onBeforeUnmount(() => { sequence++ })
function reload() { audit.value?.reload(); loadReference() }
defineExpose({ reload })
</script>

<template>
  <div class="purchase-order-audit">
    <div v-if="referenceError" role="alert" class="audit-reference-error">当前名称参考读取失败：{{ referenceError }}；历史日志仍按已记录内容展示。<el-button link type="primary" @click="loadReference">重试资料</el-button></div>
    <AuditTimeline ref="audit" resource-type="purchase-order" :resource-id="resourceId">
      <template #default="{ logs }"><PurchaseOrderAuditRecords :logs="logs" :current="current" :resource-id="resourceId" /></template>
    </AuditTimeline>
  </div>
</template>

<style scoped>
.purchase-order-audit { container-type: inline-size; min-width: 0; }
.audit-reference-error { padding: 8px 0; color: var(--el-color-danger); font-size: 12px; }
</style>
