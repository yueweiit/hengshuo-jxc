<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { BizError, http, createCommandIntent } from '@/api/http'
import { getCountryId, getToken } from '@/utils/session'
import { useUserStore } from '@/stores/user'
import StatusTag from '@/components/StatusTag.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import ScanInput from '@/components/biz/ScanInput.vue'
import DocAttachment from '@/components/DocAttachment.vue'
import { matchBarcode } from '@/utils/action'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const r = ref<Row>({})
const loading = ref(false)
const saving = ref(false)
const active = ref<number | null>(null)
const checked = ref<Set<number>>(new Set())
const scan = ref<InstanceType<typeof ScanInput>>()
/** 相同内容的失败重试复用幂等键；改变数量或成功后开始新意图 */
const idemKey = createCommandIntent()

const id = computed(() => Number(route.params.id))
const receiptScope = () => JSON.stringify([id.value, getCountryId(), getToken()])
let loadRequest = 0
const lines = computed<Row[]>(() => r.value.lines ?? [])
const editable = computed(() => r.value.status === 'DRAFT' && user.hasPerm('lgs:receipt:confirm'))
const lineSum = (l: Row) => (l.goodQty || 0) + (l.damagedQty || 0) + (l.pendingInspectQty || 0) + (l.shortQty || 0)
const balanced = (l: Row) => lineSum(l) === l.dispatchQty
const allBalanced = computed(() => lines.value.every(balanced))
const totals = computed(() => ({
  dispatch: lines.value.reduce((s, l) => s + l.dispatchQty, 0),
  good: lines.value.reduce((s, l) => s + (l.goodQty || 0), 0),
  frozen: lines.value.reduce((s, l) => s + (l.damagedQty || 0) + (l.pendingInspectQty || 0), 0),
  short: lines.value.reduce((s, l) => s + (l.shortQty || 0), 0),
}))

async function load() {
  const request = ++loadRequest, scope = receiptScope(), receiptId = id.value
  loading.value = true
  try {
    const result = await http.get<Row>(`/lgs/receipts/${receiptId}`)
    if (request !== loadRequest || scope !== receiptScope()) return
    r.value = result
  } finally {
    if (request === loadRequest) loading.value = false
  }
  nextTick(() => scan.value?.focus())
}

