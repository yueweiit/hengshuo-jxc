import { getCountryId, getToken } from '@/utils/session'

// 仅在本次页面会话内保留失败审批意见；刷新网页不恢复，不落盘保存敏感意见。
const drafts = new Map<string, string>()
let owner = ''
export function opinionScope() {
  const current = typeof localStorage === 'undefined' ? '' : JSON.stringify([getToken(), getCountryId()])
  if (owner !== current) { drafts.clear(); owner = current }
  return current
}
export function saveOpinion(scope: string, taskId: number, type: string, comment: string) {
  if (opinionScope() === scope) drafts.set(`${taskId}:${type}`, comment)
}
export function readOpinion(taskId: number, type: string) {
  opinionScope()
  return drafts.get(`${taskId}:${type}`) ?? '' // 尚无草稿就是未填写意见。
}
export function removeOpinion(scope: string, taskId: number) {
  if (opinionScope() !== scope) return
  for (const type of ['approve', 'reject']) drafts.delete(`${taskId}:${type}`)
}
