<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ArrowDown, Box, Lock, Right, User } from '@element-plus/icons-vue'
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
const ripple = ref<{ x: number; y: number; id: number }>()

function animateSubmit(event: MouseEvent) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  ripple.value = {
    x: event.detail ? event.clientX - bounds.left : bounds.width / 2,
    y: event.detail ? event.clientY - bounds.top : bounds.height / 2,
    id: (ripple.value?.id ?? 0) + 1,
  }
}

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
  <div class="login-shell">
    <div class="scene" aria-hidden="true"><div class="scene-grid" /></div>
    <div class="page-tools">
      <div class="locale-control">
        <select
          id="login-language"
          class="language"
          aria-label="语言 / Idioma"
          :value="locale"
          @change="setLocale(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="l in LOCALES" :key="l.value" :value="l.value">{{ l.label }}</option>
        </select>
        <el-icon class="select-chevron" aria-hidden="true"><ArrowDown /></el-icon>
      </div>
    </div>
    <main class="login-page">
      <section class="login-box" aria-labelledby="login-title">
        <header class="brand">
          <div class="brand-mark" aria-hidden="true"><Box /></div>
          <div class="brand-copy">
            <h1 id="login-title">{{ t('app.short') }}</h1>
            <p class="subtitle">{{ t('app.title') }}</p>
          </div>
        </header>
        <el-form ref="formRef" :model="form" class="login-form" @submit.prevent="submit">
          <el-form-item prop="username" :rules="[{ required: true, message: t('login.username') }]">
            <div class="field" :class="{ 'has-value': form.username.length > 0 }">
              <el-input id="account" v-model="form.username" placeholder=" " autocomplete="username" size="large" aria-required="true">
                <template #prefix><el-icon class="field-icon"><User /></el-icon></template>
              </el-input>
              <label for="account" class="field-label">{{ t('login.username') }}</label>
            </div>
          </el-form-item>
          <el-form-item prop="password" :rules="[{ required: true, message: t('login.password') }]">
            <div class="field" :class="{ 'has-value': form.password.length > 0 }">
              <el-input id="password" v-model="form.password" type="password" placeholder=" " show-password autocomplete="current-password" size="large" aria-required="true">
                <template #prefix><el-icon class="field-icon"><Lock /></el-icon></template>
              </el-input>
              <label for="password" class="field-label">{{ t('login.password') }}</label>
            </div>
          </el-form-item>
          <el-button type="primary" size="large" native-type="submit" :loading="loading" class="submit" @click="animateSubmit">
            <span class="submit-label">{{ t('login.submit') }}</span>
            <el-icon v-if="!loading" class="submit-icon" aria-hidden="true"><Right /></el-icon>
            <i v-if="ripple" :key="ripple.id" class="ripple" :style="{ left: `${ripple.x}px`, top: `${ripple.y}px` }" aria-hidden="true" @animationend="ripple = undefined" />
          </el-button>
        </el-form>

        <template v-if="isMock">
          <el-divider>{{ t('login.demoAccounts') }}</el-divider>
          <div class="demo-list">
            <button v-for="a in demoAccounts" :key="a.username" type="button" class="demo-item" @click="fill(a)">
              <span class="mono">{{ a.username }} / {{ a.password }}</span>
              <span class="muted">{{ a.desc }}</span>
            </button>
          </div>
        </template>
      </section>
    </main>
  </div>
</template>

<style scoped lang="scss">
.login-shell {
  --login-blue: #409eff;
  --login-blue-deep: #2675c5;
  --login-ink: #25364b;
  --login-line: #dce5ef;
  position: relative;
  min-height: 100vh;
  min-height: 100svh;
  color: var(--login-ink);
  background: #1f3a5f;
  font-family: 'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif;
  letter-spacing: 0;
}

