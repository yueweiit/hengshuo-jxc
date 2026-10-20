<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <el-result icon="info" title="页面不存在" sub-title="链接可能已失效，或者这个页面不在一期范围内。" style="margin-top: 12vh">
    <template #extra>
      <el-button type="primary" @click="router.replace('/workbench')">返回工作台</el-button>
    </template>
  </el-result>
</template>
