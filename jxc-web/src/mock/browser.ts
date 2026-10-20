import { setupWorker } from 'msw/browser'
import { aiHandlers } from './handlers/ai'
import { anaHandlers } from './handlers/ana'
import { apHandlers } from './handlers/ap'
import { arHandlers } from './handlers/ar'
import { authHandlers } from './handlers/auth'
import { countryHandlers } from './handlers/country'
import { cstHandlers } from './handlers/cst'
import { cstOpsHandlers } from './handlers/cstOps'
import { finHandlers } from './handlers/fin'
import { impHandlers } from './handlers/imp'
import { invHandlers } from './handlers/inv'
import { lgsHandlers } from './handlers/lgs'
import { mdHandlers } from './handlers/md'
import { orgHandlers } from './handlers/org'
import { purHandlers } from './handlers/pur'
import { rtnHandlers } from './handlers/rtn'
import { salHandlers } from './handlers/sal'
import { sysHandlers } from './handlers/sys'
import { wfHandlers } from './handlers/wf'
import './scenario'

export const worker = setupWorker(
  ...authHandlers, ...countryHandlers, ...sysHandlers, ...orgHandlers, ...mdHandlers, ...wfHandlers,
  ...purHandlers, ...lgsHandlers, ...invHandlers, ...anaHandlers, ...cstHandlers, ...cstOpsHandlers,
  ...salHandlers, ...arHandlers, ...apHandlers, ...rtnHandlers, ...finHandlers, ...aiHandlers, ...impHandlers,
)

// 热更新会重建未启动的 worker，修改 mock 后整页刷新
import.meta.hot?.accept(() => location.reload())
