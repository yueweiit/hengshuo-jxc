<script setup lang="ts">
import { feedbackMessage, reportError } from '@/api/error-feedback'
import { opinionScope, readOpinion, removeOpinion, saveOpinion } from './opinion-draft'
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http } from '@/api/http'
import type { PageResult } from '@/api/types'
import { useTodoStore } from '@/stores/todo'
import { useUserStore } from '@/stores/user'
import StatusTag from '@/components/StatusTag.vue'
import ApprovalAmount from './ApprovalAmount.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import ApprovalPanel from '@/components/ApprovalPanel.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import { financeSourcePath } from '@/utils/finance-source'

interface TaskRow {
  id: number
  instanceId: number
  nodeName: string
  status: string
  comment: string
  actedAt: string | null
  docType: string
  docId: number
  docNo: string
  docTitle: string
  amount?: number | null
  currency: string | null
  ruleName: string
  ruleVersionNo: number
  instanceStatus: string
  submittedByName: string
  submittedAt: string
}

const DOC_TYPES = [
  { label: '销售订单', value: 'SALES_ORDER' },
  { label: '采购单', value: 'PURCHASE_ORDER' },
  { label: '退款', value: 'REFUND' },
  { label: '销售退货', value: 'SALES_RETURN' },
  { label: '盘点', value: 'STOCKTAKE' },
  { label: '调拨', value: 'TRANSFER' },
  { label: '到货差异核销', value: 'DISCREPANCY_WRITE_OFF' },
]
const docTypeLabel = (v: string) => DOC_TYPES.find((d) => d.value === v)?.label ?? v

const DOC_LINKS: Record<string, (id: number) => string> = {
  STOCKTAKE: (id) => `/inventory/stocktakes?id=${id}`,
  TRANSFER: (id) => `/inventory/transfers?id=${id}`,
  DISCREPANCY_WRITE_OFF: (id) => `/logistics/discrepancies?id=${id}`,
}
function documentLink(row: TaskRow) {
  return DOC_LINKS[row.docType]?.(row.docId) ?? financeSourcePath({ sourceDocType: row.docType, sourceDocId: row.docId })
}

type AttachmentPolicy = { bizType: string; category: string; fields: string[]; read: string[]; write: string[] }
// These are the existing source modules' registered attachment categories and UI visibility checks.
const ATTACHMENTS: Record<string, AttachmentPolicy> = {
  SALES_ORDER: { bizType: 'SAL_ORDER', category: 'SALES_DOC', fields: ['CUSTOMER_PRICE'], read: ['sal:order:view', 'sal:order:create', 'sal:order:submit', 'sal:outbound:create', 'sal:outbound:confirm', 'sal:sign:record', 'ar:receipt:create', 'ar:writeoff:create', 'rtn:sales:create'], write: ['sal:order:create', 'sal:order:submit', 'sal:outbound:confirm'] },
  PURCHASE_ORDER: { bizType: 'PURCHASE_ORDER', category: 'PURCHASE_DOC', fields: ['COST'], read: ['pur:order:view', 'lgs:shipment:view', 'ap:bill:create', 'rtn:purchase:create'], write: ['pur:order:submit', 'pur:order:edit', 'pur:receipt:confirm', 'pur:export:confirm'] },
  REFUND: { bizType: 'REFUND', category: 'REFUND_PROOF', fields: ['ORDER_TOTAL', 'BANK_INFO'], read: ['rtn:refund:create', 'rtn:refund:pay'], write: ['rtn:refund:create', 'rtn:refund:pay'] },
  SALES_RETURN: { bizType: 'SALES_RETURN', category: 'RETURN_PROOF', fields: ['ORDER_TOTAL', 'COST'], read: ['rtn:sales:create', 'rtn:sales:receive', 'rtn:sales:inspect', 'rtn:sales:settle'], write: ['rtn:sales:create', 'rtn:sales:submit', 'rtn:sales:receive', 'rtn:sales:inspect', 'rtn:sales:settle'] },
  PURCHASE_RETURN: { bizType: 'PURCHASE_RETURN', category: 'RETURN_PROOF', fields: ['COST'], read: ['rtn:purchase:create', 'rtn:purchase:ship'], write: ['rtn:purchase:create', 'rtn:purchase:ship'] },
  DISCREPANCY_WRITE_OFF: { bizType: 'DISCREPANCY', category: 'LOGISTICS_DOC', fields: ['COST'], read: ['lgs:shipment:view', 'lgs:receipt:confirm', 'ap:bill:view', 'rtn:purchase:create'], write: ['lgs:shipment:edit', 'lgs:discrepancy:handle', 'lgs:fee:confirm', 'lgs:receipt:confirm', 'lgs:hold:release'] },
}
function attachment(row: TaskRow) { return ATTACHMENTS[row.docType] ?? null }
function canReadAttachment(row: TaskRow) { const policy = attachment(row); return !!policy && policy.fields.every(group => user.fieldAccess(group) !== 'HIDDEN') && user.hasPerm(policy.read) }
function canWriteAttachment(row: TaskRow) { const policy = attachment(row); return !!policy && policy.fields.every(group => user.fieldAccess(group) === 'WRITE') && user.hasPerm(policy.write) }

