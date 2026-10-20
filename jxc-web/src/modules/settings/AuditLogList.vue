<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { http } from '@/api/http'
import type { PageResult } from '@/api/types'
import DateTimeText from '@/components/DateTimeText.vue'
import { RESOURCE_TYPES, labelOf } from './constants'

interface AuditRow {
  id: number
  action: string
  resourceType: string
  resourceId: number
  userName: string
  beforeValue: Record<string, unknown> | null
  afterValue: Record<string, unknown> | null
  reason?: string
  occurredAt: string
}

const query = reactive({ keyword: '', resourceType: '', range: [] as string[] })
const rows = ref<AuditRow[]>([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await http.get<PageResult<AuditRow>>('/sys/audit-logs', {
      keyword: query.keyword || undefined,
      resourceType: query.resourceType || undefined,
      from: query.range?.[0],
      to: query.range?.[1],
      page: page.value,
      size: 20,
    })
    rows.value = res.records
    total.value = res.total
  } finally {
    loading.value = false
  }
}

const show = (v: unknown) => (v === undefined || v === null ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v))

function diff(row: AuditRow) {
  const before = row.beforeValue ?? {}
  const after = row.afterValue ?? {}
  const skip = new Set(['version', 'updatedAt', 'createdAt', 'updatedBy'])
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => !skip.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => ({ field: k, before: show(before[k]), after: show(after[k]) }))
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-card">
      <div class="page-title"><h2>审计日志</h2></div>
      <el-form inline class="search-form" @submit.prevent="(page = 1), load()">
        <el-form-item label="关键字">
          <el-input v-model="query.keyword" placeholder="动作 / 操作人 / 原因" clearable style="width: 180px" />
        </el-form-item>
        <el-form-item label="对象">
          <el-select v-model="query.resourceType" clearable filterable style="width: 150px">
            <el-option v-for="r in RESOURCE_TYPES" :key="String(r.value)" v-bind="r" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker v-model="query.range" type="daterange" value-format="YYYY-MM-DD" style="width: 240px" />
        </el-form-item>
        <el-form-item><el-button type="primary" native-type="submit">查询</el-button></el-form-item>
      </el-form>
      <div class="table-scroll">
        <el-table v-loading="loading" :data="rows" border row-key="id">
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="expand">
                <el-table :data="diff(row)" size="small" border empty-text="没有字段变化">
                  <el-table-column prop="field" label="字段" width="160" />
                  <el-table-column prop="before" label="修改前" min-width="200" show-overflow-tooltip />
                  <el-table-column prop="after" label="修改后" min-width="200" show-overflow-tooltip />
                </el-table>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="时间" width="190">
            <template #default="{ row }"><DateTimeText :value="row.occurredAt" /></template>
          </el-table-column>
          <el-table-column prop="userName" label="操作人" width="150" />
          <el-table-column prop="action" label="动作" width="130" />
          <el-table-column label="对象" min-width="160">
            <template #default="{ row }">{{ labelOf(RESOURCE_TYPES, row.resourceType) }} <span class="muted">#{{ row.resourceId }}</span></template>
          </el-table-column>
          <el-table-column label="原因" min-width="160">
            <template #default="{ row }">{{ row.reason || '-' }}</template>
          </el-table-column>
        </el-table>
      </div>
      <el-pagination v-model:current-page="page" :total="total" :page-size="20" layout="total, prev, pager, next" class="pager" @current-change="load" />
    </div>
  </div>
</template>

<style scoped>
.expand {
  padding: 8px 16px;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
