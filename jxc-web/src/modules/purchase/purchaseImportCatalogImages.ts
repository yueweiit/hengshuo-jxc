import { ref } from 'vue'
import { createPurchaseImportImages } from '@/modules/purchase/purchaseImportImages'

type CatalogResult = { status: 'ok'; imageId: number | null } | { status: 'error'; message: string }
interface CatalogImage { id: number; productId: number; isPrimary: boolean; sortOrder: number }

/** 商品照片目录只负责选图；照片字节、请求去重和URL回收复用导入原图读取器。 */
export function createPurchaseImportCatalogImages(
  list: (productId: number, signal: AbortSignal) => Promise<unknown>,
  read: (imageId: number, signal: AbortSignal) => Promise<Blob>,
  scope: () => string | null,
) {
  const entries = ref<Record<number, CatalogResult | { status: 'loading' }>>({}), revision = ref(0)
  const images = createPurchaseImportImages((_scope, id, signal) => read(id, signal), scope)
  const pending = new Map<number, Promise<CatalogResult | { status: 'stale' }>>(), controllers = new Set<AbortController>()
  function reset() {
    revision.value++
    controllers.forEach(controller => controller.abort()); controllers.clear(); pending.clear()
    entries.value = {}; images.reset()
  }
  function loadProduct(productId: number): Promise<CatalogResult | { status: 'stale' }> {
    const cached = entries.value[productId]
    if (cached?.status === 'ok') return Promise.resolve(cached)
    const running = pending.get(productId)
    if (running) return running
    const context = revision.value, countryBatch = scope(), controller = new AbortController()
    controllers.add(controller); entries.value[productId] = { status: 'loading' }
    const result = (async (): Promise<CatalogResult | { status: 'stale' }> => {
      try {
        if (!countryBatch) throw new Error('缺少国家或导入批次，无法读取商品照片')
        const value = await list(productId, controller.signal)
        if (context !== revision.value || countryBatch !== scope()) return { status: 'stale' }
        if (!Array.isArray(value) || value.some(item => !item || typeof item !== 'object' || !Number.isSafeInteger(item.id) || item.id <= 0 || item.productId !== productId || typeof item.isPrimary !== 'boolean' || !Number.isSafeInteger(item.sortOrder))) throw new Error('商品照片目录响应不完整或归属不一致，请重试')
        const sorted = [...value as CatalogImage[]].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder || a.id - b.id)
        const ready: CatalogResult = { status: 'ok', imageId: sorted[0]?.id ?? null }
        entries.value[productId] = ready
        return ready
      } catch (error) {
        if (context !== revision.value || countryBatch !== scope()) return { status: 'stale' }
        const failed: CatalogResult = { status: 'error', message: error instanceof Error ? error.message : '商品照片目录读取失败，请重试' }
        entries.value[productId] = failed
        return failed
      } finally {
        controllers.delete(controller)
        if (context === revision.value) pending.delete(productId)
      }
    })()
    pending.set(productId, result)
    return result
  }
  return { entries, revision, images, loadProduct, reset }
}
export type PurchaseImportCatalogImages = ReturnType<typeof createPurchaseImportCatalogImages>
