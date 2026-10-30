<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { http } from '@/api/http'
import { useUserStore } from '@/stores/user'

type ServiceName = 'n8n' | 'deepseek' | 'docling'
interface Probe { status: 'ok' | 'error'; message: string; checkedAt: string }
interface Service {
  enabled: boolean; source: 'PAGE' | 'STARTUP' | 'UNCONFIGURED'; timeoutSeconds: number
  url?: string; model?: string; fieldsUrl?: string; recognitionUrl?: string
  keyConfigured?: boolean; fieldsKeyConfigured?: boolean; recognitionKeyConfigured?: boolean
  lastTest: Probe | null
}
interface Settings { version: number; keyReady: boolean; workerEnabled: boolean; recognitionEnabled: boolean; services: Record<ServiceName, Service> }
const serviceOptions: { name: ServiceName; title: string; description: string }[] = [
  { name: 'n8n', title: 'n8n 工作流', description: '采购字段识别、商品图文核对' },
  { name: 'deepseek', title: 'DeepSeek', description: '识别所用模型与访问密钥' },
  { name: 'docling', title: 'Docling 解析服务', description: '采购原文件解析与图片处理' },
]
const user = useUserStore()
const canConfigure = computed(() => user.user?.isPlatformAdmin === true && user.hasPerm('sys:integration:config'))
const settings = ref<Settings | null>(null)
const selected = ref<ServiceName>('n8n')
const loading = ref(false), saving = ref(false), testing = ref(false)
const error = ref(''), notice = ref('')
const form = reactive({ enabled: false, url: '', fieldsUrl: '', recognitionUrl: '', model: '', timeoutSeconds: 180,
  key: '', fieldsKey: '', recognitionKey: '', clearKey: false, clearFieldsKey: false, clearRecognitionKey: false })
