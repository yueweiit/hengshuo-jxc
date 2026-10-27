import { ElMessage, ElMessageBox } from 'element-plus'
import { isCancelledFailure, reportError } from '@/api/error-feedback'

/** 二次确认后执行单据动作；用户取消时静默返回 false，接口错误由 http 统一提示 */
export async function confirmAction(message: string, run: () => Promise<unknown>, opts: { title?: string; success?: string; type?: 'warning' | 'info' } = {}) {
  try {
    await ElMessageBox.confirm(message, opts.title ?? '确认', { type: opts.type ?? 'warning' })
  } catch (error) {
    if (isCancelledFailure(error)) return false
    reportError(error, { title: '确认窗口未能打开' })
    throw error
  }
  try { await run() }
  catch (error) { reportError(error); throw error }
  ElMessage.success(opts.success ?? '已完成')
  return true
}

/** 扫码匹配：商品编码完全一致或条码列表包含 */
export function matchBarcode(row: { productCode?: string; barcodeText?: string }, code: string) {
  return row.productCode === code || (row.barcodeText ?? '').split(/\s+/).includes(code)
}

/** 路由查询参数转为列表初始筛选：纯数字转为 number，以匹配下拉选项的值 */
export function queryDefaults(query: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(query).map(([k, v]) => [k, /^\d+$/.test(String(v)) ? Number(v) : v]))
}
