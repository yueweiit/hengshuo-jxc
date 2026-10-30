import { getCountryId, getToken } from '@/utils/session'
import { describeFailure } from '@/api/error-guidance'

export interface ErrorAction {
  label: string
  to?: string
  intent?: string
  permission?: string | string[]
  fields?: Record<string, 'READ' | 'WRITE'>
  run?: () => void | Promise<void>
}
export interface ErrorDetail { label: string; value: string | number; currency?: string; field?: string; permission?: string }
export interface ErrorFeedbackOptions {
  title?: string
  nextStep?: string
  method?: string
  key?: string
  sourcePath?: string
  bookId?: number
  actions?: ErrorAction[]
  details?: ErrorDetail[]
  beforeNavigate?: (action: ErrorAction) => void | boolean | Promise<void | boolean>
}
export interface ErrorNotice {
  id: number
  code: string
  title: string
  message: string
  nextStep: string
  traceId?: string
  details: ErrorDetail[]
  actions: ErrorAction[]
  beforeNavigate?: ErrorFeedbackOptions['beforeNavigate']
}
type Stored = ErrorNotice & { scope: string; key?: string }
const notices: Stored[] = []
const listeners = new Set<(items: readonly ErrorNotice[]) => void>()
const contexts = new WeakMap<object, ErrorFeedbackOptions & { scope: string; id?: number }>()
let sequence = 0
function scope() { return typeof localStorage === 'undefined' ? '' : JSON.stringify([getToken(), getCountryId()]) }
function publish() { const visible = getErrors(); for (const listener of listeners) listener(visible) }
export function getErrors(): readonly ErrorNotice[] {
  const current = scope()
  for (let i = notices.length - 1; i >= 0; i--) if (notices[i]!.scope !== current) notices.splice(i, 1)
  return notices.map(({ scope: _scope, key: _key, ...item }) => item)
}
export function clearErrors() { notices.splice(0); publish() }
export function dismissError(id: number) { const index = notices.findIndex(n => n.id === id); if (index >= 0) { notices.splice(index, 1); publish() } }
export function isCurrentError(id: number) { return getErrors().some(n => n.id === id) }
export function subscribeErrors(listener: (items: readonly ErrorNotice[]) => void) {
  listeners.add(listener); listener(getErrors())
  return () => { listeners.delete(listener) }
}
export function rememberFailureContext(error: object, options: ErrorFeedbackOptions) { contexts.set(error, { ...options, scope: scope() }) }
export function isCancelledFailure(error: unknown) {
  if (error === 'cancel' || error === 'close') return true
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: string; name?: string }
  return ['ERR_CANCELED', 'CONTEXT_CHANGED'].includes(e.code ?? '') || e.name === 'AbortError'
}
export function reportError(error: unknown, options: ErrorFeedbackOptions = {}): ErrorNotice | undefined {
  if (isCancelledFailure(error)) return
  const object = error !== null && typeof error === 'object' ? error : undefined
  const remembered = object ? contexts.get(object) : undefined
  const current = scope()
  if (remembered && remembered.scope !== current) return
  const context = { ...remembered, ...options }
  getErrors()
  const existing = remembered?.id ? notices.find(n => n.id === remembered.id) : context.key ? notices.find(n => n.key === context.key && n.scope === current) : undefined
  if (remembered?.id && !existing) return // A closed event stays closed; a fresh request has a fresh error.
  const described = describeFailure(error, context)
  const item: Stored = { ...described, id: existing?.id ?? ++sequence, scope: current, key: context.key, beforeNavigate: context.beforeNavigate }
  if (existing) Object.assign(existing, item)
  else notices.push(item)
  if (object) contexts.set(object, { ...context, scope: current, id: item.id })
  publish()
  return getErrors().find(n => n.id === item.id)
}
/** Call inside the page's current-request guard. The returned text remains state, not a second presenter. */
export function feedbackMessage(error: unknown, fallback = '操作未完成，请重试') {
  const message = error instanceof Error && error.message.trim() ? error.message : typeof error === 'string' && error.trim() ? error : fallback
  reportError(error, fallback === '操作未完成，请重试' ? {} : { title: fallback })
  return message
}

export function visibleActions(notice: ErrorNotice, hasPerm: (permission?: string | string[]) => boolean, fieldAccess: (field: string) => string) {
  return notice.actions.filter(action => hasPerm(action.permission) && Object.entries(action.fields ?? {}).every(([field, level]) => level === 'WRITE' ? fieldAccess(field) === 'WRITE' : fieldAccess(field) !== 'HIDDEN'))
}
export function visibleDetails(notice: ErrorNotice, fieldAccess: (field: string) => string, hasPerm: (permission?: string | string[]) => boolean = () => true) {
  return notice.details.filter(row => (!row.field || fieldAccess(row.field) !== 'HIDDEN') && hasPerm(row.permission))
}
