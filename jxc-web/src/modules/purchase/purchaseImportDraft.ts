import { nextTick, reactive, watch, type WatchStopHandle } from 'vue'
import type { PurchaseImportModel } from './purchaseImportModel'

type Snapshot = ReturnType<PurchaseImportModel['exportLocalDraft']>
export interface PurchaseImportDraftStore {
  read(key: string): Promise<unknown>
  write(key: string, value: Snapshot): Promise<void>
}

/** 同一站点下以稳定账号、国家及入口批次隔离；不把登录令牌落盘。 */
export function purchaseImportDraftKey(userId: number, countryId: number, batchId: string | null) {
  return JSON.stringify(['purchase-import-v1', userId, countryId, batchId])
}

export function createPurchaseImportDraftStore(factory: IDBFactory | undefined = globalThis.indexedDB): PurchaseImportDraftStore {
  async function database() {
    if (!factory) throw new Error('当前浏览器不支持本地草稿存储')
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('jxc-purchase-import', 1)
      let blocked = false
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts') }
      request.onerror = () => reject(request.error ?? new Error('无法打开本地草稿存储'))
      request.onblocked = () => { blocked = true; reject(new Error('本地草稿存储被其他页面占用，请关闭旧页面后重试')) }
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result) }
    })
  }
  async function run(key: string, mode: IDBTransactionMode, value?: Snapshot) {
    const db = await database()
    return new Promise<unknown>((resolve, reject) => {
      let result: unknown
      try {
        const transaction = db.transaction('drafts', mode), store = transaction.objectStore('drafts')
        const request = mode === 'readwrite' ? store.put(value, key) : store.get(key)
        request.onsuccess = () => { result = request.result }
        transaction.oncomplete = () => { db.close(); resolve(result) }
        transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error ?? request.error ?? new Error('本地草稿读写失败')) }
      } catch (error) { db.close(); reject(error) }
    })
  }
  return { read: key => run(key, 'readonly'), write: async (key, value) => { await run(key, 'readwrite', value) } }
}

/** 串行写入，清空后的空快照永远排在旧草稿之后；切换后旧回调不更新新页面状态。 */
export function createPurchaseImportDraftSession(page: PurchaseImportModel, store = createPurchaseImportDraftStore()) {
  const view = reactive({ ready: false, saving: false, saved: false, error: '' })
  let key: string | null = null, epoch = 0, revision = 0, stopWatch: WatchStopHandle | undefined
  let queue: Promise<boolean> = Promise.resolve(true)
  function enqueue(snapshot: Snapshot) {
    if (!key) return Promise.resolve(false)
    const target = key, context = epoch, writeRevision = ++revision
    view.saving = true; view.saved = false
    queue = queue.then(async () => {
      try {
        await store.write(target, snapshot)
        if (context === epoch && writeRevision === revision) { view.error = ''; view.saved = true }
        return true
      } catch (error) {
        if (context === epoch && writeRevision === revision) view.error = `草稿保存失败：${error instanceof Error ? error.message : '本地存储写入失败'}；当前内容仍在页面中，请重试保存`
        return false
      } finally { if (context === epoch && writeRevision === revision) view.saving = false }
    })
    return queue
  }
  function pause() {
    stopWatch?.(); stopWatch = undefined
    if (view.ready) void enqueue(page.exportLocalDraft())
    view.ready = false
  }
  async function open(nextKey: string) {
    pause()
    const pending = queue, context = ++epoch
    key = nextKey; page.invalidate(); view.error = ''; view.saved = false; view.saving = false
    await pending
    try {
      const stored = await store.read(nextKey)
      if (context !== epoch) return false
      if (stored !== undefined) page.restoreLocalDraft(stored)
      view.ready = true; view.saved = stored !== undefined
      stopWatch = watch(() => page.exportLocalDraft(), snapshot => { void enqueue(snapshot) }, { deep: true, flush: 'post' })
      return stored !== undefined
    } catch (error) {
      if (context === epoch) view.error = `草稿恢复失败：${error instanceof Error ? error.message : '本地存储读取失败'}；请重试，原本地数据未覆盖`
      return false
    }
  }
  async function flush() {
    if (!view.ready) return false
    await nextTick()
    return enqueue(page.exportLocalDraft())
  }
  function stop() { pause(); ++epoch; key = null }
  page.grid.setCheckpoint(flush)
  return { view, open, flush, pause, stop }
}
