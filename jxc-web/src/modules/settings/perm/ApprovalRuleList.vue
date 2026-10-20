<script setup lang="ts">
import { computed, onMounted, reactive, ref, toRaw } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http } from '@/api/http'
import type { PageResult } from '@/api/types'
import StatusTag from '@/components/StatusTag.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import AuditTimeline from '@/components/AuditTimeline.vue'
import FieldInput from '@/components/crud/FieldInput.vue'
import type { OptionItem } from '@/stores/options'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { DOC_TYPES, labelOf } from '../constants'

interface Condition {
  field: string
  op: string
  value: unknown
}

interface RuleNode {
  seq?: number
  nodeName: string
  approverType: 'ROLE' | 'USER'
  approverRef: string | number
  mode: 'ANY' | 'ALL'
}

interface Rule {
  id: number
  ruleKey: string
  docType: string
  name: string
  priority: number
  conditions: Condition[]
  nodes: RuleNode[]
  versionNo: number
  status: string
  effectiveFrom: string
  version: number
  createdAt: string
  instanceCount?: number
}

interface DocTypeConfig {
  docType: string
  approvalRequired: boolean
  keyFields: string[]
  version?: number
}

const country = useCountryStore()
const user = useUserStore()

const FIELDS: (OptionItem & { kind: 'money' | 'number' | 'payment' | 'bool' })[] = [
  { label: '单据金额', value: 'amount', kind: 'money' },
  { label: '付款方式', value: 'paymentType', kind: 'payment' },
  { label: '人工改价', value: 'manualPrice', kind: 'bool' },
  { label: '超过授信额度', value: 'overLimit', kind: 'bool' },
  { label: '存在逾期欠款', value: 'overdue', kind: 'bool' },
  { label: '折扣率 (%)', value: 'discountRate', kind: 'number' },
]
const OPS: OptionItem[] = [
  { label: '≥', value: 'gte' },
  { label: '>', value: 'gt' },
  { label: '≤', value: 'lte' },
  { label: '<', value: 'lt' },
  { label: '=', value: 'eq' },
]
const PAYMENT_TYPES: OptionItem[] = [
  { label: '赊销', value: 'CREDIT' },
  { label: '现款', value: 'CASH' },
]
const STATUS: OptionItem[] = [
  { label: '生效中', value: 'ACTIVE' },
  { label: '草稿', value: 'DRAFT' },
  { label: '停用', value: 'DISABLED' },
  { label: '历史版本', value: 'RETIRED' },
]

const kindOf = (field: string) => FIELDS.find((f) => f.value === field)?.kind ?? 'number'

function conditionText(c: Condition) {
  const v = kindOf(c.field) === 'payment' ? labelOf(PAYMENT_TYPES, c.value) : kindOf(c.field) === 'bool' ? (c.value ? '是' : '否') : c.value
  return `${labelOf(FIELDS, c.field)} ${labelOf(OPS, c.op)} ${v}`
}

const tab = ref('rules')
const query = reactive({ docType: '', status: '' })
const rows = ref<Rule[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await http.get<PageResult<Rule>>('/wf/rules', { docType: query.docType || undefined, status: query.status || undefined, size: 100 })
    rows.value = res.records
  } finally {
    loading.value = false
  }
}

// ---------- 编辑 ----------
const edit = reactive({
  visible: false,
  saving: false,
  id: 0,
  status: '',
  model: { name: '', docType: 'SALES_ORDER', priority: 10, effectiveFrom: '', version: 0, conditions: [] as Condition[], nodes: [] as RuleNode[] },
})

function openEdit(row?: Rule) {
  edit.id = row?.id ?? 0
  edit.status = row?.status ?? ''
  const source = row ? toRaw(row) : undefined
  edit.model = source
    ? structuredClone({ name: source.name, docType: source.docType, priority: source.priority, effectiveFrom: source.effectiveFrom, version: source.version, conditions: source.conditions, nodes: source.nodes })
    : { name: '', docType: 'SALES_ORDER', priority: 10, effectiveFrom: '', version: 0, conditions: [], nodes: [{ nodeName: '', approverType: 'ROLE', approverRef: '', mode: 'ANY' }] }
  edit.visible = true
}

