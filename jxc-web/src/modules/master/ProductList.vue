<script setup lang="ts">
import { computed, ref } from 'vue'
import CrudPage from '@/components/crud/CrudPage.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { useUserStore } from '@/stores/user'
import { STATUS_OPTIONS } from './options'

const user = useUserStore()
const canManageCategories = computed(() => !!user.user?.isPlatformAdmin && user.hasPerm('md:product:edit'))
const categoriesVisible = ref(false)
function openCategories() {
  if (canManageCategories.value) categoriesVisible.value = true
}
const categoryColumns: ColumnDef[] = [
  { prop: 'code', label: '编码', width: 150 },
  { prop: 'name', label: '名称', minWidth: 160 },
  { prop: 'parentId', label: '上级分类', type: 'option', options: { remote: '/md/categories' } },
  { prop: 'status', label: '状态', type: 'status', width: 80 },
]
const categoryFields: FieldDef[] = [
  { prop: 'code', label: '编码', required: true },
  { prop: 'name', label: '名称', required: true },
  { prop: 'parentId', label: '上级分类', type: 'select', options: { remote: '/md/categories' } },
]

interface UnitRow {
  unit: string
  factorToBase: number
  isPurchaseDefault: boolean
  isSalesDefault: boolean
}

interface BarcodeRow {
  barcode: string
  unit: string
}

interface Product {
  id: number
  status?: string
  version?: number
  baseUnit?: string
  units?: UnitRow[]
  barcodes?: BarcodeRow[]
}

const columns: ColumnDef[] = [
  { prop: 'productCode', label: '商品编码', width: 110, fixed: 'left' },
  { prop: 'name', label: '名称', minWidth: 180 },
  { prop: 'categoryName', label: '分类', width: 110 },
  { prop: 'brand', label: '品牌', width: 100 },
  { prop: 'spec', label: '规格', width: 110 },
  { prop: 'baseUnit', label: '基础单位', width: 90 },
  { prop: 'barcodeText', label: '条码', minWidth: 150 },
  { prop: 'status', label: '状态', type: 'status', width: 80 },
]

const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '关键字', placeholder: '编码 / 名称 / 条码' },
  { prop: 'categoryId', label: '分类', type: 'select', options: { remote: '/md/categories' } },
  { prop: 'status', label: '状态', type: 'select', options: STATUS_OPTIONS },
]

const formFields: FieldDef[] = [
  { prop: 'productCode', label: '商品编码', required: true, editDisabled: true, tip: '全局唯一，所有国家共用' },
  { prop: 'name', label: '名称', required: true },
  { prop: 'categoryId', label: '分类', type: 'select', options: { remote: '/md/categories' }, required: true },
  { prop: 'brand', label: '品牌' },
  { prop: 'spec', label: '规格' },
  { prop: 'model', label: '型号' },
  { prop: 'baseUnit', label: '基础单位', required: true, default: '件', tip: '库存与统计一律按基础单位' },
  { prop: 'hsCode', label: 'HS 编码' },
  { prop: 'grossWeight', label: '毛重 (kg)', type: 'number', min: 0, precision: 3 },
  { prop: 'volume', label: '体积 (m³)', type: 'number', min: 0, precision: 4 },
]

function beforeOpen(row: Partial<Product>, mode: 'create' | 'edit') {
  const units = row.units?.length
    ? structuredClone(row.units)
    : [{ unit: row.baseUnit ?? '件', factorToBase: 1, isPurchaseDefault: true, isSalesDefault: true }]
  void mode
  return { ...row, units, barcodes: structuredClone(row.barcodes ?? []) }
}

const unitsOf = (m: Record<string, unknown>) => m.units as UnitRow[]
const barcodesOf = (m: Record<string, unknown>) => m.barcodes as BarcodeRow[]

function setDefault(m: Record<string, unknown>, idx: number, key: 'isPurchaseDefault' | 'isSalesDefault') {
  unitsOf(m).forEach((u, i) => (u[key] = i === idx))
}
</script>

<template>
  <CrudPage
    title="商品"
    resource="/md/products"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    edit-perm="md:product:edit"
    audit-type="product"
    form-width="820px"
    :before-open="beforeOpen"
  >
    <template #toolbar>
      <el-button v-if="canManageCategories" @click="openCategories">商品分类</el-button>
    </template>
    <template #form-extra="{ model }">
      <el-divider content-position="left">单位换算</el-divider>
      <el-table :data="unitsOf(model)" size="small" border>
        <el-table-column label="单位" width="120">
          <template #default="{ row }"><el-input v-model="row.unit" size="small" /></template>
        </el-table-column>
        <el-table-column label="1 单位 = N 基础单位" width="190">
          <template #default="{ row }">
            <el-input-number
              v-model="row.factorToBase"
              size="small"
              :min="0.000001"
              :precision="6"
              :disabled="row.unit === model.baseUnit"
              controls-position="right"
            />
          </template>
        </el-table-column>
        <el-table-column label="采购默认" width="90" align="center">
          <template #default="{ row, $index }">
            <el-radio :model-value="row.isPurchaseDefault" :value="true" @change="setDefault(model, $index, 'isPurchaseDefault')">&nbsp;</el-radio>
          </template>
        </el-table-column>
        <el-table-column label="销售默认" width="90" align="center">
          <template #default="{ row, $index }">
            <el-radio :model-value="row.isSalesDefault" :value="true" @change="setDefault(model, $index, 'isSalesDefault')">&nbsp;</el-radio>
          </template>
        </el-table-column>
        <el-table-column>
          <template #default="{ $index }">
            <el-button link type="danger" :disabled="$index === 0" @click="unitsOf(model).splice($index, 1)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-button
        class="add"
        size="small"
        @click="unitsOf(model).push({ unit: '', factorToBase: 1, isPurchaseDefault: false, isSalesDefault: false })"
      >
        添加单位
      </el-button>
      <p class="muted">换算系数被历史单据引用后不能修改，只能新增单位或停用旧单位。</p>

      <el-divider content-position="left">条码</el-divider>
      <el-table :data="barcodesOf(model)" size="small" border>
        <el-table-column label="条码" min-width="200">
          <template #default="{ row }"><el-input v-model="row.barcode" size="small" /></template>
        </el-table-column>
        <el-table-column label="单位" width="140">
          <template #default="{ row }">
            <el-select v-model="row.unit" size="small">
              <el-option v-for="u in unitsOf(model)" :key="u.unit" :label="u.unit" :value="u.unit" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column width="80">
          <template #default="{ $index }">
            <el-button link type="danger" @click="barcodesOf(model).splice($index, 1)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-button class="add" size="small" @click="barcodesOf(model).push({ barcode: '', unit: String(model.baseUnit ?? '') })">添加条码</el-button>
    </template>
  </CrudPage>
  <el-dialog v-model="categoriesVisible" title="商品分类" width="860px" append-to-body destroy-on-close>
    <CrudPage
      v-if="canManageCategories"
      title="全局商品分类"
      resource="/md/categories"
      :columns="categoryColumns"
      :form-fields="categoryFields"
      edit-perm="md:product:edit"
      form-width="560px"
    >
      <template #header><p class="muted">分类由所有国家共用。保存后可在商品表单中选择；历史商品归属不会自动改变。</p></template>
    </CrudPage>
  </el-dialog>
</template>

<style scoped>
.add {
  margin-top: 8px;
}
</style>
