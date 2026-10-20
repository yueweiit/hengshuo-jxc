<script setup lang="ts">
import CrudPage from '@/components/crud/CrudPage.vue'
import FieldInput from '@/components/crud/FieldInput.vue'
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http } from '@/api/http'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import type { OptionItem } from '@/stores/options'
import { WAREHOUSE_SOURCE } from '@/modules/master/options'
import { DOC_TYPES, FIELD_GROUPS, labelOf } from '../constants'

interface Delegation { id: number; toUserName: string; fromUserName: string; scope: string[] | string; startAt: string; endAt: string; reason: string; status: string; canRevoke: boolean }
const delegationVisible = ref(false)
const delegationRows = ref<Delegation[]>([])
const delegation = reactive({ toUserId: undefined as number | undefined, scope: [] as string[], startAt: '', endAt: '', reason: '' })
async function loadDelegations() { delegationRows.value = (await http.get<{ records: Delegation[] }>('/sys/delegations')).records }
async function openDelegations() { await loadDelegations(); delegationVisible.value = true }
async function saveDelegation() {
  if (!delegation.toUserId || !delegation.scope.length || !delegation.endAt || !delegation.reason.trim()) { ElMessage.warning('请选择代理人、单据类型和截止时间，并填写原因'); return }
  await http.post('/sys/delegations', { ...delegation, startAt: delegation.startAt ? new Date(delegation.startAt).toISOString() : undefined, endAt: new Date(delegation.endAt).toISOString() })
  ElMessage.success('审批代理已设置')
  Object.assign(delegation, { toUserId: undefined, scope: [], startAt: '', endAt: '', reason: '' })
  await loadDelegations()
}
async function revokeDelegation(row: Delegation) { await http.post(`/sys/delegations/${row.id}/revoke`); await loadDelegations() }

const WATCH_TYPES: OptionItem[] = [
  { label: '看单（只读）', value: 'VIEWER' },
  { label: '抄送通知', value: 'CC' },
]

const TARGET_TYPES: OptionItem[] = [
  { label: '按仓库', value: 'WAREHOUSE_RULE' },
  { label: '按单据类型', value: 'DOC_TYPE_RULE' },
]

const columns: ColumnDef[] = [
  { prop: 'watchType', label: '方式', type: 'option', options: WATCH_TYPES, width: 120 },
  { prop: 'targetType', label: '范围', type: 'option', options: TARGET_TYPES, width: 110 },
  { prop: 'docType', label: '单据类型', type: 'option', options: DOC_TYPES, width: 110 },
  { prop: 'warehouseName', label: '仓库', minWidth: 140 },
  { prop: 'userName', label: '人员', minWidth: 140 },
  { prop: 'fieldGroups', label: '允许展示字段组', type: 'tags', minWidth: 160 },
  { prop: 'status', label: '状态', type: 'status', width: 80 },
]

const searchFields: FieldDef[] = [
  { prop: 'watchType', label: '方式', type: 'select', options: WATCH_TYPES },
  { prop: 'docType', label: '单据类型', type: 'select', options: DOC_TYPES },
]

const formFields: FieldDef[] = [
  { prop: 'watchType', label: '方式', type: 'select', options: WATCH_TYPES, required: true, default: 'VIEWER' },
  { prop: 'targetType', label: '范围', type: 'select', options: TARGET_TYPES, required: true, default: 'WAREHOUSE_RULE' },
  { prop: 'docType', label: '单据类型', type: 'select', options: DOC_TYPES, required: true },
  { prop: 'warehouseId', label: '仓库', type: 'select', options: WAREHOUSE_SOURCE, tip: '按仓库时必填' },
  { prop: 'userId', label: '人员', type: 'select', options: { remote: '/sys/user-options', label: 'displayName' }, required: true },
  {
    prop: 'fieldGroups',
    label: '允许展示字段组',
    type: 'multi-select',
    options: FIELD_GROUPS,
    default: [],
    tip: '只能选择配置人与接收人当前均有权查看的字段组；此设置不新增权限',
  },
]
</script>

<template>
  <CrudPage
    title="看单与抄送"
    resource="/sys/doc-watchers"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    edit-perm="sys:watcher:edit"
    audit-type="doc-watcher"
  >
    <template #header>
      <p class="muted">看单人只能查看、不能修改单据；收到抄送的人打开单据时，仍按其本人的数据范围校验。</p>
      <el-button @click="openDelegations">我的审批代理</el-button>
      <el-dialog v-model="delegationVisible" title="限时审批代理" width="840px" append-to-body>
        <p class="muted">代理人须有自己的单据查看权限和数据范围，代理不转移角色，也不授予支付、出库或记账权限。</p>
        <el-form label-width="100px">
          <el-form-item label="代理人" required><FieldInput v-model="delegation.toUserId" :field="{ prop: 'toUserId', label: '代理人', type: 'select', options: { remote: '/sys/user-options', label: 'displayName' } }" /></el-form-item>
          <el-form-item label="单据类型" required><FieldInput v-model="delegation.scope" :field="{ prop: 'scope', label: '单据类型', type: 'multi-select', options: DOC_TYPES }" /></el-form-item>
          <el-form-item label="开始时间"><el-date-picker v-model="delegation.startAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" /></el-form-item>
          <el-form-item label="结束时间" required><el-date-picker v-model="delegation.endAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" /></el-form-item>
          <el-form-item label="代理原因" required><el-input v-model="delegation.reason" /></el-form-item>
          <el-button type="primary" @click="saveDelegation">设置代理</el-button>
        </el-form>
        <el-table :data="delegationRows" style="margin-top: 16px">
          <el-table-column prop="fromUserName" label="被代理人" /><el-table-column prop="toUserName" label="代理人" />
          <el-table-column prop="endAt" label="结束时间" /><el-table-column prop="status" label="状态" />
          <el-table-column label="操作"><template #default="{ row }"><el-button v-if="row.status === 'ACTIVE' && row.canRevoke" link @click="revokeDelegation(row)">撤销我的代理</el-button></template></el-table-column>
        </el-table>
      </el-dialog>
    </template>
    <template #col-fieldGroups="{ row }">
      <el-tag v-for="g in row.fieldGroups" :key="g" size="small" class="tag">{{ labelOf(FIELD_GROUPS, g) }}</el-tag>
      <span v-if="!row.fieldGroups?.length" class="muted">无</span>
    </template>
  </CrudPage>
</template>

<style scoped>
.tag {
  margin-right: 4px;
}
</style>