const props = defineProps<{ mode: 'todo' | 'done' }>()

const todo = useTodoStore()
const user = useUserStore()
const query = reactive({ keyword: '', docType: '' })
const applied = reactive({ keyword: '', docType: '' })
const rows = ref<TaskRow[]>([])
const page = ref(1)
const size = ref(20)
const sizeOptions = [20, 50, 100]
const total = ref(0)
const loading = ref(false)
const loadError = ref('')
const forbidden = ref(false)
const summaryError = ref('')
const compact = ref(false)
let requestId = 0
let disposed = false



async function load() {
  if (disposed) return
  const request = ++requestId
  loading.value = true
  loadError.value = ''
  forbidden.value = false
  try {
    const res = await http.get<PageResult<TaskRow>>('/wf/tasks/mine', {
      mode: props.mode,
      keyword: applied.keyword || undefined,
      docType: applied.docType || undefined,
      page: page.value,
      size: size.value,
    }, { silent: true })
    if (disposed || request !== requestId) return
    const lastPage = Math.max(1, Math.ceil(res.total / size.value))
    if (page.value > lastPage) {
      page.value = lastPage
      await load()
      return
    }
    rows.value = res.records
    total.value = res.total
  } catch (error) {
    if (disposed || request !== requestId) return
    rows.value = []
    total.value = 0
    loadError.value = feedbackMessage(error, '审批列表加载失败，请重试')
    forbidden.value = typeof error === 'object' && error !== null && 'code' in error && error.code === 'SYS_FORBIDDEN'
  } finally {
    if (!disposed && request === requestId) loading.value = false
  }
}

async function search() {
  Object.assign(applied, { keyword: query.keyword.trim(), docType: query.docType })
  page.value = 1
  await load()
}
async function resetSearch() {
  Object.assign(query, { keyword: '', docType: '' })
  await search()
}
async function changePage(value: number) {
  if (value === page.value) return
  page.value = value
  await load()
}
async function changeSize(value: number) {
  if (!sizeOptions.includes(value) || value === size.value) return
  size.value = value
  page.value = 1
  await load()
}
async function refreshTodo() {
  summaryError.value = ''
  try { await todo.refresh() }
  catch (error) { if (!disposed) summaryError.value = feedbackMessage(error, '待办数量刷新失败，请重试') }
}
async function refreshPage() {
  await Promise.all([load(), refreshTodo()])
}

// ---------- 详情 ----------
const detail = ref<TaskRow | null>(null)
const drawerVisible = ref(false)
function openDetail(row: TaskRow) {
  detail.value = row
  drawerVisible.value = true
}

// ---------- 审批动作 ----------
const action = reactive({ visible: false, type: 'approve' as 'approve' | 'reject', comment: '', task: null as TaskRow | null, saving: false, validation: '' })
let actionScope = ''

function openAction(row: TaskRow, type: 'approve' | 'reject') {
  if (disposed || action.saving || props.mode !== 'todo' || row.status !== 'PENDING' || row.instanceStatus !== 'PENDING') return
  actionScope = opinionScope()
  Object.assign(action, { visible: true, type, comment: readOpinion(row.id, type), task: row, validation: '' })
}

