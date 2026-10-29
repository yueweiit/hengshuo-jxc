import { ref } from 'vue'

type ImageReadResult = { status: 'ok'; url: string } | { status: 'error'; message: string } | { status: 'stale' }

/** 同批次原图共享读取和URL；生命周期由导入工作区的模型统一管理。 */
export function createPurchaseImportImages(read: (batchId: string, imageId: number, signal: AbortSignal) => Promise<Blob>, getBatch: () => string | null) {
  const urls = ref<Record<number, string>>({}), errors = ref<Record<number, string>>({}), loading = ref<Record<number, boolean>>({})
  const pending = new Map<number, Promise<ImageReadResult>>(), controllers = new Set<AbortController>()
  let epoch = 0
  function reset() {
    ++epoch
    controllers.forEach(controller => controller.abort()); controllers.clear(); pending.clear()
    Object.values(urls.value).forEach(url => URL.revokeObjectURL(url))
    urls.value = {}; errors.value = {}; loading.value = {}
  }
  function load(imageId: number): Promise<ImageReadResult> {
    const cached = urls.value[imageId]
    if (cached) return Promise.resolve({ status: 'ok', url: cached })
    const existing = pending.get(imageId)
    if (existing) return existing
    const context = epoch, batch = getBatch(), controller = new AbortController()
    controllers.add(controller); loading.value[imageId] = true; delete errors.value[imageId]
    const result = (async (): Promise<ImageReadResult> => {
      try {
        if (!batch) throw new Error('缺少导入批次，无法读取照片')
        const blob = await read(batch, imageId, controller.signal)
        if (context !== epoch || batch !== getBatch()) return { status: 'stale' }
        if (!blob.size || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(blob.type)) throw new Error('原图响应格式不正确')
        const url = URL.createObjectURL(blob)
        urls.value[imageId] = url
        return { status: 'ok', url }
      } catch (error) {
        if (context !== epoch || batch !== getBatch()) return { status: 'stale' }
        const message = error instanceof Error ? error.message : '原图读取失败，请重试'
        errors.value[imageId] = message
        return { status: 'error', message }
      } finally {
        controllers.delete(controller)
        if (context === epoch) { delete loading.value[imageId]; pending.delete(imageId) }
      }
    })()
    pending.set(imageId, result)
    return result
  }
  return { urls, errors, loading, load, reset }
}
