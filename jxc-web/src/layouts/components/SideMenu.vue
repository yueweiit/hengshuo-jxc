<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { menuGroups } from '@/router/routes'
import { useUserStore } from '@/stores/user'
import { useCountryStore } from '@/stores/country'

const route = useRoute()
const { t } = useI18n()
const user = useUserStore()
const country = useCountryStore()

const visibleGroups = computed(() =>
  menuGroups
    .filter((g) => country.isModuleEnabled(g.module))
    .map((g) => ({
      ...g,
      children: g.children.filter(
        (r) => !r.meta?.hidden && user.hasPerm(r.meta?.perm) && (country.current || r.path === '/workbench'),
      ),
    }))
    .filter((g) => g.children.length > 0),
)

const activePath = computed(() => {
  if (route.path.startsWith('/settings/countries')) return '/settings/countries'
  return route.meta.activeMenu ?? route.path
})
</script>

<template>
  <div class="side-menu">
    <div class="brand">
      <el-icon :size="20"><Shop /></el-icon>
      <span>{{ t('app.short') }}</span>
    </div>
    <el-scrollbar class="menu-scroll">
      <el-menu
        :default-active="activePath"
        router
        background-color="#1f2d3d"
        text-color="#bfcbd9"
        active-text-color="#409eff"
        :default-openeds="['workbench']"
      >
        <el-sub-menu v-for="g in visibleGroups" :key="g.key" :index="g.key">
          <template #title>
            <el-icon><component :is="g.icon" /></el-icon>
            <span>{{ t(g.title) }}</span>
          </template>
          <el-menu-item v-for="r in g.children" :key="r.path" :index="r.path">
            <span>{{ t(r.meta?.title ?? '') }}</span>
            <el-tag v-if="r.meta?.batch" size="small" type="info" effect="dark" class="batch-tag">
              {{ r.meta.batch }}
            </el-tag>
          </el-menu-item>
        </el-sub-menu>
      </el-menu>
    </el-scrollbar>
  </div>
</template>

<style scoped lang="scss">
.side-menu {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.brand {
  height: var(--app-header-height);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 20px;
  color: #fff;
  font-weight: 600;
  font-size: 16px;
  flex-shrink: 0;
}

.menu-scroll {
  flex: 1;
}

.el-menu {
  border-right: none;
}

.batch-tag {
  margin-left: auto;
  opacity: 0.6;
}
</style>