const busy = computed(() => loading.value || saving.value || testing.value)
const current = computed(() => settings.value?.services[selected.value])
const title = computed(() => serviceOptions.find(option => option.name === selected.value)?.title)
let alive = true, generation = 0
function clearSecrets() { form.key = ''; form.fieldsKey = ''; form.recognitionKey = ''; form.clearKey = false; form.clearFieldsKey = false; form.clearRecognitionKey = false }
function clearSecretDraft(key: 'key' | 'fieldsKey' | 'recognitionKey') { const flag = key === 'key' ? 'clearKey' : key === 'fieldsKey' ? 'clearFieldsKey' : 'clearRecognitionKey'; if (form[flag]) form[key] = '' }
function fillForm() {
  const service = settings.value?.services[selected.value]
  clearSecrets()
  if (service) Object.assign(form, { enabled: service.enabled, url: service.url ?? '', fieldsUrl: service.fieldsUrl ?? '', recognitionUrl: service.recognitionUrl ?? '', model: service.model ?? '', timeoutSeconds: service.timeoutSeconds })
}
function selectService(name: ServiceName) { if (busy.value) return; selected.value = name; error.value = ''; notice.value = ''; fillForm() }
function validSettings(value: unknown): Settings {
  const data = value as Settings
  if (!data || !Number.isSafeInteger(data.version) || data.version < 0 || typeof data.keyReady !== 'boolean' || typeof data.workerEnabled !== 'boolean' || typeof data.recognitionEnabled !== 'boolean') throw new Error('配置数据格式异常，请重试或联系管理员')
  for (const option of serviceOptions) {
    const service = data.services?.[option.name]
    if (!service || typeof service.enabled !== 'boolean' || !['PAGE', 'STARTUP', 'UNCONFIGURED'].includes(service.source) || !Number.isInteger(service.timeoutSeconds) || service.timeoutSeconds < 1 || service.timeoutSeconds > 600 || !('lastTest' in service)) throw new Error('配置数据格式异常，请重试或联系管理员')
    const fields = option.name === 'n8n' ? ['fieldsUrl', 'recognitionUrl'] : ['url']
    const keys = option.name === 'n8n' ? ['fieldsKeyConfigured', 'recognitionKeyConfigured'] : ['keyConfigured']
    if (fields.some(key => typeof (service as unknown as Record<string, unknown>)[key] !== 'string') || keys.some(key => typeof (service as unknown as Record<string, unknown>)[key] !== 'boolean') || (option.name === 'deepseek' && typeof service.model !== 'string')) throw new Error('配置数据格式异常，请重试或联系管理员')
    if (service.lastTest !== null && (!['ok', 'error'].includes(service.lastTest.status) || typeof service.lastTest.message !== 'string' || typeof service.lastTest.checkedAt !== 'string')) throw new Error('配置数据格式异常，请重试或联系管理员')
  }
  return data
}
function reason(value: unknown) { return value instanceof Error && value.message ? value.message : '服务请求失败，请重试或联系管理员' }
async function loadSettings() {
  if (saving.value || testing.value) return
  const turn = ++generation; loading.value = true; error.value = ''; notice.value = ''
  try {
    const result = validSettings(await http.get<Settings>('/sys/external-services', undefined, { silent: true }))
    if (!alive || turn !== generation) return
    settings.value = result; fillForm()
  } catch (failure) { if (alive && turn === generation) { error.value = reason(failure); settings.value = null; clearSecrets() } }
  finally { if (alive && turn === generation) loading.value = false }
}
async function save() {
  if (busy.value || !settings.value || !canConfigure.value) return
  saving.value = true; error.value = ''; notice.value = ''; const turn = generation
  const body: Record<string, unknown> = { version: settings.value.version, enabled: form.enabled, timeoutSeconds: form.timeoutSeconds }
  if (selected.value === 'n8n') Object.assign(body, { fieldsUrl: form.fieldsUrl.trim(), recognitionUrl: form.recognitionUrl.trim() })
  else { body.url = form.url.trim(); if (selected.value === 'deepseek') body.model = form.model.trim() }
  for (const key of (selected.value === 'n8n' ? ['fieldsKey', 'recognitionKey'] : ['key']) as ('key' | 'fieldsKey' | 'recognitionKey')[]) {
    const clear = key === 'key' ? 'clearKey' : key === 'fieldsKey' ? 'clearFieldsKey' : 'clearRecognitionKey'
    if (form[key]) body[key] = form[key]
    if (form[clear]) body[clear] = true
  }
  try {
    const result = validSettings(await http.put<Settings>(`/sys/external-services/${selected.value}`, body, { silent: true }))
    if (!alive || turn !== generation) return
    settings.value = result; fillForm(); notice.value = '配置已保存，新任务使用新版本；正在执行的任务继续使用原版本。'
  } catch (failure) { if (alive && turn === generation) error.value = reason(failure) }
  finally { if (alive && turn === generation) saving.value = false }
}
async function testConnection() {
  if (busy.value || !settings.value || !canConfigure.value) return
  testing.value = true; error.value = ''; notice.value = ''; const turn = generation
  try {
    const result = await http.post<Probe>(`/sys/external-services/${selected.value}/test`, { version: settings.value.version }, { silent: true })
    if (!alive || turn !== generation) return
    if (!result || !['ok', 'error'].includes(result.status) || typeof result.message !== 'string' || typeof result.checkedAt !== 'string') throw new Error('连接测试响应格式异常')
    settings.value.services[selected.value].lastTest = result
    if (result.status === 'error') error.value = result.message
    else notice.value = result.message
  } catch (failure) { if (alive && turn === generation) error.value = reason(failure) }
  finally { if (alive && turn === generation) testing.value = false }
}
function status(service: Service) {
  if (service.source === 'UNCONFIGURED') return '未配置'
  if (!service.enabled) return '已停用'
  if (!service.lastTest) return '未测试'
  return service.lastTest.status === 'ok' ? '连接正常' : '连接失败'
}
onMounted(loadSettings)
onBeforeUnmount(() => { alive = false; generation++; clearSecrets() })
</script>