function onFieldChange(c: Condition) {
  const kind = kindOf(c.field)
  c.op = kind === 'payment' || kind === 'bool' ? 'eq' : 'gte'
  c.value = kind === 'payment' ? 'CREDIT' : kind === 'bool' ? true : 0
}

function move(list: RuleNode[], i: number, d: -1 | 1) {
  const [n] = list.splice(i, 1)
  list.splice(i + d, 0, n)
}

async function save() {
  edit.saving = true
  try {
    if (edit.id) {
      const res = await http.put<Rule & { inflight?: number }>(`/wf/rules/${edit.id}`, edit.model)
      if (edit.status === 'DRAFT') ElMessage.success('已保存')
      else ElMessage.success(`已生成 v${res.versionNo}${res.inflight ? `；在途 ${res.inflight} 张单据继续按旧版本审批` : ''}`)
    } else {
      await http.post('/wf/rules', edit.model)
      ElMessage.success('已新增')
    }
    edit.visible = false
    load()
  } finally {
    edit.saving = false
  }
}

async function toggle(row: Rule) {
  const action = row.status === 'ACTIVE' ? 'disable' : 'enable'
  if (action === 'disable') await ElMessageBox.confirm('停用后新提交的单据不再匹配这条规则，在途审批不受影响。', '停用规则', { type: 'warning' })
  await http.post(`/wf/rules/${row.id}/${action}`)
  load()
}

// ---------- 版本 ----------
const versions = reactive({ visible: false, list: [] as Rule[], auditId: 0 })
async function openVersions(row: Rule) {
  versions.list = await http.get<Rule[]>(`/wf/rules/${row.id}/versions`)
  versions.auditId = row.id
  versions.visible = true
}

// ---------- 单据审批设置 ----------
const docTypes = ref<DocTypeConfig[]>([])
const docTypeSaving = reactive<Record<string, boolean>>({})
const docTypeDraft = reactive({ visible: false, saving: false, docType: '', approvalRequired: undefined as boolean | undefined, keyFields: [] as string[] })
const availableDocTypes = computed(() => DOC_TYPES.filter(type => !docTypes.value.some(row => row.docType === type.value)))
async function loadDocTypes() {
  docTypes.value = await http.get<DocTypeConfig[]>('/wf/doc-types')
}
function openDocType() {
  if (docTypeDraft.saving || !user.hasPerm('wf:rule:edit')) return
  Object.assign(docTypeDraft, { visible: true, docType: '', approvalRequired: undefined, keyFields: [] })
}
async function saveDocType(d: DocTypeConfig) {
  if (!user.hasPerm('wf:rule:edit') || docTypeSaving[d.docType]) return false
  docTypeSaving[d.docType] = true
  try {
    const saved = await http.put<DocTypeConfig>(`/wf/doc-types/${d.docType}`, d)
    Object.assign(d, saved)
    ElMessage.success('已保存')
    return true
  } finally {
    docTypeSaving[d.docType] = false
  }
}
async function saveNewDocType() {
  if (docTypeDraft.saving || !user.hasPerm('wf:rule:edit')) return
  if (!availableDocTypes.value.some(type => type.value === docTypeDraft.docType) || typeof docTypeDraft.approvalRequired !== 'boolean') {
    ElMessage.warning('请选择尚未配置的单据类型，并明确是否必须审批')
    return
  }
  if (docTypeDraft.keyFields.some(key => !/^[A-Za-z][A-Za-z0-9]*$/.test(key))) {
    ElMessage.warning('关键字段须使用字母开头的字段名')
    return
  }
  docTypeDraft.saving = true
  try {
    const config: DocTypeConfig = { docType: docTypeDraft.docType, approvalRequired: docTypeDraft.approvalRequired, keyFields: [...docTypeDraft.keyFields] }
    if (await saveDocType(config)) {
      docTypes.value.push(config)
      docTypeDraft.visible = false
    }
  } finally {
    docTypeDraft.saving = false
  }
}

