<script setup lang="ts">
import { useCountryStore } from '@/stores/country'
import AuditTimeline from './AuditTimeline.vue'
import AuditDrawerRecords from './AuditDrawerRecords.vue'
import StatusTag from './StatusTag.vue'
import type { AuditDocumentContext, AuditPresentation } from './auditPresentation'

defineProps<{ modelValue: boolean; resourceType: string; resourceId: number | string; context: AuditDocumentContext; presentation?: AuditPresentation }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const country = useCountryStore()
</script>

<template>
  <el-drawer :model-value="modelValue" title="操作日志" aria-label="操作日志" :with-header="false" size="min(640px, 100vw)" destroy-on-close append-to-body class="operation-audit-drawer" modal-class="operation-audit-overlay" @update:model-value="emit('update:modelValue', $event)">
    <AuditTimeline :resource-type="resourceType" :resource-id="resourceId" class="audit-drawer-layout">
      <template #layout="state">
        <header class="audit-drawer-header">
          <div class="audit-drawer-heading"><h2><el-icon><Clock /></el-icon>操作日志</h2><div class="audit-header-actions"><el-button link type="primary" :disabled="state.loading" @click="state.reload"><el-icon><Refresh /></el-icon>刷新</el-button><el-button text class="audit-close" aria-label="关闭操作日志" @click="emit('update:modelValue', false)"><el-icon><Close /></el-icon></el-button></div></div>
          <div class="audit-document-context"><div class="audit-document-identity"><div class="audit-document-label">{{ context.title }}</div><div class="audit-document-number">{{ context.identifier }}</div></div><StatusTag v-if="context.status" :status="context.status" /></div>
        </header>
        <AuditDrawerRecords :logs="state.logs" :loading="state.loading" :load-error="state.loadError" :total="state.total" :timezone="country.timezone" :presentation="presentation" @reload="state.reload" />
      </template>
    </AuditTimeline>
  </el-drawer>
</template>

<style scoped>
:global(.operation-audit-drawer) {
  --audit-ink: #273343; --audit-body: #515f71; --audit-muted: #738093; --audit-line: #e8edf3;
  --audit-soft: #f6f8fb; --audit-blue: #2878e8; --audit-blue-soft: #edf4ff; --audit-green: #24784d; --audit-green-soft: #edf8f1;
  --audit-data-font: 'Cascadia Code', Consolas, 'Microsoft YaHei', monospace;
  --el-color-primary: var(--audit-blue);
  background: var(--el-bg-color); box-shadow: -12px 0 38px rgba(12, 28, 49, .13);
}
:global(.operation-audit-drawer .el-drawer__body) { display: flex; flex-direction: column; padding: 0; min-height: 0; overflow: hidden; }
.audit-drawer-layout { display: flex; flex-direction: column; flex: 1; min-height: 0; color: var(--audit-ink); line-height: 1.6; }
.audit-drawer-header { flex-shrink: 0; padding: 22px 26px 0; }.audit-drawer-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.audit-drawer-heading h2 { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 18px; font-weight: 600; }.audit-drawer-heading h2 > .el-icon { color: var(--audit-blue); font-size: 20px; }
.audit-header-actions { display: flex; align-items: center; gap: 10px; }.audit-header-actions .el-button { margin-left: 0; font-size: 12px; }.audit-header-actions .el-icon { margin-right: 4px; }.audit-header-actions .audit-close { padding: 6px; }.audit-close .el-icon { margin: 0; font-size: 18px; }
.audit-document-context { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 20px; padding: 12px 14px; background: var(--audit-soft); border: 1px solid var(--audit-line); border-radius: 6px; }
.audit-document-identity { min-width: 0; }.audit-document-label { margin-bottom: 3px; color: var(--audit-muted); font-size: 12px; }.audit-document-number { font: 14px/1.6 var(--audit-data-font); overflow-wrap: anywhere; }
.audit-header-actions :deep(.el-button:focus-visible) { outline: 2px solid var(--audit-blue); outline-offset: 3px; }
:global(.operation-audit-overlay) { background-color: rgba(17, 29, 45, .36); }
@media (max-width: 680px) { .audit-drawer-header { padding: 19px 19px 0; }.audit-document-context { margin-top: 15px; }.audit-document-number { font-size: 13px; } }
@media (max-width: 380px) { .audit-drawer-header { padding-left: 14px; padding-right: 14px; }.audit-document-context { padding: 10px; align-items: flex-start; }.audit-document-number { font-size: 12px; } }
@media (pointer: coarse) { .audit-header-actions .audit-close { min-width: 44px; min-height: 44px; } }
</style>
