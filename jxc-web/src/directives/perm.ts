import type { Directive } from 'vue'
import { useUserStore } from '@/stores/user'

/**
 * 按钮级权限：v-perm="'md:rate:confirm'" 或 v-perm="['a', 'b']"（任一满足）。
 * 只是隐藏入口，后端仍然独立校验。
 */
export const vPerm: Directive<HTMLElement, string | string[]> = {
  mounted(el, binding) {
    if (!useUserStore().hasPerm(binding.value)) el.remove()
  },
}