async function submitAction() {
  if (disposed || action.saving || !action.task) return
  action.validation = ''
  if (action.type === 'reject' && !action.comment.trim()) {
    action.validation = '请填写驳回原因'
    return
  }
  action.saving = true
  const task = action.task, type = action.type, scope = actionScope
  try {
    await http.post(`/wf/tasks/${action.task.id}/${action.type}`, { comment: action.comment.trim() }, { silent: true })
    removeOpinion(scope, task.id)
    if (disposed) return
    ElMessage.success(action.type === 'approve' ? '已同意' : '已驳回')
    action.visible = false
    drawerVisible.value = false
    await Promise.all([load(), refreshTodo()])
  } catch (error) {
    if (!disposed && action.task?.id === task.id) saveOpinion(scope, task.id, type, action.comment)
    if (!disposed) reportError(error, {
      title: `${docTypeLabel(action.task.docType)}${action.type === 'approve' ? '审批未通过' : '驳回未完成'}`,
      beforeNavigate: () => {
        if (!disposed && action.task?.id === task.id && action.type === type) {
          saveOpinion(scope, task.id, type, action.comment)
          action.visible = false
        }
      },
    })
  } finally {
    if (!disposed) action.saving = false
  }
}

function guardDialogClose(done: () => void) { if (!action.saving) done() }

let media: MediaQueryList | undefined
function updateCompact(event: MediaQueryList | MediaQueryListEvent) { compact.value = event.matches }
onMounted(() => {
  media = window.matchMedia('(max-width: 768px)')
  updateCompact(media)
  media.addEventListener('change', updateCompact)
  load()
})
onBeforeUnmount(() => {
  disposed = true
  requestId++
  media?.removeEventListener('change', updateCompact)
})
</script>

