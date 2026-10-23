<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AuditLog } from './AuditTimeline.vue'
import { groupAuditLogs, rawAuditRecord, type AuditDrawerEntry, type AuditPresentation } from './auditPresentation'
import StatusTag from './StatusTag.vue'

const props = defineProps<{ logs: AuditLog[]; timezone: string; presentation?: AuditPresentation; loading: boolean; loadError: string; total: number }>()
defineEmits<{ reload: [] }>()
const groups = computed(() => groupAuditLogs(props.logs, props.timezone, props.presentation))
const opened = ref(new Set<string>())
const expansionKey = (id: number, part: string) => `${id}:${part}`
function snapshotPanels(view: AuditDrawerEntry) {
  return [
    ...(view.previousSnapshot ? [{ key: 'before', label: '操作前单据与商品明细', snapshot: view.previousSnapshot }] : []),
    ...(view.snapshot ? [{ key: 'details', label: view.isCreate ? '单据与商品明细' : '操作后单据与商品明细', snapshot: view.snapshot }] : []),
  ]
}
const expansionKeys = computed(() => groups.value.flatMap(group => group.entries.flatMap(({ log, view }) => [
  expansionKey(log.id, 'raw'), ...snapshotPanels(view).map(panel => expansionKey(log.id, panel.key)),
  ...(view.isCreate && view.changes.length ? [expansionKey(log.id, 'changes')] : []),
])))
const allExpanded = computed(() => expansionKeys.value.length > 0 && expansionKeys.value.every(key => opened.value.has(key)))
function isOpen(id: number, part: string) { return opened.value.has(expansionKey(id, part)) }
function setOpen(id: number, part: string, open: boolean) {
  const next = new Set(opened.value)
  if (open) next.add(expansionKey(id, part)); else next.delete(expansionKey(id, part))
  opened.value = next
}
function onToggle(id: number, part: string, event: Event) { setOpen(id, part, (event.currentTarget as HTMLDetailsElement).open) }
function toggleAll() { opened.value = allExpanded.value ? new Set() : new Set(expansionKeys.value) }
let resourceKey: string | undefined
watch(() => props.logs, logs => {
  const first = logs[0]
  const key = first ? `${first.resourceType}:${first.resourceId}` : undefined
  if (key !== resourceKey) {
    opened.value = new Set()
    const create = groups.value.flatMap(group => group.entries).find(entry => entry.view.isCreate && entry.view.snapshot)
    if (create) opened.value.add(expansionKey(create.log.id, 'details'))
  } else opened.value = new Set([...opened.value].filter(item => expansionKeys.value.includes(item)))
  resourceKey = key
}, { immediate: true })
</script>

