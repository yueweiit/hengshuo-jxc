/** 日期时间选择器使用毫秒时间戳（value-format="x"），提交接口前转为 ISO 字符串 */
export function toIso(v: number | string | null | undefined) {
  if (v == null || v === '') return undefined
  return new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v).toISOString()
}

export function nowMs() {
  return Date.now()
}
