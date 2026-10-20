<script setup lang="ts">
import { computed } from 'vue'
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { useUserStore } from '@/stores/user'
import { CUSTOMER_TYPES, STATUS_OPTIONS, STORE_SOURCE } from './options'

interface AddressRow {
  contactName: string
  contactPhone: string
  address: string
  isDefault: boolean
}

interface Customer {
  id: number
  status?: string
  version?: number
  addresses?: AddressRow[]
}

const user = useUserStore()

const columns: ColumnDef[] = [
  { prop: 'code', label: '客户编码', width: 100, fixed: 'left' },
  { prop: 'name', label: '名称', minWidth: 180 },
  { prop: 'customerType', label: '类型', type: 'option', options: CUSTOMER_TYPES, width: 80 },
  { prop: 'groupName', label: '客户组', width: 100 },
  { prop: 'levelName', label: '等级', width: 80 },
  { prop: 'phone', label: '电话', width: 150 },
  { prop: 'salesOwnerName', label: '销售归属', width: 140 },
  { prop: 'storeName', label: '归属门店', width: 140 },
  { prop: 'status', label: '状态', type: 'status', width: 80 },
]

const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '关键字', placeholder: '编码 / 名称 / 电话 / 税号' },
  { prop: 'groupId', label: '客户组', type: 'select', options: { remote: '/md/customer-groups' } },
  { prop: 'levelId', label: '等级', type: 'select', options: { remote: '/md/customer-levels' } },
  { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS },
]

const formFields = computed<FieldDef[]>(() => [
  { prop: 'code', label: '客户编码', required: true, editDisabled: true },
  { prop: 'name', label: '名称', required: true },
  { prop: 'customerType', label: '类型', type: 'select', options: CUSTOMER_TYPES, required: true, default: 'COMPANY' },
  { prop: 'taxId', label: '税号' },
  { prop: 'groupId', label: '客户组', type: 'select', options: { remote: '/md/customer-groups' } },
  { prop: 'levelId', label: '等级', type: 'select', options: { remote: '/md/customer-levels' } },
  { prop: 'phone', label: '电话' },
  { prop: 'email', label: '邮箱' },
  ...(user.hasPerm('sys:user:edit')
    ? [{ prop: 'salesOwnerId', label: '销售归属', type: 'select', options: { remote: '/sys/users', label: 'displayName' } } as FieldDef]
    : []),
  { prop: 'storeId', label: '归属门店', type: 'select', options: STORE_SOURCE, tip: '门店员新建时默认归属自己的门店' },
])

function beforeOpen(row: Partial<Customer>) {
  return { ...row, addresses: structuredClone(row.addresses ?? []) }
}

const addressesOf = (m: Record<string, unknown>) => m.addresses as AddressRow[]
function setDefault(m: Record<string, unknown>, idx: number) {
  addressesOf(m).forEach((a, i) => (a.isDefault = i === idx))
}
</script>

<template>
  <CrudPage
    title="客户"
    resource="/md/customers"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    edit-perm="md:customer:edit"
    audit-type="customer"
    form-width="760px"
    :before-open="beforeOpen"
  >
    <template #header>
      <p class="muted">客户的赊销资格、额度和账期不在客户档案中维护，统一在「授信规则」中配置。</p>
    </template>
    <template #form-extra="{ model }">
      <el-divider content-position="left">收货地址</el-divider>
      <el-table :data="addressesOf(model)" size="small" border>
        <el-table-column label="联系人" width="120">
          <template #default="{ row }"><el-input v-model="row.contactName" size="small" /></template>
        </el-table-column>
        <el-table-column label="电话" width="150">
          <template #default="{ row }"><el-input v-model="row.contactPhone" size="small" /></template>
        </el-table-column>
        <el-table-column label="地址" min-width="220">
          <template #default="{ row }"><el-input v-model="row.address" size="small" /></template>
        </el-table-column>
        <el-table-column label="默认" width="70" align="center">
          <template #default="{ row, $index }">
            <el-radio :model-value="row.isDefault" :value="true" @change="setDefault(model, $index)">&nbsp;</el-radio>
          </template>
        </el-table-column>
        <el-table-column width="70">
          <template #default="{ $index }">
            <el-button link type="danger" @click="addressesOf(model).splice($index, 1)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-button
        size="small"
        style="margin-top: 8px"
        @click="addressesOf(model).push({ contactName: '', contactPhone: '', address: '', isDefault: !addressesOf(model).length })"
      >
        添加地址
      </el-button>
    </template>
  </CrudPage>
</template>
