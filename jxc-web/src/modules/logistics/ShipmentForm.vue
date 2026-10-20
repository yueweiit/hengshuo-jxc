<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import FieldInput from '@/components/crud/FieldInput.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import { useCountryStore } from '@/stores/country'
import { countryDateTimeToIso, countryDateTimeInput } from '@/utils/format'
import { CARRIER_SOURCE, MX_WAREHOUSE_SOURCE, TRANSPORT_MODES } from '@/modules/shared/bizOptions'

const supplyCommandIntent = createCommandIntent()


type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const country = useCountryStore()
const emit = defineEmits<{ saved: [shipment: Row] }>()
const visible = ref(false)
const saving = ref(false)
const sources = ref<Row[]>([])
const m = reactive<Row>({})

async function open(existing?: Row) {
  for (const k of Object.keys(m)) delete m[k]
  Object.assign(m, existing ? { ...existing, containerNo: existing.currentContainerNo, sealNo: existing.currentSealNo } : { transportMode: 'SEA', originLocation: '' })
  m.plannedEtd = countryDateTimeInput(existing?.plannedEtd, country.timezone)
  m.plannedEta = countryDateTimeInput(existing?.plannedEta, country.timezone)
  const list = await http.get<Row[]>('/pur/shippable-sources', existing ? { excludeShipmentId: existing.id } : {})
  const current = new Map<number, Row>((existing?.lines ?? []).map((l: Row) => [l.sourceLineId, l]))
  sources.value = list
    .filter((s) => s.remainingQty > 0 || current.has(s.sourceLineId))
    .map((s) => ({ ...s, baseQty: current.get(s.sourceLineId)?.baseQty ?? 0, boxes: current.get(s.sourceLineId)?.boxes ?? null }))
  visible.value = true
}

const picked = computed(() => sources.value.filter((s) => s.baseQty > 0))
const totalQty = computed(() => picked.value.reduce((s, x) => s + x.baseQty, 0))
const dimensionTotal = (field: 'unitWeight' | 'unitVolume') => picked.value.some(row => row[field] == null || !Number.isFinite(Number(row[field])))
  ? null : picked.value.reduce((sum, row) => sum + row.baseQty * Number(row[field]), 0)
const totalWeight = computed(() => dimensionTotal('unitWeight'))
const totalVolume = computed(() => dimensionTotal('unitVolume'))

async function save(submit: boolean) {
  if (!picked.value.length) return ElMessage.warning('请至少选择一行出口来源并填写发运数量')
  saving.value = true
  try {
    const body = { ...m, plannedEtd: countryDateTimeToIso(m.plannedEtd, country.timezone), plannedEta: countryDateTimeToIso(m.plannedEta, country.timezone), version: m.version, submit, lines: picked.value.map((s) => ({ sourceLineId: s.sourceLineId, baseQty: s.baseQty, boxes: s.boxes })) }
    let res: Row
    if (m.id) {
      res = await http.put<Row>(`/lgs/shipments/${m.id}`, body)
      if (submit && res.status === 'DRAFT') res = await http.postIdem<Row>(`/lgs/shipments/${m.id}/submit`, undefined, supplyCommandIntent)
    } else {
      res = await http.postIdem<Row>('/lgs/shipments', body, supplyCommandIntent)
    }
    ElMessage.success(submit ? '已提交，等待实际发运' : '已保存草稿')
    visible.value = false
    emit('saved', res)
  } finally {
    saving.value = false
  }
}

defineExpose({ open })
</script>

