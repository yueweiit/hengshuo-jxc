<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatQty } from '@/utils/format'

const props = defineProps<{ value?: number | string | null; unit?: string }>()
const { locale } = useI18n()
const text = computed(() => formatQty(props.value, props.unit, locale.value))
</script>

<template>
  <span class="mono">{{ text }}</span>
</template>
