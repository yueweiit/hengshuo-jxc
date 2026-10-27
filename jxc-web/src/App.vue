<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import es from 'element-plus/es/locale/lang/es'
import GlobalErrorFeedback from '@/components/GlobalErrorFeedback.vue'

const { locale } = useI18n()
const elLocale = computed(() => (locale.value === 'es-MX' ? es : zhCn))
</script>

<template>
  <el-config-provider :locale="elLocale">
    <router-view />
    <GlobalErrorFeedback />
  </el-config-provider>
</template>
