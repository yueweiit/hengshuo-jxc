import { registerHooks } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

// Reuse the installed TypeScript compiler; no second application or test server.
const project = fileURLToPath(new URL('../', import.meta.url))
registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('.') || specifier.startsWith('@/')) && context.parentURL && !context.parentURL.includes('/node_modules/')) {
      const target = specifier.startsWith('@/')
        ? resolve(project, 'src', specifier.slice(2))
        : resolve(dirname(fileURLToPath(context.parentURL)), specifier)
      const found = [target, `${target}.ts`, `${target}.js`, resolve(target, 'index.ts')].find(p => existsSync(p) && !p.endsWith('/'))
      if (found && /\.(ts|js|mjs)$/.test(found)) return nextResolve(pathToFileURL(found).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts') && !url.includes('/node_modules/')) {
      return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const storage = new Map()
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: key => storage.delete(key),
  clear: () => storage.clear(),
}
const { getDb, resetDb } = await import('../src/mock/db.ts')

export function freshDb() {
  storage.clear()
  resetDb()
  return getDb()
}

export function context(userId = 1, countryId = 1) {
  const db = getDb()
  const request = new Request('http://test.local/api/v1/test')
  return { user: db.users.find(user => user.id === userId), countryId, request, url: new URL(request.url) }
}

/** Exercise the real API resolver including auth, transactions and response envelope. */
export async function callApi(handlers, method, path, body, options = {}) {
  const url = new URL(path.startsWith('/api/') ? path : `/api/v1${path}`, 'http://test.local')
  const userId = options.userId ?? 1
  const countryId = options.countryId ?? 1
  const token = `test-session-${userId}`
  getDb().sessions[token] = userId
  const headers = new Headers({ Authorization: `Bearer ${token}`, ...(countryId == null ? {} : { 'X-Country-Id': String(countryId) }), ...options.headers })
  const init = { method: method.toUpperCase(), headers }
  if (body !== undefined && method.toUpperCase() !== 'GET') {
    if (body instanceof FormData) init.body = body
    else { headers.set('Content-Type', 'application/json'); init.body = JSON.stringify(body) }
  }
  const request = new Request(url, init)
  for (const handler of handlers) {
    if (handler.info.method !== method.toUpperCase()) continue
    const names = []
    const pattern = String(handler.info.path).split('/').map(part => {
      if (part.startsWith(':')) { names.push(part.slice(1)); return '([^/]+)' }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }).join('/')
    const match = url.pathname.match(new RegExp(`^${pattern}$`))
    if (!match) continue
    const params = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]))
    const response = await handler.resolver({ request, params })
    const envelope = await response.json()
    return { status: response.status, code: envelope.code, data: envelope.data, body: envelope }
  }
  throw new Error(`No handler: ${method} ${url.pathname}`)
}
