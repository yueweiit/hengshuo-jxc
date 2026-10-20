import { useRouter } from 'vue-router'
import { useCountryStore } from '@/stores/country'
import { useUserStore } from '@/stores/user'
import { useTodoStore } from '@/stores/todo'
import { useOptionsStore } from '@/stores/options'

/** 切换国家后同步权限、菜单、币种时区，清空筛选缓存并刷新待办（docs/01 第 9 节） */
export function useSwitchCountry() {
  const router = useRouter()
  const country = useCountryStore()
  const user = useUserStore()
  const todo = useTodoStore()
  const options = useOptionsStore()

  return async function switchCountry(id: number, goto?: string) {
    if (country.switching || id === country.currentId) return
    country.switching = true
    try {
    await user.loadMe(id)
    options.invalidate()
    todo.reset()
    await todo.refresh()
    if (goto) {
      await router.push(goto)
      return
    }
    const current = router.currentRoute.value
    if (current.meta.perm && !user.hasPerm(current.meta.perm)) router.replace('/workbench')
    } finally { country.switching = false }
  }
}
