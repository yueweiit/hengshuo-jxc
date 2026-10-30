const TOKEN_KEY = 'jxc.token'
const COUNTRY_KEY = 'jxc.countryId'
export const SESSION_CHANGE_EVENT = 'jxc:session-change'
function changed() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_CHANGE_EVENT))
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string) {
  const previous = getToken()
  localStorage.setItem(TOKEN_KEY, token)
  if (previous !== token) changed()
}

export function getCountryId(): number | null {
  const v = localStorage.getItem(COUNTRY_KEY)
  return v ? Number(v) : null
}

export function setCountryId(id: number | null) {
  const previous = getCountryId()
  if (id == null) localStorage.removeItem(COUNTRY_KEY)
  else localStorage.setItem(COUNTRY_KEY, String(id))
  if (previous !== id) changed()
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
  changed()
}
