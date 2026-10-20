<script setup lang="ts">
import { nextTick, reactive, ref } from 'vue'
import { ElMessage, type ElTree } from 'element-plus'
import { http } from '@/api/http'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { STATUS_OPTIONS } from '@/modules/master/options'
import { ROLE_TYPES } from '../constants'

interface PermNode {
  code: string
  name: string
  children?: PermNode[]
}

interface RoleRow {
  id: number
  code: string
  name: string
  status?: string
  version?: number
  permissions: string[]
  fieldPolicies: Record<string, string>
}

const me = useUserStore()
const crud = ref<{ reload: () => Promise<void> }>()

const columns: ColumnDef[] = [
  { prop: 'code', label: '编码', width: 150 },
  { prop: 'name', label: '名称', minWidth: 150 },
  { prop: 'roleType', label: '类型', type: 'option', options: ROLE_TYPES, width: 80 },
  { prop: 'userCount', label: '人数', width: 70 },
  { prop: 'isTemplate', label: '可复制到新国家', type: 'bool', width: 130 },
  { prop: 'status', label: '状态', type: 'status', width: 80 },
]

const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '关键字' },
  { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS },
]

const formFields: FieldDef[] = [
  { prop: 'code', label: '编码', required: true, editDisabled: true },
  { prop: 'name', label: '名称', required: true },
  { prop: 'roleType', label: '类型', type: 'select', options: ROLE_TYPES, required: true, default: 'BUSINESS' },
  { prop: 'isTemplate', label: '可复制', type: 'switch', default: true, tip: '国家模板复制时带上该角色（不含人员）' },
]

// ---------- 权限点 ----------
const tree = ref<PermNode[]>([])
const fieldGroups = ref<{ code: string; name: string }[]>([])
const treeRef = ref<InstanceType<typeof ElTree>>()
const perm = reactive({ visible: false, saving: false, role: null as RoleRow | null })

async function ensureTree() {
  if (tree.value.length) return
  const res = await http.get<{ tree: PermNode[]; fieldGroups: { code: string; name: string }[] }>('/sys/permissions/tree')
  tree.value = res.tree
  fieldGroups.value = res.fieldGroups
}

/** 把 org:* 之类的模块通配展开为具体权限点，便于在树上勾选 */
function expand(perms: string[]) {
  const leaves = tree.value.flatMap((m) => m.children ?? [])
  return leaves
    .filter((l) => perms.some((p) => p === l.code || (p.endsWith(':*') && l.code.startsWith(p.slice(0, -1)))))
    .map((l) => l.code)
}

async function openPerm(row: RoleRow) {
  await ensureTree()
  const fresh = await http.get<RoleRow>(`/sys/roles/${row.id}`)
  perm.role = fresh
  perm.visible = true
  await nextTick()
  treeRef.value?.setCheckedKeys(expand(fresh.permissions))
}

async function savePerm() {
  const checked = (treeRef.value?.getCheckedKeys(true) ?? []) as string[]
  perm.saving = true
  try {
    await http.put(`/sys/roles/${perm.role!.id}/permissions`, { permissions: checked, version: perm.role!.version })
    ElMessage.success('权限已保存')
    perm.visible = false
    await me.loadMe()
    crud.value?.reload()
  } finally {
    perm.saving = false
  }
}

// ---------- 字段权限 ----------
const field = reactive({ visible: false, saving: false, role: null as RoleRow | null, policies: {} as Record<string, string> })

async function openField(row: RoleRow) {
  await ensureTree()
  const fresh = await http.get<RoleRow>(`/sys/roles/${row.id}`)
  const policies: Record<string, string> = {}
  for (const g of fieldGroups.value) policies[g.code] = fresh.fieldPolicies?.[g.code] ?? 'HIDDEN'
  Object.assign(field, { visible: true, role: fresh, policies })
}

async function saveField() {
  field.saving = true
  try {
    await http.put(`/sys/roles/${field.role!.id}/field-policies`, { fieldPolicies: field.policies, version: field.role!.version })
    ElMessage.success('字段权限已保存')
    field.visible = false
    await me.loadMe()
    crud.value?.reload()
  } finally {
    field.saving = false
  }
}
</script>

<template>
  <CrudPage
    ref="crud"
    title="角色与权限"
    resource="/sys/roles"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    edit-perm="sys:role:edit"
    audit-type="role"
    form-width="560px"
  >
    <template #header>
      <p class="muted">功能权限决定能看哪些菜单和按钮；字段权限决定成本、价格、银行信息等敏感字段是否可见。两者都按国家生效。</p>
    </template>
    <template #row-actions="{ row }">
      <el-button link type="primary" @click="openPerm(row)">功能权限</el-button>
      <el-button link type="primary" @click="openField(row)">字段权限</el-button>
    </template>
  </CrudPage>

  <el-drawer v-model="perm.visible" :title="`${perm.role?.name} · 功能权限`" size="460px">
    <el-alert v-if="perm.role?.permissions.includes('*')" type="info" :closable="false" title="该角色拥有全部权限，不能单独调整" />
    <el-tree
      v-else
      ref="treeRef"
      :data="tree"
      node-key="code"
      show-checkbox
      default-expand-all
      :props="{ label: 'name', children: 'children' }"
    >
      <template #default="{ data }">
        <span>{{ data.name }}</span>
        <span v-if="!data.children" class="muted code">{{ data.code }}</span>
      </template>
    </el-tree>
    <template #footer>
      <el-button @click="perm.visible = false">取消</el-button>
      <el-button v-if="!perm.role?.permissions.includes('*')" type="primary" :loading="perm.saving" @click="savePerm">保存</el-button>
    </template>
  </el-drawer>

  <el-dialog v-model="field.visible" :title="`${field.role?.name} · 字段权限`" width="520px">
    <el-table :data="fieldGroups" size="small" border>
      <el-table-column prop="name" label="字段组" width="120" />
      <el-table-column label="权限">
        <template #default="{ row: g }">
          <el-radio-group v-model="field.policies[g.code]" size="small">
            <el-radio-button value="HIDDEN">不可见</el-radio-button>
            <el-radio-button value="READ">只读</el-radio-button>
            <el-radio-button value="WRITE">可编辑</el-radio-button>
          </el-radio-group>
        </template>
      </el-table-column>
    </el-table>
    <p class="muted">不可见的字段在接口层就被移除，导出和打印同样不包含。</p>
    <template #footer>
      <el-button @click="field.visible = false">取消</el-button>
      <el-button type="primary" :loading="field.saving" @click="saveField">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.code {
  margin-left: 8px;
  font-size: 12px;
}
</style>
