<script setup lang="ts">
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { ENTITY_SOURCE, STORE_SOURCE } from '@/modules/master/options'
import { TIMEZONES, WAREHOUSE_TYPES } from '../constants'

const columns: ColumnDef[] = [
  { prop: 'code', label: '编码', width: 130 },
  { prop: 'name', label: '名称', minWidth: 150 },
  { prop: 'type', label: '类型', type: 'option', options: WAREHOUSE_TYPES, width: 90 },
  { prop: 'entityName', label: '所属主体', minWidth: 140 },
  { prop: 'storeName', label: '所属门店', minWidth: 140 },
  { prop: 'address', label: '地址', minWidth: 220 },
  { prop: 'timezone', label: '时区', width: 160 },
  { prop: 'status', label: '状态', type: 'status', width: 80 },
]

const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '关键字' },
  { prop: 'type', label: '类型', type: 'select', options: WAREHOUSE_TYPES },
]

const formFields: FieldDef[] = [
  { prop: 'code', label: '编码', required: true, editDisabled: true },
  { prop: 'name', label: '名称', required: true },
  { prop: 'type', label: '类型', type: 'select', options: WAREHOUSE_TYPES, required: true, default: 'WAREHOUSE', editDisabled: true },
  { prop: 'entityId', label: '所属主体', type: 'select', options: ENTITY_SOURCE, required: true },
  { prop: 'storeId', label: '所属门店', type: 'select', options: STORE_SOURCE, tip: '门店仓必须选择门店' },
  { prop: 'timezone', label: '时区', type: 'select', options: TIMEZONES, tip: '留空时使用国家时区' },
  { prop: 'address', label: '地址', span: 24 },
]
</script>

<template>
  <CrudPage
    title="仓库"
    resource="/org/warehouses"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    edit-perm="org:warehouse:edit"
    audit-type="warehouse"
  />
</template>
