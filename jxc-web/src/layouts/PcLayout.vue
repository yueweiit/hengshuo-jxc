<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import SideMenu from './components/SideMenu.vue'
import HeaderBar from './components/HeaderBar.vue'
import { useCountryStore } from '@/stores/country'
import { useTodoStore } from '@/stores/todo'

const route = useRoute()
const country = useCountryStore()
const todo = useTodoStore()

const isMobile = ref(false)
const drawerOpen = ref(false)

function onResize() {
  isMobile.value = window.innerWidth <= 768
}

onMounted(() => {
  onResize()
  window.addEventListener('resize', onResize)
  todo.refresh()
})
onBeforeUnmount(() => window.removeEventListener('resize', onResize))

watch(() => route.fullPath, () => (drawerOpen.value = false))
</script>

<template>
  <el-container class="layout">
    <el-aside v-if="!isMobile" class="layout-aside">
      <SideMenu />
    </el-aside>
    <el-drawer v-else v-model="drawerOpen" direction="ltr" size="240px" :with-header="false" class="layout-drawer">
      <SideMenu />
    </el-drawer>

    <el-container direction="vertical">
      <HeaderBar :is-mobile="isMobile" @toggle-menu="drawerOpen = !drawerOpen" />
      <el-main class="layout-main">
        <router-view v-slot="{ Component }">
          <component :is="Component" v-if="!country.switching" :key="`${country.epoch}:${route.fullPath}`" />
          <el-empty v-else description="正在读取目标国家的权限与配置…" />
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped lang="scss">
.layout {
  height: 100%;
}

.layout-aside {
  width: var(--app-aside-width);
  background: #1f2d3d;
  overflow: hidden;
}

.layout-main {
  padding: 0;
  overflow-y: auto;
}

:deep(.layout-drawer .el-drawer__body) {
  padding: 0;
  background: #1f2d3d;
}
</style>
