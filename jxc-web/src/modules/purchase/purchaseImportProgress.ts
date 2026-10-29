import type { ImportRow, ImportTask } from './purchaseImportModel'
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
type ReviewState = { tasks: ImportTask[]; rows: ImportRow[]; imageReviewEnabled?: boolean; imageReviewError?: string; groups: { id: number; createStatus: string }[] }
export function imageReviewRows(state: ReviewState) {
  return state.rows.filter(row => (row.readiness !== 'READY' || !!row.matchTaskId) && !row.targetOrderLineId && !state.groups.some(group => group.id === row.groupId && ['CREATING', 'UNKNOWN'].includes(group.createStatus)))
}
/** 汇总后台当前行任务；人工确认数与AI任务处理数分别计算。 */
export function imageReviewProgress(state: ReviewState) {
  const rows = imageReviewRows(state), tasks = new Map(state.tasks.map(task => [task.id, task]))
  let succeeded = 0, failed = 0, attention = 0, pending = 0
  for (const row of rows) {
    const task = row.matchTaskId ? tasks.get(row.matchTaskId) : undefined
    if (!task || ['QUEUED', 'RUNNING'].includes(task.status)) { pending++; continue }
    const result = row.matchResult
    if (task.status !== 'SUCCEEDED' || result?.status === 'FAILED' || ['FAILED', 'UNAVAILABLE'].includes(result?.explanation?.status || '')) failed++
    else if (!result || result.runId !== task.id || (result.inputRevision !== row.version && row.readiness !== 'READY') || result.status !== 'OK' || result.image.status === 'NO_INPUT') attention++
    else succeeded++
  }
  return { total: rows.length, completed: succeeded + failed + attention, succeeded, failed, attention, pending, running: rows.some(row => row.matchTaskId && ['QUEUED', 'RUNNING'].includes(tasks.get(row.matchTaskId)?.status ?? '')) || state.tasks.some(task => task.kind === 'EXPLAIN' && ['QUEUED', 'RUNNING'].includes(task.status) && rows.some(row => row.id === task.result?.rowId)) }
}
export function importProgressView(state: ReviewState & { activeTaskId?: string | null; upload?: ImportUpload | null; progressError?: string; progressReloadNeeded?: boolean; error?: string }) {
  const task = state.tasks.find(item => item.id === state.activeTaskId) ?? state.tasks.filter(item => !item.kind || item.kind === 'PARSE').at(-1)
  const upload = state.upload
  if (upload) return { title: upload.status === 'UPLOADING' ? '正在上传文件' : upload.status === 'ACCEPTING' ? '等待服务器接收确认' : upload.status === 'UNKNOWN' ? '文件接收结果尚未确认' : '文件未成功接收', fileName: upload.fileName, message: ['UNKNOWN', 'ERROR'].includes(upload.status) ? state.error || '请核对原因后使用原请求重试' : '文件上传完成后还需解析和保存', percentage: upload.total ? Math.round(upload.loaded / upload.total * 100) : null, complete: false, failed: ['UNKNOWN', 'ERROR'].includes(upload.status), rows: '', images: '', step: 0 }
  const review = imageReviewProgress(state)
  if (state.imageReviewEnabled && review.total && !state.progressReloadNeeded && (!task || task.status === 'SUCCEEDED')) {
    const complete = review.completed === review.total && !review.failed && !review.attention && !review.running
    const stopped = !review.running && (!!state.imageReviewError || !!review.failed || !!review.attention)
    return {
      title: complete ? '导入与AI图文核对已完成，待人工确认' : stopped ? '明细已暂存，AI图文核对仍有待处理项' : review.running ? '正在进行AI图文核对' : '明细已暂存，等待AI图文核对',
      fileName: task?.fileName || '采购明细',
      message: review.running ? 'AI正在核对照片与规格，请等待全部任务处理结束；当前暂不能操作表格和图片。' : state.imageReviewError ? `明细已暂存。AI图文核对未能启动：${state.imageReviewError}。请进入核对窗口处理。` : `明细已暂存；AI结果仅供参考，请点击“待确定是否为新商品”逐行确认。${review.attention ? '缺图、部分结果或过期结果仍需人工处理。' : ''}${review.failed ? '核对失败行请进入辅助识别查看原因并重试。' : ''}`,
      percentage: Math.floor(review.completed / review.total * 100), complete, failed: stopped,
      rows: `AI已处理 ${review.completed} / ${review.total} 行；成功 ${review.succeeded} · 失败 ${review.failed} · 待人工处理 ${review.attention} · 处理中 ${review.pending}`,
      images: '', step: complete ? 6 : 5,
    }
  }
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
  const message = complete ? (state.progressReloadNeeded ? '后台已完成，正在重新读取明细' : result?.rows !== undefined && result.images !== undefined ? `本次导入暂存完成：明细 ${result.rows} 条，图片 ${result.images} 张${result.reviewRows ? `；解析时 ${result.reviewRows} 条来源字段待补充` : ''}${result.unstagedCandidates ? `；另有 ${result.unstagedCandidates} 条候选未能导入，请查看来源记录` : ''}` : '本次文件已处理完成，明细数量待核对') : failed ? `本次未保存明细。${task.errorMessage || '任务未完成，请核对后重试'}` : '行数仅表示当前步骤已处理的数量，提交成功后才完成暂存'
  return { title: complete ? '导入暂存完成' : failed ? `导入未完成（${labels[phase ?? 'READING']!.replace(/^正在/, '')}）` : task.status === 'QUEUED' ? '文件已接收，等待后台处理' : labels[phase ?? 'READING']!, fileName: task.fileName || '采购文件', message, percentage, complete, failed, rows, images: p ? `原图 ${p.processedImages} / ${p.totalImages === null ? '待统计' : p.totalImages} 张` : '', step: complete ? 5 : step }
}
