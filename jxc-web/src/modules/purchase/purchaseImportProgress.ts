import type { ImportTask } from './purchaseImportModel'
export const importPhases = ['READING', 'CONVERTING', 'PARSING', 'EXTRACTING_IMAGES', 'VALIDATING', 'PREPARING_IMAGES', 'SAVING', 'LINKING'] as const
export interface ImportProgress { phase: typeof importPhases[number]; processedRows: number; totalRows: number | null; sourceTotalRows?: number | null; processedImages: number; totalImages: number | null; sourceSheet?: string | null; sourceRow?: number | null; attemptCount: number; updatedAt: string }
export interface ImportUpload { fileName: string; loaded: number; total: number | null; status: 'UPLOADING' | 'ACCEPTING' | 'UNKNOWN' | 'ERROR' }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
export function readImportTask(value: unknown): ImportTask {
  if (!object(value) || typeof value.id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id) || !['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REAUTH', 'STALE'].includes(String(value.status))) throw new Error('后端返回的导入任务状态无效')
  if (value.progress != null) {
    const p = value.progress
    if (object(p) && p.sourceTotalRows != null && !count(p.sourceTotalRows)) throw new Error('后端返回的文件行数无效')
    if (!object(p) || !importPhases.includes(p.phase as ImportProgress['phase']) || !count(p.processedRows) || !count(p.processedImages) || p.totalRows !== null && (!count(p.totalRows) || Number(p.processedRows) > Number(p.totalRows)) || p.totalImages !== null && (!count(p.totalImages) || Number(p.processedImages) > Number(p.totalImages)) || !count(p.attemptCount) || Number(p.attemptCount) < 1 || typeof p.updatedAt !== 'string' || value.attemptCount !== undefined && value.attemptCount !== p.attemptCount) throw new Error('后端返回的行数进度无效，请重新查询')
  }
  if (object(value.result) && (value.result.rows !== undefined && !count(value.result.rows) || value.result.images !== undefined && !count(value.result.images))) throw new Error('后端返回的导入完成数量无效')
  return value as unknown as ImportTask
}
export function importProgressView(state: { tasks: ImportTask[]; activeTaskId?: string | null; upload?: ImportUpload | null; progressError?: string; progressReloadNeeded?: boolean; error?: string }) {
  const task = state.tasks.find(item => item.id === state.activeTaskId) ?? state.tasks.filter(item => !item.kind || item.kind === 'PARSE').at(-1)
  const upload = state.upload
  if (upload) return { title: upload.status === 'UPLOADING' ? '正在上传文件' : upload.status === 'ACCEPTING' ? '等待服务器接收确认' : upload.status === 'UNKNOWN' ? '文件接收结果尚未确认' : '文件未成功接收', fileName: upload.fileName, message: ['UNKNOWN', 'ERROR'].includes(upload.status) ? state.error || '请核对原因后使用原请求重试' : '文件上传完成后还需解析和保存', percentage: upload.total ? Math.round(upload.loaded / upload.total * 100) : null, complete: false, failed: ['UNKNOWN', 'ERROR'].includes(upload.status), rows: '', images: '', step: 0 }
  if (!task) return null
  const p = task.progress
  const labels: Record<string, string> = { READING: '正在读取文件、统计采购行数', CONVERTING: '正在识别文件内容', PARSING: '正在解析采购明细', EXTRACTING_IMAGES: '正在提取原图', VALIDATING: '正在校验采购明细', PREPARING_IMAGES: '正在保存原图文件', SAVING: '正在保存采购明细', LINKING: '正在关联照片、等待保存提交' }
  const complete = task.status === 'SUCCEEDED', failed = ['FAILED', 'NEEDS_REAUTH', 'STALE', 'CANCELLED'].includes(task.status)
  const rows = p ? `${p.sourceTotalRows != null ? `文件 ${p.sourceTotalRows} 行；` : ''}当前步骤已处理 ${p.processedRows} / ${p.totalRows === null ? '待统计' : p.totalRows} 行${p.sourceSheet && p.sourceRow ? `；最近处理 ${p.sourceSheet}!${p.sourceRow}` : ''}` : '正在统计采购行数'
  const phase = p?.phase
  const step = task.status === 'QUEUED' || !phase || phase === 'READING' ? 1 : phase === 'CONVERTING' || phase === 'PARSING' ? 2 : phase === 'EXTRACTING_IMAGES' || phase === 'VALIDATING' || phase === 'PREPARING_IMAGES' ? 3 : 4
  const result = task.result
  const imageStep = phase === 'EXTRACTING_IMAGES' || phase === 'PREPARING_IMAGES'
  const percentage = complete ? 100 : imageStep ? p?.totalImages ? Math.floor(p.processedImages / p.totalImages * 100) : null : p?.totalRows ? Math.floor(p.processedRows / p.totalRows * 100) : null
  const message = complete ? (state.progressReloadNeeded ? '后台已完成，正在重新读取明细' : result?.rows !== undefined && result.images !== undefined ? `本次导入暂存完成：明细 ${result.rows} 条，图片 ${result.images} 张` : '本次文件已处理完成，明细数量待核对') : failed ? `本次未保存明细。${task.errorMessage || '任务未完成，请核对后重试'}` : '行数仅表示当前步骤已处理的数量，提交成功后才完成暂存'
  return { title: complete ? '导入暂存完成' : failed ? `导入未完成（${labels[phase ?? 'READING']!.replace(/^正在/, '')}）` : task.status === 'QUEUED' ? '文件已接收，等待后台处理' : labels[phase ?? 'READING']!, fileName: task.fileName || '采购文件', message, percentage, complete, failed, rows, images: p ? `原图 ${p.processedImages} / ${p.totalImages === null ? '待统计' : p.totalImages} 张` : '', step: complete ? 5 : step }
}
