<script setup lang="ts">
import { computed } from 'vue'
import { statusDef } from '@/utils/status'

const props = defineProps<{ status?: string | null; domain?: string }>()
const def = computed(() => statusDef(props.status, props.domain))
</script>

<template>
  <el-tag :type="def.type" size="small" disable-transitions>{{ def.label }}</el-tag>
</template>
