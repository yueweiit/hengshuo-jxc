<script setup lang="ts">
import { reportError } from '@/api/error-feedback'
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { BizError, http } from '@/api/http'
import type { Country, MissingItem } from '@/api/types'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'
import StatusTag from '@/components/StatusTag.vue'
import DateTimeText from '@/components/DateTimeText.vue'
import AuditTimeline from '@/components/AuditTimeline.vue'
import FieldInput from '@/components/crud/FieldInput.vue'
import MissingList from './MissingList.vue'
import type { TemplateVersion } from './types'
import { COUNTRY_LOCALES, DATE_FORMATS, MODULES, NUMBER_FORMATS, TIMEZONES, labelOf } from '../constants'

interface CountryDetail extends Country {
  version: number
  logisticsDelayToleranceHours?: number | string | null
  blockCount: number
  warnCount: number
  sourceCountry: Country | null
  sourceTemplateVersionNo: number | null
  cloneJobId: number | null
}

interface Review {
  id: number
  itemKey: string
  label: string
  source: string
  status: string
  reviewedBy: string | null
  reviewedAt: string | null
  comment: string
}

interface Diff {
  itemKey: string
  label: string
  oldLabel: string | null
  changeType: 'ADDED' | 'MODIFIED' | 'REMOVED'
  requiresReview: boolean
}

interface Upgrade {
  id: number
  fromVersionNo: number
  toVersionNo: number
  status: string
  diffs: Diff[]
  createdBy: string
  createdAt: string
  confirmedAt: string | null
}

const CHANGE_LABEL = { ADDED: { t: '新增', c: 'success' }, MODIFIED: { t: '修改', c: 'warning' }, REMOVED: { t: '移除', c: 'info' } } as const

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const countryStore = useCountryStore()
const id = Number(route.params.id)

interface NumberRule { docType: string; prefix: string; datePattern: string; sequenceWidth: number; resetPeriod: string; version?: number }
const numberRules = ref<NumberRule[]>([])
const numberForm = reactive<NumberRule>({ docType: '', prefix: '', datePattern: 'yyyyMMdd', sequenceWidth: 6, resetPeriod: 'NONE' })
async function loadNumberRules() { numberRules.value = await http.get<NumberRule[]>(`/sys/countries/${id}/doc-number-rules`) }
function editNumberRule(rule: NumberRule) { Object.assign(numberForm, rule) }
async function saveNumberRule() {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(numberForm.docType) || !numberForm.prefix) { ElMessage.warning('请填写单据类型和编号前缀'); return }
  await http.put(`/sys/countries/${id}/doc-number-rules/${numberForm.docType}`, { ...numberForm })
  ElMessage.success('编号规则已保存，已签发号码保持不变')
  Object.assign(numberForm, { docType: '', prefix: '', datePattern: 'yyyyMMdd', sequenceWidth: 6, resetPeriod: 'NONE', version: undefined })
  await loadNumberRules()
}

const tab = ref('params')
const detail = ref<CountryDetail | null>(null)
const canEdit = computed(() => user.hasPerm(['sys:country-param:edit', 'sys:country:create']))

async function loadDetail() {
  detail.value = await http.get<CountryDetail>(`/sys/countries/${id}`)
  Object.assign(form, {
    name: detail.value.name,
    defaultCurrency: detail.value.defaultCurrency,
    timezone: detail.value.timezone,
    locale: detail.value.locale,
    dateFormat: detail.value.dateFormat,
    numberFormat: detail.value.numberFormat,
    isTest: detail.value.isTest,
    enabledModules: [...detail.value.enabledModules],
  })
  const configuredHours = detail.value.logisticsDelayToleranceHours
  // 48 is a form default; it becomes effective only after the existing save command succeeds.
  const hours = configuredHours === null || configuredHours === undefined ? 48
    : typeof configuredHours === 'string' && /^[0-9]{1,6}$/.test(configuredHours) ? Number(configuredHours) : configuredHours
  if (typeof hours === 'number' && Number.isInteger(hours) && hours >= 0 && hours <= 999999) {
    form.logisticsDelayToleranceHours = hours
  } else {
    form.logisticsDelayToleranceHours = undefined
    reportError(new Error('物流延误容忍时长配置无效，请重新填写并保存'))
  }
}

// ---------- 地区参数 ----------
const form = reactive({
  name: '',
  defaultCurrency: '',
  timezone: '',
  locale: '',
  dateFormat: '',
  numberFormat: '',
  isTest: false,
  enabledModules: [] as string[],
  logisticsDelayToleranceHours: 48 as number | undefined,
})
const saving = ref(false)
async function saveParams() {
  const hours = form.logisticsDelayToleranceHours
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 0 || hours > 999999) {
    ElMessage.warning('物流延误容忍时长必须为0至999999的整数小时')
    return
  }
  saving.value = true
  try {
    await http.put(`/sys/countries/${id}/params`, { ...form, version: detail.value!.version })
    ElMessage.success('已保存')
    await loadDetail()
    if (countryStore.currentId === id) await user.loadMe()
  } finally {
    saving.value = false
  }
}

