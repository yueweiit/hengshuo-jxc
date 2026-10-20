export interface ApiResult<T = unknown> {
  code: string
  message: string
  data: T
  traceId: string
}

export interface PageResult<T> {
  records: T[]
  total: number
  page: number
  size: number
}

export interface PageQuery {
  page?: number
  size?: number
  keyword?: string
  [key: string]: unknown
}

export type Id = number

export interface Country {
  id: Id
  code: string
  name: string
  status: 'DRAFT' | 'ACTIVE' | 'DISABLED'
  defaultCurrency: string
  timezone: string
  locale: string
  dateFormat: string
  numberFormat: string
  isTest: boolean
  enabledModules: string[]
  sourceCountryId?: Id | null
  sourceTemplateVersionId?: Id | null
  activatedAt?: string | null
}

export interface CurrentUser {
  id: Id
  username: string
  displayName: string
  isPlatformAdmin: boolean
  locale: string
}

export interface MeResult {
  user: CurrentUser
  countries: Country[]
  /** 权限与字段权限按这个国家计算；请求的国家不可用时由后端回退 */
  currentCountryId: Id | null
  permissions: string[]
  fieldGroups: Record<string, 'HIDDEN' | 'READ' | 'WRITE'>
}

export interface MissingItem {
  key: string
  label: string
  level: 'BLOCK' | 'WARN'
  link?: string
}
