<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { Close } from '@element-plus/icons-vue'
import type { AuditLog } from '@/components/AuditTimeline.vue'
import { useCountryStore } from '@/stores/country'
import StatusTag from '@/components/StatusTag.vue'
import PurchaseOrderAuditSnapshot from './PurchaseOrderAuditSnapshot.vue'
import { formatAuditTime, purchaseOrderAudit } from './purchaseOrderAudit'
const props = defineProps<{ logs: AuditLog[]; current?: Record<string, unknown>; resourceId: number | string }>()
const entries = computed(() => props.logs.map(log => ({ log, view: purchaseOrderAudit(log, props.current) })))
const selectedId = ref<number>()
const contentId = useId()
const country = useCountryStore()
watch(() => props.resourceId, () => { selectedId.value = undefined })
watch(() => props.logs, logs => {
  if (selectedId.value !== undefined && !logs.some(log => log.id === selectedId.value)) selectedId.value = undefined
})
const active = computed(() => entries.value.find(e => e.log.id === selectedId.value))
function select(id: number) { selectedId.value = selectedId.value === id ? undefined : id }
function close() { selectedId.value = undefined }
</script>

<template>
  <div v-if="entries.length" class="purchase-audit-workspace" :class="{ 'is-open': active }">
    <aside class="purchase-audit-directory" aria-label="操作日志时间轴">
      <header><b>操作日志</b><span>最新在前</span></header>
      <el-timeline class="purchase-audit-timeline" aria-label="选择一条操作日志">
        <el-timeline-item v-for="entry in entries" :key="entry.log.id" :type="active?.log.id === entry.log.id ? 'primary' : 'info'" :hollow="active?.log.id !== entry.log.id" @click="select(entry.log.id)">
          <button class="audit-timeline-entry" type="button" :aria-expanded="active?.log.id === entry.log.id" :aria-controls="active?.log.id === entry.log.id ? contentId : undefined" @click.stop="select(entry.log.id)">
            <b>{{ entry.view.title }}</b>
            <span class="audit-choice-description">{{ entry.view.isCreate ? `创建单据 · ${entry.view.snapshot?.lines?.length ?? '未记录'} 行商品` : entry.view.summary[0] || '查看本次记录' }}</span>
            <small>{{ entry.log.userName }}</small><time :datetime="entry.log.occurredAt" :title="entry.log.occurredAt">{{ formatAuditTime(entry.log.occurredAt, country.timezone) }}</time>
          </button>
        </el-timeline-item>
      </el-timeline>
    </aside>
    <article v-if="active" :id="contentId" :key="active.log.id" class="purchase-audit-content" aria-label="选中的操作记录">
      <header class="audit-event-header"><div><h3>{{ active.view.title }} <StatusTag v-if="active.view.status" :status="active.view.status" /></h3><p>{{ active.log.userName }} <span>·</span> <time :datetime="active.log.occurredAt" :title="active.log.occurredAt">{{ formatAuditTime(active.log.occurredAt, country.timezone) }}</time></p></div><div class="audit-detail-controls"><span class="audit-record-number">记录 #{{ active.log.id }}</span><el-tooltip content="收起明细" placement="top"><button type="button" class="audit-close" aria-label="收起明细" @click="close"><el-icon><Close /></el-icon></button></el-tooltip></div></header>
      <div class="audit-event-body">
        <p v-if="active.log.reason" class="audit-reason">原因：{{ active.log.reason }}</p>
        <template v-if="active.view.isCreate">
          <p class="audit-snapshot-intro">以下为创建时的单据与商品明细</p>
          <PurchaseOrderAuditSnapshot v-if="active.view.snapshot" :snapshot="active.view.snapshot" />
        </template>
        <template v-else>
          <template v-if="active.view.changes.length">
            <h4>本次变更 <span>{{ active.view.changes.length }} 项</span></h4>
            <div class="audit-compare-scroll" tabindex="0" role="region" aria-label="本次业务变更，可左右滚动">
              <table class="audit-compare"><thead><tr><th scope="col">变更项目</th><th scope="col">操作前</th><th scope="col">操作后</th></tr></thead>
                <tbody><tr v-for="(change, index) in active.view.changes" :key="index"><th scope="row">{{ change.label }}</th><td><StatusTag v-if="change.from.status" :status="change.from.status" /><span v-else>{{ change.from.text }}</span></td><td><StatusTag v-if="change.to.status" :status="change.to.status" /><span v-else>{{ change.to.text }}</span></td></tr></tbody>
              </table>
            </div>
          </template>
          <p v-else-if="!active.view.added && !active.view.removed && !active.view.other.length" class="muted">未记录业务字段变化</p>
          <section v-if="active.view.added" class="audit-line-changes"><h4>列入商品 {{ active.view.added.lines?.length }} 行</h4><PurchaseOrderAuditSnapshot :snapshot="active.view.added" products-only /></section>
          <section v-if="active.view.removed" class="audit-line-changes"><h4>移除商品 {{ active.view.removed.lines?.length }} 行</h4><PurchaseOrderAuditSnapshot :snapshot="active.view.removed" products-only /></section>
          <div v-if="active.view.linesUnchanged !== undefined" class="audit-unchanged"><b>商品明细保持一致</b><p>{{ active.view.linesUnchanged }} 行商品的已记录业务字段均未变化。</p></div>
          <details v-if="active.view.snapshot" class="audit-full-snapshot"><summary>查看操作后的单据与商品明细</summary><PurchaseOrderAuditSnapshot :snapshot="active.view.snapshot" /></details>
        </template>
        <details v-if="active.view.other.length || active.view.originalAction" class="audit-other">
          <summary>其他记录与原始动作</summary><p v-if="active.view.originalAction">动作码：<span class="mono">{{ active.view.originalAction }}</span></p>
          <dl><template v-for="(change, index) in active.view.other" :key="index"><dt>{{ change.label }}</dt><dd>{{ active.view.isCreate ? change.to.text : `${change.from.text} → ${change.to.text}` }}</dd></template></dl>
        </details>
        <p v-for="note in active.view.notes" :key="note" class="audit-note">{{ note }}</p>
      </div>
    </article>
  </div>
