<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const { t } = useI18n()
</script>

<template>
  <div class="page">
    <div class="page-card">
      <div class="page-title">
        <h2>{{ t(route.meta.title ?? '') }}</h2>
        <el-tag type="info">{{ t('placeholder.batch', { n: route.meta.batch }) }}</el-tag>
      </div>
      <el-alert :title="t('placeholder.hint')" type="info" :closable="false" show-icon />
      <el-descriptions :column="1" border class="desc">
        <el-descriptions-item :label="t('placeholder.doc')">
          <span class="mono">docs/{{ route.meta.doc }}</span>
        </el-descriptions-item>
        <el-descriptions-item :label="t('placeholder.planned')">
          <ul class="features">
            <li v-for="d in route.meta.desc" :key="d">{{ d }}</li>
          </ul>
        </el-descriptions-item>
        <el-descriptions-item label="权限码">
          <span class="mono">{{ route.meta.perm }}</span>
        </el-descriptions-item>
      </el-descriptions>
    </div>
  </div>
</template>

<style scoped>
.desc {
  margin-top: 16px;
}

.features {
  margin: 0;
  padding-left: 18px;
}
</style>
