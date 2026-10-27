import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import './support.mjs'
const feedback = await import('../src/api/error-feedback.ts')
const source = ts.transpileModule(readFileSync(new URL('../src/utils/action.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
function action(confirm) {
  const m = { exports: {} }
  new Function('require', 'module', 'exports', source)(name => name === '@/api/error-feedback' ? feedback : { ElMessageBox: { confirm }, ElMessage: { success() {} } }, m, m.exports)
  return m.exports.confirmAction
}
test.beforeEach(() => feedback.clearErrors())
test('取消确认是正常返回，确认组件异常必须报告并继续抛出', async () => {
  let runs = 0
  assert.equal(await action(async () => { throw 'cancel' })('确认', async () => runs++), false)
  assert.equal(runs, 0)
  assert.deepEqual(feedback.getErrors(), [])
  await assert.rejects(action(async () => { throw new Error('确认窗口加载失败') })('确认', async () => runs++), /确认窗口/)
  assert.equal(feedback.getErrors().length, 1)
  assert.equal(runs, 0)
})
test('确认后的本地校验失败也有全局提示，接口已报告的错误不会重复', async () => {
  const error = new Error('订单已关闭')
  await assert.rejects(action(async () => {})('确认', async () => { feedback.reportError(error); throw error }), /订单已关闭/)
  assert.equal(feedback.getErrors().length, 1)
})
