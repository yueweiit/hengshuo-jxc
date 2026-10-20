<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { http } from '@/api/http'
import type { Country } from '@/api/types'
import StatusTag from '@/components/StatusTag.vue'
import DateTimeText from '@/components/DateTimeText.vue'

interface CountryRow extends Country {
  blockCount: number
  warnCount: number
  cloneJobId: number | null
}

const router = useRouter()
const rows = ref<CountryRow[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    rows.value = await http.get<CountryRow[]>('/sys/countries')
  } finally {
    loading.value = false
  }
}

const nameOf = (id?: number | null) => rows.value.find((c) => c.id === id)?.name ?? '-'

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>国家配置</h2>
        <div class="toolbar">
          <el-button v-perm="'sys:country:create'" type="primary" @click="router.push('/settings/countries/clone')">
            <el-icon><Plus /></el-icon>从模板新建国家
          </el-button>
        </div>
      </div>
      <p class="muted">新国家通过「已发布模板」复制配置结构；账号授权、银行资料和任何业务数据都不会被复制。</p>
      <div class="table-scroll">
        <el-table v-loading="loading" :data="rows" border stripe row-key="id">
          <el-table-column label="国家" min-width="160">
            <template #default="{ row }">
              <el-link type="primary" @click="router.push(`/settings/countries/${row.id}`)">{{ row.name }}</el-link>
              <span class="muted"> {{ row.code }}</span>
              <el-tag v-if="row.isTest" size="small" type="warning" class="ml">测试</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }"><StatusTag :status="row.status" /></template>
          </el-table-column>
          <el-table-column label="币种" width="80">
            <template #default="{ row }">{{ row.defaultCurrency || '-' }}</template>
          </el-table-column>
          <el-table-column label="时区" min-width="170">
            <template #default="{ row }">{{ row.timezone || '-' }}</template>
          </el-table-column>
          <el-table-column label="来源" width="120">
            <template #default="{ row }">{{ row.sourceCountryId ? nameOf(row.sourceCountryId) : '首个国家' }}</template>
          </el-table-column>
          <el-table-column label="缺项" width="140">
            <template #default="{ row }">
              <el-tag v-if="row.blockCount" type="danger" size="small">阻断 {{ row.blockCount }}</el-tag>
              <el-tag v-if="row.warnCount" type="warning" size="small" class="ml">提示 {{ row.warnCount }}</el-tag>
              <span v-if="!row.blockCount && !row.warnCount" class="muted">无</span>
            </template>
          </el-table-column>
          <el-table-column label="启用时间" min-width="170">
            <template #default="{ row }"><DateTimeText :value="row.activatedAt" :tz="row.timezone || undefined" /></template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="170">
            <template #default="{ row }">
              <el-button link type="primary" @click="router.push(`/settings/countries/${row.id}`)">详情</el-button>
              <el-button
                v-if="row.status === 'DRAFT' && row.cloneJobId"
                v-perm="'sys:country:create'"
                link
                type="warning"
                @click="router.push({ path: '/settings/countries/clone', query: { jobId: row.cloneJobId } })"
              >
                继续配置
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ml {
  margin-left: 6px;
}
</style>