</template>

<style scoped>
.purchase-audit-workspace { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; font-size: 13px; }
.purchase-audit-workspace.is-open { grid-template-columns: 260px minmax(0, 1fr); }
.purchase-audit-directory, .purchase-audit-content { min-width: 0; border: 1px solid var(--el-border-color-light); border-radius: 6px; overflow: hidden; background: var(--el-bg-color); }
.purchase-audit-directory > header { display: flex; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--el-border-color-light); }
.purchase-audit-directory > header span { color: #737c8b; font-size: 12px; }
.purchase-audit-timeline { padding: 18px 12px 0 22px; margin: 0; max-height: 640px; overflow-y: auto; }
.purchase-audit-timeline :deep(.el-timeline-item) { padding-bottom: 12px; cursor: pointer; }
.purchase-audit-timeline :deep(.el-timeline-item__wrapper) { padding-left: 22px; top: -8px; }
.audit-timeline-entry { display: block; width: 100%; text-align: left; border: 1px solid transparent; border-radius: 4px; background: transparent; padding: 6px 10px; color: var(--el-text-color-primary); cursor: pointer; font: inherit; }
.audit-timeline-entry:hover { background: var(--el-fill-color-light); }
.audit-timeline-entry[aria-expanded=true] { background: #edf5ff; border-color: #d6e7fb; }
.audit-timeline-entry > b { display: block; font-weight: 600; }
.audit-timeline-entry > span, .audit-timeline-entry > small { display: block; color: #737c8b; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.audit-timeline-entry > time { font-size: 12px; color: #737c8b; font-variant-numeric: tabular-nums; }
.audit-choice-description { margin: 4px 0; }
.audit-event-header { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding: 16px 20px 14px; border-bottom: 1px solid var(--el-border-color-light); }
h3 { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; font-size: 16px; margin: 0; font-weight: 600; }
.audit-event-header p { margin: 6px 0 0; color: #737c8b; font-size: 12px; }
.audit-event-header p > span { margin: 0 4px; }
.audit-record-number { font-size: 12px; white-space: nowrap; color: #737c8b; }
.audit-detail-controls { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.audit-close { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--el-text-color-regular); font: inherit; font-size: 16px; cursor: pointer; }
.audit-close:hover { color: var(--el-color-primary); background: var(--el-fill-color-light); }
.audit-event-body { padding: 16px 20px; min-width: 0; }
.audit-snapshot-intro { border-left: 3px solid var(--el-color-primary); padding-left: 8px; font-size: 12px; color: var(--el-text-color-regular); margin: 0 0 16px; }
h4 { margin: 0 0 9px; font-size: 13px; font-weight: 600; }
h4 span { font-size: 12px; color: #737c8b; font-weight: 400; margin-left: 6px; }
.audit-compare-scroll { overflow-x: auto; border: 1px solid var(--el-border-color-light); border-radius: 3px; }
.audit-compare { width: 100%; min-width: 430px; border-collapse: collapse; table-layout: fixed; text-align: left; }
.audit-compare th, .audit-compare td { padding: 7px 12px; border-bottom: 1px solid var(--el-border-color-light); overflow-wrap: anywhere; font-size: 13px; line-height: 23px; font-weight: 400; }
.audit-compare thead th { background: var(--el-fill-color-light); font-size: 12px; color: var(--el-text-color-regular); }
.audit-compare tbody tr:nth-child(even) { background: #f0f3f7; }
.audit-compare tbody td:last-child { background: #edf5ff; }
.audit-compare tbody tr:last-child > * { border-bottom: 0; }
.audit-unchanged { padding: 16px 0; }
.audit-unchanged b { font-weight: 500; }
.audit-unchanged p { margin: 4px 0 0; color: #737c8b; font-size: 12px; }
.audit-line-changes { margin-top: 16px; }
.audit-full-snapshot { border-top: 1px solid var(--el-border-color-light); }
summary { padding: 10px 0; color: var(--el-color-primary); cursor: pointer; font-size: 12px; }
.audit-note, .audit-other, .audit-reason { font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.audit-note { color: #737c8b; margin: 8px 0 0; }
.audit-other dt { color: #737c8b; }
.audit-other dd { margin: 2px 0 8px 12px; }
button:focus-visible, summary:focus-visible, .audit-compare-scroll:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
@container (max-width: 800px) { .purchase-audit-workspace.is-open { grid-template-columns: minmax(0, 1fr); gap: 12px; } .purchase-audit-timeline { max-height: 320px; } .audit-event-body, .audit-event-header { padding: 12px; } }
@container (max-width: 430px) { .audit-record-number { display: none; } }
</style>
