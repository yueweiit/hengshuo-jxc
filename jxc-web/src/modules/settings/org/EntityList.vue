<script setup lang="ts">
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'

const columns: ColumnDef[] = [
  { prop: 'code', label: '编码', width: 120 },
  { prop: 'name', label: '名称', minWidth: 160 },
  { prop: 'legalName', label: '法定名称', minWidth: 240 },
  { prop: 'taxId', label: '税号', width: 160 },
  { prop: 'status', label: '状态', type: 'status', width: 80 },
]

const searchFields: FieldDef[] = [{ prop: 'keyword', label: '关键字' }]

const formFields: FieldDef[] = [
  { prop: 'code', label: '编码', required: true, editDisabled: true },
  { prop: 'name', label: '名称', required: true },
  { prop: 'legalName', label: '法定名称', span: 24 },
  { prop: 'taxId', label: '税号' },
]
</script>

<template>
  <CrudPage
    title="经营主体"
    resource="/org/entities"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    edit-perm="org:entity:edit"
    audit-type="entity"
  >
    <template #header>
      <p class="muted">经营主体是账套、资金账户和仓库的归属单位。一个国家可以有多个主体。</p>
    </template>
  </CrudPage>
</template>