function onScan(code: string) {
  const l = lines.value.find((x) => matchBarcode(x, code))
  if (!l) return ElMessage.error(`${code} 不在这张派送单上，请单独登记为异常`)
  active.value = l.id
  checked.value.add(l.id)
  document.getElementById(`line-${l.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

/** 改了破损、待检、短缺后，合格数自动补齐差额，减少手工计算 */
function autoGood(l: Row) {
  l.goodQty = Math.max(0, l.dispatchQty - (l.damagedQty || 0) - (l.pendingInspectQty || 0) - (l.shortQty || 0))
}

const payload = () => ({
  version: r.value.version,
  bizDate: r.value.bizDate,
  remark: r.value.remark,
  lines: lines.value.map((l) => ({ id: l.id, goodQty: l.goodQty, damagedQty: l.damagedQty, pendingInspectQty: l.pendingInspectQty, shortQty: l.shortQty, remark: l.remark })),
})

async function saveDraft() {
  const scope = receiptScope(), receiptId = id.value
  saving.value = true
  try {
    await http.put<Row>(`/lgs/receipts/${receiptId}`, payload())
    if (scope !== receiptScope()) throw new BizError('CONTEXT_CHANGED', '国家、登录状态或实收单已切换，请重新打开')
    await load()
    ElMessage.success('已暂存')
  } finally {
    saving.value = false
  }
}

async function confirm() {
  if (!allBalanced.value) return ElMessage.error('每行的合格 + 破损 + 待检 + 短缺必须等于派送数量')
  const scope = receiptScope(), receiptId = id.value, body = payload()
  const unchecked = lines.value.filter((l) => !checked.value.has(l.id)).length
  const msg = [
    `合格 ${totals.value.good} 件入可用库存`,
    totals.value.frozen ? `破损/待检 ${totals.value.frozen} 件入冻结库存` : '',
    totals.value.short ? `短缺 ${totals.value.short} 件将生成到货差异` : '',
    unchecked ? `还有 ${unchecked} 行未扫码核对` : '',
  ].filter(Boolean).join('；')
  try {
    await ElMessageBox.confirm(`${msg}。确认后不能修改。`, '确认实收', { type: unchecked ? 'warning' : 'info' })
  } catch {
    return
  }
  saving.value = true
  try {
    if (scope !== receiptScope()) throw new BizError('CONTEXT_CHANGED', '国家、登录状态或实收单已切换，请重新打开')
    const res = await http.postIdem<Row>(`/lgs/receipts/${receiptId}/confirm`, body, idemKey)
    if (scope !== receiptScope()) throw new BizError('CONTEXT_CHANGED', '国家、登录状态或实收单已切换，请重新打开')
    await load()
    ElMessage.success(res.duplicate ? '这张实收单已确认过，没有重复入库' : '实收已确认，库存已增加')
  } finally {
    saving.value = false
  }
}

watch(id, load)
onMounted(load)
</script>

<template>
  <div v-loading="loading" class="page receipt">
    <div class="page-card">
      <div class="page-title">
        <h2>
          <el-button link @click="router.push('/logistics/receipts')"><el-icon><ArrowLeft /></el-icon></el-button>
          实收 <span class="mono">{{ r.docNo }}</span>
          <StatusTag :status="r.status" />
        </h2>
      </div>
      <el-descriptions :column="2" border size="small" class="desc">
        <el-descriptions-item label="派送单"><span class="mono">{{ r.deliveryNo }}</span></el-descriptions-item>
        <el-descriptions-item label="运输批次"><span class="mono">{{ r.shipmentNo }}</span></el-descriptions-item>
        <el-descriptions-item label="仓库">{{ r.warehouseName }}</el-descriptions-item>
        <el-descriptions-item label="业务日期">
          <el-date-picker v-if="editable" v-model="r.bizDate" type="date" value-format="YYYY-MM-DD" size="small" style="width: 150px" />
          <span v-else>{{ r.bizDate }}</span>
        </el-descriptions-item>
        <el-descriptions-item v-if="r.status === 'CONFIRMED'" label="确认" :span="2"><template v-if="r.confirmedAt">{{ r.receivedByName || `用户#${r.confirmedBy}` }} · <DateTimeText :value="r.confirmedAt" /></template><span v-else>历史确认人 / 时刻未记录</span></el-descriptions-item>
      </el-descriptions>
      <ScanInput v-if="editable" ref="scan" class="scan" @scan="onScan" />
    </div>

    <div class="summary page-card">
      <div><span class="muted">派送</span><b>{{ totals.dispatch }}</b></div>
      <div><span class="muted">合格</span><b class="ok">{{ totals.good }}</b></div>
      <div><span class="muted">冻结</span><b class="frozen">{{ totals.frozen }}</b></div>
      <div><span class="muted">短缺</span><b :class="{ bad: totals.short }">{{ totals.short }}</b></div>
    </div>

    <div v-for="l in lines" :id="`line-${l.id}`" :key="l.id" class="page-card line" :class="{ active: active === l.id, unbalanced: !balanced(l) }">
      <div class="line-head">
        <ProductCell :code="l.productCode" :name="l.productName" :extra="l.spec" />
        <div class="line-qty">
          <el-tag v-if="checked.has(l.id)" type="success" size="small">已扫码</el-tag>
          <span class="muted">派送</span> <b>{{ l.dispatchQty }}</b>
        </div>
      </div>
      <div class="grid">
        <label>合格<el-input-number v-model="l.goodQty" :min="0" :max="l.dispatchQty" :disabled="!editable" :controls="editable" /></label>
        <label>破损<el-input-number v-model="l.damagedQty" :min="0" :max="l.dispatchQty" :disabled="!editable" :controls="editable" @change="autoGood(l)" /></label>
        <label>待检<el-input-number v-model="l.pendingInspectQty" :min="0" :max="l.dispatchQty" :disabled="!editable" :controls="editable" @change="autoGood(l)" /></label>
        <label>短缺<el-input-number v-model="l.shortQty" :min="0" :max="l.dispatchQty" :disabled="!editable" :controls="editable" @change="autoGood(l)" /></label>
      </div>
      <div v-if="!balanced(l)" class="bad">合计 {{ lineSum(l) }}，与派送 {{ l.dispatchQty }} 相差 {{ l.dispatchQty - lineSum(l) }}</div>
      <el-input v-if="editable || l.remark" v-model="l.remark" :disabled="!editable" size="small" placeholder="行备注，例如：外箱压损 2 箱" />
      <div v-if="l.batchNo" class="muted">入库批次 <span class="mono">{{ l.batchNo }}</span></div>
    </div>

    <div class="page-card">
      <el-input v-if="editable" v-model="r.remark" type="textarea" :rows="2" placeholder="备注" />
      <p v-else-if="r.remark">{{ r.remark }}</p>
      <h4>现场照片</h4>
      <DocAttachment v-if="r.id" biz-type="LGS_RECEIPT" :biz-id="r.id" category="RECEIPT_PHOTO" />
    </div>

    <div v-if="editable" class="actions">
      <el-button size="large" :loading="saving" @click="saveDraft">暂存</el-button>
      <el-button size="large" type="primary" :disabled="!allBalanced" :loading="saving" @click="confirm">确认实收</el-button>
    </div>
    <div v-else-if="r.status === 'CONFIRMED'" class="page-card">
      <el-result icon="success" title="已入库" :sub-title="totals.short ? `短缺 ${totals.short} 件已生成到货差异，等待物流负责人处理` : '数量与派送一致'">
        <template #extra>
          <el-button @click="router.push('/inventory/stocks')">查看库存</el-button>
          <el-button v-if="totals.short && user.hasPerm('lgs:discrepancy:handle')" type="primary" @click="router.push({ path: '/logistics/discrepancies', query: { status: 'OPEN' } })">处理差异</el-button>
          <el-button type="primary" plain @click="router.push('/logistics/receipts')">继续收下一单</el-button>
        </template>
      </el-result>
    </div>
  </div>
</template>

<style scoped>
.receipt {
  max-width: 860px;
}

h2 {
  display: flex;
  align-items: center;
  gap: 8px;
}

.scan {
  margin-top: 12px;
}

.summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  text-align: center;
}

.summary div {
  display: flex;
  flex-direction: column;
}

.summary b {
  font-size: 22px;
}

.line {
  border: 1px solid transparent;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.line.active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-7);
}

.line.unbalanced {
  border-color: var(--el-color-danger);
}

.line-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.line-qty b {
  font-size: 20px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.grid :deep(.el-input-number) {
  width: 100%;
}

.ok {
  color: var(--el-color-success);
}

.frozen {
  color: var(--el-color-warning);
}

.bad {
  color: var(--el-color-danger);
}

.actions {
  position: sticky;
  bottom: 0;
  display: flex;
  gap: 12px;
  padding: 12px;
  background: var(--el-bg-color);
  border-top: 1px solid var(--el-border-color);
}

.actions .el-button {
  flex: 1;
}

@media (max-width: 640px) {
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .desc :deep(.el-descriptions__table) {
    font-size: 12px;
  }
}
</style>
