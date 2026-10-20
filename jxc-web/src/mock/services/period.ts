/**
 * 会计期间锁（docs/12 第 5.9 节）。账套未启用时不拦截；已结账期间返回 FIN_PERIOD_CLOSED。
 */
import { getDb } from '../db'
import { bad } from './common'

export function activeBook(countryId: number) {
  return getDb().books.find((b) => b.countryId === countryId && b.status === 'ACTIVE') ?? null
}

export function periodOf(countryId: number, bizDate: string, bookId?: number) {
  const book = bookId ? getDb().books.find(b => b.id === bookId && b.countryId === countryId) : activeBook(countryId)
  if (!book) return null
  const day = bizDate.slice(0, 10)
  return getDb().finPeriods.find((p) => p.bookId === book.id && p.startDate <= day && p.endDate >= day) ?? null
}

export function assertPeriodOpen(countryId: number, bizDate: string, bookId?: number) {
  const book = bookId ? getDb().books.find(b => b.id === bookId && b.countryId === countryId) : activeBook(countryId)
  if (!book) return
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(bizDate)) || Number.isNaN(Date.parse(bizDate.slice(0, 10)))) bad('请填写有效的业务日期', 'FIN_DATE_INVALID')
  const p = periodOf(countryId, bizDate, book.id)
  if (!p) bad(`${bizDate.slice(0, 10)} 没有对应的会计期间`, 'FIN_PERIOD_NOT_OPEN')
  if (p.status === 'CLOSED') bad(`${p.fiscalYear}-${String(p.periodNo).padStart(2, '0')} 已结账，不能再记入业务`, 'FIN_PERIOD_CLOSED')
  if (!['OPEN', 'PENDING_CLOSE'].includes(p.status)) bad('该会计期间尚未开放', 'FIN_PERIOD_NOT_OPEN')
}
