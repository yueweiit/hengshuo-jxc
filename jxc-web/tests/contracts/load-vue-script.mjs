import { readFileSync } from 'node:fs'
import ts from 'typescript'

/** Execute a page's actual setup functions with controlled UI dependencies; this is not a browser acceptance test. */
export function loadVueScript(file, dependencies, exposed) {
  const script = readFileSync(file, 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]
  const code = ts.transpileModule(script, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [() => node => ts.factory.updateSourceFile(node, node.statements.filter(statement => !ts.isImportDeclaration(statement)))] },
  }).outputText.replace(/\bexport\s*\{\s*\};?/g, '').replace(/import\.meta\.env/g, '(deps.importMetaEnv || {})')
  const names = Object.keys(dependencies)
  if ([...names, ...exposed].some(name => !/^[A-Za-z_$][\w$]*$/.test(name))) throw new Error('Invalid test dependency')
  return new Function('deps', `const {${names.join(',')}}=deps; ${code}; return {${exposed.join(',')}};`)(dependencies)
}