<template>
  <el-dialog v-model="visible" :title="m.id ? `编辑运输批次 ${m.docNo}` : '新建运输批次'" width="1000px" append-to-body destroy-on-close class="crud-dialog">
    <el-form label-width="90px">
      <el-row :gutter="12">
        <el-col :xs="24" :span="8">
          <el-form-item label="物流商" required>
            <FieldInput v-model="m.carrierId" :field="{ prop: 'carrierId', label: '物流商', type: 'select', options: CARRIER_SOURCE }" />
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="8">
          <el-form-item label="运输方式" required>
            <el-radio-group v-model="m.transportMode">
              <el-radio-button v-for="o in TRANSPORT_MODES" :key="String(o.value)" :value="o.value">{{ o.label }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
        </el-col>
        <el-col :xs="12" :span="8">
          <el-form-item label="目的仓" required>
            <FieldInput v-model="m.destWarehouseId" :field="{ prop: 'destWarehouseId', label: '目的仓', type: 'select', options: MX_WAREHOUSE_SOURCE }" />
          </el-form-item>
        </el-col>
        <template v-if="m.transportMode === 'SEA'">
          <el-col :xs="12" :span="6"><el-form-item label="船名" required><el-input v-model="m.vessel" /></el-form-item></el-col>
          <el-col :xs="12" :span="6"><el-form-item label="航次" required><el-input v-model="m.voyage" /></el-form-item></el-col>
          <el-col :xs="12" :span="6"><el-form-item label="提单号" required><el-input v-model="m.blNo" /></el-form-item></el-col>
          <el-col :xs="12" :span="6"><el-form-item label="柜号" required><el-input v-model="m.containerNo" placeholder="CSNU1234567" /></el-form-item></el-col>
          <el-col :xs="12" :span="6"><el-form-item label="封号"><el-input v-model="m.sealNo" /></el-form-item></el-col>
        </template>
        <template v-else>
          <el-col :xs="12" :span="6"><el-form-item label="航班号" required><el-input v-model="m.flightNo" /></el-form-item></el-col>
          <el-col :xs="12" :span="6"><el-form-item label="运单号" required><el-input v-model="m.awbNo" /></el-form-item></el-col>
        </template>
        <el-col :xs="12" :span="6"><el-form-item label="起运地"><el-input v-model="m.originLocation" /></el-form-item></el-col>
        <el-col :xs="12" :span="6">
          <el-form-item :label="`计划发运（${country.timezone}）`"><el-date-picker v-model="m.plannedEtd" type="datetime" value-format="YYYY-MM-DD HH:mm:ss.SSS" style="width: 100%" /></el-form-item>
        </el-col>
        <el-col :xs="12" :span="6">
          <el-form-item :label="`计划到港（${country.timezone}）`"><el-date-picker v-model="m.plannedEta" type="datetime" value-format="YYYY-MM-DD HH:mm:ss.SSS" style="width: 100%" /></el-form-item>
        </el-col>
      </el-row>
    </el-form>

    <h4>选择出口来源</h4>
    <div class="table-scroll">
      <el-table :data="sources" border size="small" max-height="320" empty-text="没有可发运的出口行，请先在出口节点确认出口">
        <el-table-column prop="sourceNo" label="出口单" width="160" />
        <el-table-column prop="poNo" label="采购单" width="160" />
        <el-table-column label="商品" min-width="170"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" :extra="row.supplierName" /></template></el-table-column>
        <el-table-column label="出口 / 已发运 / 其他计划" width="150" align="right">
          <template #default="{ row }"><span class="mono">{{ row.qty }} / {{ row.shippedQty }} / {{ row.plannedQty }}</span></template>
        </el-table-column>
        <el-table-column prop="remainingQty" label="可发运" width="72" align="right" />
        <el-table-column label="本批数量" width="120">
          <template #default="{ row }"><el-input-number v-model="row.baseQty" :min="0" :max="row.remainingQty" :controls="false" style="width: 100%" /></template>
        </el-table-column>
        <el-table-column label="箱数" width="90">
          <template #default="{ row }"><el-input-number v-model="row.boxes" :min="0" :controls="false" style="width: 100%" /></template>
        </el-table-column>
        <el-table-column width="60">
          <template #default="{ row }"><el-button link type="primary" @click="row.baseQty = row.remainingQty">全部</el-button></template>
        </el-table-column>
      </el-table>
    </div>
    <p class="muted">
      合计 <b>{{ totalQty }}</b> 件 · 毛重 {{ totalWeight === null ? '待补齐' : totalWeight.toFixed(2) + ' kg' }} · 体积 {{ totalVolume === null ? '待补齐' : totalVolume.toFixed(3) + ' m³' }}。
      一个批次可以合并多张采购单和多个 SKU；草稿与待发运批次占用的计划数量不会被其他批次重复选择。
    </p>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button :loading="saving" @click="save(false)">保存草稿</el-button>
      <el-button type="primary" :loading="saving" @click="save(true)">保存并提交</el-button>
    </template>
  </el-dialog>
</template>
