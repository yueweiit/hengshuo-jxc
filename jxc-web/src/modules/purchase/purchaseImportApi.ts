import { http } from '@/api/http'
import type { PurchaseImportApi } from './purchaseImportModel'

/** 后端接入约定的唯一路径定义；不在这里解析Excel或模拟保存成功。 */
const base = '/pur/order-imports'
const batchPath = (id: string) => `${base}/${encodeURIComponent(id)}`
export const purchaseImportApi: PurchaseImportApi = {
  upload(file, header, batchId, key) {
    const data = new FormData()
    data.append('file', file)
    data.append('header', JSON.stringify(header))
    if (batchId) data.append('batchId', batchId)
    return http.post(base, data, { headers: { 'Idempotency-Key': key }, silent: true })
  },
  load: id => http.get(batchPath(id), undefined, { silent: true }),
  saveHeader: (id, header, versions) => http.put(batchPath(id), { header, versions }, { silent: true }),
  saveRow: (id, row, values) => http.put(`${batchPath(id)}/rows/${row.id}`, { version: row.version, values }, { silent: true }),
  deleteRow: (id, row) => http.delete(`${batchPath(id)}/rows/${row.id}`, { headers: { 'If-Match': String(row.version) }, silent: true }),
}