<template>
  <div class="page external-services-page">
    <header class="settings-heading"><div><h2>外部服务配置</h2><p class="muted">管理采购导入和商品识别使用的服务。系统级配置，所有国家共用。</p></div><el-button :disabled="busy" @click="loadSettings">重新读取</el-button></header>
    <el-alert v-if="!canConfigure" title="仅平台管理员可以管理外部服务配置" type="warning" :closable="false" />
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon role="alert" />
    <el-alert v-if="notice" :title="notice" type="success" :closable="false" show-icon role="status" />
    <div v-if="loading" class="settings-loading" role="status">正在读取配置…</div>
    <div v-else-if="!settings" class="settings-empty"><p>尚未读取到服务配置。</p><el-button :disabled="busy" @click="loadSettings">重试</el-button></div>
    <template v-else>
      <el-alert v-if="!settings.keyReady" title="后端尚未配置有效的密钥加密主密钥，请联系部署管理员配置后再保存。" type="warning" :closable="false" />
      <el-alert v-if="settings.services.deepseek.source === 'PAGE' && settings.services.n8n.source !== 'PAGE'" title="n8n 仍使用原连接。完成 n8n 配置与配套服务更新后，采购识别才会使用这里保存的模型设置。" type="info" :closable="false" />
      <div class="service-workspace">
        <nav class="service-list" aria-label="外部服务">
          <button v-for="option in serviceOptions" :key="option.name" type="button" class="service-choice" :class="{ active: selected === option.name }" :aria-pressed="selected === option.name" :disabled="busy" @click="selectService(option.name)">
            <strong>{{ option.title }}</strong><span>{{ option.description }}</span><small>{{ status(settings.services[option.name]) }}</small>
          </button>
        </nav>
        <section class="service-editor" :aria-label="title">
          <div class="service-heading"><h3>{{ title }}</h3><span class="muted">{{ current?.source === 'PAGE' ? '来源：页面配置' : current?.source === 'STARTUP' ? '来源：启动配置快照' : '尚未配置' }} · 版本 {{ settings.version }}</span></div>
          <p v-if="selected === 'n8n'" class="muted">分别填写原采购字段识别、商品识别工作流的完整调用地址。访问密钥需与 n8n 中的入口认证一致。</p>
          <p v-else-if="selected === 'deepseek'" class="muted">密钥由后端保存，n8n 通过采购任务使用。这里只配置采购识别所用模型。</p>
          <p v-else class="muted">连接已部署的采购解析桥接服务。保存连接配置后，后台程序仍须已启动。</p>
          <el-form label-position="top" :disabled="!canConfigure || busy || !settings.keyReady" @submit.prevent="save">
            <el-form-item label="启用连接"><el-switch v-model="form.enabled" aria-label="启用连接" /><span class="field-hint">停用后相关新任务会明确报错。</span></el-form-item>
            <template v-if="selected === 'n8n'">
              <el-form-item label="采购字段识别地址"><el-input v-model="form.fieldsUrl" placeholder="https://n8n.example.com/webhook/jxc-purchase-fields-v1" autocomplete="off" /></el-form-item>
              <el-form-item label="字段识别访问密钥"><el-input v-model="form.fieldsKey" type="password" autocomplete="new-password" :disabled="form.clearFieldsKey" :placeholder="current?.fieldsKeyConfigured ? '已配置；留空保留原密钥' : '尚未配置'" /><el-checkbox v-model="form.clearFieldsKey" @change="clearSecretDraft('fieldsKey')">清除已保存密钥</el-checkbox></el-form-item>
              <el-form-item label="商品识别地址"><el-input v-model="form.recognitionUrl" placeholder="https://n8n.example.com/webhook/jxc-purchase-recognition-v1" autocomplete="off" /></el-form-item>
              <el-form-item label="商品识别访问密钥"><el-input v-model="form.recognitionKey" type="password" autocomplete="new-password" :disabled="form.clearRecognitionKey" :placeholder="current?.recognitionKeyConfigured ? '已配置；留空保留原密钥' : '尚未配置'" /><el-checkbox v-model="form.clearRecognitionKey" @change="clearSecretDraft('recognitionKey')">清除已保存密钥</el-checkbox></el-form-item>
            </template>
            <template v-else>
              <el-form-item :label="selected === 'deepseek' ? 'API 根地址' : '解析服务根地址'"><el-input v-model="form.url" :placeholder="selected === 'deepseek' ? 'https://api.deepseek.com' : 'http://识别服务地址:端口'" autocomplete="off" /></el-form-item>
              <el-form-item v-if="selected === 'deepseek'" label="模型名称"><el-input v-model="form.model" placeholder="填写账户可用的模型名称" autocomplete="off" /></el-form-item>
              <el-form-item :label="selected === 'deepseek' ? 'API Key' : '访问密钥'"><el-input v-model="form.key" type="password" autocomplete="new-password" :disabled="form.clearKey" :placeholder="current?.keyConfigured ? '已配置；留空保留原密钥' : '尚未配置'" /><el-checkbox v-model="form.clearKey" @change="clearSecretDraft('key')">清除已保存密钥</el-checkbox></el-form-item>
            </template>
            <el-form-item label="请求超时（秒）"><el-input-number v-model="form.timeoutSeconds" :min="1" :max="600" :precision="0" /><span class="field-hint">超过时限后保留失败原因，可在业务页面重试。</span></el-form-item>
            <div class="settings-actions"><el-button type="primary" native-type="submit" :loading="saving">保存配置</el-button><el-button :loading="testing" @click="testConnection">测试已保存连接</el-button></div>
          </el-form>
          <p class="field-hint">测试使用已保存配置，不保存当前输入，也不提交采购文件。连接检查通过后，仍需验证实际识别效果。</p>
          <div v-if="current?.lastTest" class="last-test"><strong>最近连接检查</strong><p :class="{ 'test-error': current.lastTest.status === 'error' }">{{ current.lastTest.message }}</p><span class="muted">{{ current.lastTest.checkedAt }}</span></div>
          <p v-if="settings && (!settings.workerEnabled || !settings.recognitionEnabled)" class="field-hint">部署状态：解析后台{{ settings?.workerEnabled ? '已启用' : '未启用' }}，商品识别{{ settings?.recognitionEnabled ? '已启用' : '未启用' }}。连接设置不会自动启动这些程序。</p>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.external-services-page { max-width: 1180px; }
