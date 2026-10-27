import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { computed, ref, shallowRef, watch } from 'vue'
import './support.mjs'
import { loadVueScript } from './contracts/load-vue-script.mjs'
const feedback = await import('../src/api/error-feedback.ts')
const file = new URL('../src/components/GlobalErrorFeedback.vue', import.meta.url)
function host({ permissions = ['*'], field = 'WRITE' } = {}) {
  assert.ok(existsSync(file), '全局错误必须挂在应用级而非业务正文')
  const hooks = [], pushed = []
  const view = loadVueScript(file, { ...feedback, computed, ref, shallowRef, watch, onMounted: fn => fn(), onBeforeUnmount: fn => hooks.push(fn), useZIndex: () => ({ currentZIndex: ref(3100) }), useRouter: () => ({ push: async path => pushed.push(path) }), useUserStore: () => ({ hasPerm: p => !p || permissions.includes('*') || (Array.isArray(p) ? p : [p]).some(v => permissions.includes(v)), fieldAccess: () => field }), SESSION_CHANGE_EVENT: 'jxc:session-change' }, ['notices', 'presented', 'activate', 'zIndex', 'keyboardFocus', 'toggleKeyboardFocus'])
  return { ...view, pushed, dispose: () => hooks.forEach(fn => fn()) }
}
test.beforeEach(() => { localStorage.clear(); feedback.clearErrors() })
test('全局宿主位于body，常驻于业务弹层之上并提供手动关闭与明细', () => {
  const h = host()
  const source = readFileSync(file, 'utf8')
  assert.match(source, /Teleport to="body"/)
  assert.match(source, /position:\s*fixed/)
  assert.match(source, /dismissError/)
  assert.match(source, /查看明细/)
  assert.equal(h.zIndex.value, 3101)
  feedback.reportError(new Error('失败'))
  assert.equal(h.notices.value.length, 1)
  h.dispose()
})
test('明细和入口按当前权限遮罩，未知服务端地址不能操作', () => {
  const h = host({ permissions: [], field: 'HIDDEN' })
  feedback.reportError(new Error('失败'), { details: [{ label: '需确认', value: 2900, field: 'ORDER_TOTAL' }], actions: [{ label: '登记收款', to: '/ar/receipts', permission: 'ar:receipt:create' }] })
  assert.deepEqual(h.presented.value[0].details, [])
  assert.deepEqual(h.presented.value[0].actions, [])
  h.dispose()
})
test('点击入口才导航，导航前保存业务上下文，关闭提示不执行写操作', async () => {
  const h = host(), order = []
  const n = feedback.reportError(new Error('失败'), { actions: [{ label: '打开原单', to: '/sales/orders/7' }], beforeNavigate: async () => { order.push('saved') } })
  assert.deepEqual(order, [])
  await h.activate(n, n.actions[0])
  assert.deepEqual(order, ['saved'])
  assert.deepEqual(h.pushed, ['/sales/orders/7'])
  assert.deepEqual(feedback.getErrors(), [])
  h.dispose()
})
test('已切换身份的旧通知即使持有按钮对象也不能导航', async () => {
  const h = host()
  const n = feedback.reportError(new Error('失败'), { actions: [{ label: '旧原单', to: '/sales/orders/7' }] })
  localStorage.setItem('jxc.token', 'another-user')
  await h.activate(n, n.actions[0])
  assert.deepEqual(h.pushed, [])
  h.dispose()
})

test('F8切换全局提示和原表单的焦点范围，空提示不接管键盘', () => {
  const h = host(); let prevented = 0
  const key = { key: 'F8', preventDefault() { prevented++ } }
  h.toggleKeyboardFocus(key); assert.equal(prevented, 0)
  feedback.reportError(new Error('审批失败'))
  h.toggleKeyboardFocus(key); assert.equal(h.keyboardFocus.value, true)
  h.toggleKeyboardFocus(key); assert.equal(h.keyboardFocus.value, false)
  assert.equal(prevented, 2)
  assert.match(readFileSync(file, 'utf8'), /<FocusTrap[^>]*:trapped="keyboardFocus"/)
  h.dispose()
})
