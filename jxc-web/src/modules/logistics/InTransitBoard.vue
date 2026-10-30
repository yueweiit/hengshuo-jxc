<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { http } from '@/api/http'
import type { PageResult } from '@/api/types'
import { useCountryStore } from '@/stores/country'
import FieldInput from '@/components/crud/FieldInput.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import StatusTag from '@/components/StatusTag.vue'
import QtyText from '@/components/QtyText.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import { BUCKETS, MX_WAREHOUSE_SOURCE, PRODUCT_SOURCE } from '@/modules/shared/bizOptions'

type Phase = 'intlQty' | 'pendingDeliveryQty' | 'onHoldQty' | 'deliveringQty'
type QuantityKey = Phase | 'totalQty' | 'openDiscrepancyQty'
type Quantities = Record<QuantityKey, number> & { unit: string }
type Shipment = Quantities & { id: number; docNo: string; status: string; plannedEta?: string; actualEta?: string; timezone?: string }
type Row = Quantities & { id: string; warehouseName: string; productCode: string; productName: string; shipments: Shipment[] }
type Delay = { id: number; docNo: string; carrierName: string; destWarehouseName: string; status: string; delayStage: string; delayHours: number; plannedAt: string; timezone?: string }
type Rule = { status: 'ACTIVE' | 'MISSING' | 'INVALID'; toleranceHours: number | null; message: string }
type Query = { warehouseId?: number; productId?: number }
type BoardResult = PageResult<Row> & { summary: Quantities[] }
type DelayResult = PageResult<Delay> & { rule: Rule }

const router = useRouter()
const country = useCountryStore()
const phases = BUCKETS.slice(0, 4) as { prop: Phase; label: string }[]
const metrics = [{ prop: 'totalQty', label: '在途合计' }, ...phases, { prop: 'openDiscrepancyQty', label: '未结差异' }] as { prop: QuantityKey; label: string }[]
const draft = reactive<Query>({})
const applied = reactive<Query>({})
const filtered = computed(() => applied.warehouseId !== undefined || applied.productId !== undefined)
const rows = ref<Row[]>([])
const summary = ref<Quantities[] | null>(null)
const page = ref(1), size = ref(20), total = ref(0)
const delayed = ref<Delay[]>([])
const delayPage = ref(1), delaySize = ref(20), delayTotal = ref(0)
const delayRule = ref<Rule | null>(null)
const loading = ref(false), delayLoading = ref(false)
const boardError = ref(''), delayError = ref('')
let boardRequest = 0, delayRequest = 0, active = true

function checkPage<T>(value: PageResult<T>): void {
  if (!value || !Array.isArray(value.records) || !Number.isSafeInteger(value.total) || value.total < 0
    || !Number.isSafeInteger(value.page) || value.page < 1 || !Number.isSafeInteger(value.size) || value.size < 1) {
    throw new Error('看板返回的数据格式不正确，请重试或联系管理员')
  }
}
function checkQuantities(value: Quantities): void {
  if (!value || typeof value.unit !== 'string' || !value.unit.trim()
    || metrics.some(({ prop }) => typeof value[prop] !== 'number' || !Number.isFinite(value[prop]) || value[prop] < 0)) {
    throw new Error('看板数量或单位不完整，请重试或联系管理员')
  }
}


async function loadBoard() {
  const request = ++boardRequest, epoch = country.epoch
  loading.value = true
  boardError.value = ''
  summary.value = null
  try {
    const response = await http.get<BoardResult>('/lgs/in-transit', { ...applied, page: page.value, size: size.value }, { silent: true })
    if (!active || request !== boardRequest || epoch !== country.epoch) return
    checkPage(response)
    if (!Array.isArray(response.summary)) throw new Error('看板缺少完整汇总，请重试或联系管理员')
    response.summary.forEach(checkQuantities)
    response.records.forEach(row => {
      checkQuantities(row)
      if (!Array.isArray(row.shipments)) throw new Error('看板批次明细不完整，请重试或联系管理员')
      row.shipments.forEach(checkQuantities)
    })
    rows.value = response.records
    summary.value = response.summary
    total.value = response.total
    page.value = response.page
  } catch (error) {
    if (active && request === boardRequest && epoch === country.epoch) boardError.value = feedbackMessage(error, "读取失败，请重试")
  } finally {
    if (active && request === boardRequest && epoch === country.epoch) loading.value = false
  }
}

