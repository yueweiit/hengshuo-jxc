<script setup lang="ts">
import { useRouter } from 'vue-router'
import type { MissingItem } from '@/api/types'

defineProps<{ items: MissingItem[] }>()
const router = useRouter()
</script>

<template>
  <el-result v-if="!items.length" icon="success" title="没有缺项" sub-title="必填配置已齐全" />
  <div v-else class="missing">
    <div v-for="m in items" :key="m.key" class="row">
      <el-tag :type="m.level === 'BLOCK' ? 'danger' : 'warning'" size="small">{{ m.level === 'BLOCK' ? '阻断' : '提示' }}</el-tag>
      <span class="label">{{ m.label }}</span>
      <el-link v-if="m.link" type="primary" @click="router.push(m.link)">去处理</el-link>
    </div>
  </div>
</template>

<style scoped>
.missing {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.label {
  flex: 1;
}
</style>
