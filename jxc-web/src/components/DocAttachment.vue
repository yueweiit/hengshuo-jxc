<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox, type UploadRequestOptions } from 'element-plus'
import { http } from '@/api/http'
import { attachmentDownloadTarget } from '@/api/attachment-download'
import DateTimeText from './DateTimeText.vue'

export interface AttachmentItem {
  id: number
  category: string
  fileName: string
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

async function load() {
  loading.value = true
  try {
    items.value = await http.get<AttachmentItem[]>('/sys/attachments', {
      bizType: props.bizType,
      bizId: props.bizId,
      category: props.category,
    })
    emit('change', items.value)
  } finally {
    loading.value = false
  }
}

async function upload(opt: UploadRequestOptions) {
  const fd = new FormData()
  fd.append('file', opt.file)
  fd.append('bizType', props.bizType)
  fd.append('bizId', String(props.bizId))
  fd.append('category', props.category)
  await http.post('/sys/attachments', fd)
  ElMessage.success('已上传')
  await load()
}

async function unlink(item: AttachmentItem) {
  await ElMessageBox.confirm(`解除附件“${item.fileName}”的关联？历史记录会保留。`, '删除附件', { type: 'warning' })
  await http.post(`/sys/attachments/${item.id}/unlink`)
  await load()
}

async function download(item: AttachmentItem) {
  const res = await http.get<{ url: string }>(`/sys/attachments/${item.id}/url`)
  const target = attachmentDownloadTarget(res.url, window.location.origin, import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true')
  const blob = target.kind === 'proxy' ? await http.attachmentBlob(target.url) : await (await fetch(target.url)).blob()
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = item.fileName
  document.body.append(anchor)
  try { anchor.click() } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  }
}

onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <div v-loading="loading" class="doc-attachment">
    <el-upload v-if="!readonly" :show-file-list="false" :http-request="upload">
      <el-button size="small" type="primary" plain>
        <el-icon><Upload /></el-icon>上传
      </el-button>
    </el-upload>
    <el-empty v-if="!items.length" :image-size="48" description="暂无附件" />
    <ul v-else class="list">
      <li v-for="a in items" :key="a.id">
        <el-link type="primary" @click="download(a)">{{ a.fileName }}</el-link>
        <span class="muted">v{{ a.versionNo }} · {{ a.uploadedByName }} · <DateTimeText :value="a.uploadedAt" /></span>
        <el-button v-if="!readonly" link type="danger" size="small" @click="unlink(a)">删除</el-button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
}

.list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  flex-wrap: wrap;
}
</style>
