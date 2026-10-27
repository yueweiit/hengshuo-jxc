import axios, { AxiosError, type AxiosRequestConfig } from 'axios'
import { rememberFailureContext, reportError, type ErrorFeedbackOptions } from '@/api/error-feedback'
import type { ApiResult } from './types'
import { getToken, getCountryId, clearSession } from '@/utils/session'
import { router } from '@/router'
import type { CommandIntent } from './command-intent'
import { attachmentDownloadTarget, readBlobError } from './attachment-download'
export { createCommandIntent, newIdempotencyKey } from './command-intent'

export class BizError extends Error {
  code: string
  data: unknown
  traceId?: string
  constructor(code: string, message: string, data?: unknown, traceId?: string) {
    super(message)
    this.code = code
    this.data = data
    this.traceId = traceId
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
function requestContext(config: RequestOptions): RequestOptions {
  return { ...config, feedback: { sourcePath: router.currentRoute?.value?.fullPath, ...config.feedback } }
}
function assertCurrentRead(config: RequestOptions) {
  if ((config.method ?? 'GET').toUpperCase() === 'GET' && config.feedback?.sourcePath && config.feedback.sourcePath !== router.currentRoute?.value?.fullPath) {
    throw new BizError('CONTEXT_CHANGED', '已离开原页面，请在当前页面重试')
  }
}

function fail(error: BizError, config: RequestOptions): never {
  const method = (config.method ?? 'GET').toUpperCase()
  rememberFailureContext(error, {
    method,
    ...(method === 'GET' ? { key: `${config.url}:${JSON.stringify(config.params ?? {})}` } : {}),
    ...config.feedback,
  })
  if (!config.silent) reportError(error)
  throw error
}

function handleError(err: AxiosError<ApiResult>, config: RequestOptions): never {
  const status = err.response?.status
  const body = err.response?.data
  const code = body?.code ?? (status ? `HTTP_${status}` : err.code ?? 'NETWORK_ERROR')
  const message = body?.message || err.message || '请求失败，未收到有效响应'

  if (status === 401) {
    clearSession()
    router.replace({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } })
  }
  return fail(new BizError(code, message, body?.data, body?.traceId), config)
}

export interface RequestOptions extends AxiosRequestConfig {
  /** 延后至调用方核对当前请求有效性后，通过reportError/feedbackMessage报告。不是吞掉失败。 */
  silent?: boolean
  feedback?: ErrorFeedbackOptions
}

async function request<T>(config: RequestOptions): Promise<T> {
  config = requestContext(config)
  const scope = requestScope()
  try {
    const res = await instance.request<ApiResult<T>>(scopedConfig(config))
    assertScope(scope)
    assertCurrentRead(config)
    const body = res.data
    if (body.code !== 'OK') {
      fail(new BizError(body.code, body.message, body.data, body.traceId), config)
    }
    return body.data
  } catch (e) {
    assertScope(scope)
    assertCurrentRead(config)
    if (e instanceof BizError) throw e
    return handleError(e as AxiosError<ApiResult>, config)
  }
}

export const http = {
  /** Attachment proxy only. Retains auth/country interceptors and normal business-error handling. */
  async attachmentBlob(url: string, options?: RequestOptions): Promise<Blob> {
    const target = attachmentDownloadTarget(url, window.location.origin)
    const scope = requestScope()
    const config = requestContext({ ...options, url: target.url, method: 'GET' })
    try {
      const response = await instance.request<Blob>(scopedConfig({ ...options, baseURL: '', url: target.url, method: 'GET', responseType: 'blob' }))
      assertScope(scope)
      assertCurrentRead(config)
      return response.data
    } catch (error) {
      assertScope(scope)
      assertCurrentRead(config)
      const failure = error as AxiosError<ApiResult>
      const envelope = await readBlobError(failure.response?.data)
      if (envelope && failure.response) failure.response.data = envelope
      return handleError(failure, config)
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