async function loadDelays() {
  const request = ++delayRequest, epoch = country.epoch
  delayLoading.value = true
  delayError.value = ''
  delayRule.value = null
  try {
    const response = await http.get<DelayResult>('/lgs/in-transit', { ...applied, view: 'delays', page: delayPage.value, size: delaySize.value }, { silent: true })
    if (!active || request !== delayRequest || epoch !== country.epoch) return
    checkPage(response)
    if (!response.rule || !['ACTIVE', 'MISSING', 'INVALID'].includes(response.rule.status)) throw new Error('延误规则信息不完整，请重试或联系管理员')
    if (response.rule.status === 'ACTIVE' && (!Number.isSafeInteger(response.rule.toleranceHours) || response.rule.toleranceHours === null || response.rule.toleranceHours < 0)) throw new Error('延误规则缺少有效容忍时长，请重试或联系管理员')
    if (response.records.some(row => !Number.isSafeInteger(row.id) || row.id < 1 || !row.docNo || !row.delayStage || !row.plannedAt || !Number.isSafeInteger(row.delayHours) || row.delayHours < 0)) throw new Error('延误批次数据不完整，请重试或联系管理员')
    delayed.value = response.records
    delayTotal.value = response.total
    delayPage.value = response.page
    delayRule.value = response.rule
  } catch (error) {
    if (active && request === delayRequest && epoch === country.epoch) delayError.value = feedbackMessage(error, "读取失败，请重试")
  } finally {
    if (active && request === delayRequest && epoch === country.epoch) delayLoading.value = false
  }
}

async function refresh() { await Promise.all([loadBoard(), loadDelays()]) }
async function search() {
  applied.warehouseId = draft.warehouseId ?? undefined
  applied.productId = draft.productId ?? undefined
  page.value = 1
  delayPage.value = 1
  await refresh()
}
async function reset() { draft.warehouseId = undefined; draft.productId = undefined; await search() }
async function changePage(value: number) { page.value = value; await loadBoard() }
async function changeSize(value: number) { size.value = value; page.value = 1; await loadBoard() }
async function changeDelayPage(value: number) { delayPage.value = value; await loadDelays() }
async function changeDelaySize(value: number) { delaySize.value = value; delayPage.value = 1; await loadDelays() }
const open = (id: number) => router.push(`/logistics/shipments/${id}`)

onMounted(refresh)
onBeforeUnmount(() => { active = false; boardRequest++; delayRequest++ })
</script>

