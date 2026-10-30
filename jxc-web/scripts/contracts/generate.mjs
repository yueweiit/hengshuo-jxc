import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const webRoot = fileURLToPath(new URL('../../', import.meta.url))
const repoRoot = resolve(webRoot, '..')
const outputRoot = resolve(repoRoot, 'docs/backend/contracts')
const originalTestFiles = ['amounts', 'cost-inventory', 'finance', 'permissions', 'scenario'].map(n => `tests/${n}.test.mjs`)
const json = value => `${JSON.stringify(value, null, 2)}\n`
const portablePath = value => value.replaceAll('\\', '/')
const uniq = values => [...new Set(values)].sort()
const unwrap = node => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node))) node = node.expression
  return node
}
function source(file, text = readFileSync(file, 'utf8')) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const definitions = new Map()
  const imports = new Map()
  const mutations = new Map()
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) definitions.set(declaration.name.text, declaration.initializer)
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const specifier of statement.importClause.namedBindings.elements) imports.set(specifier.name.text, { name: specifier.propertyName?.text ?? specifier.name.text, from: statement.moduleSpecifier.text })
    }
  }
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
    const call = statement.expression
    if (!ts.isPropertyAccessExpression(call.expression) || !ts.isIdentifier(call.expression.expression) || !['push', 'unshift'].includes(call.expression.name.text)) continue
    const name = call.expression.expression.text
    if (!mutations.has(name)) mutations.set(name, [])
    mutations.get(name).push({ call, action: call.expression.name.text })
  }
  return { ast, definitions, imports, mutations, file }
}
function location(node, ctx) {
  return { file: portablePath(relative(repoRoot, ctx.file)), line: ctx.ast.getLineAndCharacterOfPosition(node.getStart(ctx.ast)).line + 1 }
}
function textOf(node, ctx) { return node?.getText(ctx.ast) ?? '' }
function property(node, key) {
  node = unwrap(node)
  return node && ts.isObjectLiteralExpression(node) ? node.properties.find(p => p.name?.getText().replace(/['"]/g, '') === key)?.initializer : undefined
}
function literal(node, ctx, env = {}) {
  node = unwrap(node)
  if (!node) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) return -literal(node.operand, ctx, env)
  if (ts.isIdentifier(node)) {
    if (node.text in env) return env[node.text]
    if (node.text === 'API') return '/api/v1'
    const declaration = ctx.definitions.get(node.text)
    return declaration && declaration !== node ? literal(declaration, ctx, env) : undefined
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(e => literal(e, ctx, env))
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText().replace(/['"]/g, ''), literal(p.initializer, ctx, env)]).filter(([, v]) => v !== undefined))
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text
    for (const span of node.templateSpans) {
      const value = literal(span.expression, ctx, env)
      if (value === undefined) return undefined
      result += String(value) + span.literal.text
    }
    return result
  }
  return undefined
}
function visit(node, fn) { fn(node); ts.forEachChild(node, child => visit(child, fn)) }
function observations(node, ctx, env = {}) {
  const calls = [], permissions = [], fields = [], guards = [], errors = [], headers = []
  if (node) visit(node, child => {
    if (ts.isCallExpression(child)) {
      const name = ts.isIdentifier(child.expression) ? child.expression.text : ts.isPropertyAccessExpression(child.expression) ? child.expression.name.text : ''
      if (name) calls.push(name)
      if (name === 'requirePerm' || name === 'hasPerm') {
        const value = literal(child.arguments[1], ctx, env)
        if (value !== undefined) permissions.push({ guard: name, values: Array.isArray(value) ? value : [value], ...location(child, ctx) })
      }
      if (name === 'requireFieldAccess') fields.push({ group: literal(child.arguments[1], ctx, env) ?? 'unknown', write: literal(child.arguments[2], ctx, env) ?? false, ...location(child, ctx) })
      if (['requireCountry', 'requireDataAccess', 'canDataAccess', 'inScope', 'scopedRows', 'requireDocumentAccess', 'canDocumentDataAccess', 'findOr404', 'assertWarehouseScope', 'assertPeriodOpen'].includes(name)) guards.push(name)
      if (name === 'get' && ts.isPropertyAccessExpression(child.expression) && child.expression.expression.getText(ctx.ast).endsWith('.headers')) {
        const header = literal(child.arguments[0], ctx, env)
        if (header) headers.push(header)
      }
    }
    if (ts.isNewExpression(child) && textOf(child.expression, ctx) === 'MockError') {
      const status = literal(child.arguments?.[0], ctx, env), code = literal(child.arguments?.[1], ctx, env)
      if (typeof status === 'number' && typeof code === 'string') errors.push({ status, code })
    }
  })
  return { calls: uniq(calls), permissions, fields, guards: uniq(guards), errors: [...new Map(errors.map(e => [`${e.status}:${e.code}`, e])).values()], headers: uniq(headers) }
}
function phaseOf(path) {
  if (/^\/api\/v1\/sys\/(workbench|todos|notifications|export-jobs)(\/|$)/.test(path)) return 'M4'
  if (/^\/api\/v1\/(auth|sys|org|md|wf|countries|templates|clone-jobs|reviews)(\/|$)/.test(path)) return 'M1'
  if (/^\/api\/v1\/(cst|fin|ai)(\/|$)/.test(path)) return /^\/api\/v1\/fin\/(books|periods)(\/|$)/.test(path) && !/\/(close|close-check|waive|reopen)$/.test(path) ? 'M1' : /\/(close|close-check|waive|reopen)$/.test(path) || /\/reports(\/|$)/.test(path) ? 'M4' : 'M3'
  if (/^\/api\/v1\/(ana|imp)(\/|$)/.test(path)) return 'M4'
  return 'M2'
}
function policy(node, ctx, env, generic) {
  const observed = observations(node, ctx, env)
  const authOptions = ts.isCallExpression(unwrap(node)) && textOf(unwrap(node).expression, ctx) === 'handle' ? literal(unwrap(node).arguments[1], ctx, env) ?? {} : {}
  if (generic) {
    const configured = generic.method === 'GET' ? generic.options.viewPerm : generic.options.editPerm
    if (configured) observed.permissions.push({ guard: 'crud.requirePerm', values: Array.isArray(configured) ? configured : [configured], ...generic.source })
    observed.guards.push(...(generic.options.countryScoped === false ? [] : ['crud.countryScoped']), ...(generic.options.scope ? ['crud.inScope'] : []), ...(generic.hasCanAccess ? ['crud.canAccess'] : []))
  }
  return {
    auth: authOptions.auth === false ? 'anonymous' : 'bearer-session',
    permissions: { observed: observed.permissions, interpretation: 'Observed guard calls only; conditions and referenced helpers require review.' },
    scope: { country: generic?.options.countryScoped === false ? 'global-table; authenticated wrapper still checks supplied country grant' : authOptions.skipCountry ? 'wrapper skips country header' : authOptions.auth === false ? 'anonymous' : 'country header authorization; resource requirements need review', configuredFields: generic?.options.scope ?? null, observedGuards: uniq(observed.guards), reviewRequired: true },
    field: { observed: observed.fields, serializerCalls: observed.calls.filter(c => /^(readable|userFieldGroups|.*Out$|.*View$)/.test(c)), reviewRequired: true },
    idem: { observedHeader: observed.headers.includes('Idempotency-Key'), referencedHelpersMayCheck: true, required: 'unknown; verify docs and service implementation', hashBinding: 'not inferred from AST' },
    facts: { observedCalls: observed.calls, synchronousFacts: 'unknown; verify domain command, transaction and outbox explicitly' },
    dto: { request: 'unknown; Row/body accesses do not define a complete DTO', response: 'unknown; referenced serializers and field access must be reviewed' },
    errors: { observed: observed.errors, completeness: 'partial; shared wrapper, helpers and domain errors are not expanded' },
    version: { observedCheck: generic?.method === 'PUT' || observed.calls.includes('checkVersion'), required: 'M1 edits require version; current Mock allows omission' },
    analysis: { completeness: 'partial', reviewRequired: true, limitation: 'AST registration extraction is complete for supported syntax; policies, DTOs, errors and facts are evidence only, never complete control-flow inference.' },
  }
}

export function extractRoutes() {
  const contexts = new Map()
  const load = file => { if (!contexts.has(file)) contexts.set(file, source(file)); return contexts.get(file) }
  function evaluate(node, ctx, env = {}) {
    node = unwrap(node)
    if (!node) return []
    if (ts.isSpreadElement(node)) return evaluate(node.expression, ctx, env)
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(e => evaluate(e, ctx, env))
    if (ts.isIdentifier(node)) {
      if (ctx.definitions.has(node.text)) {
        let value = evaluate(ctx.definitions.get(node.text), ctx, env)
        for (const mutation of ctx.mutations.get(node.text) ?? []) {
          const entries = mutation.call.arguments.flatMap(argument => evaluate(argument, ctx, env))
          value = mutation.action === 'push' ? [...value, ...entries] : [...entries, ...value]
        }
        return value
      }
      const imported = ctx.imports.get(node.text)
      if (imported?.from.startsWith('.')) {
        const target = load(resolve(dirname(ctx.file), `${imported.from}.ts`))
        return evaluate(ts.factory.createIdentifier(imported.name), target, env)
      }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'crud') return { crud: true, path: literal(node.arguments[0], ctx, env), table: literal(node.arguments[1], ctx, env), options: literal(node.arguments[2], ctx, env) ?? {}, optionsNode: node.arguments[2], source: location(node, ctx), ctx }
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        const receiver = unwrap(node.expression.expression)
        if (ts.isIdentifier(receiver) && receiver.text === 'http' && ['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
          const path = literal(node.arguments[0], ctx, env)
          if (!path) throw new Error(`Unresolved route at ${JSON.stringify(location(node, ctx))}`)
          return [{ method: method.toUpperCase(), path, kind: 'http', source: location(node, ctx), ...policy(node.arguments[1], ctx, env) }]
        }
        if (method === 'handlers') {
          const resource = evaluate(receiver, ctx, env)
          if (!resource?.crud) throw new Error(`Unknown CRUD at ${textOf(node, ctx)}`)
          const extra = node.arguments[0] ? evaluate(node.arguments[0], ctx, env) : []
          const { ctx: crudCtx, optionsNode, ...g } = resource
          const hasCanAccess = !!property(optionsNode, 'canAccess')
          return [...extra, ...[['GET', ''], ['POST', ''], ['POST', '/:id/disable'], ['POST', '/:id/enable'], ['GET', '/:id'], ['PUT', '/:id']].map(([verb, suffix]) => ({ method: verb, path: `/api/v1${g.path}${suffix}`, kind: 'crud', table: g.table, source: g.source, mockStatus: verb !== 'GET' && !g.options.editPerm ? 'blocked' : 'registered', blockedReason: verb !== 'GET' && !g.options.editPerm ? 'crud.requireEdit denies absent editPerm; this registered hidden write is not an implemented command' : null, ...policy(optionsNode, crudCtx, env, { ...g, method: verb, hasCanAccess }) }))]
        }
        if (method === 'map') {
          const values = literal(receiver, ctx, env)
          const fn = unwrap(node.arguments[0])
          if (!Array.isArray(values) || !fn || !ts.isArrowFunction(fn) || !ts.isIdentifier(fn.parameters[0].name)) throw new Error(`Unsupported exported map at ${textOf(node, ctx)}`)
          return values.flatMap(value => evaluate(fn.body, ctx, { ...env, [fn.parameters[0].name.text]: value }))
        }
      }
    }
    throw new Error(`Unsupported exported registration at ${JSON.stringify(location(node, ctx))}: ${textOf(node, ctx).slice(0, 100)}`)
  }
  const browser = load(resolve(webRoot, 'src/mock/browser.ts'))
  let setup
  visit(browser.ast, n => { if (ts.isCallExpression(n) && textOf(n.expression, browser) === 'setupWorker') setup = n })
  if (!setup) throw new Error('setupWorker registration not found')
  const registrations = setup.arguments.flatMap(argument => evaluate(argument, browser)).map((route, registrationIndex) => ({ ...route, registrationIndex, mockStatus: route.mockStatus ?? 'registered', phase: phaseOf(route.path), backend: { status: 'blocked', reason: route.mockStatus === 'blocked' ? route.blockedReason : 'Deferred until the declared phase has a verified real implementation.' }, effective: true }))
  const groups = new Map()
  for (const registration of registrations) {
    const key = `${registration.method} ${registration.path}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(registration.registrationIndex)
  }
  for (const indices of groups.values()) for (const index of indices.slice(1)) Object.assign(registrations[index], { effective: false, shadowedBy: indices[0], resolution: 'first matching registration wins; crud.handlers(extra) prepends extra before generic routes; browser.ts spread order retained' })
  const operations = [...groups.values()].map(indices => ({ ...registrations[indices[0]], registrations: indices }))
  const exportOrder = setup.arguments.map(argument => {
    const name = unwrap(ts.isSpreadElement(argument) ? argument.expression : argument).text
    const imported = browser.imports.get(name)
    if (!imported) throw new Error(`Unknown worker export ${name}`)
    return { name: imported.name, file: portablePath(relative(repoRoot, resolve(dirname(browser.file), `${imported.from}.ts`))) }
  })
  const registrationRecords = registrations.map(route => ({
    registrationIndex: route.registrationIndex, method: route.method, path: route.path, kind: route.kind,
    ...(route.table ? { table: route.table } : {}), source: route.source,
    phase: route.phase, mockStatus: route.mockStatus, backend: route.backend, effective: route.effective,
    ...(route.blockedReason ? { blockedReason: route.blockedReason } : {}),
    ...(route.shadowedBy !== undefined ? { shadowedBy: route.shadowedBy, resolution: route.resolution } : {}),
    policyOperationIndex: operations.findIndex(operation => operation.registrations.includes(route.registrationIndex)),
  }))
  return { schemaVersion: 1, source: 'jxc-web/src/mock/browser.ts export order, http.* calls, top-level array mutations and crud.handlers(extra) expanded with the installed TypeScript AST', phaseNote: 'Phase labels are the controlled foundation plan classification, not proof of implementation; reviewed M1 status is maintained separately.', registrationCount: registrations.length, operationCount: operations.length, exportOrder, registrations: registrationRecords, operations }
}

export function extractRegressionBaseline() {
  const contracts = []
  for (const file of originalTestFiles) {
    const ctx = source(resolve(webRoot, file))
    function scan(node, env = {}, parameters = null) {
      if (ts.isForOfStatement(node)) {
        const values = literal(node.expression, ctx, env)
        if (!Array.isArray(values)) throw new Error(`Cannot freeze parameter expansion in ${file}`)
        const name = node.initializer.declarations[0].name
        for (const value of values) {
          const bindings = ts.isArrayBindingPattern(name) ? Object.fromEntries(name.elements.map((e, i) => [e.name.text, value[i]])) : { [name.text]: value }
          scan(node.statement, { ...env, ...bindings }, { ...parameters, ...bindings })
        }
        return
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test') {
        const name = literal(node.arguments[0], ctx, env)
        if (typeof name !== 'string') throw new Error(`Unresolved test name in ${file}`)
        const key = `${file}:${node.getStart()}`
        let contract = contracts.find(c => c.key === key)
        if (!contract) {
          const body = node.arguments[1]
          contract = { key, id: `${file.replace('tests/', '').replace('.test.mjs', '')}-${contracts.filter(c => c.source.file.endsWith(file)).length + 1}`, source: location(node, ctx), nameTemplate: textOf(node.arguments[0], ctx), contractType: /callApi|\bapi\(/.test(textOf(body, ctx)) ? 'HTTP-observable' : 'direct-TS-function-or-scenario', expansions: [] }
          contracts.push(contract)
        }
        contract.expansions.push({ name, parameters })
        return // loops inside a test body are assertions, not new tests
      }
      if (ts.isFunctionLike(node)) return
      ts.forEachChild(node, child => scan(child, env, parameters))
    }
    scan(ctx.ast)
  }
  for (const contract of contracts) delete contract.key
  return { schemaVersion: 1, scope: originalTestFiles.map(f => `jxc-web/${f}`), note: 'Frozen original test call-sites are independent contracts; for-of names are parameter expansions. This records Mock coverage, not PostgreSQL or Java acceptance.', independentContractCount: contracts.length, expandedTestCount: contracts.reduce((n, c) => n + c.expansions.length, 0), contracts }
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => !entry.isDirectory() || !/^(?:target(?: \d+)?|node_modules|dist|\.git)$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap(entry => entry.isDirectory() ? walkFiles(resolve(directory, entry.name)) : [portablePath(resolve(directory, entry.name))])
}
const pathSignature = path => path.replace(/:[\w]+|\{[^}]+\}/g, '*')
function matchEvidence(method, path, catalog) {
  if (!path) return { match: 'unknown-dynamic', registrations: [], reviewRequired: true }
  const candidates = catalog.operations.filter(route => route.method === method && pathSignature(route.path) === pathSignature(path))
  return { match: candidates.length ? candidates.every(route => route.mockStatus === 'blocked') ? 'blocked' : 'registered' : path.includes('{') ? 'unknown-dynamic' : 'not-registered', registrations: candidates.map(route => route.registrationIndex), reviewRequired: true }
}
export function extractRequestEvidence(catalog) {
  const frontend = [], documented = []
  for (const file of walkFiles(resolve(webRoot, 'src')).filter(file => /\.(ts|vue)$/.test(file) && !file.includes('/mock/') && !file.endsWith('/api/http.ts'))) {
    let content = readFileSync(file, 'utf8')
    if (file.endsWith('.vue')) {
      const scripts = [...content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
      if (!scripts.length) continue
      content = scripts.map(match => '\n'.repeat(content.slice(0, match.index + match[0].indexOf('>') + 1).split('\n').length - 1) + match[1]).join('\n')
    }
    const ctx = source(file, content)
    visit(ctx.ast, node => {
      if (!ts.isCallExpression(node)) return
      if (ts.isIdentifier(node.expression) && node.expression.text === 'createCrudApi') {
        const resource = literal(node.arguments[0], ctx)
        for (const [method, suffix] of [['GET', ''], ['GET', '/{id}'], ['POST', ''], ['PUT', '/{id}'], ['DELETE', '/{id}'], ['POST', '/{id}/disable'], ['POST', '/{id}/enable']]) {
          const path = typeof resource === 'string' && resource.startsWith('/') ? `/api/v1${resource}${suffix}` : null
          frontend.push({ ...location(node, ctx), kind: 'crud-factory-candidate', method, pathPattern: path, expression: textOf(node.arguments[0], ctx), ...matchEvidence(method, path, catalog) })
        }
      }
      const pagedOptions = ts.isIdentifier(node.expression) && node.expression.text === 'allRecords'
        && ctx.imports.get('allRecords')?.from === '@/api/pagination'
      if (!pagedOptions && (!ts.isPropertyAccessExpression(node.expression) || node.expression.expression.getText(ctx.ast) !== 'http')) return
      const wrapperMethod = pagedOptions ? 'allRecords' : node.expression.name.text
      if (!['get', 'post', 'postIdem', 'put', 'delete', 'attachmentBlob', 'allRecords'].includes(wrapperMethod)) return
      const method = wrapperMethod === 'postIdem' ? 'POST' : ['attachmentBlob', 'allRecords'].includes(wrapperMethod) ? 'GET' : wrapperMethod.toUpperCase()
      const argument = unwrap(node.arguments[0])
      let path = literal(argument, ctx)
      if (path === undefined && argument && ts.isTemplateExpression(argument) && argument.head.text.startsWith('/')) path = argument.head.text + argument.templateSpans.map((span, i) => `{param${i + 1}}${span.literal.text}`).join('')
      path = typeof path === 'string' && path.startsWith('/') ? `${path.startsWith('/api/') ? '' : '/api/v1'}${path}`.split('?')[0] : null
      frontend.push({ ...location(node, ctx), kind: 'http-call', method, wrapperMethod, idempotencyHeaderByWrapper: wrapperMethod === 'postIdem', pathPattern: path, expression: textOf(argument, ctx), ...matchEvidence(method, path, catalog) })
    })
  }
  for (const file of readdirSync(resolve(repoRoot, 'docs')).filter(name => /^\d\d.*\.md$/.test(name)).sort()) {
    const lines = readFileSync(resolve(repoRoot, 'docs', file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      const columns = line.split('|').map(cell => cell.trim())
      if (!columns[1] || !/^(CRUD|GET|POST|PUT|DELETE|PATCH)(?:\s*\/\s*(?:GET|POST|PUT|DELETE|PATCH))*$/.test(columns[1])) return
      const concrete = columns[1] !== 'CRUD'
      for (const match of (columns[2] ?? '').matchAll(/`(\/api\/v1\/[^`]+)`/g)) {
        const base = match[1].split('?')[0]
        const methods = concrete ? columns[1].split(/\s*\/\s*/).map(method => [method, base]) : [['GET', base], ['GET', `${base}/{id}`], ['POST', base], ['PUT', `${base}/{id}`], ['DELETE', `${base}/{id}`]]
        for (const [method, path] of methods) documented.push({ file: `docs/${file}`, line: i + 1, method, pathPattern: path, kind: concrete ? 'explicit-table-path' : 'CRUD-shorthand-requires-review', description: columns[3] ?? '', ...matchEvidence(method, path, catalog), ...(!concrete && !catalog.operations.some(route => route.method === method && pathSignature(route.path) === pathSignature(path)) ? { match: 'not-registered' } : {}) })
      }
    })
  }
  return { schemaVersion: 1, limitations: ['Frontend evidence includes direct http calls, the reviewed options allRecords GET wrapper and createCrudApi candidates only; dynamic component configuration and arbitrary helper data flow require review.', 'Templates replace unresolved expressions with positional parameters; this does not prove an action or identifier is valid.', 'Documentation extraction covers explicit API table paths and clearly labelled CRUD shorthand; shortened action alternatives and prose are not inferred.', 'Registered means Mock registration evidence, never verified real backend availability.'], frontend, documented }
}

export function extractControllerMappings() {
  const operations = []
  for (const file of walkFiles(resolve(repoRoot, 'jxc-server')).filter(file => file.endsWith('Controller.java') && file.includes('/src/main/'))) {
    const content = readFileSync(file, 'utf8')
    if (!content.includes('@RestController')) continue
    const base = content.match(/@RequestMapping\("([^"\n]+)"\)/)?.[1]
    if (!base) throw new Error(`Unsupported Controller base: ${file}`)
    for (const match of content.matchAll(/@(Get|Post|Put|Delete|Patch)Mapping\b(?:\s*\(([^)]*)\))?/g)) {
      const argument = match[2]?.trim() ?? ''
      let suffixes
      if (!argument || /^(?:consumes|produces)\s*=/.test(argument) && !/\b(?:value|path)\s*=/.test(argument)) suffixes = ['']
      else if (/^"[^"\n]*"$/.test(argument)) suffixes = [argument.slice(1, -1)]
      else if (/^\{\s*"[^"\n]*"(?:\s*,\s*"[^"\n]*")*\s*\}$/.test(argument)) suffixes = [...argument.matchAll(/"([^"]*)"/g)].map(m => m[1])
      else throw new Error(`Unsupported Controller annotation: ${file}:${argument}`)
      const paths = []
      for (const suffix of suffixes) {
        let pending = [base + suffix]
        while (pending.some(path => /\{[^}]*:/.test(path))) {
          pending = pending.flatMap(path => {
            const finite = path.match(/\{\w+:([A-Za-z][A-Za-z0-9-]*(?:\|[A-Za-z][A-Za-z0-9-]*)+)\}/)
            if (!finite) { if (/\{[^}]*:/.test(path)) throw new Error(`Unsupported Controller regex: ${file}:${path}`); return [path] }
            return finite[1].split('|').map(value => path.replace(finite[0], value))
          })
        }
        paths.push(...pending)
      }
      const expanded = suffixes.length > 1 || paths.length > 1
      const symbol = content.slice(match.index + match[0].length).match(/public\s+[A-Za-z<>[\],? ]+\s+(\w+)\s*\(/)?.[1]
      if (!symbol) throw new Error(`Unsupported Controller declaration: ${file}:${template}`)
      for (const path of paths) operations.push({ method: match[1].toUpperCase(), path, file: portablePath(relative(repoRoot, file)), line: content.slice(0, match.index).split('\n').length, symbol, ...(expanded ? { expandedFrom: base + argument } : {}) })
    }
  }
  return { schemaVersion: 1, limitation: 'Bounded Java annotation inventory, not a Java AST or handler/policy inference. Literal/array paths and finite enumerated regex products are inventoried; registered combinations still need service-level action review. M1/M2/M3/M4 schemas and policies are reviewed separately.', operations }
}

