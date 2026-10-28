<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PurchaseImportModel, ImportDraftGroup, FeeReviewInput } from './purchaseImportModel'

const props = defineProps<{ page: PurchaseImportModel; currencies: { code: string }[] }>()
const editor = ref<{ group: ImportDraftGroup; items: FeeReviewInput[] } | null>(null)
const locked = computed(() => props.page.busy() || !!props.page.state.edit || props.page.headerDirty())
const reviewLabel = (status: string) => ({ CONFIRMED: '已核对', STALE: '来源有变化，请重新核对', UNRESOLVED: '待核实' }[status] || status)
const scopeLabel = (scope: string | null) => scope === 'ORDER' ? '整单' : scope === 'LINE' ? '单行' : '待核实'
const valueText = (value: string | null | undefined) => value === null || value === undefined || value === '' ? '待核实' : value
function open(group: ImportDraftGroup) {
  if (locked.value) return
  editor.value = { group: JSON.parse(JSON.stringify(group)), items: (group.feeTodos || []).map(todo => ({ sourceRowIds: [...todo.sourceRowIds], scope: todo.scope, amount: todo.amount, currency: todo.currency, reason: todo.reason, confirm: todo.reviewStatus === 'CONFIRMED' })) }
}
function add() { editor.value?.items.push({ sourceRowIds: [], scope: null, amount: null, currency: null, reason: '', confirm: false }) }
function remove(index: number) { editor.value?.items.splice(index, 1) }
async function save() {
  if (!editor.value || locked.value) return
  const current = editor.value
  const items = current.items.map(item => ({ ...item, amount: item.amount?.trim() || null, currency: item.currency || null, scope: item.scope || null, reason: item.reason.trim() }))
  if (items.some(item => !item.sourceRowIds.length || !item.reason || item.confirm && (item.amount === null || item.currency === null || item.scope === null))) { props.page.failure(new Error('请选择来源并填写核对原因；标为已核对前须明确归属、金额和原币种')); return }
  if (await props.page.saveFeeTodos(current.group, items) && editor.value === current) editor.value = null
}
</script>

