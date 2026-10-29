<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { PurchaseImportModel } from './purchaseImportModel'
import { reviewQuestions, reviewProposal, reviewProposalCurrent, type ReviewProposal } from './purchaseImportReview'
const props = defineProps<{ page: PurchaseImportModel }>()
const emit = defineEmits<{ products: []; preview: [] }>()
const {urls:imageUrls,errors:imageErrors}=props.page.images
const open = ref(true), selected = ref(''), answer = ref(''), feedback = ref('')
const groupAnswers = ref<Record<string,string>>({}), includeAnswered = ref(false)
const proposal = ref<ReviewProposal | null>(null)
const questions = computed(() => reviewQuestions(props.page.state.rows, props.page.state.sources, includeAnswered.value))
const question = computed(() => questions.value.find(q => q.id === selected.value) ?? questions.value[0])
const locked = computed(() => props.page.busy() || !!props.page.state.edit)
const pendingQuestions = computed(() => questions.value.filter(q=>!q.subject?.previousMeaning).length)
const sampleImages = computed(() => question.value?.subject?.kind==='PHOTO'?[...new Set(props.page.state.rows.filter(r=>r.sourceId===question.value!.sourceId).flatMap(r=>(r.images??[]).map(i=>i.id)))].slice(0,2):[])
watch(() => props.page.state.batchId, () => { proposal.value = null; answer.value = ''; feedback.value = ''; selected.value = ''; groupAnswers.value={};includeAnswered.value=false })
watch(() => question.value?.id, () => { proposal.value = null; answer.value = ''; feedback.value = '';groupAnswers.value={} })
watch(() => props.page.state.version, () => {
  if (proposal.value && !current(proposal.value)) { proposal.value = null; feedback.value = '明细已变化，原补充预览失效，请重新核对。' }
})
function current(value: ReviewProposal) { const s = props.page.state; return reviewProposalCurrent(value, s.batchId, s.version, s.rows, s.sources) }
function prepare(choice?:string) {
  if (!question.value || !props.page.state.batchId || locked.value) return
  try { proposal.value = reviewProposal(props.page.state.batchId, props.page.state.version, question.value, choice ?? (question.value.groups?.length?groupAnswers.value:answer.value)); feedback.value = '' }
  catch (error) { proposal.value = null; feedback.value = error instanceof Error ? error.message : '回答未能解析，请明确填写当前字段' }
}
async function confirm() {
  const value = proposal.value
  if (!value || locked.value) return
  if (!current(value)) { proposal.value = null; feedback.value = '文件或明细已变化，请重新核对。'; return }
  if (await props.page.confirmReview(value)) { proposal.value = null; answer.value = '';groupAnswers.value={}; feedback.value = value.interpretation?'已保存本次原文含义确认，请继续核对剩余事项。':`已保存本次补充的 ${value.changes.length} 条明细。` }
}
function later(){const i=questions.value.findIndex(q=>q.id===question.value?.id);selected.value=questions.value[(i+1)%questions.value.length]?.id??'';proposal.value=null;feedback.value='这项仍保留为待核对，没有补造业务值。'}
</script>
<template>
  <aside class="review-assistant" aria-label="导入核对助手">
    <header><div><strong>核对助手</strong><small>已暂存 {{ page.state.rows.length }} 条 · 待核对 {{ pendingQuestions }} 项</small></div><el-button text @click="open = !open">{{ open ? '收起' : '展开核对' }}</el-button></header>
    <div v-if="open" class="assistant-body">
      <p class="assistant-note">结合原表列名、实际数值和图片确认含义。先看本次准备记录或修改什么，再确认；不确定的可以稍后核对。</p>
      <el-button text @click="includeAnswered = !includeAnswered">{{ includeAnswered ? '只看未完成问题' : '查看已确认的含义' }}</el-button>
      <template v-if="question">
        <el-select v-model="selected" :disabled="locked" :placeholder="`${question.fileName} · ${question.label}`" aria-label="选择待核对问题">
          <el-option v-for="q in questions" :key="q.id" :value="q.id" :label="`${q.fileName} · ${q.label}${q.subject?.previousMeaning ? ' · 已确认' : ''}`"/>
        </el-select>
        <div class="assistant-question"><strong>{{ question.prompt }}</strong><p>原文件：{{ question.fileName }}</p><p v-if="question.note">{{ question.note }}</p><details><summary>查看原表位置与涉及的 {{ question.rows.length }} 条明细</summary><p><span v-for="row in question.rows" :key="row.id">第{{ row.rowNo }}条（原{{ row.sourceRow }}行 {{ row.sourceItemKey }}） </span></p></details></div>
        <div v-if="question.subject" class="meaning-choices"><el-button v-for="choice in question.subject.choices" :key="choice.value" :disabled="locked" @click="prepare(choice.value)">{{ choice.label }}</el-button></div>
        <template v-else-if="question.groups?.length"><label v-for="(group,index) in question.groups" :key="group.key">{{ group.header }} · 第{{ index+1 }}组 · 数量示例 {{ group.examples.join('、') || '待核对' }}<el-input v-model="groupAnswers[group.key]" :disabled="locked" :aria-label="`第${index+1}组商品规格`" placeholder="这组数量对应什么规格名称？" /></label><el-button :disabled="locked" @click="prepare()">整理修改建议</el-button></template>
        <template v-else><label for="purchase-review-answer">你的回答：{{ question.label }}</label><el-input id="purchase-review-answer" v-model="answer" :disabled="locked" :aria-label="`补充${question.label}`" placeholder="填写已经核实的内容，不确定时可稍后核对" @keyup.enter="prepare()" /><el-button :disabled="locked || !answer.trim()" @click="prepare()">整理修改建议</el-button></template>
        <div v-for="(id,index) in sampleImages" :key="id"><el-image v-if="imageUrls[id]" :src="imageUrls[id]" :preview-src-list="[imageUrls[id]!]" fit="contain" style="width:120px;height:120px"/><el-button v-else :disabled="locked" @click="page.images.load(id)">查看照片示例 {{ index+1 }}</el-button><p v-if="imageErrors[id]" role="alert">{{ imageErrors[id] }}</p></div>
        <el-button text :disabled="locked" @click="later">暂不确定，稍后核对</el-button>
      </template>
      <p v-else>来源字段缺项已补齐。请继续核对商品、单位、价税和原图归属；最终能否保存以采购预览为准。</p>
      <div v-if="proposal" class="review-proposal">
        <strong v-if="proposal.interpretation">待确认：将“{{ question?.subject?.label }}”记录为“{{ question?.subject?.choices.find(c=>c.value===proposal!.interpretation!.meaning)?.label }}”</strong><strong v-else>待确认的修改 · {{ proposal.changes.length }} 条</strong>
        <p v-if="proposal.interpretation && !proposal.changes.length">本次仅记录当前文件的原文含义，不修改账套、采购币种、图片归属或正式单据。</p>
        <div v-if="proposal.changes.length" class="proposal-scroll"><table><thead><tr><th>明细</th><th>原值</th><th>准备补充的内容</th></tr></thead><tbody><tr v-for="change in proposal.changes" :key="change.rowId"><td>第{{ page.state.rows.find(row => row.id === change.rowId)?.rowNo }}条</td><td>未确认</td><td>{{ Object.values(change.values).join('、') }}</td></tr></tbody></table></div>
        <el-button type="primary" :disabled="locked" :loading="page.state.saving" @click="confirm">确认本次核对</el-button><el-button :disabled="locked" @click="proposal = null">取消本次建议</el-button>
      </div>
      <p v-if="feedback" role="status">{{ feedback }}</p>
      <footer><el-button :disabled="locked" @click="emit('products')">核对商品与单位</el-button><el-button :disabled="locked || page.headerDirty()" @click="emit('preview')">核对采购预览与价税</el-button></footer>
    </div>
  </aside>
