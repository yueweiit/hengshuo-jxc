<script setup lang="ts" generic="T extends { id: number; status?: string; version?: number }">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { createCrudApi } from '@/api/crud'
import { createCommandIntent, withEditVersion } from '@/api/command-intent'
import { useUserStore } from '@/stores/user'
import { useOptionsStore } from '@/stores/options'
import StatusTag from '@/components/StatusTag.vue'
import MoneyText from '@/components/MoneyText.vue'
import QtyText from '@/components/QtyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import AuditTimeline from '@/components/AuditTimeline.vue'
import FieldInput from './FieldInput.vue'
import OptionText from './OptionText.vue'
import type { ColumnDef, FieldDef } from './types'
import { formatDate } from '@/utils/format'

const props = withDefaults(
  defineProps<{
    title: string
    resource: string
    columns: ColumnDef[]
    searchFields?: FieldDef[]
    formFields?: FieldDef[]
    /** 新增、编辑、停用所需权限码 */
    editPerm?: string | string[]
    /** 审计日志的 resourceType，不传则不显示操作日志 */
    auditType?: string
    /** 审计抽屉宽度；业务展示通过 audit 插槽复用加载器。 */
    auditWidth?: string
    canCreate?: boolean
    canEdit?: boolean
    canToggle?: boolean
    formWidth?: string
    labelWidth?: string
    defaultQuery?: Record<string, unknown>
    /** 打开编辑框前转换数据，例如补全子表 */
    beforeOpen?: (row: Partial<T>, mode: 'create' | 'edit') => Partial<T>
    /** 提交前转换数据 */
    beforeSubmit?: (model: Partial<T>, mode: 'create' | 'edit') => Partial<T>
    /** 行是否可编辑，例如只有草稿可改 */
    rowEditable?: (row: T) => boolean
    /** 显示勾选列，勾选结果通过 selection 暴露 */
    selectable?: boolean | ((row: T) => boolean)
    actionsWidth?: number
  }>(),
  {
    searchFields: () => [],
    formFields: () => [],
    canCreate: true,
    canEdit: true,
    canToggle: true,
    formWidth: '640px',
    labelWidth: '110px',
    defaultQuery: () => ({}),
    auditWidth: '420px',
  },
)

const emit = defineEmits<{ saved: [row: T] }>()

const { t } = useI18n()
const user = useUserStore()
const optionsStore = useOptionsStore()
const saveIntent = createCommandIntent()
const api = createCrudApi<T>(props.resource, saveIntent)

const canWrite = computed(() => user.hasPerm(props.editPerm))

const query = reactive<Record<string, unknown>>({ ...props.defaultQuery })
const page = ref(1)
const size = ref(20)
const total = ref(0)
const rows = ref<T[]>([]) as { value: T[] }
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await api.list({ ...query, page: page.value, size: size.value })
    rows.value = res.records
    total.value = res.total
  } finally {
    loading.value = false
  }
}

function search() {
  page.value = 1
  load()
}

function resetQuery() {
  for (const k of Object.keys(query)) delete query[k]
  Object.assign(query, props.defaultQuery)
  search()
}

// ---------- 编辑 ----------
const dialogVisible = ref(false)
const mode = ref<'create' | 'edit'>('create')
const model = ref<Record<string, unknown>>({})
const formRef = ref<FormInstance>()
const saving = ref(false)
const originalVersion = ref<number>()
const originalId = ref<number>()

const visibleFields = computed(() => props.formFields.filter((f) => !(f.createOnly && mode.value === 'edit')))

const rules = computed<FormRules>(() => {
  const r: FormRules = {}
  for (const f of props.formFields) {
    if (f.createOnly && mode.value === 'edit') continue
    const list = [...(f.rules ?? [])]
    if (f.required) list.unshift({ required: true, message: `${f.label}不能为空`, trigger: ['blur', 'change'] })
    if (list.length) r[f.prop] = list
  }
  return r
})

