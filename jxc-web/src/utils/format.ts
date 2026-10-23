import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'

dayjs.extend(utc)
dayjs.extend(timezone)

const CURRENCY_DECIMALS: Record<string, number> = { CNY: 2, MXN: 2, USD: 2, COP: 2, JPY: 0 }

export function currencyDecimals(currency: string) {
  return CURRENCY_DECIMALS[currency] ?? 2
}

export function formatMoney(value: number | string | null | undefined, currency: string, locale = 'zh-CN') {
  if (value === null || value === undefined || value === '') return '-'
  const digits = currencyDecimals(currency)
  const n = Number(value)
  const text = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n)
  return `${currency} ${text}`
}

export function formatQty(value: number | string | null | undefined, unit?: string, locale = 'zh-CN') {
  if (value === null || value === undefined || value === '') return '-'
  const text = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(Number(value))
  return unit ? `${text} ${unit}` : text
}

/** 时间戳按国家或仓店时区展示，并附带时区缩写（docs/00 第 4 节） */
export function formatDateTime(value: string | null | undefined, tz: string, precision: 'minute' | 'second' = 'minute') {
  if (!value) return '-'
  const d = dayjs(value).tz(tz)
  const abbr = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(d.toDate())
    .find((p) => p.type === 'timeZoneName')?.value
  return `${d.format(precision === 'second' ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD HH:mm')} ${abbr ?? ''}`.trim()
}

export function formatDate(value: string | null | undefined) {
  if (!value) return '-'
  return dayjs(value).format('YYYY-MM-DD')
}

export function todayIn(tz: string) {
  return dayjs().tz(tz).format('YYYY-MM-DD')
}

/** A planned wall time is explicit input in the selected country's timezone, never a guessed midnight. */
export function countryDateTimeToIso(value: string | null | undefined, tz: string) {
  if (value == null || value === '') return undefined
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?$/.test(value)) throw new Error('请填写完整的当地日期和时间')
  const parsed = dayjs.tz(value, tz)
  if (!parsed.isValid() || parsed.format(value.includes('.') ? 'YYYY-MM-DD HH:mm:ss.SSS' : 'YYYY-MM-DD HH:mm:ss') !== value) throw new Error('当地日期或时间不合法')
  return parsed.toISOString()
}
export function countryDateTimeInput(value: string | null | undefined, tz: string) {
  return value ? dayjs(value).tz(tz).format('YYYY-MM-DD HH:mm:ss.SSS') : undefined
}
