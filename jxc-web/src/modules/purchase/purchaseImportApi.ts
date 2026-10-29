import { http } from '@/api/http'
import type { PurchaseImportApi } from './purchaseImportModel'

/** 后端接入约定的唯一路径定义；不在这里解析Excel或模拟保存成功。 */
const base = '/pur/order-imports'
const batchPath = (id: string) => `${base}/${encodeURIComponent(id)}`
export const purchaseImportApi: PurchaseImportApi = {
  upload(file, batchId, key) {
    const data = new FormData()
    data.append('file', file)
    if (batchId) data.append('batchId', batchId)
    return http.post(base, data, { headers: { 'Idempotency-Key': key }, timeout: 120000, silent: true })
  },
  load: id => http.get(batchPath(id), undefined, { silent: true }),
  saveHeader: (id, header, versions, batchVersion) => http.put(batchPath(id), { header, versions, batchVersion }, { silent: true }),
  saveRow: (id, row, values, matchInputs) => http.put(`${batchPath(id)}/rows/${row.id}`, { version: row.version, values, ...(matchInputs ? { matchInputs } : {}) }, { silent: true }),
  uploadPhoto(id, row, file, values, key) {
    const data = new FormData()
    data.append('file', file)
    data.append('version', String(row.version))
    data.append('values', JSON.stringify(values))
    return http.post(`${batchPath(id)}/rows/${row.id}/image`, data, { headers: { 'Idempotency-Key': key }, timeout: 120000, silent: true })
  },
  readImage: (id, imageId, signal) => http.attachmentBlob(`/api/v1${batchPath(id)}/images/${imageId}/content`, { signal, silent: true }),
  deleteRow: (id, row) => http.delete(`${batchPath(id)}/rows/${row.id}`, { headers: { 'If-Match': String(row.version) }, silent: true }),
  retryTask: (id, key, sheet) => http.post(`${base}/tasks/${encodeURIComponent(id)}/retry`, { sheet }, { headers: { 'Idempotency-Key': key }, silent: true }),
  associate: (id, row, imageId, association) => http.put(`${batchPath(id)}/rows/${row.id}/images/${imageId}/association`, { version: row.version, association }, { silent: true }),
  decide: (id, row, input) => http.put(`${batchPath(id)}/rows/${row.id}/decision`, { ...input, version: row.version }, { silent: true }),
  createProduct: (id, row, input, key) => http.post(`${batchPath(id)}/rows/${row.id}/products`, input, { headers: { 'Idempotency-Key': key }, silent: true }),
  publishPhotos: (id, row, imageIds, key) => http.post(`${batchPath(id)}/rows/${row.id}/photos`, { version: row.version, confirmOwnership: true, imageIds }, { headers: { 'Idempotency-Key': key }, silent: true }),
  startMatches: (id, batchVersion, rowIds, key) => http.post(`${batchPath(id)}/matches`, { batchVersion, rowIds, topK: 5 }, { headers: { 'Idempotency-Key': key }, silent: true }),
  explain: (id, row, key) => http.post(`${batchPath(id)}/rows/${row.id}/explanations`, { version: row.version }, { headers: { 'Idempotency-Key': key }, silent: true }),
  gallery: () => http.get(`${base}/gallery/status`, undefined, { silent: true }),
  rebuildGallery: (batchId, key) => http.post(`${base}/gallery/rebuild`, { batchId }, { headers: { 'Idempotency-Key': key }, silent: true }),
  previews: (id, batchVersion) => http.post(`${batchPath(id)}/previews`, { batchVersion }, { silent: true }),
  saveGroup: (id, group, header, splitRowIds) => http.put(`${batchPath(id)}/groups/${group.id}`, { groupVersion: group.version, header, splitRowIds }, { silent: true }),
  createDraft: (id, group, request, key) => http.post(`${batchPath(id)}/groups/${group.id}/drafts`, request, { headers: { 'Idempotency-Key': key }, silent: true }),
  saveFeeTodos: (id, group, items) => http.put(`${batchPath(id)}/groups/${group.id}/fee-todos`, { version: group.feeTodosVersion, sourceBasisHash: group.sourceBasisHash, items }, { silent: true }),
  creation: (id, group) => http.get(`${batchPath(id)}/groups/${group.id}/creation`, undefined, { silent: true }),
}
