<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ElMessageBox } from 'element-plus'
import CountrySwitcher from '@/components/CountrySwitcher.vue'
import { useUserStore } from '@/stores/user'
import { useTodoStore } from '@/stores/todo'
import { LOCALES, setLocale } from '@/locales'

defineProps<{ isMobile: boolean }>()
defineEmits<{ 'toggle-menu': [] }>()

const route = useRoute()
const router = useRouter()
const { t, locale } = useI18n()
const user = useUserStore()
const todo = useTodoStore()
const isMock = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'

const title = computed(() => (route.meta.title ? t(route.meta.title) : ''))

async function onCommand(cmd: string) {
  if (cmd === 'logout') {
    await user.logout()
    router.replace('/login')
  } else if (isMock && cmd === 'resetMock') {
    await ElMessageBox.confirm('将清空本地演示数据并恢复初始数据，是否继续？', t('header.resetMock'), { type: 'warning' })
    const { resetDb } = await import('@/mock/db')
    resetDb()
    location.reload()
  } else if (cmd.startsWith('locale:')) {
    setLocale(cmd.slice(7))
  }
}
</script>

<template>
  <el-header class="header">
    <div class="left">
      <el-button v-if="isMobile" text @click="$emit('toggle-menu')">
        <el-icon :size="20"><Expand /></el-icon>
      </el-button>
      <span class="title">{{ title }}</span>
    </div>
    <div class="right">
      <CountrySwitcher />
      <el-badge :value="todo.total" :hidden="!todo.total" :max="99">
        <el-button text @click="router.push('/workbench')">
          <el-icon><Bell /></el-icon>
          <span v-if="!isMobile">{{ t('header.todo') }}</span>
        </el-button>
      </el-badge>
      <el-dropdown trigger="click" @command="onCommand">
        <el-button text>
          <el-icon><User /></el-icon>
          <span v-if="!isMobile">{{ user.user?.displayName }}</span>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="l in LOCALES"
              :key="l.value"
              :command="`locale:${l.value}`"
              :disabled="locale === l.value"
            >
              {{ l.label }}
            </el-dropdown-item>
            <el-dropdown-item v-if="isMock" divided command="resetMock">{{ t('header.resetMock') }}</el-dropdown-item>
            <el-dropdown-item divided command="logout">{{ t('header.logout') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </el-header>
</template>

<style scoped lang="scss">
.header {
  height: var(--app-header-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid var(--el-border-color-light);
  padding: 0 12px;
}

.left,
.right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
