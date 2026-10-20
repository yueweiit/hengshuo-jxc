<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { http, createCommandIntent } from '@/api/http'
import { useUserStore } from '@/stores/user'
import CrudPage from '@/components/crud/CrudPage.vue'
import StatusTag from '@/components/StatusTag.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import ApprovalPanel from '@/components/ApprovalPanel.vue'
import ProductCell from '@/components/biz/ProductCell.vue'
import ScanInput from '@/components/biz/ScanInput.vue'
import FieldInput from '@/components/crud/FieldInput.vue'
import type { ColumnDef, CrudPageExpose, FieldDef } from '@/components/crud/types'
import { ALL_WAREHOUSE_SOURCE, CATEGORY_SOURCE, STOCKTAKE_STATUS } from '@/modules/shared/bizOptions'
import { confirmAction, matchBarcode } from '@/utils/action'

const intent = createCommandIntent()

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const user = useUserStore()
const page = ref<CrudPageExpose>()

const columns: ColumnDef[] = [
  { prop: 'docNo', label: '盘点单', width: 185, fixed: 'left' },
  { prop: 'warehouseName', label: '仓库', width: 130 },
  { prop: 'categoryName', label: '范围', width: 120 },
  { prop: 'progress', label: '已盘 / 商品数', width: 120 },
  { prop: 'diff', label: '差异行 · 盘盈 / 盘亏', width: 170 },
  { prop: 'snapshotAt', label: '快照时间', type: 'datetime', width: 170 },
  { prop: 'createdByName', label: '创建人', width: 110 },
  { prop: 'status', label: '状态', type: 'status', width: 100 },
]
const searchFields: FieldDef[] = [
  { prop: 'keyword', label: '单号 / 备注' },
  { prop: 'status', label: '状态', type: 'select', options: STOCKTAKE_STATUS },
  { prop: 'warehouseId', label: '仓库', type: 'select', options: ALL_WAREHOUSE_SOURCE },
]

// ---------- 新建 ----------
const create = reactive({ visible: false, saving: false, warehouseId: undefined as number | undefined, categoryId: undefined as number | undefined, remark: '', start: true })
async function submitCreate() {
  if (!create.warehouseId) return ElMessage.warning('请选择仓库')
  create.saving = true
  try {
    const st = await http.postIdem<Row>('/inv/stocktakes', { warehouseId: create.warehouseId, categoryId: create.categoryId, remark: create.remark, start: create.start }, intent)
    ElMessage.success(create.start ? `已开始盘点，锁定 ${st.lineCount} 个商品` : '已保存草稿')
    create.visible = false
    page.value?.reload()
    if (create.start) openCount(st)
  } finally {
    create.saving = false
  }
}

const act = async (st: Row, path: string, msg: string, success: string) => {
  if (await confirmAction(msg, () => http.postIdem(`/inv/stocktakes/${st.id}/${path}`, {}, intent), { success })) page.value?.reload()
}

// ---------- 录入实盘 ----------
const cnt = reactive({ visible: false, saving: false, st: {} as Row, active: 0, onlyDiff: false, tab: 'lines' })
const countLines = computed<Row[]>(() => (cnt.st.lines ?? []).filter((l: Row) => !cnt.onlyDiff || (l.countedQty != null && l.countedQty !== l.bookQty)))
const editable = computed(() => cnt.st.status === 'COUNTING' && user.hasPerm('inv:stocktake:count'))
const counted = computed(() => (cnt.st.lines ?? []).filter((l: Row) => l.countedQty != null).length)
const diffLines = computed(() => (cnt.st.lines ?? []).filter((l: Row) => diffOf(l)).length)

