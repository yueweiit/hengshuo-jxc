import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { http } from '@/api/http'
import type { CurrentUser, MeResult } from '@/api/types'
import { clearSession, getToken, setToken } from '@/utils/session'
import { useCountryStore } from './country'

export const useUserStore = defineStore('user', () => {
  const token = ref<string | null>(getToken())
  const user = ref<CurrentUser | null>(null)
  const permissions = ref<string[]>([])
  const fieldGroups = ref<MeResult['fieldGroups']>({})
  const loaded = ref(false)

  const isLoggedIn = computed(() => !!token.value)

  /** 权限码支持精确匹配、全部（*）以及模块通配（例如 org:*） */
  function hasPerm(code?: string | string[]) {
    if (!code) return true
    const codes = Array.isArray(code) ? code : [code]
    return codes.some((c) =>
      permissions.value.some((p) => p === '*' || p === c || (p.endsWith(':*') && c.startsWith(p.slice(0, -1)))),
    )
  }

  function fieldAccess(group: string) {
    return fieldGroups.value[group] ?? 'HIDDEN'
  }

  async function login(username: string, password: string) {
    const res = await http.post<{ token: string }>('/auth/login', { username, password })
    token.value = res.token
    setToken(res.token)
    loaded.value = false
  }

  /** 读取当前用户、可用国家，以及当前国家下的权限码与字段权限 */
  async function loadMe(requestedCountryId?: number) {
    const country = useCountryStore()
    const me = await http.get<MeResult>('/auth/me', { countryId: requestedCountryId ?? country.currentId ?? undefined })
    user.value = me.user
    permissions.value = me.permissions
    fieldGroups.value = me.fieldGroups
    country.setAvailable(me.countries, me.currentCountryId)
    loaded.value = true
  }

  async function logout() {
    try {
      await http.post('/auth/logout', undefined, { silent: true })
    } catch {
      // 会话已失效时登出接口返回 401，本地清理即可
    } finally {
      clearSession()
      token.value = null
      user.value = null
      permissions.value = []
      fieldGroups.value = {}
      useCountryStore().select(null)
      loaded.value = false
    }
  }

  return { token, user, permissions, fieldGroups, loaded, isLoggedIn, hasPerm, fieldAccess, login, loadMe, logout }
})
