<script setup lang="ts">
import { computed } from 'vue'
import type { ImportDraftGroup, PurchaseImportModel } from './purchaseImportModel'

const props = defineProps<{ page: PurchaseImportModel; disabled: boolean; currencies?: { code: string }[] }>()
const locked = computed(() => props.disabled || props.page.fees.view.saving || props.page.fees.view.preparing)
const groupLocked = (group: ImportDraftGroup) => locked.value || !!group.orderId || ['CREATING', 'UNKNOWN'].includes(group.createStatus)
</script>

<template>
  <section id="import-fees" class="import-fees" aria-labelledby="import-fees-title">
    <div class="fees-heading"><h3 id="import-fees-title">本次导入费用</h3><el-button v-if="page.state.rows.length && page.fees.canPrepare()" link type="primary" :disabled="locked || page.fees.dirty()" :loading="page.fees.view.preparing" @click="page.fees.prepare()">重新读取费用来源</el-button></div>
    <p class="fees-hint">无需先有正式采购单号；导入明细后，按原文件参考分组填写，点击“保存基础信息”一并保存。费用币种默认建议采购币种，仍需核对；未知金额请留空。</p>
    <p v-if="!page.state.rows.length" class="fees-empty">导入采购明细后可填写费用。</p>
    <p v-else-if="!page.state.groups.length" class="fees-empty">{{ page.fees.view.preparing ? '正在读取费用来源…' : '费用来源尚未准备好，请核对明细中的原文件参考号，再重新读取费用来源。' }}</p>
    <article v-for="entry in page.fees.entries()" :key="entry.group.id" class="fee-group">
      <div class="fees-heading"><strong>原文件参考：{{ entry.group.sourceOrderNo }}</strong><span class="fees-hint">{{ entry.group.orderId ? '已生成采购草稿，费用只读' : '随本次导入暂存' }}</span></div>
      <el-alert v-if="entry.stale" type="warning" :closable="false" title="费用来源已变化，已保留填写内容，请重新核对并勾选确认。" />
      <div v-if="entry.items.length" class="fees-scroll">
        <table class="fees-table"><thead><tr><th>费用金额</th><th>费用币种</th><th>费用归属</th><th>来源明细</th><th>核对说明</th><th>确认</th></tr></thead>
          <tbody><tr v-for="(fee, index) in entry.items" :key="index">
            <td><el-input v-model="fee.amount" aria-label="费用金额" inputmode="decimal" placeholder="未知请留空" :disabled="groupLocked(entry.group)" /></td>
            <td><el-select v-model="fee.currency" aria-label="费用币种" filterable placeholder="请选择" :disabled="groupLocked(entry.group)"><el-option v-if="fee.currency && !currencies?.some(item => item.code === fee.currency)" :value="fee.currency" :label="fee.currency"/><el-option v-for="item in currencies" :key="item.code" :value="item.code" :label="item.code"/></el-select></td>
            <td><el-select v-model="fee.scope" aria-label="费用归属" placeholder="请核对" :disabled="groupLocked(entry.group)"><el-option value="ORDER" label="整单一次"/><el-option value="LINE" label="单行"/></el-select></td>
            <td><el-select v-model="fee.sourceRowIds" multiple collapse-tags collapse-tags-tooltip aria-label="费用来源明细" :disabled="groupLocked(entry.group)"><el-option v-for="source in entry.group.sourceEvidence" :key="source.rowId" :value="source.rowId" :label="`第${source.rowNo}行 · ${source.sourceSheet || '来源表'} 原${source.sourceRow ?? '待核实'}行`"/></el-select></td>
            <td><el-input v-model="fee.reason" type="textarea" :autosize="{ minRows: 1, maxRows: 3 }" aria-label="费用核对说明" placeholder="填写核对依据" :disabled="groupLocked(entry.group)" /></td>
            <td><el-checkbox v-model="fee.confirm" aria-label="确认本项费用" :disabled="groupLocked(entry.group)">已核对</el-checkbox><span class="fee-status">{{ fee.confirm ? '来源、金额与币种已核对' : '待核对来源、金额与币种' }}</span></td>
          </tr></tbody>
        </table>
      </div>
      <p v-else class="fees-hint">本组没有待核对的费用来源。</p>
    </article>
  </section>
</template>

<style scoped lang="scss">
.import-fees { margin-top: 8px; padding-top: 16px; border-top: 1px solid var(--el-border-color-light); font-size: 13px; }
.fees-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; h3 { margin: 0; font-size: 14px; } }
.fees-hint, .fee-status { color: var(--el-text-color-secondary); font-size: 12px; line-height: 20px; }
.fees-hint { margin: 8px 0; }
.fees-empty { color: var(--el-text-color-secondary); padding: 12px 0; margin: 0; }
.fee-group { margin-top: 14px; }
.fees-scroll { overflow-x: auto; margin-top: 8px; }
.fees-table { width: 100%; min-width: 980px; border-collapse: collapse; table-layout: fixed; th, td { border: 1px solid var(--el-border-color-light); text-align: left; padding: 9px; vertical-align: top; } th { background: var(--el-fill-color-light); font-weight: 500; } th:nth-child(1) { width: 13%; } th:nth-child(2), th:nth-child(3) { width: 11%; } th:nth-child(4) { width: 24%; } th:nth-child(5) { width: 24%; } th:nth-child(6) { width: 17%; } .el-select { width: 100%; } }
.fee-status { display: block; }
</style>
