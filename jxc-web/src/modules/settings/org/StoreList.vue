<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, type FormInstance } from 'element-plus'
import { http } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { useCountryStore } from '@/stores/country'
import { useOptionsStore } from '@/stores/options'
import CrudPage from '@/components/crud/CrudPage.vue'
import FieldInput from '@/components/crud/FieldInput.vue'
import type { ColumnDef, FieldDef } from '@/components/crud/types'
import { ENTITY_SOURCE, WAREHOUSE_SOURCE } from '@/modules/master/options'
import { TIMEZONES } from '../constants'
import { todayIn } from '@/utils/format'

const country = useCountryStore()
const optionsStore = useOptionsStore()

const columns: ColumnDef[] = [
  { prop: 'code', label: '编码', width: 120 },
  { prop: 'name', label: '名称', minWidth: 150 },
  { prop: 'entityName', label: '所属主体', minWidth: 140 },
  { prop: 'defaultWarehouseName', label: '默认出库仓', minWidth: 150 },
  { prop: 'address', label: '地址', minWidth: 220 },
  { prop: 'openedAt', label: '开业日期', type: 'date', width: 110 },
  { prop: 'status', label: '状态', type: 'status', width: 80 },
]

const searchFields: FieldDef[] = [{ prop: 'keyword', label: '关键字' }]

const formFields: FieldDef[] = [
  { prop: 'code', label: '编码', required: true, editDisabled: true },
  { prop: 'name', label: '名称', required: true },
  { prop: 'entityId', label: '所属主体', type: 'select', options: ENTITY_SOURCE, required: true },
  { prop: 'defaultWarehouseId', label: '默认出库仓', type: 'select', options: WAREHOUSE_SOURCE },
  { prop: 'timezone', label: '时区', type: 'select', options: TIMEZONES, tip: '留空时使用国家时区' },
  { prop: 'openedAt', label: '开业日期', type: 'date' },
  { prop: 'address', label: '地址', span: 24 },
]

// ---------- 新开门店 ----------
const wizard = reactive({
  visible: false,
  saving: false,
  form: {} as Record<string, unknown>,
})
const formRef = ref<FormInstance>()
const books = ref<{ id: number; entityId: number; name: string; status: string }[]>([])
const bookOptions = computed(() => books.value.filter(book => book.status === 'ACTIVE' && book.entityId === wizard.form.entityId).map(book => ({ label: book.name, value: book.id })))
watch(() => wizard.form.entityId, () => { wizard.form.bookId = undefined; wizard.form.glAccountId = undefined })
watch(() => wizard.form.bookId, () => { wizard.form.glAccountId = undefined })

async function openWizard() {
  books.value = await allRecords('/org/books', { status: 'ACTIVE' })
  wizard.form = {
    entityId: undefined,
    code: '',
    name: '',
    address: '',
    openedAt: todayIn(country.timezone),
    createWarehouse: true,
    warehouseCode: '',
    defaultWarehouseId: undefined,
    createCash: false,
    bookId: undefined,
    glAccountId: undefined,
    cashName: '',
    userIds: [],
  }
  wizard.visible = true
}

async function submitWizard(reload: () => void) {
  await formRef.value?.validate()
  const f = wizard.form
  wizard.saving = true
  try {
    if (f.createCash && !f.bookId) { ElMessage.warning('请选择资金账户所属账套'); return }
    await http.post('/org/stores', {
      entityId: f.entityId,
      code: f.code,
      name: f.name,
      address: f.address,
      openedAt: f.openedAt,
      createWarehouse: f.createWarehouse,
      warehouseCode: f.warehouseCode || undefined,
      defaultWarehouseId: f.createWarehouse ? undefined : f.defaultWarehouseId,
      fundAccount: f.createCash ? { name: f.cashName || `${f.name}现金`, accountType: 'CASH', bookId: f.bookId, currency: country.currency, glAccountId: f.glAccountId || undefined } : undefined,
      userIds: f.userIds,
    })
    ElMessage.success('门店已创建')
    wizard.visible = false
    optionsStore.invalidate('/org/')
    reload()
  } finally {
    wizard.saving = false
  }
}

