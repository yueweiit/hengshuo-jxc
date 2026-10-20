<script setup lang="ts">
import { computed } from 'vue'
import { useCountryStore } from '@/stores/country'
import { formatDateTime } from '@/utils/format'

/** 时间戳按仓店或国家时区显示，tz 未传时用当前国家时区 */
const props = defineProps<{ value?: string | null; tz?: string; knownDate?: string | null }>()
const country = useCountryStore()
const text = computed(() => !props.value && props.knownDate
  ? `来源日期 ${props.knownDate}（时刻未知）`
  : formatDateTime(props.value, props.tz || country.timezone))
</script>

<template>
  <span>{{ text }}</span>
</template>
