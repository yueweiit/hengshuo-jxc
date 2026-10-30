<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useZIndex } from 'element-plus'
import FocusTrap from 'element-plus/es/components/focus-trap/index'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { SESSION_CHANGE_EVENT } from '@/utils/session'
import { clearErrors, dismissError, isCurrentError, reportError, subscribeErrors, visibleActions, visibleDetails, type ErrorAction, type ErrorNotice } from '@/api/error-feedback'
import MoneyText from '@/components/MoneyText.vue'

const router = useRouter(), user = useUserStore()
const notices = shallowRef<readonly ErrorNotice[]>([])
const copied = ref<number>()
const feedbackElement = ref<HTMLElement>()
const keyboardFocus = ref(false)
const { currentZIndex } = useZIndex()
const zIndex = computed(() => currentZIndex.value + 1)
const presented = computed(() => notices.value.map(item => ({ ...item,
  details: visibleDetails(item, user.fieldAccess, user.hasPerm),
  actions: visibleActions(item, user.hasPerm, user.fieldAccess),
})))
let unsubscribe = () => {}
function toggleKeyboardFocus(event: KeyboardEvent) {
  if (event.key !== 'F8' || !notices.value.length || event.altKey || event.ctrlKey || event.metaKey) return
  event.preventDefault()
  keyboardFocus.value = !keyboardFocus.value
}
function pointerOutside(event: PointerEvent) {
  if (feedbackElement.value && !feedbackElement.value.contains(event.target as Node)) keyboardFocus.value = false
}
watch(() => notices.value.length, count => { if (!count) keyboardFocus.value = false })
function storageChanged(event: StorageEvent) { if (!event.key || ['jxc.token', 'jxc.countryId'].includes(event.key)) clearErrors() }
onMounted(() => {
  unsubscribe = subscribeErrors(items => { notices.value = items })
  if (typeof window !== 'undefined') {
    window.addEventListener(SESSION_CHANGE_EVENT, clearErrors)
    window.addEventListener('storage', storageChanged)
    window.addEventListener('keydown', toggleKeyboardFocus)
    window.addEventListener('pointerdown', pointerOutside, true)
  }
})
onBeforeUnmount(() => {
  unsubscribe()
  if (typeof window !== 'undefined') {
    window.removeEventListener(SESSION_CHANGE_EVENT, clearErrors)
    window.removeEventListener('storage', storageChanged)
    window.removeEventListener('keydown', toggleKeyboardFocus)
    window.removeEventListener('pointerdown', pointerOutside, true)
  }
})
async function activate(notice: ErrorNotice, action: ErrorAction) {
  if (!isCurrentError(notice.id) || !visibleActions(notice, user.hasPerm, user.fieldAccess).includes(action)) return
  try {
    const handled = await notice.beforeNavigate?.(action)
    if (!isCurrentError(notice.id) || !visibleActions(notice, user.hasPerm, user.fieldAccess).includes(action)) return
    if (handled !== false) {
      if (action.run) await action.run()
      else if (action.to) await router.push(action.to)
    }
    dismissError(notice.id)
  } catch (error) { reportError(error, { title: '处理入口未能打开', nextStep: '原业务表单仍保留。请核对当前账号和页面状态后重试。' }) }
}
async function copyProblem(notice: ErrorNotice) {
  if (!isCurrentError(notice.id)) return
  const visible = presented.value.find(item => item.id === notice.id)
  if (!visible) return
  const text = [visible.title, visible.message, ...visible.details.map(row => `${row.label}：${row.currency ? row.currency + ' ' : ''}${row.value}`), visible.nextStep, `错误编号：${visible.code}`, ...(visible.traceId ? [`追踪号：${visible.traceId}`] : [])].join('\n')
  try { await navigator.clipboard.writeText(text); copied.value = notice.id }
  catch (error) { reportError(error, { title: '问题信息未能复制', nextStep: '请手动复制通知中的错误编号和追踪号交给管理员核查。' }) }
}
</script>

<template>
  <Teleport to="body">
    <FocusTrap v-if="presented.length" :trapped="keyboardFocus" :focus-trap-el="feedbackElement" focus-start-el="first" loop>
    <aside ref="feedbackElement" class="global-error-feedback" :style="{ zIndex }" aria-label="全局错误提示" tabindex="-1" @pointerdown.capture="keyboardFocus = true">
      <span class="keyboard-hint">按 F8 切换提示与原页面</span>
      <section v-for="notice in presented" :key="notice.id" class="global-error-notice" role="alert" @keydown.esc.stop="dismissError(notice.id)">
        <header><strong>{{ notice.title }}</strong><el-button link aria-label="关闭这条错误提示" @click="dismissError(notice.id)"><el-icon><Close /></el-icon></el-button></header>
        <p class="failure-reason">{{ notice.message }}</p>
        <details v-if="notice.details.length" open>
          <summary>查看明细</summary>
          <dl><div v-for="(row, index) in notice.details" :key="index"><dt>{{ row.label }}</dt><dd><span v-if="row.currency && Number(row.value) !== 0 && Math.abs(Number(row.value)) < 0.01">{{ row.currency }} {{ Number(row.value).toFixed(4) }}</span><MoneyText v-else-if="row.currency" :value="row.value" :currency="row.currency" /><span v-else>{{ row.value }}</span></dd></div></dl>
        </details>
        <p class="next-step">{{ notice.nextStep }}</p>
        <div v-if="notice.actions.length" class="feedback-actions"><el-button v-for="(action, index) in notice.actions" :key="action.label" :type="index === 0 ? 'primary' : 'default'" size="small" @click="activate(notice, action)">{{ action.label }}</el-button></div>
        <details class="problem-info"><summary>问题信息</summary><p>错误编号：{{ notice.code }}</p><p v-if="notice.traceId">追踪号：{{ notice.traceId }}</p><el-button link type="primary" @click="copyProblem(notice)">{{ copied === notice.id ? '已复制' : '复制问题信息' }}</el-button></details>
      </section>
    </aside>
    </FocusTrap>
  </Teleport>
</template>

<style scoped>
.global-error-feedback { position: fixed; top: 16px; right: 16px; width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto; display: grid; gap: 12px; }
.global-error-notice { background: var(--el-bg-color-overlay); border: 1px solid var(--el-border-color-light); border-left: 4px solid var(--el-color-danger); border-radius: var(--el-border-radius-base); box-shadow: var(--el-box-shadow-light); padding: 16px; font-size: 14px; overflow-wrap: anywhere; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
header strong { line-height: 1.5; color: var(--el-color-danger); }
p { margin: 10px 0; line-height: 1.65; }
summary { cursor: pointer; font-size: 13px; color: var(--el-text-color-secondary); }
dl { margin: 8px 0; } dl > div { padding: 6px 0; border-bottom: 1px solid var(--el-border-color-lighter); }
dt { color: var(--el-text-color-secondary); font-size: 13px; } dd { margin: 4px 0 0; font-variant-numeric: tabular-nums; }
.feedback-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; } .feedback-actions :deep(.el-button) { margin-left: 0; }
.problem-info { margin-top: 12px; } .problem-info p { font-size: 12px; margin: 4px 0; }
.keyboard-hint { justify-self: end; padding: 2px 6px; background: var(--el-bg-color-overlay); color: var(--el-text-color-secondary); font-size: 12px; border-radius: 4px; }
</style>
