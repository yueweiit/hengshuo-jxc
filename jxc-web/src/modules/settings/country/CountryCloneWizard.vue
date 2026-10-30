<script setup lang="ts">
import { reportError } from '@/api/error-feedback'
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { BizError, http } from '@/api/http'
import type { Country, MissingItem } from '@/api/types'
import FieldInput from '@/components/crud/FieldInput.vue'
import { useSwitchCountry } from '@/composables/useSwitchCountry'
import { useUserStore } from '@/stores/user'
import MissingList from './MissingList.vue'
import type { TemplateItem } from './types'
import { COUNTRY_LOCALES, DATE_FORMATS, MODULES, NUMBER_FORMATS, TIMEZONES } from '../constants'

interface Template {
  id: number
  sourceCountryId: number
  sourceCountryName: string
  versionNo: number
  changeNote: string
  items: TemplateItem[]
}

interface OrgRow {
  code: string
  name: string
  [key: string]: unknown
}

interface Job {
  id: number
  status: 'DRAFT' | 'APPLIED' | 'DONE'
  selectedItemIds: number[]
  template: Template
  sourceCountry: Country
  targetCountry: Country & { addressRule?: unknown; version: number }
  entity: OrgRow | null
  warehouse: OrgRow | null
  store: OrgRow | null
  book: OrgRow | null
  adminUserIds: number[]
}

interface Preview {
  copyList: TemplateItem[]
  excluded: (TemplateItem & { reason: string })[]
  missing: MissingItem[]
}

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const switchCountry = useSwitchCountry()

const STEPS = ['来源与版本', '复制范围', '本地参数', '组织与账套', '国家管理员', '预览与启用']
const step = ref(0)
const busy = ref(false)
const job = ref<Job | null>(null)

// ---------- 第 1 步 ----------
const templates = ref<Template[]>([])
const source = reactive({ templateId: undefined as number | undefined, targetCode: '', targetName: '', isTest: false })
const chosenTemplate = computed(() => templates.value.find((t) => t.id === source.templateId))

// ---------- 第 2 步 ----------
const selected = ref<number[]>([])

// ---------- 第 3 步 ----------
const params = reactive({
  name: '',
  defaultCurrency: '',
  timezone: '',
  locale: '',
  dateFormat: 'DD/MM/YYYY',
  numberFormat: '1,234.56',
  isTest: false,
  enabledModules: [] as string[],
  version: 0,
})

// ---------- 第 4 步 ----------
const org = reactive({
  entity: { code: '', name: '', legalName: '', taxId: '' },
  warehouse: { code: '', name: '', address: '' },
  store: { code: '', name: '', address: '' },
  book: { code: '', name: '' },
  withStore: false,
})

// ---------- 第 5 步 ----------
const adminUserIds = ref<number[]>([])

// ---------- 第 6 步 ----------
const preview = ref<Preview | null>(null)
const activated = ref(false)

function hydrate(j: Job) {
  job.value = j
  selected.value = [...j.selectedItemIds]
  const c = j.targetCountry
  Object.assign(params, {
    name: c.name,
    defaultCurrency: c.defaultCurrency,
    timezone: c.timezone,
    locale: c.locale,
    dateFormat: c.dateFormat,
    numberFormat: c.numberFormat,
    isTest: c.isTest,
    enabledModules: [...c.enabledModules],
    version: c.version,
  })
  const code = c.code
  if (j.entity) Object.assign(org.entity, j.entity)
  else Object.assign(org.entity, { code: `${code}-E01`, name: '', legalName: '', taxId: '' })
  if (j.warehouse) Object.assign(org.warehouse, j.warehouse)
  else Object.assign(org.warehouse, { code: `${code}-WH01`, name: `${c.name}中心仓`, address: '' })
  if (j.store) {
    Object.assign(org.store, j.store)
    org.withStore = true
  } else Object.assign(org.store, { code: `${code}-ST01`, name: `${c.name}一号店`, address: '' })
  if (j.book) Object.assign(org.book, j.book)
  else Object.assign(org.book, { code: `${code}-B01`, name: `${c.name}主账套` })
  adminUserIds.value = [...j.adminUserIds]
}

