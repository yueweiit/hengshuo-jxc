import { http } from 'msw'
import { getDb } from '../db'
import { API } from '../crud'
import { MockError, handle, userCountries, userFieldGroups, userPerms } from '../utils'

export const authHandlers = [
  http.post(
    `${API}/auth/login`,
    handle(
      (_ctx, { body }) => {
        const db = getDb()
        const user = db.users.find((u) => u.username === body?.username && u.password === body?.password)
        if (!user) throw new MockError(400, 'AUTH_BAD_CREDENTIALS', '账号或密码错误')
        if (user.status !== 'ENABLED') throw new MockError(400, 'AUTH_DISABLED', '账号已停用，请联系管理员')
        const token = crypto.randomUUID()
        db.sessions[token] = user.id
        return { token }
      },
      { auth: false },
    ),
  ),

  http.post(
    `${API}/auth/logout`,
    handle((ctx) => {
      const db = getDb()
      const token = ctx.request.headers.get('Authorization')?.replace('Bearer ', '') ?? ''
      delete db.sessions[token]
    }),
  ),

  http.get(
    `${API}/auth/me`,
    handle(
      (ctx) => {
        const countries = userCountries(ctx.user)
        const wanted = Number(ctx.url.searchParams.get('countryId'))
        const current =
          countries.find((c) => c.id === wanted) ?? countries.find((c) => c.status === 'ACTIVE') ?? countries[0] ?? null
        const countryId = current?.id ?? null
        const { password: _p, ...user } = ctx.user
        return {
          user,
          countries,
          currentCountryId: countryId,
          permissions: countryId == null ? [] : userPerms(ctx.user, countryId),
          fieldGroups: countryId == null ? {} : userFieldGroups(ctx.user, countryId),
        }
      },
      { skipCountry: true },
    ),
  ),
]
