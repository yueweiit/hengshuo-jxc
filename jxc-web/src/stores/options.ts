import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { BizError } from '@/api/http'
import { allRecords } from '@/api/pagination'
import { getCountryId, getToken } from '@/utils/session'

export interface OptionItem {
  label: string
  value: string | number | boolean
}

interface PendingOptions {
  scope: string
  generation: number
  requests: Map<string, Promise<OptionItem[]>>
}
const pending = new WeakMap<object, PendingOptions>()
const currentScope = () => `${getToken() ?? ''}:${getCountryId() ?? ''}`
function assertScope(scope: string) {
  if (scope !== currentScope()) throw new BizError('CONTEXT_CHANGED', '国家或登录状态已切换，请在当前页面重试')
}

/** 下拉选项缓存：字典和远程档案按国家缓存，切换国家时清空 */
export const useOptionsStore = defineStore('options', {
  state: () => ({
    cache: {} as Record<string, OptionItem[]>,
  }),
  actions: {
    async load(key: string, loader: (assertCurrent: () => void) => Promise<OptionItem[]>) {
      const scope = currentScope()
      // Devtools supplies a fresh action Proxy; the raw Pinia state is the stable cache owner.
      const owner = toRaw(this.$state)
      let context = pending.get(owner)
      if (!context || context.scope !== scope) {
        this.cache = {}
        context = { scope, generation: 0, requests: new Map() }
        pending.set(owner, context)
      }
      if (this.cache[key]) return this.cache[key]
      const active = context, generation = context.generation
      const assertCurrent = () => {
        assertScope(scope)
        if (pending.get(owner) !== active || active.generation !== generation) {
          throw new BizError('CONTEXT_CHANGED', '选项缓存已刷新，请在当前页面重试')
        }
      }
      let request = active.requests.get(key)
      if (!request) {
        request = loader(assertCurrent).finally(() => {
          if (active.requests.get(key) === request) active.requests.delete(key)
        })
        active.requests.set(key, request)
      }
      const items = await request
      assertCurrent()
      this.cache[key] = items
      return items
    },
    dict(dictType: string) {
      return this.load(`dict:${dictType}`, async (assertCurrent) => {
        const records = await allRecords<{ code: string; label: string }>('/md/dicts', { dictType, status: 'ENABLED' }, assertCurrent)
        return records.map((r) => ({ label: r.label, value: r.code }))
      })
    },
    remote(url: string, labelKey = 'name', valueKey = 'id', params: object = {}) {
      return this.load(`remote:${url}:${labelKey}:${valueKey}:${JSON.stringify(params)}`, async (assertCurrent) => {
        const records = await allRecords<Record<string, unknown>>(url, params, assertCurrent)
        return records.map((r) => ({ label: String(r[labelKey]), value: r[valueKey] as string | number }))
      })
    },
    invalidate(prefix?: string) {
      const context = pending.get(toRaw(this.$state))
      if (context) {
        context.generation++
        context.requests.clear()
      }
      if (!prefix) {
        this.cache = {}
        return
      }
      for (const k of Object.keys(this.cache)) if (k.includes(prefix)) delete this.cache[k]
    },
  },
})
