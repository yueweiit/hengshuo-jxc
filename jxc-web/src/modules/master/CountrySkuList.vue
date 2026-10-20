<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import type { PageResult } from '@/api/types'
import { useCountryStore } from '@/stores/country'

interface SkuRow {
  id: number
  productId: number
  version?: number
  productCode: string
  name: string
  spec: string
  baseUnit: string
  categoryName: string
  productStatus: string
  enabled: boolean
  localName: string
  taxCategory: string
}

const country = useCountryStore()
const query = reactive({ keyword: '', enabled: '' })
const rows = ref<SkuRow[]>([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)
const savingId = ref<number | null>(null)
const saveIntent = createCommandIntent()

async function load() {
  loading.value = true
  try {
    const res = await http.get<PageResult<SkuRow>>('/md/country-skus', {
      keyword: query.keyword || undefined,
      enabled: query.enabled || undefined,
      page: page.value,
      size: 20,
    })
    rows.value = res.records
    total.value = res.total
  } finally {
    loading.value = false
  }
}

async function save(row: SkuRow, patch: Partial<SkuRow>) {
  savingId.value = row.productId
  try {
    const saved = await http.putIdem<{ version?: number }>(`/md/country-skus/${row.productId}`, { ...patch, version: row.version }, saveIntent)
    Object.assign(row, patch, { version: saved.version })
    ElMessage.success('已保存')
  } catch {
    await load()
  } finally {
    savingId.value = null
  }
}

const editing = reactive({ visible: false, row: null as SkuRow | null, localName: '', taxCategory: '' })
function openEdit(row: SkuRow) {
  Object.assign(editing, { visible: true, row, localName: row.localName, taxCategory: row.taxCategory })
}
async function submitEdit() {
  await save(editing.row!, { localName: editing.localName, taxCategory: editing.taxCategory })
  editing.visible = false
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>本国经营 SKU · {{ country.current?.name }}</h2>
      </div>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="hint"
        title="商品主档全局共享；这里决定哪些商品在本国经营，以及本地名称和税目。未启用的商品不能在本国下单。"
      />
      <el-form inline class="search-form" @submit.prevent="(page = 1), load()">
        <el-form-item label="关键字">
          <el-input v-model="query.keyword" placeholder="编码 / 名称 / 条码" clearable style="width: 200px" />
        </el-form-item>
        <el-form-item label="本国状态">
          <el-select v-model="query.enabled" clearable style="width: 120px">
            <el-option label="已启用" value="true" />
            <el-option label="未启用" value="false" />
          </el-select>
        </el-form-item>
        <el-form-item><el-button type="primary" native-type="submit">查询</el-button></el-form-item>
      </el-form>
      <div class="table-scroll">
        <el-table v-loading="loading" :data="rows" border stripe row-key="id">
          <el-table-column prop="productCode" label="商品编码" width="110" />
          <el-table-column prop="name" label="名称" min-width="180" />
          <el-table-column prop="categoryName" label="分类" width="110" />
          <el-table-column prop="spec" label="规格" width="110" />
          <el-table-column label="本地名称" min-width="140">
            <template #default="{ row }">{{ row.localName || '-' }}</template>
          </el-table-column>
          <el-table-column label="税目" width="100">
            <template #default="{ row }">{{ row.taxCategory || '-' }}</template>
          </el-table-column>
          <el-table-column label="本国经营" width="100" align="center">
            <template #default="{ row }">
              <el-switch
                :model-value="row.enabled"
                :loading="savingId === row.productId"
                :disabled="row.productStatus !== 'ENABLED' && !row.enabled"
                @change="(v: string | number | boolean) => save(row, { enabled: !!v })"
              />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }"><el-button link type="primary" @click="openEdit(row)">编辑</el-button></template>
          </el-table-column>
        </el-table>
      </div>
      <el-pagination v-model:current-page="page" :total="total" :page-size="20" layout="total, prev, pager, next" class="pager" @current-change="load" />
    </div>

    <el-dialog v-model="editing.visible" :title="`本地信息 · ${editing.row?.productCode}`" width="420px" append-to-body>
      <el-form label-width="80px">
        <el-form-item label="本地名称"><el-input v-model="editing.localName" /></el-form-item>
        <el-form-item label="税目"><el-input v-model="editing.taxCategory" placeholder="例如 IVA16" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editing.visible = false">取消</el-button>
        <el-button type="primary" @click="submitEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.hint {
  margin-bottom: 12px;
}

.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
