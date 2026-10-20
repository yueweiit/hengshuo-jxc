<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import type { PageResult } from '@/api/types'
import { allRecords } from '@/api/pagination'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import FieldInput from '@/components/crud/FieldInput.vue'
import { CURRENCY_SOURCE } from '@/modules/master/options'
import { CARRIER_SOURCE, ESTIMATE_FLAGS, EXPENSE_ITEM_SOURCE, FEE_REF_TYPES } from '@/modules/shared/bizOptions'
import { todayIn } from '@/utils/format'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const emit = defineEmits<{ saved: [] }>()
const country = useCountryStore()
const user = useUserStore()
const visible = ref(false)
const saving = ref(false)
const lockRef = ref(false)
const refs = ref<Row[]>([])
const estimates = ref<Row[]>([])
const m = reactive<Row>({})

const REF_URL: Record<string, string> = { SHIPMENT: '/lgs/shipments', TRANSSHIP: '/lgs/transships', HOLD: '/lgs/holds', DELIVERY: '/lgs/deliveries' }

async function loadRefs() {
  if (!m.refType) return (refs.value = [])
  const res = await allRecords<Row>(REF_URL[m.refType]!)
  refs.value = res
}

const shipmentId = computed(() => {
  const r = refs.value.find((x) => x.id === m.refId)
  return m.refType === 'SHIPMENT' ? r?.id : r?.shipmentId
})

async function loadEstimates() {
  if (m.estimateFlag !== 'ACTUAL' || !shipmentId.value) return (estimates.value = [])
  const res = await http.get<PageResult<Row>>('/lgs/fees', { estimateFlag: 'ESTIMATE', status: 'CONFIRMED', shipmentId: shipmentId.value, size: 100 })
  estimates.value = res.records
}

watch(() => m.refType, loadRefs)
watch([() => m.estimateFlag, shipmentId], loadEstimates)

function onEstimatePick() {
  const e = estimates.value.find((x) => x.id === m.estimateFeeId)
  if (e) Object.assign(m, { carrierId: e.carrierId, expenseItemId: e.expenseItemId, currency: e.currency })
}

async function open(init: Row = {}, existing?: Row) {
  for (const k of Object.keys(m)) delete m[k]
  lockRef.value = !!init.refId
  Object.assign(m, { refType: 'SHIPMENT', estimateFlag: 'ACTUAL', incurredLocation: 'MX', currency: country.currency, bizDate: todayIn(country.timezone), ...init, ...existing })
  await loadRefs()
  visible.value = true
}

async function save(confirm: boolean) {
  for (const [k, label] of [['refId', '关联单据'], ['carrierId', '物流商'], ['expenseItemId', '费用项目'], ['currency', '币种'], ['amount', '金额']]) {
    if (!m[k!]) return ElMessage.warning(`请填写${label}`)
  }
  saving.value = true
  try {
    if (m.id) {
      await http.put(`/lgs/fees/${m.id}`, m)
      if (confirm) await http.postIdem(`/lgs/fees/${m.id}/confirm`, undefined, supplyCommandIntent)
    } else {
      await http.postIdem('/lgs/fees', { ...m, confirm }, supplyCommandIntent)
    }
    ElMessage.success(confirm ? '已确认' : '已保存草稿')
    visible.value = false
    emit('saved')
  } finally {
    saving.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <el-dialog v-model="visible" :title="m.id ? '编辑物流费用' : '登记物流费用'" width="640px" append-to-body destroy-on-close class="crud-dialog">
    <el-form label-width="96px">
      <el-row :gutter="12">
        <el-col :xs="24" :span="10">
          <el-form-item label="关联类型">
            <el-select v-model="m.refType" :disabled="lockRef" style="width: 100%" @change="m.refId = undefined">
              <el-option v-for="o in FEE_REF_TYPES" :key="String(o.value)" v-bind="o" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :xs="24" :span="14">
          <el-form-item label="关联单据" required>
            <el-select v-model="m.refId" filterable :disabled="lockRef" style="width: 100%">
              <el-option v-for="r in refs" :key="r.id" :label="r.shipmentNo ? `${r.docNo}（${r.shipmentNo}）` : r.docNo" :value="r.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :xs="24" :span="10">
          <el-form-item label="暂估/实际">
            <el-radio-group v-model="m.estimateFlag">
              <el-radio-button v-for="o in ESTIMATE_FLAGS" :key="String(o.value)" :value="o.value">{{ o.label }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
        </el-col>
        <el-col v-if="m.estimateFlag === 'ACTUAL'" :xs="24" :span="14">
          <el-form-item label="冲抵暂估">
            <el-select v-model="m.estimateFeeId" clearable style="width: 100%" placeholder="可选：关联同批次已确认的暂估" @change="onEstimatePick">
              <el-option v-for="e in estimates" :key="e.id" :label="`${e.docNo} · ${e.expenseItemName} ${e.currency} ${e.amount}`" :value="e.id" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :xs="24" :span="12">
          <el-form-item label="物流商" required>
            <FieldInput v-model="m.carrierId" :field="{ prop: 'carrierId', label: '物流商', type: 'select', options: CARRIER_SOURCE }" />
          </el-form-item>
        </el-col>
        <el-col :xs="24" :span="12">
          <el-form-item label="费用项目" required>
            <FieldInput v-model="m.expenseItemId" :field="{ prop: 'expenseItemId', label: '费用项目', type: 'select', options: EXPENSE_ITEM_SOURCE }" />
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="8">
          <el-form-item label="币种" required>
            <FieldInput v-model="m.currency" :field="{ prop: 'currency', label: '币种', type: 'select', options: CURRENCY_SOURCE }" />
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="8">
          <el-form-item label="金额" required><el-input-number v-model="m.amount" :min="0" :precision="2" :controls="false" style="width: 100%" /></el-form-item>
        </el-col>
        <el-col :xs="12" :span="8">
          <el-form-item label="发生地">
            <el-select v-model="m.incurredLocation" style="width: 100%">
              <el-option label="中国" value="CN" />
              <el-option label="墨西哥" value="MX" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="12">
          <el-form-item label="业务日期"><el-date-picker v-model="m.bizDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" /></el-form-item>
        </el-col>
        <el-col :span="24"><el-form-item label="备注"><el-input v-model="m.remark" /></el-form-item></el-col>
      </el-row>
    </el-form>
    <p class="muted">费用按原币登记；计入商品成本的费用在成本分摊（第 4 批）中按数量、重量、体积或货值分摊。实际费用冲抵暂估后，暂估标记为“已调整”，差额由成本调整处理。</p>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button :loading="saving" @click="save(false)">保存草稿</el-button>
      <el-button v-if="user.hasPerm('lgs:fee:confirm')" type="primary" :loading="saving" @click="save(true)">保存并确认</el-button>
    </template>
  </el-dialog>
</template>
