import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { loadTsModule } from './load-ts-module.mjs'
const feedback = loadTsModule(new URL('../../src/api/error-feedback.ts', import.meta.url))
export const errorFeedback = feedback
export function feedbackText() { return feedback.getErrors().map(n => [n.title, n.message, n.nextStep, ...n.details.map(row => `${row.label} ${row.value}`), ...n.actions.map(action => action.label)].join(' ')).join('\n') }

/** Execute a page's actual setup functions with controlled UI dependencies; this is not a browser acceptance test. */
export function loadVueScript(file, dependencies, exposed) {
  const script = readFileSync(file, 'utf8').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]
  const ast = ts.createSourceFile(file.href, script, ts.ScriptTarget.Latest, true)
  const imported = {}
  for (const node of ast.statements) if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === '@/api/error-feedback' && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
    for (const binding of node.importClause.namedBindings.elements) if (!binding.isTypeOnly) imported[binding.name.text] = feedback[binding.propertyName?.text ?? binding.name.text]
  }
  dependencies = { ...imported, ...dependencies }
  const code = ts.transpileModule(script, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    transformers: { before: [() => node => ts.factory.updateSourceFile(node, node.statements.filter(statement => !ts.isImportDeclaration(statement)))] },
  }).outputText.replace(/\bexport\s*\{\s*\};?/g, '').replace(/import\.meta\.env/g, '(deps.importMetaEnv || {})')
  const names = Object.keys(dependencies)
  if ([...names, ...exposed].some(name => !/^[A-Za-z_$][\w$]*$/.test(name))) throw new Error('Invalid test dependency')
  return new Function('deps', `const {${names.join(',')}}=deps; ${code}; return {${exposed.join(',')}};`)(dependencies)
}
