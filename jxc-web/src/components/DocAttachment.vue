<script setup lang="ts">
import { feedbackMessage } from '@/api/error-feedback'
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type UploadRequestOptions } from 'element-plus'
import { http } from '@/api/http'
import { attachmentDownloadTarget } from '@/api/attachment-download'
import DateTimeText from './DateTimeText.vue'

export interface AttachmentItem {
  id: number
  category: string
  fileName: string
  contentType?: string
  size: number
  uploadedByName: string
  uploadedAt: string
  versionNo: number
}

/**
 * 单据附件。category 区分销售单据、收款凭证、记账凭证等，不能互相替代（docs/00 第 8 节）。
 * 删除只解除关联，历史版本保留。
 */
const props = defineProps<{
  bizType: string
  bizId: number | string
  category: string
  readonly?: boolean
}>()
const emit = defineEmits<{ change: [items: AttachmentItem[]] }>()

const items = ref<AttachmentItem[]>([])
const loading = ref(false)
const loadError = ref('')
const actionError = ref('')
const deletingIds = ref(new Set<number>())
interface UploadEntry {
  uid: number
  fileName: string
  loaded: number
  percentage?: number
  status: 'uploading' | 'saving' | 'success' | 'error'
  error: string
}
const uploads = ref<UploadEntry[]>([])
const preview = reactive({ open: false, item: null as AttachmentItem | null, url: '', kind: 'unsupported' as 'image' | 'pdf' | 'unsupported', loading: false, error: '' })
const requests = new Set<AbortController>()
let generation = 0
let listRequest = 0
let previewRequest = 0
let disposed = false

function current(epoch: number) { return !disposed && epoch === generation }
function controller() {
  const request = new AbortController()
  requests.add(request)
  return request
}

function fileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function load(afterUpload = false) {
  const epoch = generation
  const sequence = ++listRequest
  const request = controller()
  loading.value = true
  loadError.value = ''
  try {
    const result = await http.get<AttachmentItem[]>('/sys/attachments', {
      bizType: props.bizType,
      bizId: props.bizId,
      category: props.category,
    }, { signal: request.signal, silent: true })
    if (!current(epoch) || sequence !== listRequest) return false
    items.value = result
    emit('change', items.value)
    return true
  } catch (error) {
    if (current(epoch) && sequence === listRequest) loadError.value = `附件列表加载失败：${feedbackMessage(error, afterUpload ? '文件已上传，无需重复上传。附件列表刷新未完成' : '附件列表读取未完成')}`
    return false
  } finally {
    requests.delete(request)
    if (current(epoch) && sequence === listRequest) loading.value = false
  }
}

async function upload(opt: UploadRequestOptions) {
  if (props.readonly) throw new Error('当前附件区只读，不能上传')
  const epoch = generation
  const request = controller()
  const entry = reactive<UploadEntry>({ uid: opt.file.uid, fileName: opt.file.name, loaded: 0, status: 'uploading', error: '' })
  uploads.value.push(entry)
  const fd = new FormData()
  fd.append('file', opt.file)
  fd.append('bizType', props.bizType)
  fd.append('bizId', String(props.bizId))
  fd.append('category', props.category)
  try {
    await http.post('/sys/attachments', fd, {
      signal: request.signal,
      silent: true,
      onUploadProgress(event) {
        if (!current(epoch) || entry.status === 'success' || entry.status === 'error') return
        entry.loaded = event.loaded
        entry.percentage = event.total && event.total > 0 ? Math.min(100, Math.round(event.loaded / event.total * 100)) : undefined
        if (event.total && event.loaded >= event.total) entry.status = 'saving'
      },
    })
    if (!current(epoch)) return
    entry.status = 'success'
    uploads.value = uploads.value.filter(active => active !== entry)
    ElMessage.success('已上传')
    if (!await load(true) && current(epoch) && loadError.value) loadError.value = `文件已上传，无需重复上传。${loadError.value}`
  } catch (error) {
    if (!current(epoch)) return
    entry.status = 'error'
    entry.error = feedbackMessage(error, `附件“${entry.fileName}”上传未完成`)
    throw error
  } finally {
    requests.delete(request)
  }
}

