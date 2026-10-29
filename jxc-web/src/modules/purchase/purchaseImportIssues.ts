import type { ImportDraftGroup } from './purchaseImportModel'

type Issue = ImportDraftGroup['errors'][number]

/** 只汇总展示；原错误和行标识完整保留，供用户展开与定位。 */
export function summarizeImportIssues(issues: Issue[]): { message: string; issues: Issue[] }[] {
  const groups = new Map<string, Issue[]>()
  for (const issue of issues) {
    const key = JSON.stringify([issue.field, issue.message, issue.rowId != null || issue.sourceRow != null])
    const group = groups.get(key)
    if (group) group.push(issue)
    else groups.set(key, [issue])
  }
  return [...groups.values()].map(group => {
    const rows = new Set(group.filter(issue => issue.rowId != null || issue.sourceRow != null).map(issue => issue.rowId != null ? `id:${issue.rowId}` : JSON.stringify([issue.sourceSheet, issue.sourceRow])))
    return { message: group[0]!.message + (rows.size ? `（${rows.size}行）` : ''), issues: group }
  })
}

export function formatImportIssues(issues: Issue[]): string {
  return summarizeImportIssues(issues).map(group => group.message).join('；')
}