<template>
  <div class="page in-transit-board">
    <section class="page-card">
      <div class="page-title">
        <div>
          <h2>在途看板</h2>
          <p class="board-description">查看货物所处阶段，跟进未结差异和延误批次。在途数量不计入可用库存。</p>
        </div>
        <el-button :loading="loading || delayLoading" @click="refresh"><el-icon><Refresh /></el-icon><span>刷新</span></el-button>
      </div>
      <el-form inline class="search-form board-search" @submit.prevent="search">
        <el-form-item label="目的仓">
          <FieldInput v-model="draft.warehouseId" :field="{ prop: 'warehouseId', label: '目的仓', type: 'select', options: MX_WAREHOUSE_SOURCE }" />
        </el-form-item>
        <el-form-item label="商品">
          <FieldInput v-model="draft.productId" :field="{ prop: 'productId', label: '商品', type: 'select', options: PRODUCT_SOURCE }" />
        </el-form-item>
        <el-form-item class="search-actions">
          <el-button type="primary" native-type="submit" :loading="loading || delayLoading">查询</el-button>
          <el-button @click="reset">重置</el-button>
        </el-form-item>
      </el-form>
      <div class="board-overview" :aria-busy="loading">
        <div v-for="metric in metrics" :key="metric.prop" class="board-metric" :class="`metric--${metric.prop}`">
          <span class="metric-label">{{ metric.label }}</span>
          <span v-if="!summary" class="metric-value metric-unknown">—</span>
          <span v-else-if="!summary.length" class="metric-value">0</span>
          <div v-else class="metric-values">
            <QtyText v-for="item in summary" :key="item.unit" :value="item[metric.prop]" :unit="item.unit" class="metric-value" />
          </div>
        </div>
      </div>
      <p class="overview-note">按当前已查询条件汇总全部结果；不同基础单位分别展示。未结差异单独跟踪，不计入在途合计。</p>
    </section>

    <section v-loading="loading" class="page-card board-section" :aria-busy="loading">
      <div class="section-heading">
        <h3>商品在途明细 <span v-if="!loading && !boardError" class="section-count">{{ total }} 组</span></h3>
        <span class="muted">展开可查看关联运输批次</span>
      </div>
      <div v-if="boardError" role="alert" class="read-error">
        <div  class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p></div>
        <el-button @click="loadBoard">重新加载</el-button>
      </div>
      <template v-else>
        <div class="table-scroll">
          <el-table :data="rows" border stripe row-key="id" :empty-text="loading ? '正在读取在途数量…' : filtered ? '没有符合筛选条件的在途记录' : '当前没有在途或未结差异'">
            <el-table-column type="expand" width="44">
              <template #default="{ row }">
                <div class="shipment-expansion">
                  <div class="expansion-heading">{{ row.warehouseName }} · {{ row.productCode }} <span class="muted">关联 {{ row.shipments.length }} 个运输批次</span></div>
                  <div class="table-scroll">
                    <el-table :data="row.shipments" border stripe size="small" row-key="id">
                      <el-table-column label="批次号" min-width="190"><template #default="{ row: shipment }"><el-button link type="primary" class="mono doc-link" @click="open(shipment.id)">{{ shipment.docNo }}</el-button></template></el-table-column>
                      <el-table-column label="状态" width="110"><template #default="{ row: shipment }"><StatusTag :status="shipment.status" /></template></el-table-column>
                      <el-table-column label="计划到港" min-width="205"><template #default="{ row: shipment }"><DateTimeText :value="shipment.plannedEta" :tz="shipment.timezone" /></template></el-table-column>
                      <el-table-column label="实际到港" min-width="205"><template #default="{ row: shipment }"><DateTimeText v-if="shipment.actualEta" :value="shipment.actualEta" :tz="shipment.timezone" /><span v-else class="muted">未记录</span></template></el-table-column>
                      <el-table-column v-for="metric in metrics" :key="metric.prop" :label="metric.label" min-width="110" align="right"><template #default="{ row: shipment }"><QtyText :value="shipment[metric.prop]" :unit="shipment.unit" /></template></el-table-column>
                    </el-table>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="warehouseName" label="目的仓" min-width="140" show-overflow-tooltip />
            <el-table-column label="商品" min-width="200"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
            <el-table-column label="在途合计" min-width="135" align="right">
              <template #default="{ row }">
                <QtyText :value="row.totalQty" :unit="row.unit" class="total-quantity" />
                <div v-if="row.totalQty > 0" class="distribution" aria-hidden="true">
                  <span v-for="phase in phases" :key="phase.prop" :class="`phase--${phase.prop}`" :style="{ flexGrow: row[phase.prop] }" />
                </div>
              </template>
            </el-table-column>
            <el-table-column v-for="phase in phases" :key="phase.prop" :label="phase.label" min-width="115" align="right"><template #default="{ row }"><QtyText :value="row[phase.prop]" :unit="row.unit" /></template></el-table-column>
            <el-table-column label="未结差异" min-width="115" align="right"><template #default="{ row }"><QtyText :value="row.openDiscrepancyQty" :unit="row.unit" :class="{ 'quantity-warning': row.openDiscrepancyQty > 0 }" /></template></el-table-column>
            <el-table-column label="批次数" width="80" align="right"><template #default="{ row }">{{ row.shipments.length }}</template></el-table-column>
          </el-table>
        </div>
        <el-pagination class="board-pagination" background :current-page="page" :page-size="size" :total="total" :page-sizes="[20, 50, 100]" :pager-count="5" layout="total, sizes, prev, pager, next" :disabled="loading" @current-change="changePage" @size-change="changeSize" />
      </template>
    </section>

    <section v-loading="delayLoading" class="page-card board-section" :aria-busy="delayLoading">
      <div class="section-heading">
        <h3>延误批次 <span v-if="!delayLoading && !delayError && delayRule?.status === 'ACTIVE'" class="section-count">{{ delayTotal }} 个</span></h3>
        <span v-if="delayRule?.status === 'ACTIVE'" class="muted">超过计划 {{ delayRule.toleranceHours }} 小时且未记录对应节点</span>
      </div>
      <div v-if="delayError" role="alert" class="read-error">
        <div  class="request-state" role="status"><p class="muted">操作未完成，请查看全局提示。</p></div>
        <el-button @click="loadDelays">重新加载</el-button>
      </div>
      <el-alert v-else-if="delayRule && delayRule.status !== 'ACTIVE'" :title="delayRule.message" description="暂时无法判定延误，请检查当前国家的物流延误配置。" type="warning" :closable="false" show-icon />
      <template v-else>
        <div class="table-scroll">
          <el-table :data="delayed" border stripe row-key="id" :empty-text="delayLoading ? '正在检查延误批次…' : filtered ? '当前筛选范围内没有延误批次' : '当前没有延误批次'">
            <el-table-column label="批次号" min-width="190"><template #default="{ row }"><el-button link type="primary" class="mono doc-link" @click="open(row.id)">{{ row.docNo }}</el-button></template></el-table-column>
            <el-table-column prop="carrierName" label="物流商" min-width="140" show-overflow-tooltip />
            <el-table-column prop="destWarehouseName" label="目的仓" min-width="140" show-overflow-tooltip />
            <el-table-column label="计划节点" min-width="220"><template #default="{ row }"><div>{{ row.delayStage }}</div><DateTimeText :value="row.plannedAt" :tz="row.timezone" /></template></el-table-column>
            <el-table-column label="延误时长" min-width="140"><template #default="{ row }"><el-tag type="danger" size="small">已超计划 {{ row.delayHours }} 小时</el-tag></template></el-table-column>
            <el-table-column label="状态" width="110"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
            <el-table-column label="操作" width="85"><template #default="{ row }"><el-button link type="primary" @click="open(row.id)">查看</el-button></template></el-table-column>
          </el-table>
        </div>
        <el-pagination class="board-pagination" background :current-page="delayPage" :page-size="delaySize" :total="delayTotal" :page-sizes="[20, 50, 100]" :pager-count="5" layout="total, sizes, prev, pager, next" :disabled="delayLoading" @current-change="changeDelayPage" @size-change="changeDelaySize" />
      </template>
    </section>
  </div>
</template>

<style scoped lang="scss" src="./in-transit-board.scss" />