<template>
  <div class="page approval-page">
    <div class="page-card">
      <div class="page-title approval-heading">
        <div>
          <h2>{{ mode === 'todo' ? '我的审批' : '已处理审批' }}</h2>
          <p class="muted">{{ mode === 'todo' ? '查看待审单据，核对审批记录后处理。' : '查看你的审批意见及单据当前审批状态。' }}</p>
        </div>
        <el-button :loading="loading" :disabled="action.saving" aria-label="刷新审批列表" @click="refreshPage">
          <el-icon><Refresh /></el-icon><span class="refresh-label">刷新</span>
        </el-button>
      </div>
      <el-tabs :model-value="mode" class="approval-tabs" aria-label="审批分类" @tab-change="(name: string | number) => $router.push(name === 'todo' ? '/approval/todo' : '/approval/done')">
        <el-tab-pane label="待我审批" name="todo" />
        <el-tab-pane label="已处理" name="done" />
      </el-tabs>
      <el-form label-position="top" class="approval-search" :disabled="loading || forbidden || action.saving" @submit.prevent="search">
        <el-form-item label="关键字" class="keyword-field">
          <el-input v-model="query.keyword" placeholder="单号 / 摘要 / 提交人" clearable>
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
        </el-form-item>
        <el-form-item label="单据类型" class="type-field">
          <el-select v-model="query.docType" placeholder="全部类型" clearable aria-label="单据类型">
            <el-option v-for="d in DOC_TYPES" :key="d.value" v-bind="d" />
          </el-select>
        </el-form-item>
        <el-form-item class="search-actions">
          <el-button type="primary" native-type="submit">查询</el-button>
          <el-button @click="resetSearch">重置</el-button>
        </el-form-item>
      </el-form>
      <div v-if="summaryError" class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p><p>操作未完成，请查看全局提示。</p><el-button link type="primary" @click="refreshTodo">重试刷新数量</el-button></div>
      <div class="list-caption">
        <div class="list-title">{{ applied.keyword || applied.docType ? '筛选结果' : mode === 'todo' ? '待审批单据' : '已处理记录' }}<span class="result-count" :class="{ neutral: mode === 'done' }">{{ loading || loadError ? '—' : total }}</span></div>
        <span class="sort-hint">{{ mode === 'todo' ? '按提交时间从新到旧' : '按处理时间从新到旧' }}</span>
      </div>
      <div v-if="loading" class="approval-state" role="status" aria-live="polite" aria-busy="true">
        <el-skeleton :rows="4" animated /><p class="muted">正在加载审批列表…</p>
      </div>
      <div v-else-if="loadError" class="approval-state" role="alert">
        <el-icon class="state-icon"><Lock v-if="forbidden" /><Warning v-else /></el-icon>
        <h3>{{ forbidden ? '当前账号无权查看审批' : '审批列表加载失败' }}</h3>
        <p class="muted">操作未完成，请查看全局提示。</p>
        <el-button @click="load">重新加载</el-button>
      </div>
      <div v-else-if="!rows.length" class="approval-state">
        <el-empty :image-size="58" :description="applied.keyword || applied.docType ? '没有匹配的审批' : mode === 'todo' ? '当前没有待审批的单据' : '当前没有已处理的审批'">
          <el-button v-if="applied.keyword || applied.docType" @click="resetSearch">重置筛选</el-button>
          <el-button v-else @click="load">刷新列表</el-button>
        </el-empty>
      </div>
      <div v-else class="approval-list">
        <el-table v-if="!compact" :data="rows" border stripe row-key="id" max-height="max(280px, calc(100dvh - 510px))" class="approval-table">
          <el-table-column label="单据 / 摘要" :min-width="mode === 'done' ? 216 : 260">
            <template #default="{ row }">
              <el-button link type="primary" class="doc-link mono" @click="openDetail(row)">{{ row.docNo }}</el-button>
              <div class="doc-subtitle" :title="`${docTypeLabel(row.docType)} · ${row.docTitle}`"><span class="muted">{{ docTypeLabel(row.docType) }}</span> · {{ row.docTitle }}</div>
            </template>
          </el-table-column>
          <el-table-column label="金额" width="128" align="right">
            <template #default="{ row }"><ApprovalAmount :value="row.amount" :currency="row.currency" /></template>
          </el-table-column>
          <el-table-column label="审批规则" :width="mode === 'done' ? 126 : 145">
            <template #default="{ row }">{{ row.ruleName }}<div class="subline">规则版本 v{{ row.ruleVersionNo }}</div></template>
          </el-table-column>
          <el-table-column :label="mode === 'todo' ? '当前节点' : '我的审批节点'" :width="mode === 'done' ? 120 : 130">
            <template #default="{ row }"><span class="node"><span v-if="mode === 'todo'" class="node-dot" />{{ row.nodeName }}</span></template>
          </el-table-column>
          <el-table-column label="提交人 / 提交时间" :width="mode === 'done' ? 174 : 185">
            <template #default="{ row }">{{ row.submittedByName }}<div class="subline"><DateTimeText :value="row.submittedAt" /></div></template>
          </el-table-column>
          <el-table-column v-if="mode === 'done'" label="我的处理" width="180">
            <template #default="{ row }"><StatusTag :status="row.status" /><div class="doc-subtitle" :title="row.comment">{{ row.comment || '未填写意见' }}</div><div class="subline"><DateTimeText :value="row.actedAt" /></div></template>
          </el-table-column>
          <el-table-column v-if="mode === 'done'" label="单据审批状态" width="110">
            <template #default="{ row }"><StatusTag :status="row.instanceStatus" domain="approvalDoc" /></template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" :width="mode === 'todo' ? 156 : 72" align="right">
            <template #default="{ row }">
              <div class="row-actions">
                <template v-if="mode === 'todo'">
                  <el-button link type="primary" :disabled="action.saving" @click="openAction(row, 'approve')">同意</el-button>
                  <el-button link type="danger" :disabled="action.saving" @click="openAction(row, 'reject')">驳回</el-button>
                  <span class="action-divider" />
                </template>
                <el-button link @click="openDetail(row)">详情</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
        <div v-else class="mobile-list">
          <article v-for="row in rows" :key="row.id" class="mobile-row">
            <div class="mobile-row-top"><el-button link type="primary" class="doc-link mono" @click="openDetail(row)">{{ row.docNo }}</el-button><StatusTag v-if="mode === 'done'" :status="row.status" /></div>
            <p class="mobile-summary"><span class="muted">{{ docTypeLabel(row.docType) }}</span> · {{ row.docTitle }}</p>
            <div class="mobile-facts"><span class="node"><span v-if="mode === 'todo'" class="node-dot" />{{ row.nodeName }}</span><span class="amount"><ApprovalAmount :value="row.amount" :currency="row.currency" /></span></div>
            <div class="mobile-meta"><span>{{ row.submittedByName }} 提交</span><DateTimeText :value="row.submittedAt" /></div>
            <template v-if="mode === 'done'">
              <div class="mobile-meta"><span>单据审批状态</span><StatusTag :status="row.instanceStatus" domain="approvalDoc" /></div>
              <div class="mobile-meta">{{ row.comment || '未填写意见' }} · <DateTimeText :value="row.actedAt" /></div>
            </template>
            <div class="row-actions mobile-actions">
              <template v-if="mode === 'todo'"><el-button link type="primary" :disabled="action.saving" @click="openAction(row, 'approve')">同意</el-button><el-button link type="danger" :disabled="action.saving" @click="openAction(row, 'reject')">驳回</el-button><span class="action-divider" /></template>
              <el-button link @click="openDetail(row)">详情</el-button>
            </div>
          </article>
        </div>
      </div>
      <div class="approval-pagination">
        <span>{{ loading || loadError ? '总数暂不可用' : `共 ${total} 条` }}</span>
        <el-pagination :current-page="page" :page-size="size" :page-sizes="sizeOptions" :total="total" :disabled="loading || !!loadError || action.saving" :layout="compact ? 'sizes, prev, pager, next' : 'sizes, prev, pager, next, jumper'" background :pager-count="5" @current-change="changePage" @size-change="changeSize" />
      </div>
    </div>

    <el-drawer v-model="drawerVisible" title="审批详情" size="min(660px, 100vw)" destroy-on-close class="approval-drawer" :before-close="guardDialogClose" :close-on-press-escape="!action.saving" :show-close="!action.saving">
      <template #header><div><div class="drawer-kicker">审批详情</div><h3 class="drawer-title">单据记录</h3></div></template>
      <template v-if="detail">
        <section class="document-sheet" aria-label="单据抬头和业务字段">
          <header class="document-head">
            <div class="document-eyebrow">
              <span>{{ docTypeLabel(detail.docType) }}</span>
              <StatusTag :status="detail.instanceStatus" domain="approvalDoc" />
            </div>
            <h3 class="document-name">{{ detail.docTitle }}</h3>
            <div class="document-number mono">{{ detail.docNo }}</div>
          </header>
          <div class="document-fields">
            <div class="document-field"><span class="document-label">提交人</span><span class="document-value">{{ detail.submittedByName }}</span></div>
            <div class="document-field"><span class="document-label">提交时间</span><span class="document-value"><DateTimeText :value="detail.submittedAt" /></span></div>
            <div class="document-field"><span class="document-label">审批规则</span><span class="document-value">{{ detail.ruleName }} · v{{ detail.ruleVersionNo }}</span></div>
            <div class="document-field"><span class="document-label">我的节点</span><span class="document-value">{{ detail.nodeName }}</span></div>
            <div class="document-field"><span class="document-label">单据金额</span><span class="document-value amount-value"><ApprovalAmount :value="detail.amount" :currency="detail.currency" /></span></div>
          </div>
        </section>
        <section v-if="mode === 'done'" class="detail-section my-decision">
          <h4>我的处理</h4>
          <div class="decision-meta"><StatusTag :status="detail.status" /><span>{{ detail.nodeName }}</span><DateTimeText v-if="detail.actedAt" :value="detail.actedAt" /><span v-else>处理时间未记录</span></div>
          <p class="decision-comment" :class="{ muted: !detail.comment }">{{ detail.comment || '未填写意见' }}</p>
        </section>
        <section class="detail-section approval-history">
          <h4>审批记录</h4>
          <ApprovalPanel :key="`${detail.docType}:${detail.docId}`" :doc-type="detail.docType" :doc-id="detail.docId" :presentation="mode === 'done' ? 'timeline' : 'steps'" />
        </section>
        <section class="detail-section attachment-section">
          <h4>单据附件</h4>
          <DocAttachment
            v-if="canReadAttachment(detail)"
            :key="`${detail.docType}:${detail.docId}`"
            :biz-type="attachment(detail)!.bizType"
            :biz-id="detail.docId"
            :category="attachment(detail)!.category"
            :readonly="mode === 'done' || !canWriteAttachment(detail)"
          />
          <p v-else class="muted">{{ attachment(detail) ? '当前权限不允许读取此单据附件。' : '此单据类型未提供附件入口。' }}</p>
        </section>
        <section class="detail-section source-link">
          <h4>来源单据</h4>
          <div v-if="documentLink(detail)" class="hint"><el-button type="primary" plain @click="$router.push(documentLink(detail)!)"><el-icon><TopRight /></el-icon>打开单据</el-button></div>
          <el-alert v-else class="hint" type="info" :closable="false" show-icon title="该单据类型暂无独立页面；请在当前审批中核对记录及附件。" />
        </section>
      </template>
      <template #footer>
        <div class="drawer-footer">
          <span class="muted drawer-footer-note">{{ mode === 'todo' ? '请核对单据及相关附件后处理' : '你已处理这条审批' }}</span>
          <div v-if="mode === 'todo' && detail" class="drawer-actions"><el-button type="danger" plain :disabled="action.saving" @click="openAction(detail, 'reject')">驳回</el-button><el-button type="primary" :disabled="action.saving" @click="openAction(detail, 'approve')">同意</el-button></div>
          <el-button v-else @click="drawerVisible = false">关闭</el-button>
        </div>
      </template>
    </el-drawer>

    <el-dialog v-model="action.visible" :title="action.type === 'approve' ? '同意审批' : '驳回审批'" width="460px" class="approval-action-dialog" append-to-body :close-on-click-modal="false" :close-on-press-escape="!action.saving" :show-close="!action.saving" :before-close="guardDialogClose">
      <div v-if="action.task" class="action-context">
        <div class="mono">{{ action.task.docNo }}</div><p>{{ action.task.docTitle }}</p>
        <div class="action-context-footer"><span>{{ action.task.nodeName }}</span><ApprovalAmount :value="action.task.amount" :currency="action.task.currency" /></div>
      </div>
      <el-form label-position="top" @submit.prevent="submitAction">
        <el-form-item :label="action.type === 'approve' ? '审批意见（选填）' : '驳回原因（必填）'" :required="action.type === 'reject'" :error="action.validation" for="approval-opinion">
          <el-input id="approval-opinion" v-model="action.comment" type="textarea" :rows="4" :disabled="action.saving" :placeholder="action.type === 'approve' ? '请输入审批意见（选填）' : '请说明驳回原因，便于提交人修改'" @input="action.validation = ''" />
        </el-form-item>
      </el-form>
      <p class="opinion-hint muted">意见会记录在审批记录中。</p>
      <template #footer><el-button :disabled="action.saving" @click="action.visible = false">取消</el-button><el-button :type="action.type === 'approve' ? 'primary' : 'danger'" :loading="action.saving" @click="submitAction">{{ action.type === 'approve' ? '确认同意' : '确认驳回' }}</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.approval-heading { align-items: flex-start; margin-bottom: 20px; }