onMounted(() => {
  load()
  loadDocTypes()
})
</script>

<template>
  <div class="page">
    <div class="page-card">
      <el-tabs v-model="tab">
        <el-tab-pane label="审批规则" name="rules">
          <div class="page-title">
            <el-form inline class="search-form" @submit.prevent="load">
              <el-form-item label="单据类型">
                <el-select v-model="query.docType" clearable style="width: 140px">
                  <el-option v-for="d in DOC_TYPES" :key="String(d.value)" v-bind="d" />
                </el-select>
              </el-form-item>
              <el-form-item label="状态">
                <el-select v-model="query.status" clearable placeholder="当前版本" style="width: 130px">
                  <el-option v-for="s in STATUS" :key="String(s.value)" v-bind="s" />
                </el-select>
              </el-form-item>
              <el-form-item><el-button type="primary" native-type="submit">查询</el-button></el-form-item>
            </el-form>
            <el-button type="primary" @click="openEdit()"><el-icon><Plus /></el-icon>新增规则</el-button>
          </div>
          <div class="table-scroll">
            <el-table v-loading="loading" :data="rows" border stripe row-key="id">
              <el-table-column label="单据类型" width="100">
                <template #default="{ row }">{{ labelOf(DOC_TYPES, row.docType) }}</template>
              </el-table-column>
              <el-table-column label="规则" min-width="150">
                <template #default="{ row }">
                  {{ row.name }} <span class="muted">v{{ row.versionNo }}</span>
                  <div class="muted mono">{{ row.ruleKey }}</div>
                </template>
              </el-table-column>
              <el-table-column prop="priority" label="优先级" width="80" />
              <el-table-column label="触发条件（同时满足）" min-width="220">
                <template #default="{ row }">
                  <div v-for="(c, i) in row.conditions" :key="i">{{ conditionText(c) }}</div>
                  <span v-if="!row.conditions?.length" class="muted">该类单据全部需要审批</span>
                </template>
              </el-table-column>
              <el-table-column label="审批节点" min-width="220">
                <template #default="{ row }">
                  <span v-for="(n, i) in row.nodes" :key="i">
                    <span v-if="i" class="muted"> → </span>{{ n.nodeName }}<span class="muted">（{{ n.approverRef }}）</span>
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="90">
                <template #default="{ row }"><StatusTag :status="row.status" /></template>
              </el-table-column>
              <el-table-column prop="effectiveFrom" label="生效日期" width="110" />
              <el-table-column label="操作" fixed="right" width="170">
                <template #default="{ row }">
                  <el-button v-if="row.status !== 'RETIRED'" link type="primary" @click="openEdit(row)">编辑</el-button>
                  <el-button v-if="row.status !== 'RETIRED'" link type="warning" @click="toggle(row)">
                    {{ row.status === 'ACTIVE' ? '停用' : '启用' }}
                  </el-button>
                  <el-button link @click="openVersions(row)">版本</el-button>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <p class="muted">修改生效中的规则会生成新版本；已提交的单据继续按提交时的版本审批。从模板复制来的规则为草稿，复核金额阈值后再启用。</p>
        </el-tab-pane>

        <el-tab-pane label="单据审批设置" name="docTypes">
          <p class="muted">
            关键字段在审批通过后被修改时，原审批自动失效，单据需要重新提交（{{ country.current?.name }}）。
          </p>
          <el-button v-if="user.hasPerm('wf:rule:edit')" :disabled="docTypeDraft.saving || !availableDocTypes.length" type="primary" @click="openDocType">新增设置</el-button>
          <el-table :data="docTypes" border>
            <el-table-column label="单据类型" width="130">
              <template #default="{ row }">{{ labelOf(DOC_TYPES, row.docType) }}</template>
            </el-table-column>
            <el-table-column label="必须审批" width="100" align="center">
              <template #default="{ row }"><el-switch v-model="row.approvalRequired" :disabled="!user.hasPerm('wf:rule:edit') || docTypeSaving[row.docType]" /></template>
            </el-table-column>
            <el-table-column label="关键字段">
              <template #default="{ row }">
                <el-select v-model="row.keyFields" multiple filterable allow-create default-first-option :disabled="!user.hasPerm('wf:rule:edit') || docTypeSaving[row.docType]" style="width: 100%" />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="90">
              <template #default="{ row }"><el-button :disabled="!user.hasPerm('wf:rule:edit')" :loading="docTypeSaving[row.docType]" link type="primary" @click="saveDocType(row)">保存</el-button></template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-dialog v-model="docTypeDraft.visible" title="新增单据审批设置" width="560px" append-to-body :close-on-click-modal="false" :close-on-press-escape="!docTypeDraft.saving" :show-close="!docTypeDraft.saving">
      <el-form label-width="110px" :disabled="docTypeDraft.saving || !user.hasPerm('wf:rule:edit')">
        <el-form-item label="单据类型" required>
          <el-select v-model="docTypeDraft.docType" placeholder="请选择单据类型" style="width: 100%"><el-option v-for="type in availableDocTypes" :key="String(type.value)" v-bind="type" /></el-select>
        </el-form-item>
        <el-form-item label="必须审批" required>
          <el-radio-group v-model="docTypeDraft.approvalRequired"><el-radio :value="true">必须审批</el-radio><el-radio :value="false">无需审批</el-radio></el-radio-group>
        </el-form-item>
        <el-form-item label="关键字段"><el-select v-model="docTypeDraft.keyFields" multiple filterable allow-create default-first-option style="width: 100%" /></el-form-item>
        <p class="muted">请按本国实际制度选择。保存只维护单据审批设置；需要审批时仍须单独配置有效规则和审批人。</p>
      </el-form>
      <template #footer><el-button :disabled="docTypeDraft.saving" @click="docTypeDraft.visible = false">取消</el-button><el-button type="primary" :disabled="!user.hasPerm('wf:rule:edit')" :loading="docTypeDraft.saving" @click="saveNewDocType">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="edit.visible" :title="edit.id ? '编辑审批规则' : '新增审批规则'" width="820px" append-to-body destroy-on-close>
      <el-alert
        v-if="edit.id && edit.status !== 'DRAFT'"
        type="warning"
        :closable="false"
        show-icon
        title="保存后生成新版本，旧版本转为历史版本"
        class="mb"
      />
      <el-form label-width="90px">
        <el-row :gutter="12">
          <el-col :span="12"><el-form-item label="名称" required><el-input v-model="edit.model.name" /></el-form-item></el-col>
          <el-col :span="12">
            <el-form-item label="单据类型" required>
              <el-select v-model="edit.model.docType" style="width: 100%">
                <el-option v-for="d in DOC_TYPES" :key="String(d.value)" v-bind="d" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="优先级"><el-input-number v-model="edit.model.priority" :min="1" controls-position="right" /></el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="生效日期">
              <el-date-picker v-model="edit.model.effectiveFrom" type="date" value-format="YYYY-MM-DD" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-divider content-position="left">触发条件（全部满足时触发；不设条件表示该类单据都需审批）</el-divider>
        <div v-for="(c, i) in edit.model.conditions" :key="i" class="line">
          <el-select v-model="c.field" style="width: 130px" @change="onFieldChange(c)">
            <el-option v-for="f in FIELDS" :key="String(f.value)" :label="f.label" :value="f.value" />
          </el-select>
          <el-select v-model="c.op" style="width: 80px" :disabled="['payment', 'bool'].includes(kindOf(c.field))">
            <el-option v-for="o in OPS" :key="String(o.value)" v-bind="o" />
          </el-select>
          <el-select v-if="kindOf(c.field) === 'payment'" v-model="c.value" style="width: 160px">
            <el-option v-for="p in PAYMENT_TYPES" :key="String(p.value)" v-bind="p" />
          </el-select>
          <el-switch v-else-if="kindOf(c.field) === 'bool'" v-model="c.value" />
          <el-input-number v-else v-model="c.value as number" :min="0" controls-position="right" style="width: 160px" />
          <span v-if="kindOf(c.field) === 'money'" class="muted">{{ country.currency }}</span>
          <el-button link type="danger" @click="edit.model.conditions.splice(i, 1)">删除</el-button>
        </div>
        <el-button size="small" @click="edit.model.conditions.push({ field: 'amount', op: 'gte', value: 0 })">添加条件</el-button>

        <el-divider content-position="left">审批节点（按顺序流转）</el-divider>
        <div v-for="(n, i) in edit.model.nodes" :key="i" class="line">
          <span class="seq">{{ i + 1 }}</span>
          <el-input v-model="n.nodeName" placeholder="节点名称" style="width: 140px" />
          <el-select v-model="n.approverType" style="width: 90px" @change="n.approverRef = ''">
            <el-option label="角色" value="ROLE" />
            <el-option label="指定人" value="USER" />
          </el-select>
          <div style="width: 180px">
            <FieldInput
              v-if="n.approverType === 'ROLE'"
              v-model="n.approverRef"
              :field="{ prop: 'r', label: '角色', type: 'select', options: { remote: '/sys/roles', label: 'name', value: 'code' } }"
            />
            <FieldInput
              v-else
              v-model="n.approverRef"
              :field="{ prop: 'u', label: '审批人', type: 'select', options: { remote: '/sys/user-options', label: 'displayName' } }"
            />
          </div>
          <el-select v-model="n.mode" style="width: 110px">
            <el-option label="任一人通过" value="ANY" />
            <el-option label="全部通过" value="ALL" />
          </el-select>
          <el-button link :disabled="i === 0" @click="move(edit.model.nodes, i, -1)">上移</el-button>
          <el-button link :disabled="i === edit.model.nodes.length - 1" @click="move(edit.model.nodes, i, 1)">下移</el-button>
          <el-button link type="danger" :disabled="edit.model.nodes.length === 1" @click="edit.model.nodes.splice(i, 1)">删除</el-button>
        </div>
        <el-button size="small" @click="edit.model.nodes.push({ nodeName: '', approverType: 'ROLE', approverRef: '', mode: 'ANY' })">添加节点</el-button>
        <p class="muted">节点找不到可用审批人时，单据进入「缺审批人」状态并通知国家管理员。</p>
      </el-form>
      <template #footer>
        <el-button @click="edit.visible = false">取消</el-button>
        <el-button type="primary" :loading="edit.saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="versions.visible" title="版本历史" size="560px">
      <el-timeline>
        <el-timeline-item v-for="v in versions.list" :key="v.id" :timestamp="`v${v.versionNo} · ${v.effectiveFrom}`" placement="top">
          <StatusTag :status="v.status" />
          <span class="muted"> 使用该版本的审批 {{ v.instanceCount ?? 0 }} 次 · 创建 <DateTimeText :value="v.createdAt" /></span>
          <div v-for="(c, i) in v.conditions" :key="i" class="muted">{{ conditionText(c) }}</div>
          <div class="muted">{{ v.nodes.map((n) => n.nodeName).join(' → ') }}</div>
        </el-timeline-item>
      </el-timeline>
      <h4>操作日志</h4>
      <AuditTimeline resource-type="approval-rule" :resource-id="versions.auditId" />
    </el-drawer>
  </div>
</template>

<style scoped>
.line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.seq {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--el-color-primary-light-8);
  color: var(--el-color-primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

.mb {
  margin-bottom: 12px;
}
</style>
