<script setup lang="ts">
import { reportError } from '@/api/error-feedback'
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useUserStore } from '@/stores/user'
import FieldInput from '@/components/crud/FieldInput.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import { ALERT_TAG, ALERT_TYPES, ALL_WAREHOUSE_SOURCE, INVENTORY_LIMIT_OWNER_SOURCE, optionText } from '@/modules/shared/bizOptions'

const intent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const user = useUserStore()
const rows = ref<Row[]>([])
const origin = new Map<string, string>()
const loading = ref(false)
const saving = ref(false)
const q = reactive<{ warehouseId?: number; keyword?: string; configured?: string }>({})
const canEdit = computed(() => user.hasPerm('inv:limit:config'))

const snap = (r: Row) => JSON.stringify([r.minQty ?? null, r.maxQty ?? null, !!r.alertEnabled, r.ownerId ?? null])
const dirty = computed(() => rows.value.filter((r) => origin.get(r.id) !== snap(r)))
const invalid = (r: Row) => r.minQty != null && r.maxQty != null && r.minQty > r.maxQty

async function load() {
  loading.value = true
  try {
    rows.value = await allRecords<Row>('/inv/limits', { ...q })
    origin.clear()
    for (const r of rows.value) origin.set(r.id, snap(r))
  } finally {
    loading.value = false
  }
}

async function save() {
  if (dirty.value.some(invalid)) return reportError(new Error('有商品的下限高于上限，请修改后再保存'))
  saving.value = true
  try {
    await http.putIdem('/inv/limits', {
      items: dirty.value.map((r) => ({ warehouseId: r.warehouseId, productId: r.productId, minQty: r.minQty ?? null, maxQty: r.maxQty ?? null, alertEnabled: r.alertEnabled, ownerId: r.ownerId, versionNo: r.versionNo })),
    }, intent)
    ElMessage.success(`已保存 ${dirty.value.length} 条，预警已重新计算`)
    load()
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>库存上下限</h2>
        <div class="toolbar">
          <el-tag v-if="dirty.length" type="warning">{{ dirty.length }} 条未保存</el-tag>
          <el-button v-if="canEdit" type="primary" :disabled="!dirty.length" :loading="saving" @click="save">保存修改</el-button>
        </div>
      </div>
      <el-form inline @submit.prevent="load">
        <el-form-item label="仓库"><div style="width: 180px"><FieldInput v-model="q.warehouseId" :field="{ prop: 'warehouseId', label: '仓库', type: 'select', options: ALL_WAREHOUSE_SOURCE }" clearable /></div></el-form-item>
        <el-form-item label="商品"><el-input v-model="q.keyword" placeholder="编码 / 名称" clearable style="width: 180px" /></el-form-item>
        <el-form-item><el-checkbox v-model="q.configured" true-value="true" :false-value="undefined">只看已设置</el-checkbox></el-form-item>
        <el-form-item><el-button type="primary" native-type="submit">查询</el-button></el-form-item>
      </el-form>
      <p class="muted">按“仓库 + 商品”设置。可售低于下限触发“低于下限”，等于 0 触发“缺货”，实物高于上限触发“高于上限”。每次修改保留历史版本，预警按新设置立即重算。</p>
      <div class="table-scroll">
        <el-table v-loading="loading" :data="rows" border size="small" row-key="id" max-height="620">
          <el-table-column prop="warehouseName" label="仓库" width="130" fixed="left" />
          <el-table-column label="商品" min-width="190" fixed="left"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
          <el-table-column prop="onHandQty" label="实物" width="70" align="right" />
          <el-table-column prop="availableQty" label="可售" width="70" align="right" />
          <el-table-column label="下限" width="120">
            <template #default="{ row }"><el-input-number v-model="row.minQty" :min="0" :controls="false" :disabled="!canEdit" :value-on-clear="null" :class="{ bad: invalid(row) }" style="width: 100%" /></template>
          </el-table-column>
          <el-table-column label="上限" width="120">
            <template #default="{ row }"><el-input-number v-model="row.maxQty" :min="0" :controls="false" :disabled="!canEdit" :value-on-clear="null" :class="{ bad: invalid(row) }" style="width: 100%" /></template>
          </el-table-column>
          <el-table-column label="预警" width="70" align="center">
            <template #default="{ row }"><el-switch v-model="row.alertEnabled" :disabled="!canEdit" size="small" /></template>
          </el-table-column>
          <el-table-column label="负责人" width="160">
            <template #default="{ row }"><FieldInput v-model="row.ownerId" :field="{ prop: 'ownerId', label: '负责人', type: 'select', options: INVENTORY_LIMIT_OWNER_SOURCE }" :disabled="!canEdit" clearable /></template>
          </el-table-column>
          <el-table-column label="当前预警" min-width="120">
            <template #default="{ row }"><el-tag v-for="a in row.alerts" :key="a" :type="ALERT_TAG[a]" size="small">{{ optionText(ALERT_TYPES, a) }}</el-tag></template>
          </el-table-column>
          <el-table-column label="版本" width="60" align="right"><template #default="{ row }">{{ row.versionNo || '-' }}</template></el-table-column>
        </el-table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bad :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}
</style>
