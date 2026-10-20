<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'

const route = useRoute()
const router = useRouter()
</script>

<template>
  <div class="page">
    <div class="page-card">
      <el-result icon="warning" title="没有访问权限" :sub-title="`你在当前国家没有访问 ${route.query.from ?? '该页面'} 的权限，请联系国家管理员授权。`">
        <template #extra>
          <el-button type="primary" @click="router.replace('/workbench')">返回工作台</el-button>
        </template>
      </el-result>
    </div>
  </div>
</template>