async function unlink(item: AttachmentItem) {
  if (props.readonly || deletingIds.value.has(item.id)) return
  const epoch = generation
  deletingIds.value.add(item.id)
  actionError.value = ''
  const request = controller()
  try {
    await ElMessageBox.confirm(`解除附件“${item.fileName}”的关联？历史记录会保留。`, '删除附件', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
    if (!current(epoch) || props.readonly) return
    await http.post(`/sys/attachments/${item.id}/unlink`, undefined, { signal: request.signal, silent: true })
    if (!current(epoch)) return
    listRequest++
    loading.value = false
    // 已由服务器确认解除关联，立即移除当前条目，避免列表刷新失败又展示可删除的旧附件。
    items.value = items.value.filter(a => a.id !== item.id)
    if (preview.item?.id === item.id) closePreview()
    emit('change', items.value)
  } catch (error) {
    if (current(epoch) && error !== 'cancel' && error !== 'close') actionError.value = `删除失败：${feedbackMessage(error, "请求失败，请重试")}`
  } finally {
    requests.delete(request)
    if (current(epoch)) deletingIds.value.delete(item.id)
  }
}

// 下载与预览共用受授权约束的读取链路，不直接使用任意外部地址。
async function readContent(item: AttachmentItem, signal: AbortSignal) {
  const res = await http.get<{ url: string }>(`/sys/attachments/${item.id}/url`, undefined, { signal, silent: true })
  const target = attachmentDownloadTarget(res.url, window.location.origin, import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true')
  if (target.kind === 'proxy') return http.attachmentBlob(target.url, { signal, silent: true })
  const response = await fetch(target.url, { signal })
  if (!response.ok) throw new Error(`读取附件失败（${response.status}）`)
  return response.blob()
}

async function download(item: AttachmentItem) {
  const epoch = generation
  const request = controller()
  actionError.value = ''
  try {
    const blob = await readContent(item, request.signal)
    if (!current(epoch)) return
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = item.fileName
    document.body.append(anchor)
    try { anchor.click() } finally {
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
    }
  } catch (error) {
    if (current(epoch)) actionError.value = `下载失败：${feedbackMessage(error, "请求失败，请重试")}`
  } finally {
    requests.delete(request)
  }
}

function closePreview() {
  previewRequest++
  if (preview.url) URL.revokeObjectURL(preview.url)
  Object.assign(preview, { open: false, item: null, url: '', loading: false, error: '', kind: 'unsupported' })
}

function updatePreviewOpen(open: boolean) {
  if (!open) closePreview()
}
function previewImageFailed(event: Event) {
  if (disposed || !preview.open || (event.target as HTMLImageElement | null)?.getAttribute('src') !== preview.url) return
  preview.error = feedbackMessage(new Error('图片无法显示，请下载后查看'), '附件预览未完成')
}

async function previewFile(item: AttachmentItem) {
  closePreview()
  actionError.value = ''
  const epoch = generation
  const sequence = previewRequest
  const request = controller()
  Object.assign(preview, { open: true, item, loading: true })
  try {
    const blob = await readContent(item, request.signal)
    if (!current(epoch) || sequence !== previewRequest || !preview.open) return
    const type = blob.type.split(';')[0]?.trim().toLowerCase()
    preview.kind = type === 'application/pdf' ? 'pdf' : /^(image\/(png|jpeg|gif|webp|bmp|avif))$/.test(type || '') ? 'image' : 'unsupported'
    if (preview.kind !== 'unsupported') preview.url = URL.createObjectURL(blob)
  } catch (error) {
    if (current(epoch) && sequence === previewRequest) preview.error = `预览失败：${feedbackMessage(error, "请求失败，请重试")}`
  } finally {
    requests.delete(request)
    if (current(epoch) && sequence === previewRequest) preview.loading = false
  }
}

function reset() {
  generation++
  for (const request of requests) request.abort()
  requests.clear()
  closePreview()
  items.value = []
  uploads.value = []
  deletingIds.value.clear()
  loading.value = false
  loadError.value = ''
  actionError.value = ''
}
watch(() => [props.bizType, props.bizId, props.category], () => { reset(); void load() })
onBeforeUnmount(() => { disposed = true; reset() })
onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <div class="doc-attachment" :aria-busy="loading">
    <el-upload v-if="!readonly" :show-file-list="false" :http-request="upload">
      <el-button size="small" type="primary" plain>
        <el-icon><Upload /></el-icon>上传
      </el-button>
    </el-upload>
    <ul v-if="uploads.length" class="upload-list" aria-label="上传进度" aria-live="polite">
      <li v-for="file in uploads" :key="file.uid" class="upload-entry">
        <div class="upload-heading">
          <span class="file-name">{{ file.fileName }}</span>
          <span :class="['upload-status', { 'is-error': file.status === 'error' }]">
            {{ file.status === 'error' ? '上传未完成' : file.status === 'saving' ? '已发送，正在保存…' : file.percentage === undefined ? `正在上传 · 已发送 ${fileSize(file.loaded)}` : `正在上传 ${file.percentage}%` }}
          </span>
        </div>
        <progress v-if="file.status === 'uploading' && file.percentage === undefined" class="upload-indeterminate" :aria-label="`${file.fileName} 正在上传，总大小未知`" />
        <el-progress v-else :percentage="file.percentage ?? 0" :status="file.status === 'error' ? 'exception' : undefined" :show-text="false" :stroke-width="6" />
      </li>
    </ul>
    <div v-if="loadError" class="attachment-error" role="alert">
      <span>操作未完成，请查看全局提示。</span>
      <el-button link type="primary" size="small" :loading="loading" @click="load">重新加载</el-button>
    </div>
    <p v-if="actionError" class="attachment-error" role="alert">操作未完成，请查看全局提示。</p>
    <p v-if="loading" class="muted" role="status">正在加载附件…</p>
    <el-empty v-else-if="!items.length && !loadError && !uploads.length" :image-size="48" description="暂无附件" />
    <ul v-if="items.length" class="list" aria-label="已上传附件">
      <li v-for="a in items" :key="a.id">
        <div class="file-info">
          <el-link class="file-name" type="primary" @click="download(a)">{{ a.fileName }}</el-link>
          <span class="file-meta">{{ fileSize(a.size) }} · v{{ a.versionNo }} · {{ a.uploadedByName }} · <DateTimeText :value="a.uploadedAt" /></span>
        </div>
        <div class="file-actions">
          <el-button link type="primary" size="small" @click="previewFile(a)">预览</el-button>
          <el-button link type="primary" size="small" @click="download(a)">下载</el-button>
          <el-button v-if="!readonly" link type="danger" size="small" :loading="deletingIds.has(a.id)" :disabled="deletingIds.has(a.id)" @click="unlink(a)">删除</el-button>
        </div>
      </li>
    </ul>
    <el-dialog :model-value="preview.open" :title="preview.item?.fileName || '附件预览'" width="min(900px, 94vw)" append-to-body destroy-on-close @update:model-value="updatePreviewOpen">
      <p v-if="actionError" class="attachment-error" role="alert">操作未完成，请查看全局提示。</p>
      <div v-loading="preview.loading" class="preview-body" :aria-busy="preview.loading">
        <p v-if="preview.loading" class="muted" role="status">正在读取附件…</p>
        <p v-else-if="preview.error" class="attachment-error" role="alert">操作未完成，请查看全局提示。</p>
        <img v-else-if="preview.kind === 'image'" class="preview-image" :src="preview.url" :alt="preview.item?.fileName" @error="previewImageFailed" />
        <object v-else-if="preview.kind === 'pdf'" class="preview-pdf" :data="preview.url" type="application/pdf" :aria-label="preview.item?.fileName">
          <p>浏览器暂不支持 PDF 预览，请使用下方“下载”按钮查看。</p>
        </object>
        <p v-else class="muted">此格式暂不支持在线预览，请下载后查看。</p>
      </div>
      <template #footer>
        <el-button @click="closePreview">关闭</el-button>
        <el-button v-if="preview.item" type="primary" @click="download(preview.item)">下载</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.list,
.upload-list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
}

.list li {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
  padding: 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.list li:nth-child(even) { background: var(--el-fill-color-light); }
.file-info { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
.file-name { overflow-wrap: anywhere; justify-content: flex-start; }
.file-meta, .upload-status { color: var(--el-text-color-secondary); font-size: 12px; }
.file-actions { display: flex; flex-shrink: 0; align-items: center; gap: 8px; }
.file-actions .el-button + .el-button { margin-left: 0; }
.upload-entry { padding: 8px; background: var(--el-fill-color-light); border-radius: 4px; margin-top: 8px; }
.upload-indeterminate { display: block; width: 100%; height: 6px; accent-color: var(--el-color-primary); }
.upload-heading { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.upload-status.is-error, .attachment-error { color: var(--el-color-danger); }
.attachment-error { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; margin: 8px 0; overflow-wrap: anywhere; }
.preview-body { min-height: 160px; max-height: 68vh; overflow: auto; text-align: center; }
.preview-image { display: block; max-width: 100%; height: auto; margin: 0 auto; }
.preview-pdf { width: 100%; height: 65vh; border: 0; }
@media (max-width: 600px) {
  .list li { align-items: flex-start; flex-direction: column; }
  .file-actions { align-self: flex-end; }
}
</style>
