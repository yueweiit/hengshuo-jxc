import type { ApiResult } from './types'

/** Never attach session headers to an arbitrary URL returned by metadata. */
export function attachmentDownloadTarget(url: string, origin: string, allowMockBlob = false): { kind: 'proxy' | 'mock-blob'; url: string } {
  const target = new URL(url, origin)
  if (allowMockBlob && target.protocol === 'blob:' && target.origin === origin) return { kind: 'mock-blob', url: target.href }
  const ordinary = /^\/api\/v1\/sys\/attachments\/[1-9]\d*\/content$/.test(target.pathname)
  const purchaseSource = /^\/api\/v1\/pur\/order-imports\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/(?:sources|images)\/[1-9]\d*\/content$/i.test(target.pathname)
  const productImage = /^\/api\/v1\/md\/product-images\/[1-9]\d*\/content$/.test(target.pathname)
  if (target.origin !== origin || target.username || target.password || target.hash || !(ordinary || purchaseSource || productImage)) throw new Error('附件下载地址无效，请重新获取')
  return { kind: 'proxy', url: target.pathname + target.search }
}

export async function readBlobError(body: unknown): Promise<ApiResult | undefined> {
  if (!(body instanceof Blob)) return undefined
  try {
    const value = JSON.parse(await body.text())
    return value && typeof value.code === 'string' && typeof value.message === 'string' ? value : undefined
  } catch { return undefined }
}
