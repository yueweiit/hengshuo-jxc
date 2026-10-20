import axios, { AxiosError, type AxiosRequestConfig } from 'axios'
import { ElMessage } from 'element-plus'
import type { ApiResult } from './types'
import { getToken, getCountryId, clearSession } from '@/utils/session'
import { router } from '@/router'
import type { CommandIntent } from './command-intent'
import { attachmentDownloadTarget, readBlobError } from './attachment-download'
export { createCommandIntent, newIdempotencyKey } from './command-intent'

export class BizError extends Error {
  code: string
  data: unknown
  constructor(code: string, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

const instance = axios.create({
  baseURL: '/api/v1',
  timeout: 20000,
})

function requestScope() { return `${getToken() ?? ''}:${getCountryId() ?? ''}` }
function scopedConfig(config: RequestOptions): RequestOptions {
  const token = getToken()
  const countryId = getCountryId()
  return { ...config, headers: { ...config.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(countryId ? { 'X-Country-Id': String(countryId) } : {}) } }
}
function assertScope(scope: string) {
  if (scope !== requestScope()) throw new BizError('CONTEXT_CHANGED', '国家或登录状态已切换，请在当前页面重试')
}

function handleError(err: AxiosError<ApiResult>): never {
  const status = err.response?.status
  const body = err.response?.data
  const code = body?.code ?? 'NETWORK_ERROR'
  const message = body?.message || err.message
  const silent = (err.config as RequestOptions | undefined)?.silent

  if (status === 401) {
    clearSession()
    router.replace({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } })
  } else if (!silent) {
    ElMessage.error(message)
  }
  throw new BizError(code, message, body?.data)
}

export interface RequestOptions extends AxiosRequestConfig {
  /** 不弹出错误提示，由调用方自行处理 */
  silent?: boolean
}

async function request<T>(config: RequestOptions): Promise<T> {
  const scope = requestScope()
  try {
    const res = await instance.request<ApiResult<T>>(scopedConfig(config))
    assertScope(scope)
    const body = res.data
    if (body.code !== 'OK') {
      if (!config.silent) ElMessage.error(body.message)
      throw new BizError(body.code, body.message, body.data)
    }
    return body.data
  } catch (e) {
    assertScope(scope)
    if (e instanceof BizError) throw e
    return handleError(e as AxiosError<ApiResult>)
  }
}

export const http = {
  /** Attachment proxy only. Retains auth/country interceptors and normal business-error handling. */
  async attachmentBlob(url: string, options?: RequestOptions): Promise<Blob> {
    const target = attachmentDownloadTarget(url, window.location.origin)
    const scope = requestScope()
    try {
      const response = await instance.request<Blob>(scopedConfig({ ...options, baseURL: '', url: target.url, method: 'GET', responseType: 'blob' }))
      assertScope(scope)
      return response.data
    } catch (error) {
      assertScope(scope)
      const failure = error as AxiosError<ApiResult>
      const envelope = await readBlobError(failure.response?.data)
      if (envelope && failure.response) failure.response.data = envelope
      return handleError(failure)
    }
  },
  get<T>(url: string, params?: object, options?: RequestOptions) {
    return request<T>({ ...options, url, method: 'GET', params })
  },
  post<T>(url: string, data?: unknown, options?: RequestOptions) {
    return request<T>({ ...options, url, method: 'POST', data })
  },
  put<T>(url: string, data?: unknown, options?: RequestOptions) {
    return request<T>({ ...options, url, method: 'PUT', data })
  },
  delete<T>(url: string, options?: RequestOptions) {
    return request<T>({ ...options, url, method: 'DELETE' })
  },
  putIdem<T>(url: string, data: unknown, idempotencyKey: string | CommandIntent, options?: RequestOptions) {
    const scope = requestScope()
    const commandData = typeof idempotencyKey === 'string' || data === undefined ? data : JSON.parse(JSON.stringify(data))
    const send = (key: string) => { assertScope(scope); return request<T>({ ...options, url, method: 'PUT', data: commandData, headers: { ...options?.headers, 'Idempotency-Key': key } }) }
    return typeof idempotencyKey === 'string' ? send(idempotencyKey) : idempotencyKey.run(scope, `PUT ${url}`, commandData, send)
  },
  /**
   * 收货、出库、到账、核销、退款、凭证生成等动作必须带幂等键。
   * 同一次操作的重试应复用同一个 key（见 docs/00 第 7.1 节）。
   */
  postIdem<T>(url: string, data: unknown, idempotencyKey: string | CommandIntent, options?: RequestOptions) {
    const scope = requestScope()
    const commandData = typeof idempotencyKey === 'string' || data === undefined ? data : JSON.parse(JSON.stringify(data))
    const send = (key: string) => { assertScope(scope); return request<T>({
      ...options,
      url,
      method: 'POST',
      data: commandData,
      headers: { ...options?.headers, 'Idempotency-Key': key },
    }) }
    return typeof idempotencyKey === 'string'
      ? send(idempotencyKey)
      : idempotencyKey.run(scope, `POST ${url}`, commandData, send)
  },
}

