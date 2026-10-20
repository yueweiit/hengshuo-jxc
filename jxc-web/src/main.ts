import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import * as ElementPlusIcons from '@element-plus/icons-vue'
import 'element-plus/dist/index.css'
import './styles/index.scss'

import App from './App.vue'
import { router } from './router'
import { i18n } from './locales'
import { vPerm } from './directives/perm'
import { retireMockWorker } from './api/mock-exit'

async function bootstrap() {
  if (import.meta.env.MODE === 'demo' && import.meta.env.VITE_USE_MOCK === 'true') {
    const { worker } = await import('./mock/browser')
    await worker.start({ onUnhandledFrame: 'bypass', quiet: true })
  } else if (await retireMockWorker(navigator.serviceWorker, globalThis.caches)) {
    // An unregistered worker still controls this document until the next navigation.
    // Reload before mounting so no authenticated real request can reach the old demo.
    location.reload()
    return
  }

  const app = createApp(App)
  for (const [name, comp] of Object.entries(ElementPlusIcons)) app.component(name, comp)
  app.use(createPinia())
  app.use(router)
  app.use(i18n)
  app.use(ElementPlus)
  app.directive('perm', vPerm)
  app.mount('#app')
}

bootstrap()