<template>
  <div class="audit-records" :aria-busy="loading">
    <div class="audit-log-toolbar">
      <span class="audit-active-label">全部记录<span v-if="!loading && !loadError" class="audit-count">{{ total }}</span></span>
      <div class="audit-log-tools"><span>最新在前</span><el-button link type="primary" :disabled="loading || !!loadError || !logs.length" @click="toggleAll">{{ allExpanded ? '收起全部' : '展开全部' }}</el-button></div>
    </div>
    <div class="audit-scroll-body">
      <p v-if="loading" role="status" class="audit-empty">正在加载操作日志…</p>
      <div v-else-if="loadError" role="alert" class="audit-read-error"><p>操作日志读取失败：{{ loadError }}</p><el-button link type="primary" @click="$emit('reload')">重试</el-button></div>
      <p v-else-if="!logs.length" class="audit-empty">暂无操作日志</p>
      <template v-else>
        <section v-for="group in groups" :key="group.key" class="audit-day">
          <h3 class="audit-date"><el-icon><Calendar /></el-icon>{{ group.label }}</h3>
          <ol class="audit-events">
            <li v-for="entry in group.entries" :key="entry.log.id" class="audit-event">
              <span class="audit-event-icon" :class="entry.view.kind" aria-hidden="true"><el-icon><Paperclip v-if="entry.view.kind === 'attachment'" /><Check v-else-if="entry.view.kind === 'confirm'" /><DocumentAdd v-else-if="entry.view.isCreate" /><EditPen v-else /></el-icon></span>
              <div class="audit-event-heading"><h4>{{ entry.view.title }}</h4><time :datetime="entry.log.occurredAt" :title="entry.fullTime">{{ entry.time }}</time></div>
              <div class="audit-event-byline">{{ entry.log.userName || '操作人未记录' }}</div>
              <p v-if="entry.log.reason" class="audit-event-summary">原因：{{ entry.log.reason }}</p>
              <p v-for="text in entry.view.summary" :key="text" class="audit-event-summary">{{ text }}</p>
              <div v-if="entry.view.attachment" class="audit-file-card">
                <span class="audit-file-icon" aria-hidden="true"><el-icon><Document /></el-icon></span>
                <div class="audit-file-info"><div>{{ entry.view.attachment.fileName }}</div><div class="audit-file-meta"><span v-if="entry.view.attachment.category">{{ entry.view.attachment.category }}</span><span v-if="entry.view.attachment.id">附件编号 {{ entry.view.attachment.id }}</span></div></div>
                <span v-if="entry.view.attachment.version !== undefined" class="audit-file-version">版本 {{ entry.view.attachment.version }}</span>
              </div>
              <component :is="entry.view.isCreate ? 'details' : 'div'" v-if="entry.view.changes.length" class="audit-business-changes" :open="entry.view.isCreate ? isOpen(entry.log.id, 'changes') : undefined" @toggle="onToggle(entry.log.id, 'changes', $event)">
                <summary v-if="entry.view.isCreate" class="audit-detail-toggle"><el-icon><ArrowRight /></el-icon>单据与商品明细</summary>
                <div v-for="(change, index) in entry.view.changes" :key="index" class="audit-change-row">
                  <span class="audit-change-label">{{ change.label }}</span><div class="audit-change-values">
                    <template v-if="!entry.view.isCreate"><StatusTag v-if="change.from.status" :status="change.from.status" /><span v-else>{{ change.from.text }}</span><span class="audit-change-arrow" aria-label="变更为">→</span></template>
                    <StatusTag v-if="change.to.status" :status="change.to.status" /><span v-else>{{ change.to.text }}</span>
                  </div>
                </div>
              </component>
              <details v-for="panel in snapshotPanels(entry.view)" :key="panel.key" class="audit-snapshot-detail" :open="isOpen(entry.log.id, panel.key)" @toggle="onToggle(entry.log.id, panel.key, $event)">
                <summary class="audit-detail-toggle"><el-icon><ArrowRight /></el-icon>{{ panel.label }}</summary>
                <div class="audit-snapshot">
                  <dl v-if="panel.snapshot.fields.length" class="audit-snapshot-fields"><div v-for="field in panel.snapshot.fields" :key="field.label"><dt>{{ field.label }}</dt><dd><StatusTag v-if="field.value.status" :status="field.value.status" /><span v-else>{{ field.value.text }}</span></dd></div></dl>
                  <div v-if="panel.snapshot.columns.length" class="audit-line-scroll"><table class="audit-line-table"><caption>商品明细 · {{ panel.snapshot.rows.length }} 行</caption><thead><tr><th v-for="column in panel.snapshot.columns" :key="column.key" scope="col" :class="{ numeric: column.numeric }">{{ column.label }}</th></tr></thead><tbody><tr v-for="row in panel.snapshot.rows" :key="row.key"><td v-for="(cell, index) in row.cells" :key="index" :class="{ numeric: panel.snapshot.columns[index]?.numeric }">{{ cell.text }}</td></tr></tbody></table></div>
                </div>
              </details>
              <p v-for="note in entry.view.notes" :key="note" class="audit-note">{{ note }}</p>
              <p v-if="!entry.view.isCreate && !entry.view.changes.length && !entry.view.snapshot && !entry.view.attachment && !entry.view.notes.length" class="audit-note">未记录可识别的业务字段变化，可查看原始记录。</p>
              <details class="audit-raw" :open="isOpen(entry.log.id, 'raw')" @toggle="onToggle(entry.log.id, 'raw', $event)"><summary class="audit-detail-toggle"><el-icon><ArrowRight /></el-icon>查看原始记录</summary><pre>{{ rawAuditRecord(entry.log) }}</pre></details>
            </li>
          </ol>
        </section>
      </template>
    </div>
    <footer v-if="!loading && !loadError" class="audit-records-footer"><span v-if="logs.length < total">已显示最近 {{ logs.length }} 条，共 {{ total }} 条</span><span v-else>已显示全部 {{ logs.length }} 条记录</span><span>{{ timezone }}</span></footer>
  </div>
