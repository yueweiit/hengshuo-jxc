<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { http } from '@/api/http'
import type { Country } from '@/api/types'
import StatusTag from '@/components/StatusTag.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import type { TemplateItem } from './types'

interface TemplateRow {
  id: number
  sourceCountryId: number
  sourceCountryName: string
  versionNo: number
  status: string
  changeNote: string
  publishedAt: string | null
  itemCount: number
  items: TemplateItem[]
}

const rows = ref<TemplateRow[]>([])
const countries = ref<Country[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    rows.value = await http.get<TemplateRow[]>('/sys/country-templates')
  } finally {
    loading.value = false
  }
}

const itemsVisible = ref(false)
const current = ref<TemplateRow | null>(null)
function openItems(row: TemplateRow) {
  current.value = row
  itemsVisible.value = true
}

async function publish(row: TemplateRow) {
  await ElMessageBox.confirm(`发布 ${row.sourceCountryName} 模板 v${row.versionNo}？发布后可用于新建国家和已有国家升级。`, '发布模板', { type: 'warning' })
  await http.post(`/sys/country-templates/${row.id}/publish`)
  ElMessage.success('已发布')
  load()
}

const draft = reactive({ visible: false, sourceCountryId: undefined as number | undefined, changeNote: '', saving: false })
async function openDraft() {
  countries.value = (await http.get<Country[]>('/sys/countries')).filter((c) => c.status === 'ACTIVE')
  Object.assign(draft, { visible: true, sourceCountryId: countries.value[0]?.id, changeNote: '' })
}
async function submitDraft() {
  if (!draft.sourceCountryId || !draft.changeNote.trim()) {
    ElMessage.warning('请选择来源国家并填写变更说明')
    return
  }
  draft.saving = true
  try {
    await http.post('/sys/country-templates', { sourceCountryId: draft.sourceCountryId, changeNote: draft.changeNote })
    ElMessage.success('已生成模板草稿')
    draft.visible = false
    load()
  } finally {
    draft.saving = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>国家模板版本</h2>
        <div class="toolbar">
          <el-button type="primary" @click="openDraft"><el-icon><Plus /></el-icon>从国家当前配置生成新版本</el-button>
        </div>
      </div>
      <p class="muted">模板只包含配置结构；带「需复核」的条目复制到新国家后要由当地负责人逐项确认，敏感条目永远不会被复制。</p>
      <el-table v-loading="loading" :data="rows" border stripe row-key="id">
        <el-table-column prop="sourceCountryName" label="来源国家" width="120" />
        <el-table-column label="版本" width="80">
          <template #default="{ row }">v{{ row.versionNo }}</template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }"><StatusTag :status="row.status" /></template>
        </el-table-column>
        <el-table-column prop="itemCount" label="条目数" width="80" />
        <el-table-column prop="changeNote" label="变更说明" min-width="260" show-overflow-tooltip />
        <el-table-column label="发布时间" min-width="170">
          <template #default="{ row }"><DateTimeText :value="row.publishedAt" /></template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openItems(row)">条目</el-button>
            <el-button v-if="row.status === 'DRAFT'" link type="success" @click="publish(row)">发布</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-drawer v-model="itemsVisible" :title="`${current?.sourceCountryName} 模板 v${current?.versionNo}`" size="560px">
      <el-table v-if="current" :data="current.items" size="small" border>
        <el-table-column prop="label" label="条目" min-width="260" />
        <el-table-column label="标记" width="130">
          <template #default="{ row }">
            <el-tag v-if="row.sensitive" type="danger" size="small">禁止复制</el-tag>
            <el-tag v-else-if="row.requiresReview" type="warning" size="small">需复核</el-tag>
            <span v-else class="muted">直接复制</span>
          </template>
        </el-table-column>
      </el-table>
    </el-drawer>

    <el-dialog v-model="draft.visible" title="生成模板新版本" width="480px" append-to-body>
      <el-form label-width="90px">
        <el-form-item label="来源国家">
          <el-select v-model="draft.sourceCountryId" style="width: 100%">
            <el-option v-for="c in countries" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="变更说明">
          <el-input v-model="draft.changeNote" type="textarea" :rows="3" placeholder="说明本版本相对上一版的变化，升级时展示给各国负责人" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="draft.visible = false">取消</el-button>
        <el-button type="primary" :loading="draft.saving" @click="submitDraft">生成草稿</el-button>
      </template>
    </el-dialog>
  </div>
</template>
