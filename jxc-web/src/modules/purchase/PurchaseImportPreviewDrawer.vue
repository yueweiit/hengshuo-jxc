<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { http } from '@/api/http'
import type { FeeReviewInput, ImportDraftGroup, PurchaseImportModel } from './purchaseImportModel'

const props = defineProps<{ modelValue: boolean; page: PurchaseImportModel; books: { id: number; name: string }[]; suppliers: { id: number; name: string }[]; currencies: { code: string }[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const editingVersion = ref<number | null>(null)
const editing = ref<number | null>(null), header = ref<Record<string, any>>({}), split = ref<number[]>([])
const feeEdits = ref<Record<number, FeeReviewInput[]>>({})
watch(() => props.page.state.groups.map(g => `${g.id}:${g.feeTodosVersion}:${g.sourceBasisHash}`).join(','), () => {
  feeEdits.value = Object.fromEntries(props.page.state.groups.map(g => [g.id, (g.feeTodos ?? []).map(t => ({ sourceRowIds:[...t.sourceRowIds],scope:t.scope,amount:t.amount,currency:t.currency,reason:t.reason,confirm:t.reviewStatus === 'CONFIRMED' }))]))
}, { immediate:true })
const enabled = ref(false), capabilityError = ref(''), capabilityLoading = ref(false)
const locked = computed(() => props.page.busy() || !!props.page.state.edit || props.page.headerDirty())
let active = true, epoch = 0
watch(() => props.page.state.batchId, async () => {
  editing.value = null; editingVersion.value = null; enabled.value = false; capabilityError.value = ''
  const context = ++epoch
  if (!props.page.state.batchId) return
  capabilityLoading.value = true
  try {
    const result = await http.get<{ draftCreationEnabled: boolean }>('/pur/order-imports/capabilities', {}, { silent: true })
    if (active && context === epoch) { if (typeof result.draftCreationEnabled !== 'boolean') throw new Error('创建开关返回格式不正确'); enabled.value = result.draftCreationEnabled }
  } catch (error) { if (active && context === epoch) capabilityError.value = error instanceof Error ? error.message : '读取创建权限失败' }
  finally { if (active && context === epoch) capabilityLoading.value = false }
}, { immediate: true })
function edit(group: ImportDraftGroup) { editing.value = group.id; editingVersion.value = group.version; header.value = { ...group.header }; split.value = [] }
async function save(group: ImportDraftGroup) { if (editing.value !== group.id || editingVersion.value === null) return; if (await props.page.saveGroup({ ...group, version: editingVersion.value }, header.value, split.value)) { editing.value = null; editingVersion.value = null } }
function productLabel(id:number) { const product=props.page.state.rows.find(row=>row.matchedProductId===id)?.productSnapshot; return `${product?.productCode ?? '编码待核对'} · ${product?.name ?? '名称待核对'}` }
function groupRows(group: ImportDraftGroup) { return props.page.state.rows.filter(row => row.groupId === group.id) }
function status(group: ImportDraftGroup) { return ({ DRAFT: '待补充核对', READY: '可确认建单', CREATING: '创建处理中', CREATED: '已创建草稿', FAILED: '创建失败', UNKNOWN: '创建结果待核实' } as Record<string, string>)[group.createStatus] }
async function create(group: ImportDraftGroup) {
  if (locked.value || !enabled.value) return
  const context = epoch, batch = props.page.state.batchId, token = group.previewToken
  try { await ElMessageBox.confirm(`确认按当前完整预览创建 ${group.sourceOrderNo} 的采购草稿？共${group.preview?.lines.length}行，金额${group.preview?.totalAmount} ${group.header.currency}。`, '确认创建采购草稿', { confirmButtonText: '确认创建草稿', cancelButtonText: '返回核对', type: 'warning' }) }
  catch (error) { if (error !== 'cancel' && error !== 'close') props.page.failure(error); return }
  if (active && context === epoch && batch === props.page.state.batchId && token === group.previewToken && !locked.value) await props.page.createDraft(group)
}
onBeforeUnmount(() => { active = false; ++epoch })
</script>

<template>
  <el-drawer :model-value="modelValue" title="完整采购草稿预览" size="94%" append-to-body @update:model-value="emit('update:modelValue',$event)">
  <div v-if="page.state.batchId" class="draft-preview">
    <el-alert v-if="page.state.error" :title="page.state.error" type="error" :closable="false" />
    <div class="draft-heading"><h3>完整采购预览</h3><el-button :disabled="locked || editing !== null" @click="page.previewDrafts">核对并生成预览</el-button></div>
    <p class="hint">同一采购单号的全部明细确认后才能创建草稿。表头不同的明细可以明确拆单，原单号仍保留用于追溯。</p>
    <el-alert v-if="capabilityError" :title="capabilityError" type="error" :closable="false" />
    <p v-else-if="!enabled && !capabilityLoading" class="hint">当前环境尚未启用创建采购草稿，可先完成资料核对和预览。</p>
    <article v-for="group in page.state.groups" :key="group.id" class="draft-group">
      <div class="draft-heading"><strong>{{ group.sourceOrderNo }} · {{ status(group) }}</strong><el-button v-if="!group.orderId && !['CREATING', 'UNKNOWN'].includes(group.createStatus)" :disabled="locked" @click="edit(group)">核对表头／拆单</el-button></div>
      <el-form v-if="editing === group.id" :model="header" :disabled="locked" label-width="100px" class="group-form" @submit.prevent>
        <el-form-item label="账套"><el-select v-model="header.bookId"><el-option v-for="item in books" :key="item.id" :value="item.id" :label="item.name" /></el-select></el-form-item>
        <el-form-item label="供应商"><el-select v-model="header.supplierId" filterable><el-option v-for="item in suppliers" :key="item.id" :value="item.id" :label="item.name" /></el-select></el-form-item>
        <el-form-item label="币种"><el-select v-model="header.currency"><el-option v-for="item in currencies" :key="item.code" :value="item.code" :label="item.code" /></el-select></el-form-item>
        <el-form-item label="下单日期"><el-date-picker v-model="header.orderDate" value-format="YYYY-MM-DD" type="date" /></el-form-item>
        <el-form-item label="预计交货"><el-date-picker v-model="header.expectedDate" value-format="YYYY-MM-DD" type="date" /></el-form-item>
        <el-form-item label="付款条件"><el-input v-model="header.paymentTerms" /></el-form-item>
        <el-form-item label="预付比例"><el-input v-model="header.prepayRatio" placeholder="待核实，0～1" /></el-form-item>
        <el-form-item label="账期天数"><el-input-number v-model="header.termDays" :min="0" :precision="0" /></el-form-item>
        <el-form-item label="税率"><el-input v-model="header.taxRate" placeholder="待核实，例如0.13" /></el-form-item>
        <el-form-item label="单价口径"><el-select v-model="header.priceTaxBasis" placeholder="请核对供应商单价"><el-option value="EXCLUSIVE" label="已核对：未含税单价" /></el-select></el-form-item>
        <el-form-item label="拆出明细"><el-select v-model="split" multiple placeholder="留空表示整组修改"><el-option v-for="row in groupRows(group)" :key="row.id" :value="row.id" :label="`第${row.rowNo}行 · ${row.productSpec || '规格待核实'}`" /></el-select></el-form-item>
        <div><el-button type="primary" @click="save(group)">保存并重新核对</el-button><el-button @click="editing = null">取消</el-button></div>
      </el-form>
      <p class="hint">{{ books.find(item => item.id === group.header.bookId)?.name || '账套待核实' }} · {{ suppliers.find(item => item.id === group.header.supplierId)?.name || '供应商待核实' }} · {{ group.header.currency }} · {{ group.header.orderDate }}</p>
      <p class="hint">预计交货 {{ group.header.expectedDate || '未填写' }}；预付比例 {{ group.header.prepayRatio ?? '待核实' }}；账期 {{ group.header.termDays ?? '待核实' }} 天；付款条件 {{ group.header.paymentTerms || '未填写' }}；税率 {{ group.header.taxRate ?? '待核实' }}；单价口径 {{ group.header.priceTaxBasis === 'EXCLUSIVE' ? '未含税' : '待核实' }}</p>
      <ul v-if="group.errors.length" class="issues"><li v-for="(error, n) in group.errors" :key="n"><span v-if="error.sourceRow">{{ error.sourceSheet }} 原第{{ error.sourceRow }}行：</span>{{ error.message }}</li></ul>
      <div v-if="group.preview" class="preview-scroll"><table><thead><tr><th>行</th><th>商品／规格</th><th>数量与单位</th><th>原始采购单价</th><th>正式采购单价</th><th>舍入差额</th><th>税率</th><th>金额</th></tr></thead><tbody><tr v-for="line in group.preview.lines" :key="line.lineNo"><td>{{ line.lineNo }}</td><td>{{ productLabel(line.productId) }} · {{ line.productSpec || '规格待核实' }}</td><td>{{ line.qty }} {{ line.unit }}</td><td>{{ line.sourceUnitPrice }}</td><td>{{ line.unitPrice }}</td><td>{{ line.unitPriceDifference }}</td><td>{{ line.taxRate }}</td><td>{{ line.amount }}</td></tr></tbody></table><p>货款 {{ group.preview.totalAmount }} {{ group.header.currency }}；税额 {{ group.preview.taxAmount }} {{ group.header.currency }}</p></div>
      <section class="fee-review" aria-label="费用来源核对">
        <h3>待后续登记的费用</h3><p class="hint">原表重复出现的运费不会自动相加。请核对整单或单行归属、原币和金额；此处只保存来源记录。</p>
        <el-form v-for="(fee,index) in feeEdits[group.id]" :key="index" label-width="90px" :disabled="locked">
          <p>费用来源 {{ fee.sourceRowIds.length }} 条明细 · {{ group.feeTodos?.[index]?.reviewStatus === 'CONFIRMED' ? '已核对' : group.feeTodos?.[index]?.reviewStatus === 'STALE' ? '来源已变化，需复核' : '待核对' }}</p>
          <el-form-item label="归属"><el-select v-model="fee.scope" aria-label="费用归属"><el-option value="ORDER" label="整单一次"/><el-option value="LINE" label="单行"/></el-select></el-form-item>
          <el-form-item label="来源明细"><el-select v-model="fee.sourceRowIds" multiple collapse-tags aria-label="费用来源明细"><el-option v-for="source in group.sourceEvidence" :key="source.rowId" :value="source.rowId" :label="`第${source.rowNo}行 · ${source.sourceSheet} 原${source.sourceRow}行`"/></el-select></el-form-item>
          <el-form-item label="费用原币"><el-select v-model="fee.currency" aria-label="费用原币"><el-option v-for="item in currencies" :key="item.code" :value="item.code" :label="item.code"/></el-select></el-form-item>
          <el-form-item label="费用金额"><el-input v-model="fee.amount" aria-label="费用金额" inputmode="decimal" placeholder="未知请留空"/></el-form-item>
          <el-form-item label="核对原因"><el-input v-model="fee.reason" aria-label="费用核对原因" type="textarea"/></el-form-item>
          <el-checkbox v-model="fee.confirm" aria-label="确认费用来源">我已核对上述费用归属、金额及原币</el-checkbox>
        </el-form>
        <el-button :disabled="locked" @click="page.saveFeeTodos(group,feeEdits[group.id]!)">保存费用核对</el-button>
      </section>
      <el-collapse><el-collapse-item title="原文件、原单元格与公式来源"><div v-for="source in group.sourceEvidence" :key="source.rowId" class="source-evidence"><strong>第{{ source.rowNo }}行 · {{ source.fileName }} · {{ source.sourceSheet }} 原{{ source.sourceRow }}行</strong><p>原值：{{ JSON.stringify(source.originalValues) }}</p><p>公式及数量格：{{ JSON.stringify(source.formulaProvenance) }}</p></div></el-collapse-item></el-collapse>
      <el-alert v-if="group.errorMessage" :title="group.errorMessage" type="error" :closable="false" />
      <p v-if="group.orderId">采购草稿：<router-link :to="`/purchase/orders/${group.orderId}`">{{ group.docNo || group.orderId }}</router-link> · {{ group.verifyStatus === 'VERIFIED' ? '读回核对一致' : group.verifyStatus === 'DIFFERENT' ? '读回内容有差异，请核对原采购单' : '已保存，读回待核实' }}</p>
      <div class="draft-actions"><el-button v-if="!group.orderId && ['READY', 'FAILED', 'UNKNOWN'].includes(group.createStatus) && group.previewToken" type="primary" :disabled="locked || !enabled || editing !== null || group.feeTodos?.some(todo => todo.reviewStatus !== 'CONFIRMED')" @click="create(group)">{{ group.createIntent ? '继续原创建请求' : '确认创建采购草稿' }}</el-button><el-button v-if="group.orderId || group.createIntent" :disabled="locked" @click="page.refreshCreation(group)">查询原创建结果</el-button></div>
    </article>
  </div>
</el-drawer>
</template>

<style scoped lang="scss">
.draft-preview { font-size:13px; }
.fee-review { margin:20px 0;max-width:760px; }
.source-evidence { padding:8px 0;overflow-wrap:anywhere; }
.draft-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; h3 { margin: 0; font-size: 15px; } }
.hint { color: var(--el-text-color-secondary); font-size: 13px; line-height: 22px; }
.draft-group { border: 1px solid var(--el-border-color-light); padding: 16px; margin: 16px 0; border-radius: 4px; }
.group-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 0 16px; margin-top: 16px; .el-select { width: 100%; } }
.issues { color: var(--el-color-danger); font-size: 13px; line-height: 24px; padding-left: 20px; }
.preview-scroll { overflow: auto; font-size: 13px; table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; } th, td { padding: 8px; text-align: right; white-space: nowrap; border-bottom: 1px solid var(--el-border-color-light); } th { background: var(--el-fill-color-light); } }
.draft-actions { display: flex; gap: 12px; margin-top: 14px; }
</style>
