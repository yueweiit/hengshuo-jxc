import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import './support.mjs'

async function drafts() {
  const file = new URL('../src/modules/approval/opinion-draft.ts', import.meta.url)
  assert.ok(existsSync(file), '审批跳转应保留失败意见，不能在重开时清空')
  const api = await import(file)
  localStorage.setItem('jxc.token', 'draft-user')
  localStorage.setItem('jxc.countryId', '3')
  return api
}
test('意见按任务和动作保留，成功后清除，取消其他任务不会混用', async () => {
  const d = await drafts(), scope = d.opinionScope()
  d.saveOpinion(scope, 7, 'reject', '请补凭证')
  assert.equal(d.readOpinion(7, 'reject'), '请补凭证')
  assert.equal(d.readOpinion(7, 'approve'), '')
  assert.equal(d.readOpinion(8, 'reject'), '')
  d.removeOpinion(scope, 7)
  assert.equal(d.readOpinion(7, 'reject'), '')
})
test('切换国家或登录后不恢复旧意见，也不接受旧页面写回的意见', async () => {
  const d = await drafts(), scope = d.opinionScope()
  d.saveOpinion(scope, 7, 'approve', '已核对')
  localStorage.setItem('jxc.countryId', '4')
  assert.equal(d.readOpinion(7, 'approve'), '')
  d.saveOpinion(scope, 7, 'approve', '旧页面迟到')
  assert.equal(d.readOpinion(7, 'approve'), '')
  localStorage.setItem('jxc.token', 'another-session')
  assert.equal(d.readOpinion(7, 'approve'), '')
})
