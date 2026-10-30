import { reactive } from 'vue'
import type { PurchaseImportApi } from './purchaseImportModel'

export interface ImportUploadIntent { file: File; batchId: string | null; key: string }
export interface ImportCleanupJob { id: string | null; version: number; key: string; upload?: ImportUploadIntent; status: 'READY' | 'PENDING' | 'ERROR'; error: string }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0

/** 清理待办不占用当前导入批次；原文件只在上传结果未知时用于同请求恢复。 */
export function createPurchaseImportCleanup(api: PurchaseImportApi, newKey: () => string) {
  const jobs = reactive<ImportCleanupJob[]>([])
  const uploads = new Map<string, Promise<unknown>>()
  let generation = 0, processing: Promise<void> | null = null
  let checkpoint: () => Promise<boolean> = async () => true
  function read(value: unknown, id: string) {
    if (!object(value) || value.batchId !== id || !version(value.version) || !uuid(value.requestKey) ||
        !(value.cleared === true || value.clearRequested === true && value.cleared === false) || typeof value.cleanupPending !== 'boolean' ||
        !Number.isSafeInteger(value.pendingFiles) || Number(value.pendingFiles) < 0 || !object(value.counts) ||
        ['rows', 'sources', 'images', 'tasks', 'groups', 'progress'].some(field => !Number.isSafeInteger((value.counts as Record<string, unknown>)[field]) || Number((value.counts as Record<string, unknown>)[field]) < 0) ||
        !value.cleanupPending && (value.pendingFiles !== 0 || value.cleared !== true)) throw new Error('后台清空回执不完整，请按原请求重试核实')
    return value as unknown as { batchId: string; version: number; requestKey: string; cleanupPending: boolean; cleared: boolean; retained?: boolean; cleanupState?: string }
  }
  function enqueue(id: string | null, revision: number, upload?: ImportUploadIntent, key = newKey()) {
    if (jobs.some(job => id ? job.id === id : upload && job.upload?.key === upload.key)) return
    jobs.push({ id, version: revision, key, upload, status: 'READY', error: '' })
  }
  function track(key: string, request: Promise<unknown>) {
    uploads.set(key, request)
    const release = () => { if (uploads.get(key) === request) uploads.delete(key) }
    void request.then(release, release)
  }
  function process(retryErrors = true): Promise<void> {
    if (processing) return processing
    const context = generation
    const current = () => context === generation
    const run = async () => {
      for (const job of [...jobs]) {
        if (!current()) return
        if (job.status === 'ERROR' && !retryErrors) continue
        job.error = ''
        try {
          if (!job.id) {
            if (!job.upload) throw new Error('未完成上传缺少原文件和请求编号，请保留恢复记录')
            const intent = job.upload
            const response = await (uploads.get(intent.key) ?? api.upload(intent.file, intent.batchId, intent.key))
            if (!current()) return
            if (!object(response) || !uuid(response.batchId) || !version(response.version)) throw new Error('原上传未返回有效批次，不能确认后台资料已清理')
            job.id = response.batchId; job.version = response.version
            uploads.delete(intent.key); delete job.upload
          }
          if (!await checkpoint()) throw new Error('清理批次编号未能保存，请重试保存恢复记录后再清理')
          if (!current()) return
          if (!api.clearBatch) throw new Error('批次清空接口尚未接入')
          const response = await api.clearBatch(job.id, job.version, job.key)
          if (!current()) return
          const receipt = read(response, job.id)
          if (receipt.version !== job.version || receipt.requestKey !== job.key) throw new Error('清空回执与原请求不一致，请按原请求重试核实')
          if (receipt.cleanupPending) {
            job.status = 'PENDING'
            job.error = receipt.cleanupState === 'WAITING_RESULT' ? '采购单保存结果尚待核实，来源资料暂未删除' : receipt.cleanupState === 'FILES_PENDING' ? '暂存已删除，文件清理待重试' : '已登记后台清理，正在等待原任务结束'
          } else jobs.splice(jobs.indexOf(job), 1)
        } catch (error) {
          if (!current()) return
          job.status = 'ERROR'
          job.error = error instanceof Error ? error.message === 'Network Error' ? '连接中断，清理结果未知，请按原请求重试' : error.message : '后台清理失败，请按原请求重试'
        }
      }
    }
    const request = run().finally(() => { if (processing === request) processing = null })
    processing = request
    return request
  }
  function reset() { ++generation; jobs.splice(0); uploads.clear(); processing = null }
  function snapshot() { return jobs.map(job => ({ ...job, ...(job.upload ? { upload: { ...job.upload } } : {}) })) }
  function restore(value: unknown) {
    if (value === undefined) return
    if (!Array.isArray(value) || value.some(job => !object(job) || job.id !== null && !uuid(job.id) || !uuid(job.key) || !version(job.version) || !['READY', 'PENDING', 'ERROR'].includes(String(job.status)) || typeof job.error !== 'string' || job.id === null && (!object(job.upload) || !(job.upload.file instanceof Blob) || !uuid(job.upload.key)))) throw new Error('本地清理待办格式不正确，请保留记录后重试')
    jobs.splice(0, jobs.length, ...value as ImportCleanupJob[])
  }
  return { jobs, read, enqueue, track, process, reset, snapshot, restore, setCheckpoint: (save: () => Promise<boolean>) => { checkpoint = save } }
}
