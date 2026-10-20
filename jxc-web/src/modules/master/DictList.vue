<script setup lang="ts">
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { DICT_TYPES, STATUS_OPTIONS } from './options'

const columns: ColumnDef[] = [
  { prop: 'dictType', label: '字典类型', type: 'option', options: DICT_TYPES, width: 140 },
  { prop: 'code', label: '编码', width: 180 },
  { prop: 'label', label: '名称', minWidth: 160 },
  { prop: 'seq', label: '排序', width: 80 },
  { prop: 'status', label: '状态', type: 'status', width: 80 },
]

const searchFields: FieldDef[] = [
  { prop: 'dictType', label: '字典类型', type: 'select', options: DICT_TYPES },
  { prop: 'keyword', label: '关键字' },
  { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS },
]

const formFields: FieldDef[] = [
  { prop: 'dictType', label: '字典类型', type: 'select', options: DICT_TYPES, required: true, editDisabled: true },
  { prop: 'code', label: '编码', required: true, editDisabled: true, tip: '业务单据保存编码，创建后不能修改' },
  { prop: 'label', label: '名称', required: true },
  { prop: 'seq', label: '排序', type: 'number', min: 0, default: 1 },
]
</script>

<template>
  <CrudPage
    title="业务字典"
    resource="/md/dicts"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    edit-perm="md:dict:edit"
    audit-type="dict"
    form-width="560px"
  />
</template>
