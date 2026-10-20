import { http } from './http'
import type { CommandIntent } from './command-intent'
import type { Id, PageQuery, PageResult } from './types'

export interface CrudApi<T> {
  list(query: PageQuery): Promise<PageResult<T>>
  get(id: Id): Promise<T>
  create(data: Partial<T>): Promise<T>
  update(id: Id, data: Partial<T>): Promise<T>
  remove(id: Id): Promise<void>
  disable(id: Id, data?: { version?: number }): Promise<T>
  enable(id: Id, data?: { version?: number }): Promise<T>
}

export function createCrudApi<T>(resource: string, createIntent?: CommandIntent): CrudApi<T> {
  return {
    list: (query) => http.get<PageResult<T>>(resource, query),
    get: (id) => http.get<T>(`${resource}/${id}`),
    create: (data) => createIntent ? http.postIdem<T>(resource, data, createIntent) : http.post<T>(resource, data),
    update: (id, data) => createIntent ? http.putIdem<T>(`${resource}/${id}`, data, createIntent) : http.put<T>(`${resource}/${id}`, data),
    remove: (id) => http.delete<void>(`${resource}/${id}`),
    disable: (id, data) => createIntent ? http.postIdem<T>(`${resource}/${id}/disable`, data, createIntent) : http.post<T>(`${resource}/${id}/disable`, data),
    enable: (id, data) => createIntent ? http.postIdem<T>(`${resource}/${id}/enable`, data, createIntent) : http.post<T>(`${resource}/${id}/enable`, data),
  }
}
