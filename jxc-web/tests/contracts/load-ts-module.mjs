import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

/** Execute actual TS modules and their source dependencies with the installed compiler. */
export function loadTsModule(url, cache = new Map()) {
  if (cache.has(url.href)) return cache.get(url.href)
  const module = { exports: {} }
  cache.set(url.href, module.exports)
  const code = ts.transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText
  const require = createRequire(url)
  new Function('require', 'module', 'exports', code)(specifier => specifier.startsWith('@/')
    ? loadTsModule(new URL(`../../src/${specifier.slice(2)}.ts`, import.meta.url), cache)
    : require(specifier), module, module.exports)
  return module.exports
}
