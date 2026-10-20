import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { http } from '@/api/http'

export interface TodoSummaryItem {
  type: string
  label: string
  count: number
  link: string
}

export const useTodoStore = defineStore('todo', () => {
  const summary = ref<TodoSummaryItem[]>([])
  const unreadNotifications = ref(0)

  const total = computed(() => summary.value.reduce((s, i) => s + i.count, 0))

  async function refresh() {
    const res = await http.get<{ items: TodoSummaryItem[]; unreadNotifications: number }>(
      '/sys/workbench/summary',
      undefined,
      { silent: true },
    )
    summary.value = res.items
    unreadNotifications.value = res.unreadNotifications
  }

  function reset() {
    summary.value = []
    unreadNotifications.value = 0
  }

  return { summary, unreadNotifications, total, refresh, reset }
})