// ---------- 就绪检查 ----------
const missing = ref<MissingItem[]>([])
async function loadReadiness() {
  missing.value = (await http.get<{ missing: MissingItem[] }>(`/sys/countries/${id}/readiness`)).missing
}

async function activate() {
  try {
    await http.post(`/sys/countries/${id}/activate`, undefined, { silent: true })
    ElMessage.success('国家已启用')
    await loadDetail()
  } catch (e) {
    if (e instanceof BizError && e.code === 'SYS_CONFIG_MISSING') {
      missing.value = (e.data as { missing: MissingItem[] }).missing
      tab.value = 'readiness'
      reportError(e, { title: '国家未能启用', nextStep: '请在启用检查中处理阻断缺项后重试。' })
    } else reportError(e)
  }
}

// ---------- 复核 ----------
const reviews = ref<Review[]>([])
async function loadReviews() {
  reviews.value = await http.get<Review[]>(`/sys/countries/${id}/reviews`)
}
async function confirmReview(r: Review) {
  const { value } = await ElMessageBox.prompt(`确认「${r.label}」已按${detail.value?.name}的实际情况调整？`, '复核确认', {
    inputPlaceholder: '复核说明，例如：额度改为 MXN 30,000',
    inputValidator: (v) => !!v?.trim() || '请填写复核说明',
  })
  await http.post(`/sys/countries/${id}/reviews/${r.id}/confirm`, { comment: value })
  ElMessage.success('已复核')
  loadReviews()
}

// ---------- 模板升级 ----------
const templates = ref<TemplateVersion[]>([])
const upgrades = ref<Upgrade[]>([])
const toTemplateId = ref<number>()
const pendingUpgrade = computed(() => upgrades.value.find((u) => u.status === 'PREVIEWED'))
const newerTemplates = computed(() =>
  templates.value.filter(
    (t) => t.sourceCountryId === detail.value?.sourceCountry?.id && t.versionNo > (detail.value?.sourceTemplateVersionNo ?? 0),
  ),
)

async function loadUpgrades() {
  if (!detail.value?.sourceCountry) return
  templates.value = await http.get<TemplateVersion[]>('/sys/country-templates', { status: 'PUBLISHED' })
  upgrades.value = await http.get<Upgrade[]>('/sys/template-upgrades', { countryId: id })
  toTemplateId.value = newerTemplates.value.at(-1)?.id ?? newerTemplates.value[0]?.id
}

async function previewUpgrade() {
  if (!toTemplateId.value) return
  await http.post('/sys/template-upgrades', { countryId: id, toTemplateId: toTemplateId.value })
  await loadUpgrades()
}

async function confirmUpgrade(u: Upgrade) {
  await ElMessageBox.confirm(
    `应用模板 v${u.toVersionNo}？需复核的 ${u.diffs.filter((d) => d.requiresReview).length} 项会加入复核清单，已有业务数据不受影响。`,
    '确认升级',
    { type: 'warning' },
  )
  await http.post(`/sys/template-upgrades/${u.id}/confirm`)
  ElMessage.success('已升级')
  await Promise.all([loadDetail(), loadUpgrades(), loadReviews()])
}

function onTab(name: string | number) {
  if (name === 'numbers') loadNumberRules()
  if (name === 'readiness') loadReadiness()
  if (name === 'reviews') loadReviews()
  if (name === 'upgrade') loadUpgrades()
}

onMounted(loadDetail)
</script>

