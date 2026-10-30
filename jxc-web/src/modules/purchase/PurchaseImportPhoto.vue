<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ImportRow, PurchaseImportModel } from './purchaseImportModel'

const props = defineProps<{ page: PurchaseImportModel; row: ImportRow; editing: boolean; disabled: boolean }>()
const emit = defineEmits<{ edit: [] }>()
const { urls, errors, loading } = props.page.images
const input = ref<HTMLInputElement | null>(null), selectedUrl = ref(''), legacyFailed = ref(false)
const photos = computed(() => (props.row.images ?? []).filter(image => image.status !== 'REJECTED'))
const first = computed(() => photos.value[0])
const thumbnail = computed(() => photos.value.find(image => urls.value[image.id]))
const failed = computed(() => photos.value.filter(image => errors.value[image.id]))
// 旧文本地址仅用于尚无原图关联的历史行；有过关联后不回退到已排除的照片。
const legacy = computed(() => !props.row.images?.length && props.row.photo && /^(https?:\/\/|\/(?!\/)|data:image\/(?:png|jpeg|webp);base64,)/i.test(props.row.photo) ? props.row.photo : '')
const preview = computed(() => photos.value.flatMap(image => urls.value[image.id] ? [urls.value[image.id]!] : []))
const file = computed(() => props.editing && props.page.state.edit?.id === props.row.id ? props.page.state.edit.photoFile ?? props.page.grid.photo(props.row.id) : props.page.grid.photo(props.row.id))
watch(() => [props.page.state.batchId, photos.value.map(image => image.id).join(',')], () => { photos.value.filter(image => !errors.value[image.id]).forEach(image => { void props.page.images.load(image.id) }) }, { immediate: true })
watch(() => props.row.photo, () => { legacyFailed.value = false })
function releaseSelected() { if (selectedUrl.value) URL.revokeObjectURL(selectedUrl.value); selectedUrl.value = '' }
watch(file, value => { releaseSelected(); if (value) selectedUrl.value = URL.createObjectURL(value) }, { immediate: true })
onBeforeUnmount(releaseSelected)
function choose(event: Event) {
  const target = event.target as HTMLInputElement, selected = target.files?.item(0)
  if (selected) props.page.selectPhoto(selected)
  target.value = ''
}
</script>

<template>
  <div class="photo-cell">
    <el-image v-if="selectedUrl" :src="selectedUrl" :preview-src-list="disabled ? [] : [selectedUrl]" preview-teleported fit="contain" class="photo-thumbnail" :alt="`第${row.rowNo}行待保存照片`" />
    <el-image v-else-if="thumbnail" :src="urls[thumbnail.id]" :preview-src-list="disabled ? [] : preview" preview-teleported fit="contain" class="photo-thumbnail" :alt="`第${row.rowNo}行商品照片`">
      <template #error><span class="photo-error">图片显示失败</span></template>
    </el-image>
    <template v-else-if="first">
      <span v-if="loading[first.id]" class="photo-status">照片加载中</span>
    </template>
    <el-image v-else-if="legacy && !legacyFailed" :src="legacy" :preview-src-list="disabled ? [] : [legacy]" preview-teleported fit="contain" class="photo-thumbnail" :alt="`第${row.rowNo}行历史商品照片`" @error="legacyFailed = true" />
    <template v-else-if="legacyFailed"><span class="photo-error">历史照片加载失败</span><el-button link size="small" :disabled="disabled" @click="legacyFailed = false">重试加载</el-button></template>
    <span v-else class="photo-status">未上传</span>
    <span v-if="file" class="photo-status">{{ file.name }} · 草稿待上传</span>
    <span v-else-if="first" class="photo-status">{{ photos.every(image => image.status === 'CONFIRMED') ? '已确认' : '归属待核实' }}{{ photos.length > 1 ? ` · ${photos.length}张` : '' }}</span>
    <div v-for="image in failed" :key="image.id" class="photo-failure">
      <span class="photo-error" role="status">{{ errors[image.id] }}</span>
      <el-button link type="primary" size="small" :disabled="disabled" @click="page.images.load(image.id)">重试加载</el-button>
    </div>
    <template v-if="editing">
      <input ref="input" type="file" accept=".png,.jpg,.jpeg,.gif,image/png,image/jpeg,image/gif" class="photo-file-input" :aria-label="`上传第${row.rowNo}行商品照片`" :disabled="disabled || page.state.saving" @change="choose" />
      <el-button type="primary" link size="small" :disabled="disabled || page.state.saving" @click="input?.click()">{{ first || legacy || file ? '选择替换照片' : '选择照片' }}</el-button>
      <span class="photo-hint">PNG/JPG/GIF，最多10MiB，随上传按钮提交</span>
    </template>
    <el-button v-else type="primary" link size="small" :disabled="disabled" :aria-label="`编辑第${row.rowNo}行商品照片`" @click="emit('edit')">{{ first || legacy ? '替换照片' : '上传照片' }}</el-button>
  </div>
</template>

<style scoped>
.photo-cell { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 3px 0; }
.photo-failure { display: flex; flex-direction: column; align-items: center; }
.photo-thumbnail { width: 58px; height: 50px; cursor: zoom-in; }
.photo-status, .photo-hint { font-size: 11px; color: var(--el-text-color-secondary); line-height: 1.4; overflow-wrap: anywhere; }
.photo-error { font-size: 11px; color: var(--el-color-danger); overflow-wrap: anywhere; }
.photo-file-input { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; clip-path: inset(50%); }
.photo-file-input:focus-visible + .el-button { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
</style>