const rules = {
  entityId: [{ required: true, message: '请选择经营主体' }],
  code: [{ required: true, message: '请填写门店编码' }],
  name: [{ required: true, message: '请填写门店名称' }],
}
</script>

<template>
  <CrudPage
    title="门店"
    resource="/org/stores"
    :columns="columns"
    :search-fields="searchFields"
    :form-fields="formFields"
    edit-perm="org:store:edit"
    audit-type="store"
    :can-create="false"
  >
    <template #toolbar="{ reload }">
      <el-button v-perm="'org:store:edit'" type="primary" @click="openWizard"><el-icon><Plus /></el-icon>新开门店</el-button>
      <el-dialog v-model="wizard.visible" title="新开门店" width="640px" append-to-body destroy-on-close>
        <el-form ref="formRef" :model="wizard.form" :rules="rules" label-width="120px">
          <el-divider content-position="left">门店</el-divider>
          <el-form-item label="经营主体" prop="entityId">
            <FieldInput v-model="wizard.form.entityId" :field="{ prop: 'entityId', label: '经营主体', type: 'select', options: ENTITY_SOURCE }" />
          </el-form-item>
          <el-form-item label="编码" prop="code"><el-input v-model="wizard.form.code as string" /></el-form-item>
          <el-form-item label="名称" prop="name"><el-input v-model="wizard.form.name as string" /></el-form-item>
          <el-form-item label="地址"><el-input v-model="wizard.form.address as string" /></el-form-item>
          <el-form-item label="开业日期">
            <el-date-picker v-model="wizard.form.openedAt" type="date" value-format="YYYY-MM-DD" />
          </el-form-item>

          <el-divider content-position="left">库存</el-divider>
          <el-form-item label="同时建门店仓">
            <el-switch v-model="wizard.form.createWarehouse" />
            <span class="muted ml">门店有独立库存时开启；否则选择从哪个仓出库</span>
          </el-form-item>
          <el-form-item v-if="wizard.form.createWarehouse" label="门店仓编码">
            <el-input v-model="wizard.form.warehouseCode as string" :placeholder="`默认 ${wizard.form.code || '门店编码'}-WH`" />
          </el-form-item>
          <el-form-item v-else label="默认出库仓">
            <FieldInput v-model="wizard.form.defaultWarehouseId" :field="{ prop: 'w', label: '默认出库仓', type: 'select', options: WAREHOUSE_SOURCE }" />
          </el-form-item>

          <el-divider content-position="left">收款</el-divider>
          <el-form-item label="建现金账户">
            <el-switch v-model="wizard.form.createCash" />
            <span class="muted ml">币种 {{ country.currency }}</span>
          </el-form-item>
          <el-form-item v-if="wizard.form.createCash" label="所属账套" required>
            <FieldInput v-model="wizard.form.bookId" :field="{ prop: 'bookId', label: '所属账套', type: 'select', options: bookOptions }" />
          </el-form-item>
          <el-form-item v-if="wizard.form.createCash" label="会计科目">
            <FieldInput v-model="wizard.form.glAccountId" :field="{ prop: 'glAccountId', label: '现金科目', type: 'select', options: { remote: '/fin/accounts', label: 'name', params: { bookId: wizard.form.bookId } } }" />
          </el-form-item>
          <el-form-item v-if="wizard.form.createCash" label="账户名称">
            <el-input v-model="wizard.form.cashName as string" :placeholder="`默认 ${wizard.form.name || '门店名称'}现金`" />
          </el-form-item>

          <el-divider content-position="left">人员</el-divider>
          <el-form-item label="门店人员">
            <FieldInput
              v-model="wizard.form.userIds"
              :field="{ prop: 'u', label: '门店人员', type: 'multi-select', options: { remote: '/sys/user-options', label: 'displayName' } }"
            />
            <div class="muted">授予「本门店」数据范围；角色在「用户与授权」中分配。</div>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="wizard.visible = false">取消</el-button>
          <el-button type="primary" :loading="wizard.saving" @click="submitWizard(reload)">创建</el-button>
        </template>
      </el-dialog>
    </template>
  </CrudPage>
</template>

<style scoped>
.ml {
  margin-left: 8px;
}
</style>
