import { reactive } from 'vue'
import type { FeeReviewInput, ImportDraftGroup, ImportHeader, ImportRow } from './purchaseImportModel'

interface Dependencies {
  state: { batchId: string | null; rows: ImportRow[]; groups: ImportDraftGroup[]; header: ImportHeader; edit: unknown; error: string; success: string }
  busy(): boolean; headerDirty(): boolean; canPrepare(): boolean
  saveHeader(): Promise<boolean>; previewDrafts(preserveHeader?: boolean): Promise<boolean>
  saveFeeTodos(group: ImportDraftGroup, items: FeeReviewInput[]): Promise<boolean>
  feedback(): void
  failure(error: unknown): void
}
interface Draft { items: FeeReviewInput[]; baseline: string; hash: string; version: number; stale: boolean }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const changed = (draft: Draft) => JSON.stringify(draft.items) !== draft.baseline
const editable = (group: ImportDraftGroup) => !group.orderId && !['CREATING', 'UNKNOWN'].includes(group.createStatus)

/** 基础信息和费用共用一个草稿；费用仍通过原分组核对接口保存。 */
export function createPurchaseImportFees(deps: Dependencies) {
  const view = reactive({ drafts: {} as Record<number, Draft>, saving: false, preparing: false })
  let scope: string | null = deps.state.batchId, generation = 0, preparedRows = ''
  const rowKey = () => JSON.stringify(deps.state.rows.map(row => [row.id, row.version, row.sourceOrderNo, row.groupId]))
  function reset() { ++generation; scope = deps.state.batchId; preparedRows = ''; view.drafts = {}; view.saving = false; view.preparing = false }
  function defaults(group: ImportDraftGroup): FeeReviewInput[] {
    return (group.feeTodos ?? []).map(todo => ({ sourceRowIds: [...todo.sourceRowIds], scope: todo.scope, amount: todo.amount,
      currency: todo.currency ?? group.header.currency ?? deps.state.header.currency, reason: todo.reason, confirm: todo.reviewStatus === 'CONFIRMED' }))
  }
  function sync() {
    if (scope !== deps.state.batchId) reset()
    for (const group of deps.state.groups) {
      const items = defaults(group), baseline = JSON.stringify(items), hash = group.sourceBasisHash ?? '', version = group.feeTodosVersion ?? 0
      const old = view.drafts[group.id]
      if (old && old.hash === hash && old.version === version && old.baseline === baseline) continue
      if (!old || !changed(old)) { view.drafts[group.id] = { items, baseline, hash, version, stale: false }; continue }
      if (old.hash !== hash || old.version !== version) {
        old.items.forEach(item => { item.confirm = false }); old.stale = true
        old.hash = hash; old.version = version; old.baseline = baseline
      }
    }
  }
  function entries() { sync(); return deps.state.groups.map(group => ({ group, ...view.drafts[group.id]! })) }
  function loaded() { sync(); preparedRows = rowKey() }
  function dirty() { sync(); return Object.values(view.drafts).some(changed) }
  function needsPreparation() {
    return !!deps.state.batchId && deps.state.rows.length > 0 && (preparedRows !== rowKey() || deps.state.rows.some(row => row.sourceOrderNo && (!row.groupId || !deps.state.groups.some(g => g.id === row.groupId))))
  }
  async function prepare() {
    if (!deps.canPrepare() || !deps.state.batchId || deps.busy() || deps.state.edit || view.preparing) return false
    const context = generation, batch = deps.state.batchId; view.preparing = true
    try { const ok = await deps.previewDrafts(true); if (context !== generation || batch !== deps.state.batchId) return false; if (ok) loaded(); return ok }
    finally { if (context === generation) view.preparing = false }
  }
  function issue(group: ImportDraftGroup, items: FeeReviewInput[], requireConfirmation = false) {
    for (const [index, item] of items.entries()) {
      const missing = [!item.sourceRowIds.length && '来源明细', item.scope === null && '费用归属', (item.amount === null || item.amount === '') && '费用金额', !item.currency && '费用币种', !item.reason.trim() && '核对说明'].filter(Boolean)
      if ((item.confirm || requireConfirmation) && missing.length) return `${group.sourceOrderNo} 第${index + 1}项费用：请填写${missing.join('、')}`
      if (requireConfirmation && !item.confirm) return `${group.sourceOrderNo} 第${index + 1}项费用：请在基础信息的“本次导入费用”中勾选确认`
    }
    return ''
  }
  function readyIssue() { for (const entry of entries()) { if (editable(entry.group)) { const message = issue(entry.group, entry.items, true); if (message) return message } } return '' }
  async function save() {
    if (view.saving || view.preparing || deps.busy() || deps.state.edit || !deps.state.batchId) return false
    deps.feedback()
    const current = entries(), pending = current.filter(entry => editable(entry.group) && changed(entry)).map(entry => ({ id: entry.group.id, items: copy(entry.items) }))
    const orphan = Object.entries(view.drafts).some(([id, draft]) => changed(draft) && !deps.state.groups.some(group => group.id === Number(id)))
    if (orphan) { deps.failure(new Error('费用来源分组已变化，填写内容已保留，请重新核对来源')); return false }
    for (const entry of current) { const message = issue(entry.group, entry.items); if (message) { deps.failure(new Error(message)); return false } }
    const context = generation, batch = deps.state.batchId, active = () => context === generation && batch === deps.state.batchId
    let headerSaved = false; view.saving = true
    try {
      if (deps.headerDirty()) { if (!await deps.saveHeader() || !active()) return false; headerSaved = true }
      if (deps.canPrepare() && needsPreparation() && (!await prepare() || !active())) return false
      // 同一次保存导致的表头/行版本变化来自本人的已确认输入；费用请求改用刚读回的来源hash。
      for (const saved of pending) {
        if (!active()) return false
        const group = deps.state.groups.find(group => group.id === saved.id), draft = view.drafts[saved.id]
        if (!group || !draft || !editable(group)) { deps.failure(new Error('费用来源已变化，填写内容已保留，请重新核对')); return false }
        draft.items = copy(saved.items)
        if (!await deps.saveFeeTodos(group, saved.items)) {
          const reason = deps.state.error
          draft.items = copy(saved.items)
          if (active()) deps.failure(new Error(`${headerSaved ? '基础信息已保存，但' : ''}${group.sourceOrderNo}费用保存失败：${reason}；填写内容已保留，请重试`))
          return false
        }
        if (!active()) return false
        delete view.drafts[saved.id]; sync()
      }
      const unconfirmed = deps.state.groups.some(group => editable(group) && group.feeTodos?.some(todo => todo.reviewStatus !== 'CONFIRMED'))
      deps.state.success = `基础信息${pending.length ? '与本次导入费用' : ''}已保存${unconfirmed ? '；本次导入费用仍待核对' : ''}`
      return true
    } finally { if (active()) view.saving = false }
  }
  function snapshot() { return { batchId: scope, drafts: copy(view.drafts) } }
  function restore(raw: unknown) {
    if (!raw || typeof raw !== 'object' || !('batchId' in raw) || raw.batchId !== deps.state.batchId || !('drafts' in raw) || !raw.drafts || typeof raw.drafts !== 'object' || Array.isArray(raw.drafts)) throw new Error('本地费用草稿格式或所属批次不正确')
    const validItems = (items: unknown): items is FeeReviewInput[] => Array.isArray(items) && items.every(item => item && typeof item === 'object' && Array.isArray(item.sourceRowIds) && item.sourceRowIds.every((id: unknown) => Number.isSafeInteger(id) && Number(id) > 0) && [null, 'ORDER', 'LINE'].includes(item.scope) && (item.amount === null || typeof item.amount === 'string') && (item.currency === null || typeof item.currency === 'string') && typeof item.reason === 'string' && typeof item.confirm === 'boolean')
    for (const [id, draft] of Object.entries(raw.drafts)) {
      if (!/^\d+$/.test(id) || !draft || typeof draft !== 'object' || !('items' in draft) || !validItems(draft.items) || !('baseline' in draft) || typeof draft.baseline !== 'string' || !validItems(JSON.parse(draft.baseline)) || !('hash' in draft) || typeof draft.hash !== 'string' || !('version' in draft) || !Number.isSafeInteger(draft.version) || !('stale' in draft) || typeof draft.stale !== 'boolean') throw new Error('本地费用草稿内容不完整，请保留数据后重试')
    }
    scope = deps.state.batchId; view.drafts = copy(raw.drafts) as Record<number, Draft>; sync()
  }
  return { view, entries, dirty, loaded, reset, needsPreparation, prepare, save, readyIssue, snapshot, restore, canPrepare: deps.canPrepare }
}