async function next() {
  busy.value = true
  try {
    if (step.value === 0) {
      if (!job.value) {
        if (!source.templateId || !source.targetCode) {
          ElMessage.warning('请选择模板并填写国家代码')
          return
        }
        const j = await http.post<Job>('/sys/country-clone-jobs', source)
        hydrate(j)
        router.replace({ query: { jobId: j.id } })
      }
    } else if (step.value === 1) {
      if (job.value!.status === 'DRAFT') hydrate(await http.put<Job>(`/sys/country-clone-jobs/${job.value!.id}/items`, { itemIds: selected.value }))
    } else if (step.value === 2) {
      if (!params.defaultCurrency || !params.timezone) {
        ElMessage.warning('默认币种和时区为必填项')
        return
      }
      await http.put(`/sys/countries/${job.value!.targetCountry.id}/params`, params)
      hydrate(await http.get<Job>(`/sys/country-clone-jobs/${job.value!.id}`))
    } else if (step.value === 3) {
      if (!org.entity.code || !org.entity.name || !org.warehouse.code || !org.warehouse.name) {
        ElMessage.warning('经营主体和仓库为必填项')
        return
      }
      hydrate(
        await http.post<Job>(`/sys/country-clone-jobs/${job.value!.id}/org`, {
          entity: org.entity,
          warehouse: org.warehouse,
          store: org.withStore ? org.store : undefined,
          book: org.book.code ? org.book : undefined,
        }),
      )
    } else if (step.value === 4) {
      if (!adminUserIds.value.length) {
        ElMessage.warning('至少指定一名国家管理员')
        return
      }
      hydrate(await http.post<Job>(`/sys/country-clone-jobs/${job.value!.id}/admin`, { userIds: adminUserIds.value }))
      await loadPreview()
    }
    step.value++
  } finally {
    busy.value = false
  }
}

async function loadPreview() {
  preview.value = await http.get<Preview>(`/sys/country-clone-jobs/${job.value!.id}/preview`)
}

async function apply() {
  busy.value = true
  try {
    hydrate(await http.post<Job>(`/sys/country-clone-jobs/${job.value!.id}/apply`))
    ElMessage.success('已生成配置草稿，需复核的条目已加入复核清单')
    await loadPreview()
  } finally {
    busy.value = false
  }
}

async function activate() {
  busy.value = true
  try {
    await http.post(`/sys/countries/${job.value!.targetCountry.id}/activate`, undefined, { silent: true })
    activated.value = true
    await loadPreview()
  } catch (e) {
    if (e instanceof BizError && e.code === 'SYS_CONFIG_MISSING') {
      preview.value!.missing = (e.data as { missing: MissingItem[] }).missing
      reportError(e, { title: '国家未能启用', nextStep: '请在启用检查中处理阻断缺项后重试。' })
    } else reportError(e)
  } finally {
    busy.value = false
  }
}

const blocked = computed(() => preview.value?.missing.some((m) => m.level === 'BLOCK') ?? true)
const readonlyItems = computed(() => job.value?.status !== 'DRAFT')

onMounted(async () => {
  const jobId = Number(route.query.jobId)
  if (jobId) {
    hydrate(await http.get<Job>(`/sys/country-clone-jobs/${jobId}`))
    if (job.value!.status !== 'DRAFT') {
      step.value = 5
      await loadPreview()
      activated.value = job.value!.status === 'DONE'
    } else step.value = 1
  } else {
    templates.value = (await http.get<Template[]>('/sys/country-templates', { status: 'PUBLISHED' }))
    source.templateId = templates.value[0]?.id
  }
})

const userSource = { remote: '/sys/user-options', label: 'displayName' }
</script>

