<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http } from '@/api/http'
import type { PageResult } from '@/api/types'
import { useTodoStore } from '@/stores/todo'
import { useUserStore } from '@/stores/user'
import StatusTag from '@/components/StatusTag.vue'
import MoneyText from '@/components/MoneyText.vue'
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
const rows = ref<TaskRow[]>([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await http.get<PageResult<TaskRow>>('/wf/tasks/mine', {
      mode: props.mode,
      keyword: query.keyword || undefined,
      docType: query.docType || undefined,
      page: page.value,
      size: 20,
    })
    rows.value = res.records
    total.value = res.total
  } finally {
    loading.value = false
  }
}

// ---------- 详情 ----------
const detail = ref<TaskRow | null>(null)
const drawerVisible = ref(false)
function openDetail(row: TaskRow) {
  detail.value = row
  drawerVisible.value = true
}

// ---------- 审批动作 ----------
const action = reactive({ visible: false, type: 'approve' as 'approve' | 'reject', comment: '', task: null as TaskRow | null, saving: false })

function openAction(row: TaskRow, type: 'approve' | 'reject') {
  Object.assign(action, { visible: true, type, comment: '', task: row })
}

async function submitAction() {
  if (action.type === 'reject' && !action.comment.trim()) {
    ElMessage.warning('驳回时必须填写意见')
    return
  }
  action.saving = true
  try {
    await http.post(`/wf/tasks/${action.task!.id}/${action.type}`, { comment: action.comment })
    ElMessage.success(action.type === 'approve' ? '已同意' : '已驳回')
    action.visible = false
    drawerVisible.value = false
    todo.refresh()
    load()
  } finally {
    action.saving = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>{{ mode === 'todo' ? '我的审批' : '已处理审批' }}</h2>
      </div>
      <el-form inline class="search-form" @submit.prevent="(page = 1), load()">
        <el-form-item label="关键字">
          <el-input v-model="query.keyword" placeholder="单号 / 摘要 / 提交人" clearable style="width: 200px" />
        </el-form-item>
        <el-form-item label="单据类型">
          <el-select v-model="query.docType" clearable style="width: 150px">
            <el-option v-for="d in DOC_TYPES" :key="d.value" v-bind="d" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" native-type="submit">查询</el-button>
        </el-form-item>
      </el-form>

      <div class="table-scroll">
        <el-table v-loading="loading" :data="rows" border stripe row-key="id">
          <el-table-column label="单据" min-width="220">
            <template #default="{ row }">
              <el-link type="primary" @click="openDetail(row)">{{ row.docNo }}</el-link>
              <div class="muted">{{ docTypeLabel(row.docType) }} · {{ row.docTitle }}</div>
            </template>
          </el-table-column>
          <el-table-column label="金额" width="150" align="right">
            <template #default="{ row }"><MoneyText v-if="row.currency" :value="row.amount" :currency="row.currency" /><span v-else>{{ row.amount == null ? '—' : '币种未知' }}</span></template>
          </el-table-column>
          <el-table-column label="审批规则" min-width="160">
            <template #default="{ row }">{{ row.ruleName }} <span class="muted">v{{ row.ruleVersionNo }}</span></template>
          </el-table-column>
          <el-table-column label="当前节点" prop="nodeName" width="130" />
          <el-table-column label="提交" min-width="170">
            <template #default="{ row }">
              {{ row.submittedByName }}
              <div class="muted"><DateTimeText :value="row.submittedAt" /></div>
            </template>
          </el-table-column>
          <el-table-column v-if="mode === 'done'" label="我的处理" min-width="180">
            <template #default="{ row }">
              <StatusTag :status="row.status" />
              <span class="muted"> {{ row.comment }}</span>
              <div class="muted"><DateTimeText :value="row.actedAt" /></div>
            </template>
          </el-table-column>
          <el-table-column v-if="mode === 'done'" label="单据审批状态" width="120">
            <template #default="{ row }"><StatusTag :status="row.instanceStatus" /></template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="150">
            <template #default="{ row }">
              <template v-if="mode === 'todo'">
                <el-button link type="success" @click="openAction(row, 'approve')">同意</el-button>
                <el-button link type="danger" @click="openAction(row, 'reject')">驳回</el-button>
              </template>
              <el-button link @click="openDetail(row)">详情</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <el-pagination v-model:current-page="page" :total="total" :page-size="20" layout="total, prev, pager, next" class="pager" @current-change="load" />
    </div>

    <el-drawer v-model="drawerVisible" :title="detail?.docNo" size="560px" destroy-on-close>
      <template v-if="detail">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="单据类型">{{ docTypeLabel(detail.docType) }}</el-descriptions-item>
          <el-descriptions-item label="摘要">{{ detail.docTitle }}</el-descriptions-item>
          <el-descriptions-item label="金额"><MoneyText v-if="detail.currency" :value="detail.amount" :currency="detail.currency" /><span v-else>{{ detail.amount == null ? '—' : '币种未知' }}</span></el-descriptions-item>
          <el-descriptions-item label="提交人">{{ detail.submittedByName }}</el-descriptions-item>
        </el-descriptions>
        <div v-if="documentLink(detail)" class="hint">
          <el-button type="primary" plain @click="$router.push(documentLink(detail)!)">打开单据</el-button>
        </div>
        <el-alert
          v-else
          class="hint"
          type="info"
          :closable="false"
          show-icon
          title="该单据类型暂无独立页面；请在当前审批中核对记录及附件。"
        />
        <h4>审批记录</h4>
        <ApprovalPanel :doc-type="detail.docType" :doc-id="detail.docId" />
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
        <div v-if="mode === 'todo'" class="drawer-actions">
          <el-button type="success" @click="openAction(detail, 'approve')">同意</el-button>
          <el-button type="danger" @click="openAction(detail, 'reject')">驳回</el-button>
        </div>
      </template>
    </el-drawer>

    <el-dialog v-model="action.visible" :title="action.type === 'approve' ? '同意' : '驳回'" width="460px" append-to-body>
      <p class="muted">{{ action.task?.docNo }} · {{ action.task?.nodeName }}</p>
      <el-input
        v-model="action.comment"
        type="textarea"
        :rows="3"
        :placeholder="action.type === 'approve' ? '审批意见（选填）' : '驳回原因（必填）'"
      />
      <template #footer>
        <el-button @click="action.visible = false">取消</el-button>
        <el-button :type="action.type === 'approve' ? 'success' : 'danger'" :loading="action.saving" @click="submitAction">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.pager {
  margin-top: 12px;
  justify-content: flex-end;
}

.hint {
  margin: 12px 0;
}

.drawer-actions {
  margin-top: 16px;
  display: flex;
  gap: 8px;
}
</style>