.settings-heading,.service-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; }
.settings-heading h2,.service-heading h3 { margin:0; }
.settings-heading p { margin:8px 0 0; }
.external-services-page > :deep(.el-alert) { margin-top:16px; }
.service-workspace { display:grid; grid-template-columns:240px minmax(0,1fr); gap:24px; margin-top:24px; }
.service-list { display:flex; flex-direction:column; align-items:stretch; gap:4px; }
.service-choice { appearance:none; display:grid; gap:7px; padding:16px; border:1px solid transparent; border-left:3px solid transparent; text-align:left; background:transparent; color:var(--el-text-color-primary); font:inherit; cursor:pointer; }
.service-choice.active { border-left-color:var(--el-color-primary); background:var(--el-color-primary-light-9); }
.service-choice span,.service-choice small { color:var(--el-text-color-secondary); line-height:1.5; }
.service-choice small { font-size:12px; }
.service-choice:focus-visible { outline:2px solid var(--el-color-primary); outline-offset:2px; }
.service-editor { min-width:0; padding:24px; background:var(--el-bg-color); border:1px solid var(--el-border-color-light); border-radius:var(--el-border-radius-base); }
.service-editor > p { line-height:1.7; margin:16px 0 24px; }
.service-editor :deep(.el-form-item) { max-width:680px; }
.field-hint { color:var(--el-text-color-secondary); font-size:13px; line-height:1.7; }
.el-form-item .field-hint { margin-left:12px; }
.settings-actions { display:flex; flex-wrap:wrap; gap:8px; }
.settings-actions :deep(.el-button + .el-button) { margin-left:0; }
.last-test { border-top:1px solid var(--el-border-color-light); padding-top:18px; margin-top:18px; font-size:13px; }
.last-test p { line-height:1.7; }
.test-error { color:var(--el-color-danger); }
.settings-loading,.settings-empty { padding:32px 0; }
@media(max-width:760px) { .service-workspace { grid-template-columns:minmax(0,1fr); gap:16px; } .service-list { flex-direction:row; overflow:auto; } .service-choice { min-width:170px; } .service-editor { padding:16px; } .settings-heading,.service-heading { align-items:flex-start; flex-wrap:wrap; } }
</style>