<template>
  <section v-if="page.state.batchId" class="fee-todos">
    <h3>费用待办与来源追溯</h3>
    <p class="fee-hint">这里只保存核对结果，仍待登记。重复运费不自动累加，售价和来源成本不作为正式售价或成本。</p>
    <p v-if="!page.state.groups.length" class="fee-hint">生成采购预览分组后，可核对各单费用及来源。</p>
    <div v-for="group in page.state.groups" :key="group.id" class="fee-group">
      <div class="fee-heading"><strong>来源采购单 {{ group.sourceOrderNo }}</strong><el-button :disabled="locked || !!editor" @click="open(group)">核对费用来源</el-button></div>
      <article v-for="todo in group.feeTodos" :key="todo.todoId" class="fee-card">
        <div class="fee-summary"><strong>待登记</strong><span>{{ reviewLabel(todo.reviewStatus) }}</span><span>归属：{{ scopeLabel(todo.scope) }}</span><span>金额：{{ valueText(todo.amount) }}</span><span>原币种：{{ valueText(todo.currency) }}</span></div>
        <p>{{ todo.reason }}</p>
        <p v-if="todo.reviewStatus === 'STALE'" class="fee-warning">当前展示上次核对值；请按下方最新来源重新核对。</p>
        <div class="fee-refs"><span v-for="source in todo.sourceRows" :key="source.rowId"><a v-if="source.sourceId" :href="`#import-source-${source.sourceId}`">{{ source.sourceSheet }} · 原第{{ source.sourceRow }}行</a><span v-else>原文件待核实 · 导入第{{ source.rowNo }}行</span></span></div>
        <router-link v-if="todo.targetOrderId" :to="`/purchase/orders/${todo.targetOrderId}`">实际采购单：{{ todo.targetDocNo || todo.targetOrderId }}</router-link><p v-else class="fee-hint">{{ todo.targetReferenceStatus === 'UNAVAILABLE' ? '采购引用待核实' : '尚未关联实际采购草稿' }}</p>
      </article>
      <div v-if="editor?.group.id === group.id" class="fee-editor">
        <div v-for="(item, index) in editor.items" :key="index" class="fee-edit-row">
          <el-select v-model="item.sourceRowIds" multiple aria-label="费用来源行" placeholder="选择费用对应来源行" :disabled="locked"><el-option v-for="source in editor.group.sourceEvidence" :key="source.rowId" :value="source.rowId" :label="`导入第${source.rowNo}行 · ${source.sourceSheet || '原表待核实'} · 原第${source.sourceRow || '待核实'}行`" /></el-select>
          <el-select v-model="item.scope" clearable placeholder="归属待核实" aria-label="费用归属" :disabled="locked"><el-option value="ORDER" label="整单" /><el-option value="LINE" label="单行" /></el-select>
          <el-input v-model="item.amount" placeholder="金额未知留空" aria-label="核对费用金额" :disabled="locked" /><el-select v-model="item.currency" clearable placeholder="原币种待核实" aria-label="核对费用原币种" :disabled="locked"><el-option v-for="currency in currencies" :key="currency.code" :value="currency.code" :label="currency.code" /></el-select>
          <el-input v-model="item.reason" placeholder="核对依据或待核实原因" aria-label="费用核对原因" maxlength="1000" :disabled="locked" /><el-checkbox v-model="item.confirm" :disabled="locked">归属、金额和原币种已核对</el-checkbox><el-button :disabled="locked" @click="remove(index)">移除此项核对</el-button>
        </div>
        <p class="fee-hint">同一来源行不能重复用于费用。未覆盖的来源行会保留为待核实，不会被自动当成零费用。</p>
        <div class="fee-actions"><el-button :disabled="locked" @click="add">增加一项核对</el-button><el-button type="primary" :disabled="locked" @click="save">保存核对</el-button><el-button :disabled="page.state.saving" @click="editor = null">取消</el-button></div>
      </div>
      <details class="source-evidence"><summary>查看原文件、行值、售价及成本依据</summary>
        <div v-for="source in group.sourceEvidence" :key="source.rowId" class="evidence-row"><strong>导入第{{ source.rowNo }}行 · {{ source.sourceSheet || '原表待核实' }} · 原第{{ source.sourceRow || '待核实' }}行</strong><p>原文件：{{ source.fileName || '待核实' }} · SHA256：{{ source.fileSha256 || '待核实' }}</p><p>当前导入运费：{{ valueText(source.currentValues.freight) }} · 售价：{{ valueText(source.currentValues.saleUnitPrice) }} · 售价合计：{{ valueText(source.currentValues.saleTotal) }}</p><p>当前到货单位成本：{{ valueText(source.currentValues.landedUnitCost) }} · 美元单位成本：{{ valueText(source.currentValues.usdUnitCost) }} · 美元成本合计：{{ valueText(source.currentValues.usdTotal) }}</p><p v-if="source.targetOrderLineId">实际采购行 ID：{{ source.targetOrderLineId }}</p><details><summary>原始单元格与公式（未重算）</summary><pre>{{ JSON.stringify({ originalValues: source.originalValues, formulaProvenance: source.formulaProvenance }, null, 2) }}</pre></details></div>
      </details>
    </div>
    <p v-if="page.state.groups.length" class="fee-hint">实际费用仍须在<router-link to="/logistics/fees">原物流费用页</router-link>按运输单等真实资料登记；本页没有正式登记引用。</p>
  </section>
</template>

<style scoped lang="scss">
.fee-todos { border-top: 1px solid var(--el-border-color-light); margin-top: 20px; padding-top: 18px; font-size: 13px; line-height: 1.7; h3 { font-size: 15px; margin: 0; } }
.fee-hint { color: var(--el-text-color-secondary); }
.fee-group { margin: 14px 0; padding: 14px; border: 1px solid var(--el-border-color-light); border-radius: 6px; }
.fee-heading, .fee-summary, .fee-actions, .fee-refs { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.fee-heading { justify-content: space-between; }
.fee-card, .evidence-row { border-top: 1px solid var(--el-border-color-lighter); padding: 12px 0; margin-top: 10px; p { margin: 6px 0; } }
.fee-summary strong, .fee-warning { color: var(--el-color-warning-dark-2); }
.fee-editor { padding: 14px; margin-top: 12px; background: var(--el-fill-color-light); }
.fee-edit-row { display: flex; flex-wrap: wrap; gap: 10px; border-bottom: 1px solid var(--el-border-color-light); padding: 12px 0; > .el-select, > .el-input { width: 220px; } > .el-select:first-child { width: 350px; } }
.source-evidence { margin-top: 12px; summary { cursor: pointer; } pre { white-space: pre-wrap; overflow-wrap: anywhere; } }
</style>
