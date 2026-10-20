<script setup lang="ts">
import { reactive, ref } from 'vue'
import { http } from '@/api/http'

const form = reactive({ productId: null as number | null, question: '' })
const result = ref<Record<string, any> | null>(null)
async function ask() {
  result.value = await http.post('/ai/analysis', form)
}
</script>

<template>
  <el-card>
    <template #header>AI 盈亏解释</template>
    <p class="muted">只解释当前国家、当前权限能看到的数据。没有改价、改库存、下单的操作。</p>
    <el-form inline>
      <el-form-item label="商品"><el-input-number v-model="form.productId" /></el-form-item>
      <el-form-item label="问题"><el-input v-model="form.question" placeholder="为什么这个商品毛利低" style="width: 280px" /></el-form-item>
      <el-button type="primary" @click="ask">分析</el-button>
    </el-form>
    <el-alert v-if="result" type="info" :closable="false" :title="result.disclaimer" />
    <pre v-if="result" class="out">{{ result.output }}</pre>
  </el-card>
</template>

<style scoped>
.out { white-space: pre-wrap; background: #f6f8fa; padding: 12px; }
</style>
