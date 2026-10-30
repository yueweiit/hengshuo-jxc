import { nextTick, reactive, watch, type WatchStopHandle } from 'vue'
import type { PurchaseImportModel } from './purchaseImportModel'

type Snapshot = ReturnType<PurchaseImportModel['exportLocalDraft']>
type StoredDraft = Snapshot | { cleanupJobs: Snapshot['cleanupJobs'] }
export interface PurchaseImportDraftStore {
  read(key: string): Promise<unknown>
  write(key: string, value: StoredDraft): Promise<void>
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
  async function run(key: string, mode: IDBTransactionMode, value?: StoredDraft) {
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
  function related(target: string) {
    // 自定义内存存储允许简单入口名；正式入口始终是账号、国家、批次组成的JSON键。
    if (!target.startsWith('[')) return { blank: target, cleanup: null }
    const parts: unknown = JSON.parse(target)
    if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== 'purchase-import-v1') throw new Error('本地草稿入口格式不正确')
    return { blank: purchaseImportDraftKey(parts[1], parts[2], null), cleanup: JSON.stringify(['purchase-import-cleanup-v1', parts[1], parts[2]]) }
  }
  function enqueue(snapshot: Snapshot, destination = key) {
    if (!destination) return Promise.resolve(false)
    const target = destination, context = epoch, writeRevision = ++revision
    view.saving = true; view.saved = false
    queue = queue.then(async () => {
      try {
        await store.write(target, snapshot)
        const recoveryKey = related(target).cleanup
        if (recoveryKey) await store.write(recoveryKey, { cleanupJobs: snapshot.cleanupJobs })
        if (context === epoch && writeRevision === revision) { view.error = ''; view.saved = true }
        return true
      } catch (error) {
        if (context === epoch && writeRevision === revision) view.error = `本地记录保存失败：${error instanceof Error ? error.message : '本地存储写入失败'}；请重试保存，刷新前可能无法恢复最新操作`
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
      const recoveryKey = related(nextKey).cleanup
      if (recoveryKey) {
        const recovery = await store.read(recoveryKey)
        if (context !== epoch) return false
        if (recovery !== undefined) {
          if (!recovery || typeof recovery !== 'object' || !('cleanupJobs' in recovery)) throw new Error('本地清理恢复记录不完整')
          page.restoreCleanupJobs(recovery.cleanupJobs)
        }
      }
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
  async function flushCleared() {
    if (!view.ready || !key) return false
    await nextTick()
    const snapshot = page.exportLocalDraft(), blank = related(key).blank
    if (!await enqueue(snapshot)) return false
    return blank === key || await enqueue(snapshot, blank)
  }
  function stop() { pause(); ++epoch; key = null }
  page.grid.setCheckpoint(flush)
  page.setCleanupCheckpoint(flush)
  return { view, open, flush, flushCleared, pause, stop }
}
