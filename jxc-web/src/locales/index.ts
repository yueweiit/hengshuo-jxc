import { createI18n } from 'vue-i18n'
import zhCN from './zh-CN'
import esMX from './es-MX'

export const LOCALES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'es-MX', label: 'Español (México)' },
]

const saved = localStorage.getItem('jxc.locale') ?? 'zh-CN'

export const i18n = createI18n({
  legacy: false,
  locale: saved,
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN, 'es-MX': esMX },
})

export function setLocale(locale: string) {
  i18n.global.locale.value = locale as 'zh-CN'
  localStorage.setItem('jxc.locale', locale)
  document.documentElement.lang = locale
}