<template>
  <div class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>
          从模板新建国家
          <span v-if="job" class="muted">· {{ job.targetCountry.name }}（{{ job.targetCountry.code }}）</span>
        </h2>
        <el-button @click="router.push('/settings/countries')">返回国家列表</el-button>
      </div>
      <el-steps :active="step" finish-status="success" align-center class="steps">
        <el-step v-for="s in STEPS" :key="s" :title="s" />
      </el-steps>

      <!-- 1 来源与版本 -->
      <div v-if="step === 0" class="body">
        <el-descriptions v-if="job" :column="1" border class="narrow">
          <el-descriptions-item label="模板">{{ job.sourceCountry.name }} · v{{ job.template.versionNo }}</el-descriptions-item>
          <el-descriptions-item label="说明">{{ job.template.changeNote }}</el-descriptions-item>
          <el-descriptions-item label="目标国家">{{ job.targetCountry.name }}（{{ job.targetCountry.code }}）</el-descriptions-item>
        </el-descriptions>
        <el-form v-else label-width="110px" class="narrow">
          <el-form-item label="模板版本" required>
            <el-select v-model="source.templateId" style="width: 100%">
              <el-option v-for="t in templates" :key="t.id" :label="`${t.sourceCountryName} · v${t.versionNo}`" :value="t.id" />
            </el-select>
            <div v-if="chosenTemplate" class="muted">{{ chosenTemplate.changeNote }}</div>
          </el-form-item>
          <el-form-item label="国家代码" required>
            <el-input v-model="source.targetCode" maxlength="2" placeholder="ISO 3166-1 两位字母，例如 CO" style="width: 200px" />
          </el-form-item>
          <el-form-item label="国家名称">
            <el-input v-model="source.targetName" placeholder="例如 哥伦比亚" />
          </el-form-item>
          <el-form-item label="测试国家">
            <el-switch v-model="source.isTest" />
            <span class="muted ml">测试国家的数据不进入正式汇总</span>
          </el-form-item>
        </el-form>
      </div>

      <!-- 2 复制范围 -->
      <div v-else-if="step === 1 && job" class="body">
        <el-alert
          v-if="readonlyItems"
          type="info"
          :closable="false"
          title="配置草稿已生成，复制范围不能再修改"
          class="mb"
        />
        <el-checkbox-group v-model="selected" :disabled="readonlyItems" class="items">
          <div v-for="item in job.template.items" :key="item.id" class="item">
            <el-checkbox :value="item.id" :disabled="item.sensitive">{{ item.label }}</el-checkbox>
            <el-tag v-if="item.sensitive" type="danger" size="small">敏感，禁止复制</el-tag>
            <el-tag v-else-if="item.requiresReview" type="warning" size="small">复制后需复核</el-tag>
          </div>
        </el-checkbox-group>
      </div>

      <!-- 3 本地参数 -->
      <div v-else-if="step === 2" class="body">
        <el-form label-width="110px" class="narrow">
          <el-form-item label="国家名称"><el-input v-model="params.name" /></el-form-item>
          <el-form-item label="默认币种" required>
            <FieldInput v-model="params.defaultCurrency" :field="{ prop: 'c', label: '默认币种', type: 'select', options: { remote: '/md/currencies', label: 'code', value: 'code' } }" />
            <div class="muted">启用后不能修改</div>
          </el-form-item>
          <el-form-item label="时区" required>
            <el-select v-model="params.timezone" filterable allow-create style="width: 100%">
              <el-option v-for="o in TIMEZONES" :key="String(o.value)" v-bind="o" />
            </el-select>
          </el-form-item>
          <el-form-item label="语言区域">
            <el-select v-model="params.locale" style="width: 100%">
              <el-option v-for="o in COUNTRY_LOCALES" :key="String(o.value)" v-bind="o" />
            </el-select>
          </el-form-item>
          <el-form-item label="日期格式">
            <el-select v-model="params.dateFormat"><el-option v-for="o in DATE_FORMATS" :key="String(o.value)" v-bind="o" /></el-select>
          </el-form-item>
          <el-form-item label="数字格式">
            <el-select v-model="params.numberFormat"><el-option v-for="o in NUMBER_FORMATS" :key="String(o.value)" v-bind="o" /></el-select>
          </el-form-item>
          <el-form-item label="启用模块">
            <el-checkbox-group v-model="params.enabledModules">
              <el-checkbox v-for="m in MODULES" :key="String(m.value)" :value="m.value">{{ m.label }}</el-checkbox>
            </el-checkbox-group>
          </el-form-item>
          <el-form-item label="测试国家"><el-switch v-model="params.isTest" /></el-form-item>
        </el-form>
      </div>

      <!-- 4 组织与账套 -->
      <div v-else-if="step === 3" class="body">
        <el-form label-width="110px" class="narrow">
          <el-divider content-position="left">经营主体（必填）</el-divider>
          <el-form-item label="编码"><el-input v-model="org.entity.code" /></el-form-item>
          <el-form-item label="名称"><el-input v-model="org.entity.name" /></el-form-item>
          <el-form-item label="法定名称"><el-input v-model="org.entity.legalName" /></el-form-item>
          <el-form-item label="税号"><el-input v-model="org.entity.taxId" /></el-form-item>
          <el-divider content-position="left">中心仓（必填）</el-divider>
          <el-form-item label="编码"><el-input v-model="org.warehouse.code" /></el-form-item>
          <el-form-item label="名称"><el-input v-model="org.warehouse.name" /></el-form-item>
          <el-form-item label="地址"><el-input v-model="org.warehouse.address" /></el-form-item>
          <el-divider content-position="left">首家门店（可选）</el-divider>
          <el-form-item label="同时建门店"><el-switch v-model="org.withStore" /></el-form-item>
          <template v-if="org.withStore">
            <el-form-item label="编码"><el-input v-model="org.store.code" /></el-form-item>
            <el-form-item label="名称"><el-input v-model="org.store.name" /></el-form-item>
            <el-form-item label="地址"><el-input v-model="org.store.address" /></el-form-item>
          </template>
          <el-divider content-position="left">账套（可选，财务模块需要）</el-divider>
          <el-form-item label="编码"><el-input v-model="org.book.code" /></el-form-item>
          <el-form-item label="名称"><el-input v-model="org.book.name" /></el-form-item>
          <el-form-item label="本位币"><span>{{ params.defaultCurrency || '先设置默认币种' }}</span></el-form-item>
        </el-form>
      </div>

      <!-- 5 国家管理员 -->
      <div v-else-if="step === 4" class="body">
        <el-form label-width="110px" class="narrow">
          <el-form-item label="国家管理员" required>
            <FieldInput v-model="adminUserIds" :field="{ prop: 'u', label: '国家管理员', type: 'multi-select', options: userSource }" />
            <div class="muted">获得该国「国家管理员」角色和本国全部数据范围，可继续分配门店员、财务等账号。</div>
          </el-form-item>
        </el-form>
      </div>

      <!-- 6 预览与启用 -->
      <div v-else-if="step === 5 && preview && job" class="body">
        <el-result v-if="activated" icon="success" :title="`${job.targetCountry.name} 已启用`" sub-title="提示类缺项可以在启用后继续补齐">
          <template #extra>
            <el-button type="primary" @click="router.push(`/settings/countries/${job.targetCountry.id}`)">查看国家详情</el-button>
            <el-button v-if="user.user?.isPlatformAdmin || job.adminUserIds.includes(user.user?.id ?? -1)" @click="switchCountry(job.targetCountry.id, '/workbench')">
              切换到该国家
            </el-button>
          </template>
        </el-result>
        <el-row :gutter="16">
          <el-col :xs="24" :md="12">
            <h4>将复制（{{ preview.copyList.length }}）</h4>
            <ul class="list">
              <li v-for="i in preview.copyList" :key="i.id">
                {{ i.label }} <el-tag v-if="i.requiresReview" type="warning" size="small">需复核</el-tag>
              </li>
            </ul>
            <h4>不复制（{{ preview.excluded.length }}）</h4>
            <ul class="list muted">
              <li v-for="i in preview.excluded" :key="i.id">{{ i.label }} · {{ i.reason }}</li>
            </ul>
          </el-col>
          <el-col :xs="24" :md="12">
            <h4>缺项检查</h4>
            <MissingList :items="preview.missing" />
          </el-col>
        </el-row>
      </div>

      <div class="footer">
        <el-button v-if="step > 0 && step < 5" :disabled="busy" @click="step--">上一步</el-button>
        <el-button v-if="step === 5 && !activated" :disabled="busy" @click="step = 4">上一步</el-button>
        <el-button v-if="step < 5" type="primary" :loading="busy" @click="next">下一步</el-button>
        <template v-if="step === 5 && job && !activated">
          <el-button :type="job.status === 'DRAFT' ? 'primary' : 'default'" :disabled="job.status !== 'DRAFT'" :loading="busy" @click="apply">
            {{ job.status === 'DRAFT' ? '生成配置草稿' : '配置草稿已生成' }}
          </el-button>
          <el-button v-perm="'sys:country:activate'" type="success" :disabled="blocked" :loading="busy" @click="activate">启用国家</el-button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.steps {
  margin: 8px 0 24px;
}

.body {
  min-height: 280px;
}

.narrow {
  max-width: 640px;
}

.ml {
  margin-left: 8px;
}

.mb {
  margin-bottom: 12px;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.list {
  padding-left: 18px;
  line-height: 1.9;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 12px;
}
</style>
