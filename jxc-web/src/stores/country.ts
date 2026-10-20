import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Country } from '@/api/types'
import { getCountryId, setCountryId } from '@/utils/session'

/**
 * 当前国家上下文：币种、时区、格式和启用模块都从这里读取，
 * 通用页面不得写死 MX、MXN 或墨西哥时区（docs/00 第 2.3 节）。
 */
export const useCountryStore = defineStore('country', () => {
  const available = ref<Country[]>([])
  const currentId = ref<number | null>(getCountryId())
  /** 每次切换国家加 1，页面用它作为 key 强制重建，清空筛选缓存 */
  const epoch = ref(0)
  const switching = ref(false)

  const current = computed(() => available.value.find((c) => c.id === currentId.value) ?? null)
  const currency = computed(() => current.value?.defaultCurrency ?? '')
  const timezone = computed(() => current.value?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)

  function setAvailable(list: Country[], effectiveId: number | null) {
    available.value = list
    if (effectiveId !== currentId.value) select(effectiveId)
  }

  function select(id: number | null) {
    currentId.value = id
    setCountryId(id)
    epoch.value++
  }

  function isModuleEnabled(module?: string) {
    if (!module || !current.value) return true
    return current.value.enabledModules.includes(module)
  }

  return { available, currentId, current, currency, timezone, epoch, switching, setAvailable, select, isModuleEnabled }
})
