import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { loadVueScript } from './contracts/load-vue-script.mjs'

const file = new URL('../src/modules/master/ProductList.vue', import.meta.url)
const source = readFileSync(file, 'utf8')

function categoryPage(platform = true, permitted = true) {
  const user = vue.reactive({ user: { isPlatformAdmin: platform }, permitted, hasPerm() { return this.permitted } })
  const page = loadVueScript(file, { ref: vue.ref, computed: vue.computed, useUserStore: () => user, STATUS_OPTIONS: [] }, ['canManageCategories', 'categoriesVisible', 'openCategories', 'categoryColumns', 'categoryFields', 'columns', 'searchFields', 'formFields', 'beforeOpen', 'unitsOf', 'barcodesOf', 'setDefault'])
  return { page, user }
}

function render(page) {
  const resources = [], buttons = []
  const renderer = vue.createRenderer({ createElement: tag => ({ tag, children: [] }), createText: text => ({ text }), createComment: () => ({}), setText: (n, text) => { n.text = text }, setElementText: (n, text) => { n.text = text }, insert: (n, p) => p.children.push(n), remove() {}, patchProp: (n, key, _old, value) => { n[key] = value }, parentNode: () => null, nextSibling: () => null })
  const template = source.slice(source.indexOf('<template>') + 10, source.lastIndexOf('</template>'))
  const compiled = compile(`<div>${template}</div>`, { mode: 'function', prefixIdentifiers: true, expressionPlugins: ['typescript'] }).code
  const app = renderer.createApp({ setup: () => page, render: new Function('Vue', ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(vue) })
  app.component('CrudPage', { props: ['resource', 'editPerm', 'formFields'], setup: (props, ctx) => { resources.push(props); return () => vue.h('section', ctx.slots.toolbar?.({ reload() {} })) } })
  app.component('ElButton', { setup: (_, ctx) => () => vue.h('button', ctx.attrs, ctx.slots.default?.()) })
  app.component('ElDialog', { props: ['modelValue'], setup: (props, ctx) => () => props.modelValue ? vue.h('section', ctx.slots.default?.()) : null })
  for (const name of ['ElDivider', 'ElInput', 'ElTableColumn', 'ElInputNumber', 'ElRadio', 'ElTable', 'ElOption', 'ElSelect']) app.component(name, { setup: (_, ctx) => () => vue.h('span', ctx.slots.default?.()) })
  const root = { children: [] }; app.mount(root)
  const seen = new Set()
  const walk = n => { if (seen.has(n)) return []; seen.add(n); return [n, ...(n.children ?? []).flatMap(walk)] }
  buttons.push(...walk(root).filter(n => n.tag === 'button'))
  const result = { resources: resources.map(r => ({ ...r })), buttons }; app.unmount(); return result
}

test('only the currently authorized platform maintainer can open category maintenance from the product page', () => {
  for (const [platform, permitted] of [[true, true], [false, true], [true, false]]) {
    const { page, user } = categoryPage(platform, permitted)
    const before = render(page)
    assert.equal(before.buttons.length, Number(platform && permitted))
    before.buttons[0]?.onClick()
    assert.equal(page.categoriesVisible.value, platform && permitted)
    user.permitted = false
    page.categoriesVisible.value = false
    page.openCategories()
    assert.equal(page.categoriesVisible.value, false)
  }
})

test('category maintenance embeds the existing versioned CRUD writer and requires explicit category identity', () => {
  const { page } = categoryPage()
  page.openCategories()
  const view = render(page), category = view.resources.find(r => r.resource === '/md/categories')
  assert.ok(category, 'empty product setup must expose the existing category CRUD resource')
  assert.equal(category.editPerm, 'md:product:edit')
  assert.equal(category.formFields.find(f => f.prop === 'code').required, true)
  assert.equal(category.formFields.find(f => f.prop === 'name').required, true)
  assert.equal(category.formFields.find(f => f.prop === 'parentId').options.remote, '/md/categories')
  assert.ok(category.formFields.every(f => f.default === undefined), 'the page must not invent a real category')
})
