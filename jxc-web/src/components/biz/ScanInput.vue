<script setup lang="ts">
import { nextTick, ref } from 'vue'

/** 扫码枪按回车结束；也可以手工输入编码或条码 */
const emit = defineEmits<{ scan: [code: string] }>()
defineProps<{ placeholder?: string }>()
const code = ref('')
const input = ref<{ focus: () => void }>()

function submit() {
  const v = code.value.trim()
  if (!v) return
  emit('scan', v)
  code.value = ''
  nextTick(() => input.value?.focus())
}

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <el-input ref="input" v-model="code" :placeholder="placeholder ?? '扫码或输入商品编码 / 条码后回车'" clearable @keyup.enter="submit">
    <template #prefix><el-icon><Aim /></el-icon></template>
    <template #append><el-button @click="submit">定位</el-button></template>
  </el-input>
</template>
