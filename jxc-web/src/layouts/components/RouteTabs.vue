<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessage, type TabPaneName } from 'element-plus'
import { useCountryStore } from '@/stores/country'

interface TabItem {
  key: string
  fullPath: string
  title: string
  closable: boolean
}

const route = useRoute()
const router = useRouter()
const country = useCountryStore()
const { t } = useI18n()
const home: TabItem = { key: '/workbench', fullPath: '/workbench', title: 'menu.workbench', closable: false }
const items = ref<TabItem[]>([home])
const activeKey = computed(() => country.switching ? home.key : route.path)
let countryEpoch = country.epoch

watch([() => route.fullPath, () => country.epoch, () => country.switching], () => {
  if (country.switching || countryEpoch !== country.epoch) {
    items.value = [home]
    countryEpoch = country.epoch
  }
  if (country.switching) return

  const current: TabItem = {
    key: route.path,
    fullPath: route.fullPath,
    // 未配置页面标题的路由使用地址作为标签，仍可识别和关闭。
    title: route.meta.title ?? route.path,
    closable: route.path !== home.key,
  }
  const index = items.value.findIndex(item => item.key === current.key)
  if (index < 0) items.value.push(current)
  else items.value[index] = current
}, { immediate: true, flush: 'sync' })

async function activateTab(name: TabPaneName): Promise<boolean> {
  // 路由从菜单、返回键或守卫变化时，让标签跟随实际地址。
  if (name === activeKey.value) return true
  if (country.switching) return false
  const target = items.value.find(item => item.key === name)
  if (!target) return false

  try {
    await router.push(target.fullPath)
    return route.fullPath === target.fullPath
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error))
    return false
  }
}

async function removeTab(name: TabPaneName): Promise<void> {
  if (country.switching) return
  const index = items.value.findIndex(item => item.key === name)
  const target = items.value[index]
  if (!target?.closable) return

  if (name === route.path) {
    const epoch = country.epoch
    const neighbor = items.value[index - 1] ?? items.value[index + 1] ?? home
    const navigated = await activateTab(neighbor.key)
    // 取消、重定向或国家切换都不能把当前页面或新国家的标签删掉。
    if (!navigated || country.switching || epoch !== country.epoch || route.path === name) return
  }
  items.value = items.value.filter(item => item.key !== name)
}
</script>

<template>
  <el-tabs
    class="route-tabs"
    type="card"
    :model-value="activeKey"
    :before-leave="activateTab"
    @tab-remove="removeTab"
  >
    <el-tab-pane
      v-for="item in items"
      :key="item.key"
      :name="item.key"
      :label="t(item.title)"
      :closable="item.closable"
      :disabled="country.switching"
    >
      <slot v-if="item.key === activeKey" />
    </el-tab-pane>
  </el-tabs>
</template>

<style scoped lang="scss">
.route-tabs {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.route-tabs > :deep(.el-tabs__header) {
  flex-shrink: 0;
  margin: 0;
  padding: 8px 12px 0;
  background: var(--el-bg-color);
}

.route-tabs > :deep(.el-tabs__header .el-tabs__item) {
  height: 36px;
  font-size: 13px;
}

.route-tabs > :deep(.el-tabs__header .el-tabs__item.is-active) {
  background: var(--app-bg);
}

.route-tabs > :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
}

.route-tabs > :deep(.el-tabs__content > .el-tab-pane) {
  height: 100%;
}

@media (max-width: 768px) {
  .route-tabs > :deep(.el-tabs__header) {
    padding: 4px 8px 0;
  }
}
</style>
