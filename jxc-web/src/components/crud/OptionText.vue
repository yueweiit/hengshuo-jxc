<script setup lang="ts">
import type { OptionSource } from './types'
import { optionLabel, useOptions } from './useOptions'

const props = defineProps<{ value: unknown; options?: OptionSource }>()
const items = useOptions(() => props.options)
</script>

<template>
  <span>{{ optionLabel(items, value) }}</span>
</template>
