<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PurchaseImportCatalogImages } from './purchaseImportCatalogImages'

const props = defineProps<{ catalog: PurchaseImportCatalogImages; imageId?: number; productId?: number; label: string; compact?: boolean }>()
const frame = ref<HTMLElement>(), decodeError = ref(false)
const { urls, errors, loading } = props.catalog.images
const entry = computed(() => props.imageId ? undefined : props.catalog.entries.value[props.productId!])
const resolvedId = computed(() => props.imageId ?? (entry.value?.status === 'ok' ? entry.value.imageId : null))
const url = computed(() => resolvedId.value ? urls.value[resolvedId.value] : undefined)
const pending = computed(() => entry.value?.status === 'loading' || !!resolvedId.value && loading.value[resolvedId.value] === true)
const failure = computed(() => decodeError.value ? '商品照片显示失败，请重试' : entry.value?.status === 'error' ? entry.value.message : resolvedId.value ? errors.value[resolvedId.value] : undefined)
let visible = false, observer: IntersectionObserver | undefined
async function load() {
  const reload = decodeError.value
  decodeError.value = false
  if (props.imageId) { await (reload ? props.catalog.images.reload(props.imageId) : props.catalog.images.load(props.imageId)); return }
  if (!props.productId) return
  const result = await props.catalog.loadProduct(props.productId)
  if (result.status === 'ok' && result.imageId) await (reload ? props.catalog.images.reload(result.imageId) : props.catalog.images.load(result.imageId))
}
watch(() => [props.imageId, props.productId, props.catalog.revision.value], () => { if (visible) void load() })
watch(url, () => { decodeError.value = false })
onMounted(() => {
  if (!('IntersectionObserver' in window)) { visible = true; void load(); return }
  observer = new IntersectionObserver(entries => {
    visible = entries.some(item => item.isIntersecting)
    if (visible) void load()
  })
  if (frame.value) observer.observe(frame.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div ref="frame" class="catalog-photo" :class="{ 'is-compact': compact }" :data-image-id="resolvedId" :aria-label="label" :aria-busy="pending" @click.stop>
    <div v-loading="pending" class="catalog-photo-frame">
      <el-image v-if="url && !decodeError" :key="url" :src="url" fit="contain" :preview-src-list="[url]" preview-teleported :alt="label" @error="decodeError = true" />
      <span v-else-if="failure" class="catalog-photo-error" role="status">{{ failure }}</span>
      <span v-else-if="entry?.status === 'ok' && !resolvedId" class="catalog-photo-empty">暂无商品照片</span>
      <span v-else-if="!pending" class="catalog-photo-empty">照片待加载</span>
    </div>
    <el-button v-if="failure" link type="primary" size="small" :disabled="pending" @click.stop="load">重试加载商品照片</el-button>
  </div>
</template>

<style scoped>
.catalog-photo { width: 136px; max-width: 100%; flex-shrink: 0; white-space: normal; line-height: 1.4; }
.catalog-photo-frame { position: relative; display: flex; align-items: center; justify-content: center; height: 120px; background: var(--el-fill-color-extra-light); border: 1px solid var(--el-border-color-light); border-radius: 4px; overflow: hidden; }
.catalog-photo-frame .el-image { width: 100%; height: 100%; cursor: zoom-in; }
.catalog-photo-empty, .catalog-photo-error { padding: 6px; font-size: 12px; overflow-wrap: anywhere; }
.catalog-photo-empty { color: var(--el-text-color-secondary); }
.catalog-photo-error { color: var(--el-color-danger); }
.catalog-photo.is-compact { width: 64px; }
.catalog-photo.is-compact .catalog-photo-frame { height: 58px; }
.catalog-photo.is-compact .el-button { max-width: 64px; height: auto; white-space: normal; line-height: 1.4; }
</style>
