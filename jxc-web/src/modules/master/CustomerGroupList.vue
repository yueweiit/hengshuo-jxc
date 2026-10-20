<script setup lang="ts">
import { ref } from 'vue'
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'

const tab = ref('groups')

const groupColumns: ColumnDef[] = [
  { prop: 'code', label: '编码', width: 140 },
  { prop: 'name', label: '名称', minWidth: 160 },
  { prop: 'status', label: '状态', type: 'status', width: 90 },
]
const groupFields: FieldDef[] = [
  { prop: 'code', label: '编码', required: true, editDisabled: true },
  { prop: 'name', label: '名称', required: true },
]

const levelColumns: ColumnDef[] = [
  { prop: 'code', label: '编码', width: 120 },
  { prop: 'name', label: '名称', minWidth: 140 },
  { prop: 'seq', label: '排序', width: 90 },
  { prop: 'status', label: '状态', type: 'status', width: 90 },
]
const levelFields: FieldDef[] = [
  { prop: 'code', label: '编码', required: true, editDisabled: true },
  { prop: 'name', label: '名称', required: true },
  { prop: 'seq', label: '排序', type: 'number', min: 0, default: 1 },
]
</script>

<template>
  <div>
    <el-tabs v-model="tab" class="tabs">
      <el-tab-pane label="客户组" name="groups" />
      <el-tab-pane label="客户等级" name="levels" />
    </el-tabs>
    <CrudPage
      v-if="tab === 'groups'"
      title="客户组"
      resource="/md/customer-groups"
      :columns="groupColumns"
      :form-fields="groupFields"
      edit-perm="md:customer:edit"
      audit-type="customer-group"
      form-width="520px"
    />
    <CrudPage
      v-else
      title="客户等级"
      resource="/md/customer-levels"
      :columns="levelColumns"
      :form-fields="levelFields"
      edit-perm="md:customer:edit"
      audit-type="customer-level"
      form-width="520px"
    >
      <template #header>
        <p class="muted">等级用于等级价（销售价格表），一个客户只有一个等级。</p>
      </template>
    </CrudPage>
  </div>
</template>

<style scoped>
.tabs {
  padding: 0 16px;
  background: #fff;
  margin: 12px 12px 0;
  border-radius: 6px;
}
</style>
