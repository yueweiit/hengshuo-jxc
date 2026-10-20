import { ref, watchEffect, type Ref } from 'vue'
import { useOptionsStore, type OptionItem } from '@/stores/options'
import type { OptionSource } from './types'

export function useOptions(source: () => OptionSource | undefined): Ref<OptionItem[]> {
  const store = useOptionsStore()
  const items = ref<OptionItem[]>([])

  watchEffect(async () => {
    const s = source()
    if (!s) items.value = []
    else if (Array.isArray(s)) items.value = s
    else if ('dict' in s) items.value = await store.dict(s.dict)
    else items.value = await store.remote(s.remote, s.label, s.value, s.params)
  })

  return items
}

export function optionLabel(items: OptionItem[], value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => optionLabel(items, v)).join('、')
  return items.find((i) => i.value === value)?.label ?? (value == null ? '-' : String(value))
}