</template>
<style scoped>
.review-assistant{border:1px solid var(--el-border-color);border-radius:var(--el-border-radius-base);background:var(--el-bg-color);min-width:0;align-self:start}
.meaning-choices{display:flex;flex-wrap:wrap;gap:8px}.meaning-choices .el-button+.el-button{margin-left:0}details{font-size:13px;color:var(--el-text-color-secondary)}label{line-height:1.7}
header{display:flex;justify-content:space-between;align-items:center;padding:12px;border-bottom:1px solid var(--el-border-color-lighter)}small{display:block;color:var(--el-text-color-secondary);margin-top:5px}.assistant-body{padding:12px;display:grid;gap:12px}.assistant-note{margin:0;color:var(--el-text-color-secondary);font-size:13px;line-height:1.6}.assistant-question{background:var(--el-fill-color-light);border-left:3px solid var(--el-color-warning);padding:12px;line-height:1.6}.assistant-question p{margin:6px 0;font-size:13px;overflow-wrap:anywhere;max-height:110px;overflow:auto}.proposal-scroll{max-height:220px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--el-border-color-lighter);overflow-wrap:anywhere}.review-proposal{display:grid;gap:10px}footer{display:flex;flex-wrap:wrap;gap:8px;padding-top:10px;border-top:1px solid var(--el-border-color-lighter)}footer .el-button+.el-button{margin-left:0}
</style>
