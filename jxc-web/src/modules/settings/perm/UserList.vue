<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http } from '@/api/http'
import type { PageResult } from '@/api/types'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { useOptionsStore } from '@/stores/options'
import CrudPage from '@/components/crud/CrudPage.vue'
import FieldInput from '@/components/crud/FieldInput.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { STATUS_OPTIONS, ENTITY_SOURCE, STORE_SOURCE, WAREHOUSE_SOURCE } from '@/modules/master/options'
import type { OptionItem } from '@/stores/options'

interface UserRow {
  id: number
  username: string
  displayName: string
  status?: string
  version?: number
}

interface RoleRow {
  id: number
  code: string
  name: string
  roleType: string
}

interface ScopeRow {
  scopeType: 'COUNTRY_ALL' | 'ENTITY' | 'BOOK' | 'STORE' | 'WAREHOUSE'
  scopeRefId: number | null
  effectiveFrom?: string | null
  effectiveTo?: string | null
}

const country = useCountryStore()
const me = useUserStore()
const optionsStore = useOptionsStore()
const crud = ref<{ reload: () => Promise<void> }>()

const columns: ColumnDef[] = [
  { prop: 'username', label: '账号', width: 120, fixed: 'left' },
  { prop: 'displayName', label: '姓名', minWidth: 150 },
  { prop: 'phone', label: '电话', width: 150 },
  { prop: 'email', label: '邮箱', minWidth: 170 },
  { prop: 'roleNames', label: '本国角色', type: 'tags', minWidth: 180 },
  { prop: 'scopeText', label: '本国数据范围', minWidth: 160 },
  { prop: 'status', label: '状态', type: 'status', width: 80 },
]

const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '关键字', placeholder: '账号 / 姓名 / 电话' },
  { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS },
]

const formFields: FieldDef[] = [
  { prop: 'username', label: '账号', required: true, editDisabled: true },
  { prop: 'displayName', label: '姓名', required: true },
  { prop: 'phone', label: '电话' },
  { prop: 'email', label: '邮箱' },
  { prop: 'password', label: '初始密码', type: 'password', createOnly: true, required: true, placeholder: '至少10位', rules: [{ min: 10, message: '密码至少10位', trigger: ['blur', 'change'] }] },
]

// ---------- 授权 ----------
const grant = reactive({
  visible: false,
  saving: false,
  user: null as UserRow | null,
  roles: [] as RoleRow[],
  roleIds: [] as number[],
  dataScopes: [] as ScopeRow[],
  books: [] as OptionItem[],
})

const noScope = computed(() => !grant.dataScopes.length)
const scopeTypes = [{ label: '本国全部', value: 'COUNTRY_ALL' }, { label: '经营主体', value: 'ENTITY' }, { label: '账套', value: 'BOOK' }, { label: '门店', value: 'STORE' }, { label: '仓库', value: 'WAREHOUSE' }]
function scopeOptions(type: ScopeRow['scopeType']) {
  if (type === 'ENTITY') return ENTITY_SOURCE
  if (type === 'BOOK') return grant.books
  return type === 'STORE' ? STORE_SOURCE : WAREHOUSE_SOURCE
}

async function openGrant(row: UserRow) {
  const [roles, grants, books, fresh] = await Promise.all([
    http.get<PageResult<RoleRow>>('/sys/roles', { status: 'ENABLED', size: 200 }),
    http.get<{ roleIds: number[]; dataScopes: ScopeRow[]; version?: number }>(`/sys/users/${row.id}/grants`),
    http.get<{ id: number; name: string }[]>('/org/books'),
    http.get<UserRow>(`/sys/users/${row.id}`),
  ])
  Object.assign(grant, {
    visible: true,
    user: { ...fresh, version: grants.version ?? fresh.version },
    roles: roles.records,
    roleIds: grants.roleIds,
    dataScopes: grants.dataScopes,
    books: books.map((b) => ({ label: b.name, value: b.id })),
  })
}

