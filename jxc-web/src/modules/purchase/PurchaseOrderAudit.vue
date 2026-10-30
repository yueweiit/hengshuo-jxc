<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { http } from '@/api/http'
import AuditDrawer from '@/components/AuditDrawer.vue'
import type { AuditLog } from '@/components/AuditTimeline.vue'
import { auditDocumentContext, type AuditDocumentContext } from '@/components/auditPresentation'
import { purchaseOrderDrawerPresentation } from './purchaseOrderAudit'
const props = defineProps<{ modelValue: boolean; resourceId: number | string; order?: Record<string, unknown>; context?: AuditDocumentContext }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const audit = ref<InstanceType<typeof AuditDrawer>>()
const reference = ref<Record<string, unknown>>()
const referenceError = ref('')
const current = computed(() => props.order ?? reference.value)
const context = computed(() => props.context ?? auditDocumentContext({ ...current.value, id: Number(props.resourceId) }, '采购单'))
const presentation = (log: AuditLog) => purchaseOrderDrawerPresentation(log, current.value)
let sequence = 0
async function loadReference() {
  const request = ++sequence
  reference.value = undefined
  referenceError.value = ''
  if (!props.modelValue || props.order !== undefined) return
  try {
    const result = await http.get<{ order: Record<string, unknown> }>(`/pur/orders/${props.resourceId}/progress`, undefined, { silent: true })
    if (request !== sequence) return
    if (!result || !result.order || typeof result.order !== 'object' || Array.isArray(result.order)) throw new Error('当前商品资料返回格式不正确')
    reference.value = result.order
  } catch (error) {
    if (request === sequence) referenceError.value = feedbackMessage(error, '当前商品资料读取失败')
  }
}
watch(() => [props.resourceId, props.order, props.modelValue], loadReference, { immediate: true })
onBeforeUnmount(() => { sequence++ })
function reload() { audit.value?.reload() }
defineExpose({ reload })
</script>

<template>
  <AuditDrawer v-if="modelValue" ref="audit" :model-value="modelValue" resource-type="purchase-order" :resource-id="resourceId" :context="context" :presentation="presentation" @update:model-value="emit('update:modelValue', $event)" @reload="loadReference">
    <template #notice><div v-if="referenceError" role="alert" class="audit-reference-error">当前名称参考读取失败：操作未完成，请查看全局提示。；历史日志仍按已记录内容展示。<el-button link type="primary" @click="loadReference">重试资料</el-button></div></template>
  </AuditDrawer>
</template>

<style scoped>
.audit-reference-error { margin: 12px 26px 0; color: var(--el-color-danger); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
@media (max-width: 680px) { .audit-reference-error { margin-left: 19px; margin-right: 19px; } }
@media (max-width: 380px) { .audit-reference-error { margin-left: 14px; margin-right: 14px; } }
</style>
