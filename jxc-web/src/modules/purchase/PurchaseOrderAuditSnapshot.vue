<script setup lang="ts">
import StatusTag from '@/components/StatusTag.vue'
import type { OrderAuditSnapshot } from './purchaseOrderAudit'
const props = defineProps<{ snapshot: OrderAuditSnapshot; productsOnly?: boolean }>()
</script>

<template>
  <section class="purchase-audit-snapshot">
    <template v-if="!productsOnly">
      <h4>单据信息</h4>
      <dl v-if="snapshot.fields.length" class="audit-field-grid">
        <div v-for="field in snapshot.fields" :key="field.label" class="audit-field" :class="{ 'audit-field-wide': field.label === '备注' }">
          <dt>{{ field.label }}</dt>
          <dd><StatusTag v-if="field.value.status" :status="field.value.status" /><span v-else>{{ field.value.text }}</span><small v-if="field.reference">{{ field.reference }}</small></dd>
        </div>
      </dl>
      <p v-else class="muted">此快照未记录单据基本字段</p>
    </template>
    <div class="audit-section-heading"><h4>商品明细 <span v-if="snapshot.lines">{{ snapshot.lines.length }} 行</span></h4><span class="muted">按当时记录显示</span></div>
    <p v-if="!snapshot.lines" class="muted">此快照未提供可识别的商品明细</p>
    <p v-else-if="!snapshot.lines.length" class="muted">此快照明确记录为无商品明细</p>
    <div v-else class="audit-table-scroll" tabindex="0" role="region" aria-label="商品明细，可左右滚动">
      <table class="audit-product-table">
        <caption class="audit-sr-only">单次操作记录的商品明细</caption>
        <thead><tr><th v-for="column in snapshot.columns" :key="column.key" scope="col" :class="[{ 'audit-num': column.numeric }, `audit-col-${column.key}`]">{{ column.label }}</th></tr></thead>
        <tbody><tr v-for="line in snapshot.lines" :key="line.key">
          <td v-for="column in snapshot.columns" :key="column.key" :class="[{ 'audit-num': column.numeric }, `audit-col-${column.key}`]">
            <template v-if="column.key === 'product'">
              <span class="audit-product-name">{{ line.currentName || line.name }} <span v-if="line.currentName || line.currentCode" class="audit-reference-label">当前资料</span></span>
              <span class="audit-product-meta"><span v-if="line.currentCode || line.code" class="mono">{{ line.currentCode || line.code }}</span><span v-if="line.productId">历史标识 #{{ line.productId }}</span></span>
            </template>
            <template v-else>{{ line.cells[column.key]?.text }}</template>
          </td>
        </tr></tbody>
      </table>
    </div>
    <div v-if="!productsOnly && snapshot.totals.length" class="audit-totals"><span v-for="field in snapshot.totals" :key="field.label">{{ field.label }} <b class="mono">{{ field.value.text }}</b></span></div>
    <p v-if="snapshot.lines?.some(line => line.currentName || line.currentCode)" class="audit-reference-note">标注“当前资料”的名称、编码仅供识别；每行保留日志记录的历史商品标识。</p>
    <details v-if="snapshot.lines?.length && snapshot.secondaryColumns.length" class="audit-secondary">
      <summary>单位换算与交付数量 <span>查看当时记录</span></summary>
      <div class="audit-table-scroll" tabindex="0" role="region" aria-label="单位换算与交付数量，可左右滚动">
        <table><thead><tr><th scope="col">行号</th><th scope="col">历史商品标识</th><th v-for="column in snapshot.secondaryColumns" :key="column.key" scope="col" :class="{ 'audit-num': column.numeric }">{{ column.label }}</th></tr></thead>
          <tbody><tr v-for="line in snapshot.lines" :key="line.key"><td>{{ line.cells.lineNo?.text }}</td><td>{{ line.productId ? `#${line.productId}` : '未记录' }}</td><td v-for="column in snapshot.secondaryColumns" :key="column.key" :class="{ 'audit-num': column.numeric }">{{ line.cells[column.key]?.text }}</td></tr></tbody>
        </table>
      </div>
    </details>
  </section>
</template>

<style scoped>
.purchase-audit-snapshot { min-width: 0; font-size: 13px; }
h4 { font-size: 13px; font-weight: 600; margin: 0; }
.audit-field-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--el-border-color-light); border: 1px solid var(--el-border-color-light); border-radius: 3px; overflow: hidden; margin: 9px 0 20px; }
.audit-field { display: grid; grid-template-columns: 76px minmax(0, 1fr); background: var(--el-bg-color); min-height: 36px; }
.audit-field dt { background: #f7f9fc; color: var(--el-text-color-regular); padding: 7px 9px; }
.audit-field dd { margin: 0; padding: 7px 10px; overflow-wrap: anywhere; }
.audit-field small { display: block; color: var(--el-text-color-secondary); font-size: 12px; }
.audit-field-wide { grid-column: 1 / -1; }
.audit-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 6px 12px; flex-wrap: wrap; margin: 9px 0; }
.audit-section-heading h4 span, .audit-section-heading > span { font-size: 12px; color: var(--el-text-color-secondary); font-weight: 400; }
.audit-section-heading h4 span { margin-left: 6px; }
.audit-table-scroll { width: 100%; overflow-x: auto; border: 1px solid var(--el-border-color-light); border-radius: 3px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
.audit-product-table { min-width: 810px; }
th, td { border-bottom: 1px solid var(--el-border-color-light); padding: 5px 9px; line-height: 21px; vertical-align: middle; white-space: nowrap; }
th { background: var(--el-fill-color-light); font-size: 12px; color: var(--el-text-color-regular); font-weight: 500; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:nth-child(even) { background: #f0f3f7; }
tbody tr:hover { background: #eaf3ff; }
.audit-col-product { min-width: 220px; white-space: normal; }
.audit-col-lineNo { width: 46px; color: var(--el-text-color-secondary); }
.audit-col-unitPrice, .audit-col-amount { min-width: 110px; }
.audit-num { text-align: right; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-variant-numeric: tabular-nums; }
.audit-product-name { display: block; font-weight: 500; overflow-wrap: anywhere; }
.audit-product-meta { display: flex; flex-wrap: wrap; gap: 0 12px; line-height: 18px; font-size: 12px; color: var(--el-text-color-secondary); }
.audit-reference-label { color: #737c8b; font-size: 11px; margin-left: 5px; font-weight: 400; }
.audit-totals { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 6px 20px; padding: 10px 0; font-size: 12px; color: var(--el-text-color-regular); }
.audit-totals b { font-weight: 500; color: var(--el-text-color-primary); margin-left: 5px; }
.audit-reference-note { font-size: 12px; color: #737c8b; margin: 6px 0 12px; }
.audit-secondary { margin-top: 12px; }
.audit-secondary > summary { padding: 9px 12px; cursor: pointer; background: #f7f9fc; font-size: 12px; color: var(--el-text-color-regular); }
.audit-secondary > summary span { float: right; color: var(--el-text-color-secondary); }
.audit-secondary[open] > summary { margin-bottom: 8px; }
.audit-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.audit-table-scroll:focus-visible, summary:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
@container (max-width: 1100px) { .audit-field-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (max-width: 500px) { .audit-field-grid { grid-template-columns: minmax(0, 1fr); } .audit-totals { justify-content: flex-start; } }
</style>