async function openCreate() {
  saveIntent.reset()
  originalVersion.value = undefined
  originalId.value = undefined
  mode.value = 'create'
  const init: Record<string, unknown> = {}
  for (const f of props.formFields) if (f.default !== undefined) init[f.prop] = structuredClone(f.default)
  model.value = (props.beforeOpen ? props.beforeOpen(init as Partial<T>, 'create') : init) as Record<string, unknown>
  dialogVisible.value = true
}

async function openEdit(row: T) {
  mode.value = 'edit'
  const fresh = await api.get(row.id)
  saveIntent.reset()
  originalVersion.value = fresh.version
  originalId.value = fresh.id
  model.value = (props.beforeOpen ? props.beforeOpen({ ...fresh }, 'edit') : { ...fresh }) as Record<string, unknown>
  dialogVisible.value = true
}

async function submit() {
  await formRef.value?.validate()
  saving.value = true
  try {
    const payload = (props.beforeSubmit ? props.beforeSubmit(model.value as Partial<T>, mode.value) : model.value) as Partial<T>
    const saved =
      mode.value === 'create' ? await api.create(payload) : await api.update(originalId.value!, withEditVersion(payload, originalVersion.value))
    ElMessage.success(t('common.saved'))
    dialogVisible.value = false
    optionsStore.invalidate(props.resource)
    emit('saved', saved)
    await load()
  } finally {
    saving.value = false
  }
}

async function toggle(row: T) {
  const enabled = row.status === 'ENABLED' || row.status === 'ACTIVE'
  if (enabled) {
    await ElMessageBox.confirm('停用后不能在新单据中引用，历史单据不受影响。是否停用？', t('common.disable'), { type: 'warning' })
    await api.disable(row.id, { version: row.version })
  } else {
    await api.enable(row.id, { version: row.version })
  }
  optionsStore.invalidate(props.resource)
  await load()
}

// ---------- 操作日志 ----------
const auditVisible = ref(false)
const auditRowId = ref<number>(0)
function openAudit(row: T) {
  auditRowId.value = row.id
  auditVisible.value = true
}

function cell(row: T, prop: string) {
  return (row as Record<string, unknown>)[prop]
}

const selection = ref<T[]>([]) as { value: T[] }
const onSelection = (v: T[]) => (selection.value = v)
const canSelect = (row: T) => (typeof props.selectable === 'function' ? props.selectable(row) : true)
const numericTypes = ['money', 'qty']

onMounted(load)
defineExpose({ reload: load, openCreate, openEdit, selection, query, search })
</script>

