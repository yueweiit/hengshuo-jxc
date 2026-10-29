<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { http } from '@/api/http'
import PurchaseImportMappingReviewDialog from './PurchaseImportMappingReviewDialog.vue'
import type { PurchaseImportModel, ImportTask, ImportRow, ImportSource } from './purchaseImportModel'

const props = defineProps<{ page: PurchaseImportModel }>()
const emit=defineEmits<{corrected:[batchId:string]}>()
const mappingTask = ref<ImportTask | null>(null), mappingVisible = ref(false)
const correctionSourceId=ref<number>(),mappingVersion=ref<number>(),mappingLoading=ref(false)
async function correct(source:ImportSource){
  mappingLoading.value=true
  try{const preview=await props.page.sourceMapping(source);if(!preview)return
    const task=props.page.state.tasks.find(t=>t.kind==='PARSE'&&t.sourceId===source.id)
    if(!task){props.page.failure(new Error('找不到当前来源的解析任务，请重新读取'));return}
    mappingTask.value={...task,result:preview};correctionSourceId.value=source.id;mappingVersion.value=preview.batchVersion;mappingVisible.value=true
  }finally{mappingLoading.value=false}
}
const sheets = ref<Record<string, string>>({})
const { urls: imageUrls, errors: imageErrors } = props.page.images
const downloading = ref<number | null>(null)
let epoch = 0
function clean() { ++epoch }
function path(kind: 'sources' | 'images', id: number) { return `/api/v1/pur/order-imports/${props.page.state.batchId}/${kind}/${id}/content` }
async function download(id: number, name: string) {
  if (downloading.value !== null) return
  const context = epoch; downloading.value = id
  try {
    const blob = await http.attachmentBlob(path('sources', id), { silent: true, timeout: 120000 })
    if (context !== epoch) return
    const url = URL.createObjectURL(blob), link = document.createElement('a')
    link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url)
  } catch (error) { if (context === epoch) props.page.failure(error) }
  finally { if (context === epoch) downloading.value = null }
}
async function view(row: ImportRow, id: number) {
  if (row.images?.some(image => image.id === id)) return props.page.images.load(id)
}
async function publish(row: ImportRow, imageId: number) {
  const context = epoch, product = row.matchedProductId
  if (!product || props.page.busy()) return
  try { await ElMessageBox.confirm(`确认将此原图关联到已选商品 ${product}？请核对规格和照片归属。`, '确认商品照片', { confirmButtonText: '确认关联', cancelButtonText: '返回核对', type: 'warning' }) }
  catch (error) { if (error !== 'cancel' && error !== 'close') props.page.failure(error); return }
  if (context === epoch && row.matchedProductId === product) await props.page.publishPhotos(row, [imageId])
}
function retry(task: ImportTask) { return props.page.retryTask(task, sheets.value[task.id] || null) }
watch(() => props.page.state.batchId, () => { clean(); downloading.value = null })
onBeforeUnmount(clean)
</script>

