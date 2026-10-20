import { BizError, http } from './http'
import type { PageResult } from './types'
import { getCountryId, getToken } from '@/utils/session'

/** Read full reference rows without losing fields or exceeding the server page limit. */
export async function allRecords<T>(url: string, params: object = {}, assertCurrent?: () => void): Promise<T[]> {
  const token = getToken(), country = getCountryId()
  const assertContext = () => {
    if (token !== getToken() || country !== getCountryId()) throw new BizError('CONTEXT_CHANGED', '国家或登录状态已切换，请在当前页面重试')
    assertCurrent?.()
  }
  const records: T[] = []
  for (let page = 1; ; page++) {
    assertContext()
    const result = await http.get<PageResult<T> | T[]>(url, { ...params, page, size: 200 })
    assertContext()
    if (Array.isArray(result)) return result
    if (!Array.isArray(result.records) || !Number.isSafeInteger(result.total) || result.total < 0) throw new BizError('INVALID_PAGE', '分页数据不完整，请刷新后重试')
    records.push(...result.records)
    if (records.length >= result.total) return records
    if (!result.records.length) throw new BizError('INVALID_PAGE', '分页数据不完整，请刷新后重试')
  }
}