<template>
  <div class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>{{ title }}</h2>
        <div class="toolbar">
          <slot name="toolbar" :reload="load" />
          <el-button v-if="canCreate && canWrite && formFields.length" type="primary" @click="openCreate">
            <el-icon><Plus /></el-icon>{{ t('common.create') }}
          </el-button>
        </div>
      </div>

      <slot name="header" />

      <el-form v-if="searchFields.length" inline class="search-form" @submit.prevent="search">
        <el-form-item v-for="f in searchFields" :key="f.prop" :label="f.label">
          <div style="width: 180px">
            <FieldInput v-model="query[f.prop]" :field="f" clearable />
          </div>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" native-type="submit">{{ t('common.search') }}</el-button>
          <el-button @click="resetQuery">{{ t('common.reset') }}</el-button>
        </el-form-item>
      </el-form>

      <div class="table-scroll">
        <el-table v-loading="loading" :data="rows" border stripe row-key="id" @selection-change="onSelection">
          <el-table-column v-if="selectable" type="selection" width="44" fixed="left" :selectable="canSelect" />
          <el-table-column
            v-for="c in columns"
            :key="c.prop"
            :prop="c.prop"
            :label="c.label"
            :width="c.width"
            :min-width="c.minWidth ?? 110"
            :fixed="c.fixed"
            :align="numericTypes.includes(c.type ?? '') ? 'right' : undefined"
            show-overflow-tooltip
          >
            <template #default="{ row }">
              <slot :name="`col-${c.prop}`" :row="row">
                <StatusTag v-if="c.type === 'status'" :status="cell(row, c.prop) as string" :domain="c.statusDomain" />
                <MoneyText
                  v-else-if="c.type === 'money'"
                  :value="cell(row, c.prop) as number"
                  :currency="c.currencyProp ? (cell(row, c.currencyProp) as string) : undefined"
                />
                <QtyText v-else-if="c.type === 'qty'" :value="cell(row, c.prop) as number" />
                <DateTimeText v-else-if="c.type === 'datetime'" :value="cell(row, c.prop) as string" />
                <span v-else-if="c.type === 'date'">{{ formatDate(cell(row, c.prop) as string) }}</span>
                <el-tag v-else-if="c.type === 'bool'" :type="cell(row, c.prop) ? 'success' : 'info'" size="small">
                  {{ cell(row, c.prop) ? '是' : '否' }}
                </el-tag>
                <OptionText v-else-if="c.type === 'option'" :value="cell(row, c.prop)" :options="c.options" />
                <template v-else-if="c.type === 'tags'">
                  <el-tag v-for="tg in (cell(row, c.prop) as string[]) ?? []" :key="tg" size="small" class="tag">{{ tg }}</el-tag>
                </template>
                <span v-else>{{ cell(row, c.prop) ?? '-' }}</span>
              </slot>
            </template>
          </el-table-column>
          <el-table-column :label="t('common.actions')" fixed="right" :min-width="actionsWidth ?? 170">
            <template #default="{ row }">
              <slot name="row-actions" :row="row" :reload="load" />
              <el-button
                v-if="canEdit && canWrite && formFields.length && (!rowEditable || rowEditable(row))"
                link
                type="primary"
                @click="openEdit(row)"
              >
                {{ t('common.edit') }}
              </el-button>
              <el-button v-if="canToggle && canWrite && row.status" link type="warning" @click="toggle(row)">
                {{ row.status === 'ENABLED' || row.status === 'ACTIVE' ? t('common.disable') : t('common.enable') }}
              </el-button>
              <el-button v-if="auditType" link @click="openAudit(row)">{{ t('common.auditLog') }}</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <el-pagination
        v-model:current-page="page"
        v-model:page-size="size"
        class="pager"
        :total="total"
        :page-sizes="[20, 50, 100]"
        layout="total, sizes, prev, pager, next"
        background
        @current-change="load"
        @size-change="search"
      />
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="`${mode === 'create' ? t('common.create') : t('common.edit')}${title}`"
      :width="formWidth"
      destroy-on-close
      append-to-body
      class="crud-dialog"
    >
      <el-form ref="formRef" :model="model" :rules="rules" :label-width="labelWidth">
        <el-row :gutter="12">
          <el-col v-for="f in visibleFields" :key="f.prop" :xs="24" :span="f.span ?? 12">
            <el-form-item :label="f.label" :prop="f.prop">
              <FieldInput v-model="model[f.prop]" :field="f" :disabled="f.editDisabled && mode === 'edit'" />
              <div v-if="f.tip" class="muted">{{ f.tip }}</div>
            </el-form-item>
          </el-col>
        </el-row>
        <slot name="form-extra" :model="model" :mode="mode" />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">{{ t('common.cancel') }}</el-button>
        <el-button type="primary" :loading="saving" @click="submit">{{ t('common.save') }}</el-button>
      </template>
    </el-dialog>

    <el-drawer v-if="auditType" v-model="auditVisible" :title="t('common.auditLog')" :size="auditWidth" destroy-on-close>
      <slot name="audit" :resource-id="auditRowId">
        <AuditTimeline :resource-type="auditType" :resource-id="auditRowId" />
      </slot>
    </el-drawer>
  </div>
</template>

<style scoped>
.pager {
  margin-top: 12px;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.tag {
  margin-right: 4px;
}

:global(.crud-dialog) {
  max-width: 96vw;
}
</style>