.approval-heading p { margin: 4px 0 0; line-height: 1.5; }
.approval-heading > .el-button { margin-top: 0; }
.approval-heading .el-icon { margin-right: 6px; }
.approval-tabs { margin-bottom: 20px; }
.approval-tabs :deep(.el-tabs__header) { margin-bottom: 0; }
.approval-tabs :deep(.el-tabs__nav-wrap::after) { height: 1px; background: var(--el-border-color-light); }
.approval-tabs :deep(.el-tabs__content) { display: none; }
.approval-search { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; margin-bottom: 20px; }
.approval-search :deep(.el-form-item) { margin: 0; }
.approval-search :deep(.el-form-item__label) { font-size: 13px; margin-bottom: 7px; line-height: 20px; }
.keyword-field { width: 300px; max-width: 100%; }
.type-field { width: 180px; }
.type-field :deep(.el-select) { width: 100%; }
.summary-error { margin-bottom: 16px; }
.summary-error p { margin: 0; }
.list-caption { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.list-title { font-size: 14px; font-weight: 600; }
.result-count { display: inline-block; margin-left: 8px; padding: 0 7px; border: 1px solid var(--el-color-warning-light-8); border-radius: 4px; background: var(--el-color-warning-light-9); color: var(--el-color-warning-dark-2); font-weight: 400; font-size: 12px; line-height: 20px; }
.result-count.neutral { background: var(--el-color-info-light-9); border-color: var(--el-color-info-light-8); color: var(--el-text-color-regular); }
.sort-hint { font-size: 12px; color: var(--el-text-color-secondary); }
.approval-table { width: 100%; border-radius: 4px; }
.approval-table :deep(th.el-table__cell) { background: var(--el-fill-color-light); font-size: 12px; font-weight: 500; }
.approval-table :deep(td.el-table__cell) { padding: 11px 0; font-size: 13px; }
.approval-table :deep(.cell) { padding: 0 14px; line-height: 20px; }
.doc-link { font-size: 13px; font-weight: 500; padding: 0; min-height: 22px; }
.doc-subtitle { margin-top: 3px; color: var(--el-text-color-regular); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-subtitle .muted { font-size: inherit; }
.subline { margin-top: 3px; font-size: 12px; color: var(--el-text-color-secondary); }
.node { display: inline-flex; align-items: center; gap: 6px; }
.node-dot { width: 5px; height: 5px; flex-shrink: 0; border-radius: 50%; background: var(--el-color-warning); }
.row-actions { display: flex; justify-content: flex-end; align-items: center; gap: 14px; }
.row-actions .el-button { margin: 0; font-size: 13px; }
.action-divider { width: 1px; height: 12px; background: var(--el-border-color-light); }
.approval-pagination { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 16px; color: var(--el-text-color-regular); font-size: 13px; }
.approval-state { min-height: 280px; padding: 32px 20px; border: 1px solid var(--el-border-color-lighter); border-radius: 4px; display: flex; align-items: center; justify-content: center; flex-direction: column; text-align: center; }
.approval-state .el-skeleton { max-width: 700px; }
.approval-state h3 { margin: 12px 0 0; font-size: 15px; font-weight: 500; }
.approval-state p { max-width: 100%; overflow-wrap: anywhere; }
.state-icon { width: 50px; height: 50px; border-radius: 50%; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); font-size: 25px; }
.drawer-kicker { margin-bottom: 4px; font-size: 12px; color: var(--el-text-color-secondary); }
.drawer-title { margin: 0; font-size: 17px; font-weight: 600; color: var(--el-text-color-primary); overflow-wrap: anywhere; }
/* 弹层由Element Plus传送到页面顶层，用审批专属类限定样式范围。 */
:global(.approval-drawer .el-drawer__header) { padding: 22px 24px 20px; margin-bottom: 0; border-bottom: 1px solid var(--el-border-color-light); }
:global(.approval-drawer .el-drawer__body) { padding: 0 24px 24px; }
:global(.approval-drawer .el-drawer__footer) { padding: 16px 24px; border-top: 1px solid var(--el-border-color-light); }
.document-sheet { margin-top: 18px; overflow: hidden; border: 1px solid var(--el-border-color); border-radius: 4px; background: var(--el-bg-color); }
.document-head { padding: 18px 20px 16px; border-bottom: 1px solid var(--el-border-color-light); }
.document-eyebrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--el-text-color-secondary); font-size: 12px; }
.document-name { margin: 10px 0 5px; color: var(--el-text-color-primary); font-size: 17px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.document-number { color: var(--el-color-primary); font-size: 12px; overflow-wrap: anywhere; }
.document-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 22px; padding: 4px 20px 2px; }
.document-field { min-width: 0; padding: 12px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
.document-field:nth-child(odd):nth-last-child(-n + 2), .document-field:last-child { border-bottom: 0; }
.document-label { display: block; margin-bottom: 5px; color: var(--el-text-color-secondary); font-size: 12px; }
.document-value { display: block; min-width: 0; color: var(--el-text-color-primary); font-size: 13px; line-height: 1.55; overflow-wrap: anywhere; }
.document-value.amount-value { font-variant-numeric: tabular-nums; font-weight: 600; }
.detail-section { padding-top: 24px; }
.detail-section + .detail-section { margin-top: 24px; border-top: 1px solid var(--el-border-color-light); }
.detail-section h4 { margin: 0 0 16px; font-size: 14px; font-weight: 600; }
.decision-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 16px; font-size: 12px; color: var(--el-text-color-secondary); }
.decision-comment { margin: 12px 0 0; font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.hint { margin: 6px 0 0; }
.hint .el-icon { margin-right: 6px; }
.drawer-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.drawer-footer-note { font-size: 12px; }
.drawer-actions { display: flex; gap: 8px; }
.drawer-actions .el-button { margin: 0; }
:global(.approval-action-dialog) { max-width: calc(100vw - 32px); border-radius: 6px; }
.action-context { padding: 12px; margin-bottom: 18px; background: var(--el-fill-color-light); border-radius: 4px; font-size: 13px; overflow-wrap: anywhere; }
.action-context p { margin: 4px 0 0; color: var(--el-text-color-regular); font-size: 12px; }
.action-context-footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--el-border-color-light); color: var(--el-text-color-regular); }
.opinion-hint { margin: 0; font-size: 12px; }
.mobile-row { padding: 15px 0; border-bottom: 1px solid var(--el-border-color-light); }
.mobile-list { border-top: 1px solid var(--el-border-color-light); }
.mobile-row-top, .mobile-facts { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mobile-summary { margin: 7px 0 12px; font-size: 13px; line-height: 1.6; color: var(--el-text-color-regular); overflow-wrap: anywhere; }
.mobile-summary .muted { font-size: inherit; }
.mobile-facts { font-size: 12px; color: var(--el-text-color-regular); }
.amount { font-variant-numeric: tabular-nums; text-align: right; }
.mobile-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 10px; margin-top: 6px; color: var(--el-text-color-secondary); font-size: 12px; overflow-wrap: anywhere; }
.mobile-actions { margin-top: 13px; gap: 18px; }
@media (max-width: 768px) {
  .approval-heading { margin-bottom: 16px; }
  .approval-heading p { max-width: 235px; }
  .refresh-label { display: none; }
  .approval-heading > .el-button { padding: 8px; }
  .approval-heading .el-icon { margin: 0; }
  .approval-tabs { margin-bottom: 16px; }
  .approval-search { gap: 12px 8px; margin-bottom: 18px; }
  .keyword-field { width: 100%; }
  .type-field { flex: 1; width: auto; min-width: 100px; }
  .search-actions :deep(.el-button) { padding: 8px 11px; }
  .approval-pagination > span { width: 100%; }
  .approval-pagination :deep(.el-pagination) { width: 100%; justify-content: space-between; gap: 0; }
  .approval-pagination :deep(.el-pagination__sizes) { margin: 0 6px 0 0; }
  .approval-pagination :deep(.el-pagination__sizes .el-select) { width: 104px; }
  .approval-pagination :deep(.el-pager li) { min-width: 28px; margin: 0 2px; }
  .sort-hint { font-size: 11px; }
  :global(.approval-drawer .el-drawer__header) { padding: 18px 16px; }
  :global(.approval-drawer .el-drawer__body) { padding: 0 16px 24px; }
  :global(.approval-drawer .el-drawer__footer) { padding: 12px 16px; }
  .drawer-footer-note { display: none; }
  .drawer-footer { justify-content: flex-end; }
  .document-head { padding: 16px; }
  .document-fields { grid-template-columns: 1fr; gap: 0; padding: 2px 16px; }
  .document-field:nth-child(n) { border-bottom: 1px solid var(--el-border-color-lighter); }
  .document-field:last-child { border-bottom: 0; }
  .document-name { font-size: 16px; }
  .drawer-title { font-size: 16px; }
  :global(.approval-action-dialog) { max-width: calc(100vw - 24px); }
}
@media (max-width: 380px) {
  .approval-pagination :deep(.el-pagination) { flex-wrap: wrap; justify-content: flex-end; row-gap: 8px; }
  .approval-pagination :deep(.el-pagination__sizes) { flex-basis: 100%; margin: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .approval-page :deep(.el-skeleton.is-animated .el-skeleton__item) { animation: none; }
}
</style>
