<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import type { FormInstance } from 'element-plus'
import { useUserStore } from '@/stores/user'
import { LOCALES, setLocale } from '@/locales'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const user = useUserStore()
const isMock = import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true'

const form = reactive({ username: '', password: '' })
const formRef = ref<FormInstance>()
const loading = ref(false)

const demoAccounts = [
  { username: 'admin', password: 'admin123', desc: '平台管理员：全部权限，可新建国家' },
  { username: 'lead01', password: '123456', desc: '业务负责人：销售、授信、大额采购审批' },
  { username: 'buyer01', password: '123456', desc: '采购物流：采购单、国内收货、出口、运输批次' },
  { username: 'wh01', password: '123456', desc: '中心仓仓管：MX 实收、调拨、盘点，只看中心仓' },
  { username: 'finance01', password: '123456', desc: '财务：汇率确认、入库成本、物流费用' },
  { username: 'store01', password: '123456', desc: '门店员：只看一号店的数据' },
  { username: 'newbie', password: '123456', desc: '未授权账号：登录后看不到业务（A13）' },
]

function fill(a: { username: string; password: string }) {
  form.username = a.username
  form.password = a.password
}

async function submit() {
  await formRef.value?.validate()
  loading.value = true
  try {
    await user.login(form.username, form.password)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/workbench'
    await router.replace(redirect)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-box">
      <div class="brand">
        <h1>{{ t('app.title') }}</h1>
        <el-select :model-value="locale" size="small" style="width: 120px" @change="setLocale">
          <el-option v-for="l in LOCALES" :key="l.value" :label="l.label" :value="l.value" />
        </el-select>
      </div>
      <el-form ref="formRef" :model="form" label-position="top" @submit.prevent="submit">
        <el-form-item :label="t('login.username')" prop="username" :rules="[{ required: true, message: t('login.username') }]">
          <el-input v-model="form.username" autocomplete="username" size="large" />
        </el-form-item>
        <el-form-item :label="t('login.password')" prop="password" :rules="[{ required: true, message: t('login.password') }]">
          <el-input v-model="form.password" type="password" show-password autocomplete="current-password" size="large" />
        </el-form-item>
        <el-button type="primary" size="large" native-type="submit" :loading="loading" class="submit">
          {{ t('login.submit') }}
        </el-button>
      </el-form>

      <template v-if="isMock">
        <el-divider>{{ t('login.demoAccounts') }}</el-divider>
        <div class="demo-list">
          <div v-for="a in demoAccounts" :key="a.username" class="demo-item" @click="fill(a)">
            <span class="mono">{{ a.username }} / {{ a.password }}</span>
            <span class="muted">{{ a.desc }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1f3a5f 0%, #2f6f9f 100%);
  padding: 16px;
}

.login-box {
  width: 420px;
  max-width: 100%;
  background: #fff;
  border-radius: 8px;
  padding: 28px 28px 20px;
  box-shadow: 0 12px 32px rgb(0 0 0 / 20%);
}

.brand {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 16px;

  h1 {
    font-size: 18px;
    margin: 0;
  }
}

.submit {
  width: 100%;
}

.demo-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.demo-item {
  display: flex;
  flex-direction: column;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;

  &:hover {
    background: var(--el-fill-color-light);
  }
}
</style>