.scene {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  background: linear-gradient(135deg, #1f3a5f 0%, #2f6f9f 100%);
}

.scene-grid {
  position: absolute;
  inset: -55%;
  background-image: linear-gradient(rgb(255 255 255 / 4%) 1px, transparent 1px),
    linear-gradient(90deg, rgb(255 255 255 / 4%) 1px, transparent 1px);
  background-size: 88px 88px;
  mask-image: linear-gradient(90deg, transparent 8%, #000 40%, #000 72%, transparent 92%);
  animation: grid-drift 32s ease-in-out infinite alternate;
}

.scene::after {
  content: '';
  position: absolute;
  inset: -65%;
  background: linear-gradient(118deg, transparent 43%, rgb(255 255 255 / 3%) 48%, rgb(255 255 255 / 6%) 50%, transparent 55%);
  animation: light-drift 24s ease-in-out infinite alternate;
}

.page-tools { position: absolute; z-index: 2; top: 28px; right: 36px; }
.locale-control { position: relative; }
.language {
  appearance: none;
  width: 166px;
  height: 36px;
  padding: 0 32px 0 13px;
  color: #e8f1fa;
  background: rgb(255 255 255 / 6%);
  border: 1px solid rgb(255 255 255 / 20%);
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 180ms, background 180ms, box-shadow 180ms;
}
.language option { color: var(--login-ink); background: #fff; }
.language:hover { background: rgb(255 255 255 / 10%); border-color: rgb(255 255 255 / 40%); }
.language:focus-visible { outline: none; box-shadow: 0 0 0 3px rgb(255 255 255 / 12%); }
.select-chevron {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 12px;
  height: 12px;
  color: #d4e4f3;
  pointer-events: none;
}

.login-page {
  min-height: 100vh;
  min-height: 100svh;
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  place-items: center;
  padding: 112px 24px 80px;
}

.login-box {
  position: relative;
  width: 464px;
  max-width: 100%;
  background: #fff;
  border: 1px solid #edf3fa;
  border-radius: 8px;
  padding: 42px 38px 38px;
  box-shadow: 0 28px 72px rgb(9 29 54 / 25%), 0 4px 14px rgb(9 29 54 / 8%);
  animation: panel-enter 650ms cubic-bezier(.2, .75, .25, 1) both;
}

.login-box::before {
  content: '';
  position: absolute;
  top: -1px;
  left: 28px;
  right: 28px;
  height: 1px;
  background: linear-gradient(90deg, transparent, #9acbff, transparent);
}

.brand {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 38px;
  animation: content-enter 500ms 100ms both;
}
.brand-mark {
  display: grid;
  place-items: center;
  flex: 0 0 48px;
  width: 48px;
  height: 48px;
  color: var(--login-blue-deep);
  background: linear-gradient(145deg, #f1f7ff, #e7f1fc);
  border: 1px solid #dfebf8;
  border-radius: 6px;
  box-shadow: inset 0 1px 0 #fff;
}
.brand-mark :deep(svg) { width: 25px; height: 25px; }
.brand-copy { min-width: 0; }
.brand h1 { margin: 0; font-size: 24px; line-height: 1.4; font-weight: 700; overflow-wrap: anywhere; }
.subtitle { margin: 7px 0 0; font-size: 12px; line-height: 1.7; color: #76869b; overflow-wrap: anywhere; }

.login-form :deep(.el-form-item) { margin-bottom: 26px; }
.login-form :deep(.el-form-item__content) { display: block; min-width: 0; line-height: normal; }
.field { position: relative; height: 56px; min-width: 0; }
.login-form :deep(.el-form-item:nth-child(1)) { animation: content-enter 500ms 170ms both; }
.login-form :deep(.el-form-item:nth-child(2)) { animation: content-enter 500ms 240ms both; }
.field :deep(.el-input) { height: 100%; font-family: inherit; font-size: 15px; }
.field :deep(.el-input__wrapper) {
  padding: 0 16px;
  background: #f8fafd;
  border-radius: 6px;
  box-shadow: 0 0 0 1px var(--login-line) inset;
  transition: box-shadow 240ms, background 240ms;
}
.field :deep(.el-input__wrapper:hover) { box-shadow: 0 0 0 1px #b8cce1 inset; }
.field.has-value :deep(.el-input__wrapper) { background: #fff; }
.field :deep(.el-input__wrapper.is-focus) {
  background: #fff;
  box-shadow: 0 0 0 1px var(--login-blue) inset, 0 0 0 3px rgb(64 158 255 / 8%), 0 3px 10px rgb(64 158 255 / 4%);
}
.field :deep(.el-input__inner) { height: 54px; color: var(--login-ink); caret-color: var(--login-blue); }
.field :deep(.el-input__prefix) { margin-right: 12px; }
.field :deep(.el-input__prefix-inner > .el-icon) { margin-right: 0; }
.field-icon { width: 18px; height: 18px; color: #99aabd; transition: color 240ms, transform 240ms; }
.field:focus-within .field-icon { color: var(--login-blue-deep); transform: scale(1.04); }
.field-label {
  position: absolute;
  top: 50%;
  left: 41px;
  z-index: 1;
  max-width: calc(100% - 60px);
  padding: 0 6px;
  color: #7a8ba0;
  background: transparent;
  font-size: 15px;
  line-height: 20px;
  transform: translateY(-50%);
  transform-origin: left center;
  pointer-events: none;
  transition: top 240ms cubic-bezier(.2, .75, .25, 1), left 240ms cubic-bezier(.2, .75, .25, 1),
    transform 240ms cubic-bezier(.2, .75, .25, 1), color 200ms, background 200ms;
}
.field:focus-within .field-label,
.field.has-value .field-label,
.field:has(input:not(:placeholder-shown)) .field-label {
  top: 0;
  left: 12px;
  background: #fff;
  transform: translateY(-50%) scale(.82);
}
.field:focus-within .field-label { color: var(--login-blue-deep); }
.login-form :deep(.el-form-item.is-error .el-input__wrapper) { box-shadow: 0 0 0 1px var(--el-color-danger) inset; }
.el-form-item.is-error .field-label { color: var(--el-color-danger); }
.login-form :deep(.el-form-item__error) { padding-top: 5px; line-height: 16px; }

.submit.el-button {
  position: relative;
  isolation: isolate;
  width: 100%;
  height: 50px;
  overflow: hidden;
  padding: 0 48px;
  color: #fff;
  background: linear-gradient(110deg, #307ed3, #226ab9);
  border: 1px solid transparent;
  border-radius: 6px;
  box-shadow: 0 4px 10px rgb(38 117 197 / 15%), inset 0 1px 0 rgb(255 255 255 / 12%);
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  transition: transform 200ms, box-shadow 200ms, filter 200ms;
  animation: content-enter 500ms 310ms backwards;
}
.submit.el-button:not(.is-loading):hover {
  filter: brightness(1.06);
  transform: translateY(-1px);
  box-shadow: 0 7px 18px rgb(38 117 197 / 25%), inset 0 1px 0 rgb(255 255 255 / 18%);
}
.submit.el-button:not(.is-loading):active { transform: translateY(0) scale(.99); box-shadow: 0 2px 5px rgb(38 117 197 / 15%); }
.submit:focus-visible { outline: 2px solid var(--login-blue); outline-offset: 4px; }
.submit-label { position: relative; z-index: 1; }
.submit::before {
  content: '';
  position: absolute;
  inset: -35% auto -35% 0;
  width: 55%;
  background: linear-gradient(110deg, transparent, rgb(255 255 255 / 17%), transparent);
  transform: translateX(-160%) skewX(-18deg);
  transition: transform 650ms ease;
  pointer-events: none;
}
.submit:not(.is-loading):hover::before { transform: translateX(290%) skewX(-18deg); }
.submit-icon { position: absolute; z-index: 1; top: 15px; right: 22px; width: 18px; height: 18px; opacity: .8; transition: transform 240ms, opacity 240ms; }
.submit:hover .submit-icon { transform: translateX(4px); opacity: 1; }
.ripple {
  position: absolute;
  width: 28px;
  height: 28px;
  margin: -14px 0 0 -14px;
  border-radius: 50%;
  background: rgb(255 255 255 / 28%);
  pointer-events: none;
  animation: ripple-out 600ms ease-out forwards;
}

@keyframes grid-drift {
  from { transform: translate(-24px, -16px) rotate(-18deg); }
  to { transform: translate(24px, 16px) rotate(-18deg); }
}
@keyframes light-drift {
  from { transform: translateX(-4%); }
  to { transform: translateX(4%); }
}
@keyframes panel-enter {
  from { opacity: 0; transform: translateY(18px) scale(.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes content-enter {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes ripple-out {
  from { opacity: 1; transform: scale(0); }
  to { opacity: 0; transform: scale(32); }
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
  width: 100%;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 4px;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  text-align: left;

  &:hover {
    background: var(--el-fill-color-light);
  }
}

@media (max-width: 520px) {
  .page-tools { top: 24px; right: 20px; }
  .language { width: 160px; }
  .login-page { padding: 96px 16px 72px; }
  .login-box { padding: 32px 24px 30px; }
  .brand { gap: 12px; margin-bottom: 32px; }
  .brand-mark { flex-basis: 44px; width: 44px; height: 44px; }
}
@media (max-width: 360px) {
  .login-box { padding-right: 22px; padding-left: 22px; }
  .brand { gap: 10px; }
  .brand h1 { font-size: 22px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  .field :deep(.el-input__wrapper) { transition: none !important; }
  .submit.el-button:not(.is-loading):hover, .submit.el-button:not(.is-loading):active { transform: none; }
  .submit::before, .ripple { display: none; }
}
</style>