<template>
  <div v-if="detail" class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>
          {{ detail.name }} <span class="muted">{{ detail.code }}</span>
          <StatusTag :status="detail.status" class="ml" />
          <el-tag v-if="detail.isTest" type="warning" size="small" class="ml">测试</el-tag>
        </h2>
        <div class="toolbar">
          <el-button @click="router.push('/settings/countries')">返回</el-button>
          <el-button
            v-if="detail.status === 'DRAFT' && detail.cloneJobId"
            v-perm="'sys:country:create'"
            @click="router.push({ path: '/settings/countries/clone', query: { jobId: detail.cloneJobId } })"
          >
            继续复制向导
          </el-button>
          <el-button v-if="detail.status === 'DRAFT'" v-perm="'sys:country:activate'" type="success" @click="activate">启用国家</el-button>
        </div>
      </div>
      <el-descriptions :column="4" size="small" border>
        <el-descriptions-item label="币种">{{ detail.defaultCurrency || '-' }}</el-descriptions-item>
        <el-descriptions-item label="时区">{{ detail.timezone || '-' }}</el-descriptions-item>
        <el-descriptions-item label="来源">
          {{ detail.sourceCountry ? `${detail.sourceCountry.name} 模板 v${detail.sourceTemplateVersionNo}` : '首个国家（模板来源）' }}
        </el-descriptions-item>
        <el-descriptions-item label="缺项">
          <el-tag v-if="detail.blockCount" type="danger" size="small">阻断 {{ detail.blockCount }}</el-tag>
          <el-tag v-if="detail.warnCount" type="warning" size="small" class="ml">提示 {{ detail.warnCount }}</el-tag>
          <span v-if="!detail.blockCount && !detail.warnCount">无</span>
        </el-descriptions-item>
      </el-descriptions>
    </div>

    <div class="page-card">
      <el-tabs v-model="tab" @tab-change="onTab">
        <el-tab-pane label="地区参数" name="params">
          <el-form label-width="100px" class="narrow" :disabled="!canEdit">
            <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
            <el-form-item label="默认币种">
              <FieldInput
                v-model="form.defaultCurrency"
                :field="{ prop: 'c', label: '默认币种', type: 'select', options: { remote: '/md/currencies', label: 'code', value: 'code' } }"
                :disabled="detail.status === 'ACTIVE'"
              />
              <div v-if="detail.status === 'ACTIVE'" class="muted">国家启用后不能修改默认币种</div>
            </el-form-item>
            <el-form-item label="时区">
              <el-select v-model="form.timezone" filterable allow-create style="width: 100%">
                <el-option v-for="o in TIMEZONES" :key="String(o.value)" v-bind="o" />
              </el-select>
            </el-form-item>
            <el-form-item label="语言区域">
              <el-select v-model="form.locale"><el-option v-for="o in COUNTRY_LOCALES" :key="String(o.value)" v-bind="o" /></el-select>
            </el-form-item>
            <el-form-item label="日期格式">
              <el-select v-model="form.dateFormat"><el-option v-for="o in DATE_FORMATS" :key="String(o.value)" v-bind="o" /></el-select>
            </el-form-item>
            <el-form-item label="数字格式">
              <el-select v-model="form.numberFormat"><el-option v-for="o in NUMBER_FORMATS" :key="String(o.value)" v-bind="o" /></el-select>
            </el-form-item>
            <el-form-item label="启用模块">
              <el-checkbox-group v-model="form.enabledModules">
                <el-checkbox v-for="m in MODULES" :key="String(m.value)" :value="m.value">{{ m.label }}</el-checkbox>
              </el-checkbox-group>
              <div class="muted">未启用的模块在该国家的菜单中隐藏</div>
            </el-form-item>
            <el-form-item label="测试国家"><el-switch v-model="form.isTest" /></el-form-item>
            <el-form-item label="物流延误容忍时长" label-width="150px">
              <el-input-number v-model="form.logisticsDelayToleranceHours" :min="0" :max="999999" :step="1" :precision="0" step-strictly aria-label="物流延误容忍时长（小时）" />
              <span class="ml">小时</span>
              <div class="muted">超过计划发运或到港时间，且未记录对应实际时间时，超过此时长才算延误；0表示不设宽限。</div>
              <div v-if="detail.logisticsDelayToleranceHours === null || detail.logisticsDelayToleranceHours === undefined" class="muted">尚未配置，已预填48小时，保存后生效。</div>
            </el-form-item>
            <el-form-item v-if="canEdit">
              <el-button type="primary" :loading="saving" @click="saveParams">保存</el-button>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <el-tab-pane label="就绪检查" name="readiness">
          <MissingList :items="missing" />
        </el-tab-pane>

        <el-tab-pane label="待复核配置" name="reviews">
          <el-table :data="reviews" border size="small" empty-text="没有需要复核的配置">
            <el-table-column prop="label" label="配置项" min-width="260" />
            <el-table-column prop="source" label="来源" width="140" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }"><StatusTag :status="row.status" /></template>
            </el-table-column>
            <el-table-column label="复核" min-width="220">
              <template #default="{ row }">
                <template v-if="row.reviewedAt">
                  {{ row.reviewedBy }} · <DateTimeText :value="row.reviewedAt" />
                  <div class="muted">{{ row.comment }}</div>
                </template>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="100">
              <template #default="{ row }">
                <el-button v-if="row.status === 'NEED_REVIEW' && canEdit" link type="primary" @click="confirmReview(row)">复核确认</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane label="模板升级" name="upgrade">
          <el-empty v-if="!detail.sourceCountry" description="这个国家是模板来源，不需要升级" />
          <template v-else>
            <div class="upgrade-bar">
              <span>当前模板：{{ detail.sourceCountry.name }} v{{ detail.sourceTemplateVersionNo }}</span>
              <template v-if="newerTemplates.length && !pendingUpgrade">
                <el-select v-model="toTemplateId" style="width: 160px">
                  <el-option v-for="t in newerTemplates" :key="t.id" :label="`升级到 v${t.versionNo}`" :value="t.id" />
                </el-select>
                <el-button v-perm="['sys:template:upgrade', 'sys:country:create']" type="primary" @click="previewUpgrade">生成差异预览</el-button>
              </template>
              <span v-else-if="!newerTemplates.length" class="muted">已是最新版本</span>
            </div>
            <div v-for="u in upgrades" :key="u.id" class="upgrade">
              <div class="upgrade-head">
                <strong>v{{ u.fromVersionNo }} → v{{ u.toVersionNo }}</strong>
                <StatusTag :status="u.status" />
                <span class="muted">{{ u.createdBy }} · <DateTimeText :value="u.createdAt" /></span>
                <el-button
                  v-if="u.status === 'PREVIEWED'"
                  v-perm="['sys:template:upgrade', 'sys:country:create']"
                  type="success"
                  size="small"
                  @click="confirmUpgrade(u)"
                >
                  确认应用
                </el-button>
              </div>
              <el-table :data="u.diffs" size="small" border empty-text="没有差异">
                <el-table-column label="变化" width="80">
                  <template #default="{ row }">
                    <el-tag v-if="row.changeType" :type="CHANGE_LABEL[row.changeType as Diff['changeType']].c" size="small">
                      {{ CHANGE_LABEL[row.changeType as Diff['changeType']].t }}
                    </el-tag>
                  </template>
                </el-table-column>
                <el-table-column prop="label" label="新内容" min-width="240" />
                <el-table-column label="原内容" min-width="200">
                  <template #default="{ row }"><span class="muted">{{ row.changeType === 'MODIFIED' ? row.oldLabel : '-' }}</span></template>
                </el-table-column>
                <el-table-column label="复核" width="90">
                  <template #default="{ row }"><el-tag v-if="row.requiresReview" type="warning" size="small">需复核</el-tag></template>
                </el-table-column>
              </el-table>
            </div>
          </template>
        </el-tab-pane>

        <el-tab-pane label="单据编号" name="numbers" lazy>
          <p class="muted">新单据必须先配置编号规则。编号计数由数据库原子递增；已发号后不能修改重置周期。</p>
          <el-table :data="numberRules" border>
            <el-table-column prop="docType" label="单据类型" /><el-table-column prop="prefix" label="前缀" />
            <el-table-column prop="datePattern" label="日期格式" /><el-table-column prop="sequenceWidth" label="序号位数" />
            <el-table-column prop="resetPeriod" label="重置周期" />
            <el-table-column label="操作"><template #default="{ row }"><el-button v-if="canEdit" link @click="editNumberRule(row)">编辑</el-button></template></el-table-column>
          </el-table>
          <el-form v-if="canEdit" inline style="margin-top: 16px">
            <el-form-item label="单据类型"><el-input v-model="numberForm.docType" :disabled="numberForm.version !== undefined" placeholder="例如 TRANSFER" /></el-form-item>
            <el-form-item label="前缀"><el-input v-model="numberForm.prefix" /></el-form-item>
            <el-form-item label="日期"><el-select v-model="numberForm.datePattern" style="width: 140px"><el-option v-for="pattern in ['', 'yyyy', 'yyyyMM', 'yyyyMMdd']" :key="pattern" :label="pattern || '不带日期'" :value="pattern" /></el-select></el-form-item>
            <el-form-item label="序号位数"><el-input-number v-model="numberForm.sequenceWidth" :min="3" :max="12" /></el-form-item>
            <el-form-item label="重置周期"><el-select v-model="numberForm.resetPeriod" style="width: 120px"><el-option v-for="period in ['NONE', 'YEAR', 'MONTH', 'DAY']" :key="period" :label="period" :value="period" /></el-select></el-form-item>
            <el-button type="primary" @click="saveNumberRule">保存编号规则</el-button>
          </el-form>
        </el-tab-pane>
        <el-tab-pane label="操作日志" name="audit" lazy>
          <AuditTimeline resource-type="country" :resource-id="id" />
        </el-tab-pane>
      </el-tabs>
      <p class="muted modules">已启用模块：{{ detail.enabledModules.map((m) => labelOf(MODULES, m)).join('、') || '无' }}</p>
    </div>
  </div>
</template>

<style scoped lang="scss">
.ml {
  margin-left: 8px;
}

.narrow {
  max-width: 640px;
}

.upgrade-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.upgrade {
  margin-bottom: 16px;
}

.upgrade-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.modules {
  margin-top: 12px;
}
</style>
