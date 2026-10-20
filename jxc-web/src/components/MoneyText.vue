<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCountryStore } from '@/stores/country'
import { formatMoney } from '@/utils/format'

/** 金额必须带币种展示；未指定币种时使用当前国家交易币种 */
const props = defineProps<{ value?: number | string | null; currency?: string }>()
const country = useCountryStore()
const { locale } = useI18n()
const text = computed(() => formatMoney(props.value, props.currency || country.currency, locale.value))
</script>

<template>
  <span class="mono">{{ text }}</span>
</template>