async function openCount(st: Row) {
  Object.assign(cnt, { visible: true, active: 0, onlyDiff: false, tab: 'lines', st: await http.get<Row>(`/inv/stocktakes/${st.id}`) })
}
function onScan(code: string) {
  const l = (cnt.st.lines as Row[]).find((x) => matchBarcode(x, code))
  if (!l) return ElMessage.error(`${code} 不在盘点范围内`)
  l.countedQty = (l.countedQty ?? 0) + 1
  cnt.active = l.id
}
async function saveCounts(silent = false) {
  cnt.saving = true
  try {
    cnt.st = await http.putIdem<Row>(`/inv/stocktakes/${cnt.st.id}/lines`, { version: cnt.st.version, lines: cnt.st.lines.map((l: Row) => ({ id: l.id, countedQty: l.countedQty, reason: l.reason })) }, intent)
    if (!silent) ElMessage.success('已保存')
  } finally {
    cnt.saving = false
  }
}
async function submitCount() {
  const lines = cnt.st.lines as Row[]
  if (lines.some((l) => l.countedQty == null)) return ElMessage.warning(`还有 ${lines.length - counted.value} 个商品未录入实盘`)
  const noReason = lines.find((l) => diffOf(l) && !l.reason?.trim())
  if (noReason) {
    cnt.active = noReason.id
    return ElMessage.warning(`${noReason.productCode} 有差异，请填写差异原因`)
  }
  await saveCounts(true)
  const res = await http.postIdem<Row>(`/inv/stocktakes/${cnt.st.id}/submit`, {}, intent)
  ElMessage.success(res.approvalMessage ?? '已提交')
  cnt.st = await http.get<Row>(`/inv/stocktakes/${cnt.st.id}`)
  page.value?.reload()
}
async function postCount() {
  if (await confirmAction('过账后生成盘盈盘亏流水并解除锁定，不能撤销。', () => http.postIdem(`/inv/stocktakes/${cnt.st.id}/post`, {}, intent), { success: '已过账' })) {
    cnt.st = await http.get<Row>(`/inv/stocktakes/${cnt.st.id}`)
    page.value?.reload()
  }
}
const diffOf = (l: Row) => (l.countedQty == null ? null : l.countedQty - l.bookQty)
</script>