export function validateM1Surface(surface) {
  const errors = [], keys = new Set()
  for (const entry of surface.operations ?? []) {
    const key = `${entry.method} ${entry.path}`
    if (keys.has(key)) errors.push(`duplicate ${key}`)
    keys.add(key)
    if (!['implemented-foundation', 'implemented-business-foundation', 'blocked', 'planned'].includes(entry.status)) errors.push(`invalid status ${key}`)
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(entry.method) || !entry.path?.startsWith('/api/v1/')) errors.push(`invalid route ${key}`)
    if (!entry.responses || !Object.keys(entry.responses).some(s => /^2\d\d$|^4\d\d$|default/.test(s))) errors.push(`missing response schema ${key}`)
    if (Object.values(entry.responses ?? {}).some(r => !r.content?.['application/json']?.schema && !(entry.responseKind === 'binary' && r.content?.['application/octet-stream']?.schema))) errors.push(`missing JSON schema ${key}`)
    if (entry.status.startsWith('implemented-') && !entry.evidence?.length) errors.push(`missing implementation evidence ${key}`)
  }
  return errors
}
function openApi(catalog, surface) {
  const paths = {}
  for (const route of catalog.operations) {
    const path = route.path.replace(/:([\w]+)/g, '{$1}')
    paths[path] ??= {}
    paths[path][route.method.toLowerCase()] = {
      operationId: `${route.method.toLowerCase()}_${route.path.replace(/[^\w]+/g, '_')}`,
      tags: [route.path.split('/')[3]],
      summary: `${route.method} ${route.path}`,
      parameters: [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description: 'Path token; numeric identifier bounds require DTO review.' })),
      security: route.auth === 'anonymous' ? [] : [{ bearerSession: [] }],
      ...(route.method === 'GET' ? {} : { requestBody: { required: false, content: { 'application/json': { schema: { description: route.dto.request } } } } }),
      responses: { default: { description: 'Observed response envelope only; operation-specific DTO and error status matrix require review.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiEnvelope' } } } } },
      'x-phase': route.phase, 'x-backend-status': route.backend.status, 'x-mock-status': route.mockStatus,
      'x-registration-indices': route.registrations,
      'x-contract-evidence': { source: route.source, permissions: route.permissions, scope: route.scope, field: route.field, idem: route.idem, facts: route.facts, errors: route.errors, analysis: route.analysis },
    }
  }
  for (const entry of surface.operations) {
    paths[entry.path] ??= {}
    const previous = paths[entry.path][entry.method.toLowerCase()] ?? { operationId: `${entry.method.toLowerCase()}_${entry.path.replace(/[^\w]+/g, '_')}`, tags: [entry.path.split('/')[3]], parameters: [...entry.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: { type: 'string' } })) }
    if (entry.noBody) delete previous.requestBody
    paths[entry.path][entry.method.toLowerCase()] = { ...previous, ...(entry.parameters ? { parameters: [...(previous.parameters ?? []), ...entry.parameters] } : {}), security: entry.security === 'anonymous' ? [] : [{ bearerSession: [] }], ...(previous['x-contract-evidence'] ? { 'x-mock-contract-evidence': previous['x-contract-evidence'] } : {}), 'x-contract-evidence': { reviewStatus: entry.phase === 'M1' || !entry.phase ? 'explicit-M1-review' : `${entry.phase}-main-flow-review`, ...entry.policy }, ...(entry.requestBody ? { requestBody: entry.requestBody } : {}), responses: entry.responses, 'x-phase': entry.phase ?? 'M1', 'x-backend-status': entry.status, 'x-implementation-evidence': entry.evidence, 'x-limitations': entry.limitations }
  }
  return { openapi: '3.1.0', info: { title: 'Hengshuo JXC controlled contract baseline', version: 'M0-M5-closure', description: 'Generated registration catalogue plus reviewed M1 foundation and M2/M3/M4 main-flow contracts. Controller-only registration remains distinct from tested business behavior. Unknown evidence remains unknown; blocked/deferred operations are not real backend functionality.' }, servers: [{ url: '/' }], paths, components: { securitySchemes: { bearerSession: { type: 'http', scheme: 'bearer' } }, schemas: { ...surface.schemas, ApiEnvelope: { type: 'object', required: ['code', 'message', 'data', 'traceId'], properties: { code: { type: 'string' }, message: { type: 'string' }, data: {}, traceId: { type: 'string' } }, additionalProperties: false } } } }
}
export function generateArtifacts() {
  const catalog = extractRoutes()
  const m1 = JSON.parse(readFileSync(resolve(outputRoot, 'm1-surface.json'), 'utf8'))
  const m2 = JSON.parse(readFileSync(resolve(outputRoot, 'm2-surface.json'), 'utf8'))
  const m3 = JSON.parse(readFileSync(resolve(outputRoot, 'm3-surface.json'), 'utf8'))
  const m4 = JSON.parse(readFileSync(resolve(outputRoot, 'm4-surface.json'), 'utf8'))
  const closure = JSON.parse(readFileSync(resolve(outputRoot, 'closure-surface.json'), 'utf8'))
  const surface = { schemas: { ...m1.schemas, ...m2.schemas, ...m3.schemas, ...m4.schemas, ...closure.schemas }, operations: [...m1.operations, ...m2.operations, ...m3.operations, ...m4.operations, ...closure.operations.map(entry => ({ ...entry, contractSource: 'docs/backend/contracts/closure-surface.json' }))] }
  const errors = validateM1Surface(surface)
  if (errors.length) throw new Error(errors.join('\n'))
  const controllerMappings = extractControllerMappings()
  catalog.realBackendSurface = { sources: ['docs/backend/contracts/m1-surface.json', 'docs/backend/contracts/m2-surface.json', 'docs/backend/contracts/m3-surface.json', 'docs/backend/contracts/m4-surface.json', 'docs/backend/contracts/closure-surface.json'], operationCount: surface.operations.length, note: 'Reviewed main-flow declarations are separate from bounded Controller registration and service/HTTP verification evidence.' }
  for (const route of catalog.operations) {
    const declared = surface.operations.find(entry => entry.method === route.method && entry.path === route.path.replace(/:([\w]+)/g, '{$1}'))
    if (!declared && controllerMappings.operations.some(entry => entry.method === route.method && entry.path === route.path.replace(/:([\w]+)/g, '{$1}'))) {
      route.backend = { status: 'registered-gated', note: 'Controller exists; exact action/DTO contract is outside the reviewed main-flow surface. Registration alone is not acceptance.' }
      catalog.registrations[route.registrationIndex].backend = route.backend
    }
    if (declared) {
      route.backend = { status: declared.status, contractSource: declared.contractSource ?? `docs/backend/contracts/${(declared.phase ?? 'M1').toLowerCase()}-surface.json`, policy: declared.policy }
      catalog.registrations[route.registrationIndex].backend = { status: declared.status, contractSource: declared.contractSource ?? `docs/backend/contracts/${(declared.phase ?? 'M1').toLowerCase()}-surface.json` }
    }
  }
  return { 'controller-mappings.json': controllerMappings, 'route-catalog.json': catalog, 'mock-regressions.json': extractRegressionBaseline(), 'request-evidence.json': extractRequestEvidence(catalog), 'openapi.json': openApi(catalog, surface) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  let drift = false
  mkdirSync(outputRoot, { recursive: true })
  for (const [name, value] of Object.entries(generateArtifacts())) {
    const file = resolve(outputRoot, name), serialized = json(value)
    if (check) {
      let current
      try { current = readFileSync(file, 'utf8') } catch { current = '' }
      if (current.replaceAll('\r\n', '\n') !== serialized) { process.stderr.write(`Contract drift: ${portablePath(relative(repoRoot, file))}\n`); drift = true }
    } else writeFileSync(file, serialized)
  }
  if (drift) process.exitCode = 1
  else process.stdout.write(check ? 'Contract artifacts match current sources.\n' : 'Contract artifacts generated; review unknowns and policy changes before accepting.\n')
}
