<script setup lang="ts">
import MoneyText from '@/components/MoneyText.vue'

// 审批必须保留原单币种；金额存在但币种未知时，不使用当前国家币种兜底。
defineProps<{ value?: number | null; currency: string | null }>()
</script>

<template>
  <MoneyText v-if="currency" :value="value" :currency="currency" />
  <span v-else>{{ value == null ? '—' : '币种未知' }}</span>
</template>