<template>
  <CrudPage ref="page" title="盘点单" resource="/inv/stocktakes" :columns="columns" :search-fields="searchFields" :can-create="false" :can-toggle="false" audit-type="stocktake" :actions-width="200">
    <template #toolbar>
      <el-button v-if="user.hasPerm('inv:stocktake:create')" type="primary" @click="Object.assign(create, { visible: true, warehouseId: undefined, categoryId: undefined, remark: '', start: true })">
        <el-icon><Plus /></el-icon>新建盘点
      </el-button>
    </template>
    <template #header>
      <p class="muted">开始盘点时生成账面快照并锁定范围内商品，盘点期间这些商品不能出入库。差异需要审批，过账后才生成盘盈盘亏流水；不能直接改库存余额。</p>
    </template>
    <template #col-docNo="{ row }"><el-link type="primary" @click="openCount(row)">{{ row.docNo }}</el-link></template>
    <template #col-categoryName="{ row }">{{ row.categoryName || '全部商品' }}</template>
    <template #col-progress="{ row }"><span class="mono">{{ row.countedCount }} / {{ row.lineCount }}</span></template>
    <template #col-diff="{ row }">
      <span class="mono">{{ row.diffLineCount }} · <span class="pos">+{{ row.gainQty }}</span> / <span class="neg">−{{ row.lossQty }}</span></span>
    </template>
    <template #row-actions="{ row }">
      <el-button v-if="row.status === 'DRAFT' && user.hasPerm('inv:stocktake:create')" link type="primary" @click="act(row, 'start', '开始盘点？会生成账面快照并锁定范围内商品。', '已开始盘点')">开始</el-button>
      <el-button v-if="row.status === 'COUNTING' && user.hasPerm('inv:stocktake:count')" link type="primary" @click="openCount(row)">录入实盘</el-button>
      <el-button v-if="row.status === 'APPROVED' && user.hasPerm(['inv:stocktake:approve', 'inv:stocktake:submit'])" link type="success" @click="act(row, 'post', '过账后生成盘盈盘亏流水并解除锁定，不能撤销。', '已过账')">过账</el-button>
      <el-button v-if="['DRAFT', 'COUNTING'].includes(row.status) && user.hasPerm('inv:stocktake:create')" link type="danger" @click="act(row, 'cancel', '取消盘点并解除锁定？', '已取消')">取消</el-button>
    </template>
  </CrudPage>

  <el-dialog v-model="create.visible" title="新建盘点" width="480px" append-to-body>
    <el-form label-width="90px">
      <el-form-item label="仓库" required>
        <FieldInput v-model="create.warehouseId" :field="{ prop: 'warehouseId', label: '仓库', type: 'select', options: ALL_WAREHOUSE_SOURCE }" />
      </el-form-item>
      <el-form-item label="商品分类">
        <FieldInput v-model="create.categoryId" :field="{ prop: 'categoryId', label: '分类', type: 'select', options: CATEGORY_SOURCE }" clearable />
      </el-form-item>
      <el-form-item label="备注"><el-input v-model="create.remark" /></el-form-item>
      <el-form-item><el-checkbox v-model="create.start">立即开始（生成快照并锁定）</el-checkbox></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="create.visible = false">取消</el-button>
      <el-button type="primary" :loading="create.saving" @click="submitCreate">确定</el-button>
    </template>
  </el-dialog>

  <el-drawer v-model="cnt.visible" size="860px" append-to-body>
    <template #header>
      <span class="drawer-title">盘点 <span class="mono">{{ cnt.st.docNo }}</span> <StatusTag :status="cnt.st.status" /> · {{ cnt.st.warehouseName }}</span>
    </template>
    <div class="bar">
      <span class="muted">快照 <DateTimeText :value="cnt.st.snapshotAt" /> · 已盘 {{ counted }} / {{ cnt.st.lineCount }} · 差异 {{ diffLines }} 行</span>
      <el-checkbox v-model="cnt.onlyDiff">只看差异</el-checkbox>
    </div>
    <ScanInput v-if="editable" class="mb" placeholder="扫码每次 +1，也可以直接在表格里填写" @scan="onScan" />
    <el-tabs v-model="cnt.tab">
      <el-tab-pane label="明细" name="lines">
        <el-table :data="countLines" border size="small" max-height="520" :row-class-name="({ row }: { row: Row }) => (row.id === cnt.active ? 'active-row' : '')">
          <el-table-column label="商品" min-width="180"><template #default="{ row }"><ProductCell :code="row.productCode" :name="row.productName" /></template></el-table-column>
          <el-table-column prop="bookQty" label="账面" width="70" align="right" />
          <el-table-column label="实盘" width="120">
            <template #default="{ row }">
              <el-input-number v-if="editable" v-model="row.countedQty" :min="0" :controls="false" :value-on-clear="null" style="width: 100%" />
              <span v-else>{{ row.countedQty ?? '-' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="差异" width="70" align="right">
            <template #default="{ row }"><span :class="diffOf(row) == null ? 'muted' : diffOf(row)! > 0 ? 'pos' : diffOf(row)! < 0 ? 'neg' : ''">{{ diffOf(row) == null ? '-' : diffOf(row)! > 0 ? `+${diffOf(row)}` : diffOf(row) }}</span></template>
          </el-table-column>
          <el-table-column label="差异原因" min-width="180">
            <template #default="{ row }">
              <el-input v-if="editable && diffOf(row)" v-model="row.reason" size="small" placeholder="有差异必须填写" />
              <span v-else>{{ row.reason }}</span>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
      <el-tab-pane v-if="cnt.st.approvalInstanceId" label="审批" name="approval"><ApprovalPanel doc-type="STOCKTAKE" :doc-id="cnt.st.id" /></el-tab-pane>
    </el-tabs>
    <template #footer>
      <template v-if="editable">
        <el-button :loading="cnt.saving" @click="saveCounts()">保存</el-button>
        <el-button v-if="user.hasPerm('inv:stocktake:submit')" type="primary" :loading="cnt.saving" @click="submitCount">提交</el-button>
      </template>
      <el-button v-if="cnt.st.status === 'APPROVED' && user.hasPerm(['inv:stocktake:approve', 'inv:stocktake:submit'])" type="success" @click="postCount">过账</el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
.bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.mb {
  margin-bottom: 8px;
}

.drawer-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
}

.pos {
  color: var(--el-color-success);
  font-weight: 600;
}

.neg {
  color: var(--el-color-danger);
  font-weight: 600;
}

:deep(.active-row) {
  --el-table-tr-bg-color: var(--el-color-primary-light-9);
}
</style>
