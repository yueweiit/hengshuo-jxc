<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { PurchaseImportModel, ImportTask } from './purchaseImportModel'
const props = defineProps<{ page: PurchaseImportModel }>()
let active = true, epoch = 0
watch(() => props.page.state.batchId, () => { ++epoch; if (props.page.state.batchId) void props.page.loadGallery() }, { immediate: true })
watch(() => props.page.state.tasks.map(task => `${task.id}:${task.status}:${task.attemptCount}`).join(','), () => { if (props.page.state.batchId) void props.page.loadGallery() })
function phase(task: ImportTask) { return task.phase === 'FEATURE' ? '提取图片特征' : task.phase === 'INDEX' ? '生成图库索引' : task.phase === 'DONE' ? '图库处理完成' : '等待处理' }
function status(value: string) { return ({ EMPTY: '正式图库暂无照片', NOT_READY: '特征或索引尚未完成', READY: '正式图库已就绪', PARTIAL: '图库部分覆盖，仍有照片待处理', FAILED: '最近一次图库构建失败' } as Record<string, string>)[value] }
async function rebuild() {
  const context = epoch
  try { await ElMessageBox.confirm('按当前正式商品照片补齐缺失特征，再重建索引？待确认的来源图片不会进入图库。', '重建正式图库', { confirmButtonText: '确认重建', cancelButtonText: '取消' }) }
  catch (error) { if (error !== 'cancel' && error !== 'close') props.page.failure(error); return }
  if (active && context === epoch) await props.page.rebuildGallery()
}
onBeforeUnmount(() => { active = false; ++epoch })
</script>

<template>
  <div v-if="page.state.batchId" class="gallery-panel">
    <div class="gallery-heading"><h3>正式商品图库</h3><el-button :loading="page.state.galleryLoading" :disabled="page.state.galleryLoading" @click="page.loadGallery">重新读取图库状态</el-button></div>
    <el-alert v-if="page.state.galleryError" :title="page.state.galleryError" type="error" :closable="false" />
    <template v-if="page.state.gallery"><p>{{ status(page.state.gallery.status) }}</p><p class="gallery-hint">正式照片 {{ page.state.gallery.coverage.photos }} 张，可用于检索的照片 {{ page.state.gallery.coverage.readyPhotos }} 张，独立特征 {{ page.state.gallery.coverage.features }} 份。图片相同可共用特征，商品仍分别确认。</p><p v-if="page.state.gallery.coverage.eligiblePhotos !== undefined && page.state.gallery.coverage.eligiblePhotos < page.state.gallery.coverage.photos" class="gallery-hint">部分照片所属商品或原图尚不可检索，请核对商品、本国经营和原图状态。</p><el-alert v-if="page.state.gallery.lastError" :title="page.state.gallery.lastError" type="error" :closable="false" /><el-button :disabled="page.busy() || !!page.state.edit || page.headerDirty() || page.state.gallery.coverage.photos === 0" @click="rebuild">重建正式图库索引</el-button></template>
    <div v-for="task in page.state.tasks.filter(item => ['IMAGE_PUBLISH', 'GALLERY_REBUILD'].includes(item.kind || ''))" :key="task.id" class="gallery-task" role="status"><span>{{ phase(task) }} · {{ task.status === 'SUCCEEDED' ? '成功' : task.status === 'RUNNING' ? '处理中' : task.status === 'QUEUED' ? '已排队' : '待处理' }}</span><span v-if="task.status === 'STALE'" class="task-error">旧来源已变化，可按当前正式照片重建图库。</span><span v-if="task.errorMessage" class="task-error">{{ task.errorMessage }}</span><el-button v-if="['FAILED', 'NEEDS_REAUTH'].includes(task.status)" :disabled="page.busy() || !!page.state.edit || page.headerDirty()" @click="page.retryTask(task)">继续原照片／索引任务</el-button></div>
    <p class="gallery-hint">照片、特征和索引分别保存处理状态。图库暂不可用时，仍可人工确认商品并创建采购草稿。</p>
  </div>
</template>

<style scoped lang="scss">
.gallery-panel { margin: 16px 0; padding: 16px; border: 1px solid var(--el-border-color-light); border-radius: 4px; font-size: 13px; }
.gallery-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; h3 { margin: 0; font-size: 14px; } }
.gallery-hint { color: var(--el-text-color-secondary); line-height: 22px; }
.gallery-task { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 12px; padding: 10px; background: var(--el-fill-color-light); }
.task-error { color: var(--el-color-danger); }
</style>