async function saveGrant() {
  if (grant.roleIds.length && noScope.value) {
    await ElMessageBox.confirm('已分配角色但没有数据范围，该账号将看不到任何业务数据。是否继续？', '提示', { type: 'warning' })
  }
  grant.saving = true
  try {
    const id = grant.user!.id
    const saved = await http.put<{ version?: number }>(`/sys/users/${id}/grants`, {
      roleIds: grant.roleIds, dataScopes: grant.dataScopes, version: grant.user!.version,
    })
    if (saved.version !== undefined) grant.user!.version = saved.version
    ElMessage.success('授权已保存，对方重新进入页面后生效')
    grant.visible = false
    optionsStore.invalidate('/sys/users')
    if (id === me.user?.id) await me.loadMe()
    crud.value?.reload()
  } finally {
    grant.saving = false
  }
}

async function resetPassword(row: UserRow) {
  await ElMessageBox.confirm(`重置 ${row.displayName} 的密码？对方的登录会话将全部失效。`, '重置密码', { type: 'warning' })
  const res = await http.post<{ password: string }>(`/sys/users/${row.id}/reset-password`)
  await ElMessageBox.alert(`临时密码：${res.password}`, '已重置', { confirmButtonText: '已记录' })
}
</script>

<template>
  <CrudPage
    ref="crud"
    title="用户与授权"
    resource="/sys/users"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    edit-perm="sys:user:edit"
    audit-type="user"
  >
    <template #header>
      <p class="muted">
        账号全局唯一；角色和数据范围按国家分别授予。当前在为<strong>{{ country.current?.name }}</strong>授权，未授权的账号登录后看不到该国家。
      </p>
    </template>
    <template #row-actions="{ row }">
      <el-button link type="primary" @click="openGrant(row)">授权</el-button>
      <el-button link @click="resetPassword(row)">重置密码</el-button>
    </template>
  </CrudPage>

  <el-drawer v-model="grant.visible" :title="`${grant.user?.displayName} 在${country.current?.name}的授权`" size="480px">
    <h4>角色</h4>
    <el-checkbox-group v-model="grant.roleIds" class="roles">
      <el-checkbox v-for="r in grant.roles" :key="r.id" :value="r.id">
        {{ r.name }} <span class="muted">{{ r.code }}</span>
      </el-checkbox>
    </el-checkbox-group>
    <h4>数据范围</h4>
    <div v-for="(scope, index) in grant.dataScopes" :key="index" class="scope-entry">
      <div class="field">
        <el-select v-model="scope.scopeType" @change="scope.scopeRefId = null"><el-option v-for="item in scopeTypes" :key="item.value" :label="item.label" :value="item.value" /></el-select>
        <el-button link type="danger" @click="grant.dataScopes.splice(index, 1)">移除</el-button>
      </div>
      <FieldInput v-if="scope.scopeType !== 'COUNTRY_ALL'" v-model="scope.scopeRefId" :field="{ prop: 'scopeRefId', label: '授权对象', type: 'select', options: scopeOptions(scope.scopeType) }" />
      <div class="field"><span>开始</span><el-date-picker v-model="scope.effectiveFrom" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" placeholder="立即生效" /></div>
      <div class="field"><span>结束</span><el-date-picker v-model="scope.effectiveTo" type="datetime" value-format="YYYY-MM-DDTHH:mm:ssZ" placeholder="长期有效" /></div>
    </div>
    <el-button class="field" @click="grant.dataScopes.push({ scopeType: 'WAREHOUSE', scopeRefId: null })">增加数据范围</el-button>
    <p class="muted">主体授权覆盖所属仓店和账套；门店授权覆盖门店仓。授权在有效期内生效，不能超出自己的权限和范围。</p>
    <el-alert v-if="noScope" type="warning" :closable="false" show-icon title="没有数据范围：列表和统计将为空" />
    <template #footer>
      <el-button @click="grant.visible = false">取消</el-button>
      <el-button type="primary" :loading="grant.saving" @click="saveGrant">保存</el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
.roles {
  display: flex;
  flex-direction: column;
}

.field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.field > span {
  width: 40px;
  flex-shrink: 0;
}
.scope-entry { padding: 10px 0; border-bottom: 1px solid var(--el-border-color-light); }
</style>