</template>

<style scoped>
.audit-records { display: flex; flex-direction: column; flex: 1; min-height: 0; font-size: 13px; color: var(--audit-ink, var(--el-text-color-primary)); }
.audit-log-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 17px 26px 0; border-bottom: 1px solid var(--audit-line); }
.audit-active-label { display: flex; align-items: center; gap: 7px; align-self: stretch; padding: 0 1px 10px; border-bottom: 2px solid var(--audit-blue); font-weight: 500; }
.audit-count { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; padding: 0 5px; height: 18px; background: var(--el-fill-color-light); border-radius: 4px; font-size: 11px; color: var(--audit-muted); }
.audit-log-tools { display: flex; align-items: center; gap: 14px; padding-bottom: 10px; color: var(--audit-muted); font-size: 12px; }
.audit-log-tools :deep(.el-button) { font-size: 12px; }
.audit-scroll-body { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 19px 26px 24px; }
.audit-day + .audit-day { margin-top: 22px; }
.audit-date { display: flex; align-items: center; gap: 9px; margin: 0 0 18px; color: var(--audit-muted); font-size: 12px; font-weight: 500; }
.audit-events { list-style: none; margin: 0; padding: 0; }
.audit-event { position: relative; padding: 0 0 24px 40px; min-width: 0; }
.audit-event::before { content: ''; position: absolute; top: 30px; bottom: 0; left: 13px; width: 1px; background: var(--audit-line); }
.audit-event:last-child { padding-bottom: 0; }.audit-event:last-child::before { display: none; }
.audit-event-icon { display: grid; place-items: center; position: absolute; left: 0; top: 0; width: 28px; height: 28px; border-radius: 8px; background: var(--audit-blue-soft); color: var(--audit-blue); border: 1px solid var(--audit-line); }
.audit-event-icon.confirm { color: var(--audit-green); background: var(--audit-green-soft); }.audit-event-icon.create { color: var(--audit-muted); background: var(--audit-soft); }
.audit-event-heading { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; min-height: 25px; }
.audit-event-heading h4 { margin: 0; font-size: 14px; font-weight: 600; }.audit-event-heading time { color: var(--audit-muted); font: 12px var(--audit-data-font); }
.audit-event-byline { color: var(--audit-muted); font-size: 12px; margin: 2px 0 12px; overflow-wrap: anywhere; }
.audit-event-summary { color: var(--audit-body); margin: 0 0 10px; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.audit-file-card { display: flex; align-items: center; gap: 11px; padding: 12px; border: 1px solid var(--audit-line); border-radius: 6px; background: var(--audit-soft); }
.audit-file-icon { display: grid; place-items: center; flex-shrink: 0; width: 34px; height: 38px; border-radius: 5px; background: var(--audit-blue-soft); color: var(--audit-blue); }
.audit-file-info { min-width: 0; flex: 1; overflow-wrap: anywhere; }.audit-file-meta { display: flex; flex-wrap: wrap; gap: 0 8px; margin-top: 2px; color: var(--audit-muted); font-size: 11px; }
.audit-file-version { color: var(--audit-muted); font-size: 11px; white-space: nowrap; }
.audit-business-changes { border: 1px solid var(--audit-line); border-radius: 6px; padding: 0 12px; }
.audit-change-row { display: grid; grid-template-columns: minmax(72px, 1fr) minmax(0, 3fr); gap: 10px; padding: 11px 0; font-size: 12px; }.audit-change-row + .audit-change-row { border-top: 1px solid var(--audit-line); }
.audit-change-label { color: var(--audit-muted); overflow-wrap: anywhere; }.audit-change-values { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; overflow-wrap: anywhere; }.audit-change-arrow { color: var(--audit-muted); }
.audit-detail-toggle { display: flex; align-items: center; gap: 5px; width: fit-content; padding: 4px 0; color: var(--audit-blue); font-size: 12px; cursor: pointer; list-style: none; }.audit-detail-toggle::-webkit-details-marker { display: none; }
.audit-detail-toggle > .el-icon { transition: transform .15s ease; }details[open] > .audit-detail-toggle > .el-icon { transform: rotate(90deg); }
.audit-snapshot-detail { margin-top: 6px; }.audit-snapshot { margin-top: 6px; border: 1px solid var(--audit-line); border-radius: 6px; overflow: hidden; }
.audit-snapshot-fields { margin: 0; padding: 12px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 18px; }.audit-snapshot-fields dt { margin-bottom: 3px; font-size: 11px; color: var(--audit-muted); }.audit-snapshot-fields dd { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.audit-line-scroll { overflow-x: auto; }.audit-line-table { width: 100%; border-collapse: collapse; font-size: 12px; }.audit-line-table caption { text-align: left; padding: 9px 12px; border-top: 1px solid var(--audit-line); color: var(--audit-body); }
.audit-line-table th { padding: 7px 10px; background: var(--audit-soft); color: var(--audit-muted); font-weight: 400; font-size: 11px; white-space: nowrap; }.audit-line-table td { padding: 9px 10px; border-top: 1px solid var(--audit-line); overflow-wrap: anywhere; min-width: 50px; }.audit-line-table th,.audit-line-table td { text-align: left; }.audit-line-table .numeric { text-align: right; font-variant-numeric: tabular-nums; }.audit-line-table th:first-child,.audit-line-table td:first-child { padding-left: 12px; min-width: 100px; }
.audit-note { margin: 7px 0 0; color: var(--audit-muted); font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
.audit-raw { margin-top: 7px; }.audit-raw > summary { color: var(--audit-muted); font-size: 11px; }.audit-raw pre { padding: 11px 12px; margin: 5px 0 0; background: var(--audit-soft); border-radius: 5px; color: var(--audit-body); font: 11px/1.7 var(--audit-data-font); white-space: pre-wrap; overflow-wrap: anywhere; }
.audit-records-footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; padding: 12px 26px; border-top: 1px solid var(--audit-line); color: var(--audit-muted); font-size: 11px; }
.audit-empty { color: var(--audit-muted); }.audit-read-error { color: var(--el-color-danger); overflow-wrap: anywhere; }
.audit-detail-toggle:focus-visible { outline: 2px solid var(--audit-blue); outline-offset: 3px; }
@media (max-width: 680px) { .audit-log-toolbar { margin-left: 19px; margin-right: 19px; }.audit-scroll-body { padding-left: 19px; padding-right: 19px; }.audit-records-footer { padding-left: 19px; padding-right: 19px; }.audit-log-tools > span { display: none; } }
@media (max-width: 380px) { .audit-log-toolbar { margin-left: 14px; margin-right: 14px; }.audit-scroll-body { padding-left: 14px; padding-right: 14px; }.audit-records-footer { padding-left: 14px; padding-right: 14px; }.audit-event { padding-left: 36px; }.audit-change-row { grid-template-columns: 1fr; gap: 6px; }.audit-snapshot-fields { gap: 10px; }.audit-file-card { gap: 8px; padding: 9px; }.audit-file-version { white-space: normal; overflow-wrap: anywhere; } }
@media (pointer: coarse) { .audit-detail-toggle { min-height: 40px; } }
@media (prefers-reduced-motion: reduce) { .audit-detail-toggle > .el-icon { transition: none; } }
</style>
