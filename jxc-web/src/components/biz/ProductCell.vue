<script setup lang="ts">
defineProps<{ code?: string; name?: string; extra?: string }>()
</script>

<template>
  <div class="product-cell">
    <span class="mono">{{ code ?? '-' }}</span>
    <span class="name">{{ name }}</span>
    <div v-if="extra" class="muted">{{ extra }}</div>
  </div>
</template>

<style scoped>
.product-cell {
  line-height: 1.4;
  white-space: normal;
}

.name {
  margin-left: 6px;
}
</style>
