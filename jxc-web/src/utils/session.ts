const TOKEN_KEY = 'jxc.token'
const COUNTRY_KEY = 'jxc.countryId'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function getCountryId(): number | null {
  const v = localStorage.getItem(COUNTRY_KEY)
  return v ? Number(v) : null
}

export function setCountryId(id: number | null) {
  if (id == null) localStorage.removeItem(COUNTRY_KEY)
  else localStorage.setItem(COUNTRY_KEY, String(id))
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY)
}
