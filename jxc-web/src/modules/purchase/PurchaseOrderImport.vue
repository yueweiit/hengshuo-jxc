<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { http } from '@/api/http'
import { reportError } from '@/api/error-feedback'

interface TemplateFile {
  fileName: string
  contentType: string
  contentBase64: string
}

const downloading = ref(false)
let active = true
onBeforeUnmount(() => { active = false })

async function downloadTemplate() {
  if (downloading.value || !active) return
  downloading.value = true
  try {
    const file = await http.get<TemplateFile>('/pur/orders/import-template')
    if (!active) return
    let bytes: Uint8Array<ArrayBuffer>
    try {
      if (!file || file.fileName !== '采购单导入模板.xlsx'
        || file.contentType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        || typeof file.contentBase64 !== 'string') throw new Error('模板格式不正确')
      bytes = Uint8Array.from(atob(file.contentBase64), char => char.charCodeAt(0))
      if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) throw new Error('模板格式不正确')
    } catch {
      const error = new Error('模板文件内容不完整，请重试下载')
      reportError(error)
      throw error
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: file.contentType }))
    const link = document.createElement('a')
    try {
      link.href = url
      link.download = file.fileName
      document.body.appendChild(link)
      link.click()
    } finally {
      link.remove()
      URL.revokeObjectURL(url)
    }
  } finally {
    downloading.value = false
  }
}

</script>

<template>
  <div class="page">
    <el-button type="primary" :loading="downloading" @click="downloadTemplate">
      <el-icon><Download /></el-icon>下载模板
    </el-button>
  </div>
</template>
