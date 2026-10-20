<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import { allRecords } from '@/api/pagination'
import StatusTag from '@/components/StatusTag.vue'
import CostTraceDrawer from './CostTraceDrawer.vue'

const rows = ref<Record<string, any>[]>([])
const preview = ref<Record<string, any> | null>(null)
const form = reactive({ feeId: null as number | null, basis: 'QTY' })
const user = useUserStore()
const busy = ref(false), previewIntent = createCommandIntent(), confirmIntent = createCommandIntent(), reverseIntent = createCommandIntent()
const previewInput = ref('')
const trace = ref<InstanceType<typeof CostTraceDrawer>>()

function allocationView(row: Record<string, any>): Record<string, any> {
  return {
    ...row,
    feeNo: row.feeNo ?? (row.feeId == null ? '—' : `#${row.feeId}`),
    lines: (row.lines ?? []).map((line: Record<string, any>) => ({ ...line, batchNo: line.batchNo ?? (line.batchId == null ? '—' : `#${line.batchId}`) })),
  }
}

async function load() {
  rows.value = (await allRecords<Record<string, any>>('/cst/allocations', { })).map(allocationView)
}
async function run(confirm: boolean) {
  if (busy.value) return
  if (!form.feeId) return ElMessage.warning('请填写费用 ID')
  busy.value = true
  try {
    const payload = { ...form }, fingerprint = JSON.stringify(payload)
    if (!preview.value || previewInput.value !== fingerprint) {
      preview.value = allocationView(await http.postIdem<Record<string, any>>('/cst/allocations', payload, previewIntent))
      previewInput.value = fingerprint
      previewIntent.reset()
    }
    if (confirm) {
      const confirmed = allocationView(await http.postIdem<Record<string, any>>('/cst/allocations/' + preview.value.id + '/confirm', {}, confirmIntent))
      preview.value = confirmed
      if (confirmed.status === 'CONFIRMED') {
        ElMessage.success('已确认，明细合计等于费用本位币金额')
        preview.value = null; previewInput.value = ''; form.feeId = null; confirmIntent.reset()
      } else ElMessage.info('当前状态：' + confirmed.status)
      await load()
    }
  } finally { busy.value = false }
}
async function reverse(row: Record<string, any>) {
  if (busy.value) return
  busy.value = true
  try { await http.postIdem('/cst/allocations/' + row.id + '/reverse', {}, reverseIntent); ElMessage.success('已撤销'); await load() }
  finally { busy.value = false }
}
onMounted(load)
</script>

<template>
  <el-card>
    <template #header>费用分摊</template>
    <el-form inline :disabled="busy">
      <el-form-item label="费用 ID"><el-input-number v-model="form.feeId" /></el-form-item>
      <el-form-item label="依据">
        <el-select v-model="form.basis" style="width: 120px"><el-option v-for="b in ['QTY','WEIGHT','VOLUME','VALUE']" :key="b" :label="b" :value="b" /></el-select>
      </el-form-item>
      <el-button :loading="busy" @click="run(false)">预览</el-button>
      <el-button v-if="user.hasPerm('cst:allocation:confirm')" type="primary" :loading="busy" @click="run(true)">确认</el-button>
    </el-form>
    <el-table v-if="preview" :data="preview.lines" size="small">
      <el-table-column label="批次"><template #default="{ row }"><el-link type="primary" @click="trace?.open(row.batchId)">{{ row.batchNo }}</el-link></template></el-table-column>
      <el-table-column label="依据值"><template #default="{ row }">{{ row.basisValue ?? row.weight }}</template></el-table-column>
      <el-table-column prop="amount" :label="'分摊金额 (' + preview.baseCurrency + ')'" />
    </el-table>
    <p v-if="preview">分摊合计 {{ preview.baseAmount }} {{ preview.baseCurrency }}；原费用 {{ preview.feeAmount }} {{ preview.feeCurrency }}</p>
    <el-table :data="rows" size="small">
      <el-table-column prop="feeNo" label="费用" />
      <el-table-column prop="basis" label="依据" width="90" />
      <el-table-column label="原费用" width="150"><template #default="{ row }">{{ row.feeAmount }} {{ row.feeCurrency }}</template></el-table-column>
      <el-table-column label="分摊金额" width="150"><template #default="{ row }">{{ row.baseAmount }} {{ row.baseCurrency }}</template></el-table-column>
      <el-table-column label="状态" width="100"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
      <el-table-column width="90"><template #default="{ row }"><el-button v-if="row.status === 'CONFIRMED' && user.hasPerm('cst:allocation:confirm')" link :disabled="busy" @click="reverse(row)">撤销</el-button></template></el-table-column>
    </el-table>
    <CostTraceDrawer ref="trace" />
  </el-card>
</template>