<template>
  <div v-if="page.state.batchId" class="source-panel">
    <div v-for="task in page.state.tasks.filter(item => (!item.kind || item.kind === 'PARSE') && ['FAILED', 'NEEDS_REAUTH', 'STALE'].includes(item.status))" :key="task.id" class="source-task" role="status">
        <span class="source-error">{{ task.errorMessage || '任务未完成，请重新读取原因' }}</span>
        <el-select v-if="task.errorCode === 'SHEET_SELECTION_REQUIRED'" v-model="sheets[task.id]" placeholder="请选择采购工作表" aria-label="采购工作表"><el-option v-for="sheet in task.result?.sheets" :key="sheet" :value="sheet" :label="sheet" /></el-select>
        <el-button v-if="task.result?.mapping" :disabled="page.busy() || !!page.state.edit" @click="correctionSourceId=undefined;mappingTask=task;mappingVisible=true">核对原列与规格</el-button>
        <el-button :disabled="page.busy() || !!page.state.edit || (task.errorCode === 'SHEET_SELECTION_REQUIRED' && !sheets[task.id])" @click="retry(task)">重试解析</el-button>
    </div>
    <div v-for="source in page.state.sources" :id="`import-source-${source.id}`" :key="source.id" class="source-file">
      <div><strong>{{ source.fileName }}</strong><small>{{ source.origin === 'MANUAL_UPLOAD' ? '手工上传照片' : '原文件' }} SHA256：{{ source.fileSha256 }}</small></div>
      <el-button link type="primary" :loading="downloading === source.id" @click="download(source.id, source.fileName)">下载原文件</el-button>
      <a v-if="source.correctedFrom" :href="`?batchId=${source.correctedFrom.batchId}`">查看保留的原批次</a>
      <el-button v-if="source.status==='READY' && source.parserVersion==='docling-n8n-supplier-v1' && source.origin!=='MANUAL_UPLOAD'" link type="primary" :disabled="mappingLoading || page.busy() || !!page.state.edit || page.grid.hasChanges()" @click="correct(source)">纠正原列并保留当前批次</el-button>
      <el-collapse v-if="source.warnings?.length"><el-collapse-item :title="`导入时的来源核对记录（${source.warnings.length}项）`"><p v-for="(warning, index) in source.warnings" :key="index" class="source-warning">{{ warning.sourceRow ? `原第${warning.sourceRow}行：` : '' }}{{ warning.message }}</p></el-collapse-item></el-collapse>
    </div>
    <el-collapse v-if="page.state.rows.some(row => row.images?.length)">
      <el-collapse-item title="原图与来源位置 · 请逐行确认归属" name="images">
        <div v-for="row in page.state.rows.filter(item => item.images?.length)" :key="row.id" class="source-row">
          <div class="source-position">第{{ row.rowNo }}行 · {{ row.productSpec || '规格待核实' }}<small>{{ row.sourceSheet }} · 原第{{ row.sourceRow }}行</small></div>
          <div v-for="image in row.images" :key="image.id" class="source-image">
            <el-image v-if="imageUrls[image.id]" :src="imageUrls[image.id]" :preview-src-list="[String(imageUrls[image.id])]" preview-teleported fit="contain" class="original-image" :alt="`第${row.rowNo}行商品照片`" />
            <el-button v-else size="small" @click="view(row, image.id)">查看原图</el-button>
            <span v-if="imageErrors[image.id]" class="source-error">{{ imageErrors[image.id] }}</span>
            <span v-if="image.origin === 'MANUAL_UPLOAD'">手工上传</span>
            <span>{{ image.status === 'CONFIRMED' ? '归属已确认' : image.status === 'REJECTED' ? '已排除' : '归属待核实' }}</span>
            <el-button size="small" :disabled="page.busy() || !!page.state.edit || image.status === 'CONFIRMED' || page.rowLocked(row) || image.publishStatus === 'READY'" @click="page.associate(row, image.id, 'CONFIRMED')">确认属于本行</el-button>
            <el-button size="small" :disabled="page.busy() || !!page.state.edit || image.status === 'REJECTED' || page.rowLocked(row) || image.publishStatus === 'READY'" @click="page.associate(row, image.id, 'REJECTED')">排除</el-button>
            <span v-if="image.publishStatus === 'READY' && image.publishedProductId === row.matchedProductId">已关联商品照片</span>
            <el-button v-else-if="image.status === 'CONFIRMED' && row.matchedProductId" size="small" type="primary" :disabled="page.busy() || !!page.state.edit || page.headerDirty()" @click="publish(row, image.id)">关联到已确认商品</el-button>
          </div>
        </div>
      </el-collapse-item>
    </el-collapse>
    <PurchaseImportMappingReviewDialog v-if="mappingTask" v-model="mappingVisible" :page="page" :task="mappingTask" :correction-source-id="correctionSourceId" :batch-version="mappingVersion" @corrected="emit('corrected',$event)"/>
  </div>
</template>

<style scoped lang="scss">
.source-panel { margin: 12px 0; font-size: 13px; }
.source-task { display: flex; gap: 12px; align-items: center; padding: 10px 12px; background: var(--el-fill-color-light); border-left: 3px solid var(--el-color-primary); .el-select { width: 200px; } }
.source-file { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px; small { display: block; color: var(--el-text-color-secondary); overflow-wrap: anywhere; margin-top: 4px; } }
.source-warning { width: 100%; margin: 0; color: var(--el-color-warning-dark-2); }
.source-error { color: var(--el-color-danger); }
.source-row { display: flex; gap: 16px; align-items: flex-start; padding: 12px 0; border-top: 1px solid var(--el-border-color-lighter); }
.source-position { min-width: 150px; small { display: block; color: var(--el-text-color-secondary); } }
.source-image { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.original-image { width: 90px; height: 90px; background: var(--el-fill-color-light); }
</style>
