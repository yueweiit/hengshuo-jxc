import { createRouter, createWebHistory } from 'vue-router'
import { routes } from './routes'

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

const WHITE_LIST = ['/login']

router.beforeEach(async (to) => {
  const { useUserStore } = await import('@/stores/user')
  const user = useUserStore()

  if (WHITE_LIST.includes(to.path)) return true
  if (!user.isLoggedIn) return { path: '/login', query: { redirect: to.fullPath } }

  if (!user.loaded) {
    try {
      await user.loadMe()
    } catch {
      return { path: '/login', query: { redirect: to.fullPath } }
    }
  }

  if (to.meta.perm && !user.hasPerm(to.meta.perm)) {
    return { path: '/403', query: { from: to.fullPath } }
  }
  return true
})
