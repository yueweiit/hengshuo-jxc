import { readFileSync } from 'node:fs'
import ts from 'typescript'

export function loadPagination(get, session = { token: 'page-user', countryId: 101 }) {
  const source = readFileSync(new URL('../../src/api/pagination.ts', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } }).outputText
  const deps = { http: { get }, getToken: () => session.token, getCountryId: () => session.countryId, BizError: class BizError extends Error { constructor(code, message) { super(message); this.code = code } } }
  return new Function('deps', `const {http,getToken,getCountryId,BizError}=deps; ${code}; return {allRecords};`)(deps).allRecords
}
