import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join, relative } from 'node:path'

// 显式启用时，只使用本轮Testcontainers PG和已验证制品；不接公共库、不推镜像。
export async function verifyPackagedLogistics({ browser, snapshot, output, assertReceiptFacts, selectHoldOwner }) {
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 90000 }).trim()
  const prefix = `ai02-image-${process.pid}`
  const network = `${prefix}-net`, app = `${prefix}-app`, gateway = `${prefix}-web`
  const pg = process.env.AI02_TEST_PG_CONTAINER
  assert.match(pg, /^[a-f0-9]{64}$/)
  assert.ok(process.env.AI02_TEST_PG_PASSWORD, '须有本轮隔离PG凭据')
  await writeFile(join(output, 'docker-objects.json'), JSON.stringify({ owner: 'AI-02', run: prefix, network, app, gateway, pg }, null, 2), 'utf8')
  const artifacts = process.env.AI02_VERIFIED_ARTIFACTS
  const privateDir = join(output, 'private-docker')
  await mkdir(privateDir, { recursive: true })
  const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0]
  assert.ok(sid, '须核实当前用户SID再设置私有凭据目录')
  execFileSync('icacls.exe', [privateDir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true })
  const envFile = join(privateDir, 'application.env')
  await writeFile(envFile, ['JXC_DB_URL=jdbc:postgresql://database:5432/jxc_m01_test', 'JXC_DB_USER=jxc_app',
    `JXC_DB_PASSWORD=${process.env.AI02_TEST_PG_PASSWORD}`, 'JXC_BIND_ADDRESS=0.0.0.0', 'SPRING_FLYWAY_ENABLED=false',
    'JXC_JOBS_ENABLED=false', 'JXC_ACCOUNTING_WORKER_ENABLED=false', 'JXC_PRODUCTION_ENABLED=false'].join('\n'), 'utf8')
  const nginx = join(output, 'docker-local-http.conf')
  await writeFile(nginx, 'worker_processes 1; events { worker_connections 256; } http { include /etc/nginx/mime.types; server { listen 8080; root /usr/share/nginx/html; location /api/ { proxy_pass http://application:8080; } location /actuator/ { proxy_pass http://application:8080; } location / { try_files $uri $uri/ /index.html; } } }', 'utf8')
  let networkCreated = false, pgConnected = false, appCreated = false, gatewayCreated = false, context
  const report = { status: 'error', scope: '本地HTTP配置、同一原生PG、真实应用与网关镜像；不代表生产TLS或外部系统验收' }
  const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex')
  async function compareTree(expected, actual) {
    let count = 0
    const entries = await readdir(expected, { withFileTypes: true })
    assert.deepEqual(entries.map(entry => entry.name).sort(), (await readdir(actual)).sort(), '镜像文件集合必须与已验证制品相同')
    for (const entry of entries) {
      const left = join(expected, entry.name), right = join(actual, entry.name)
      if (entry.isDirectory()) count += await compareTree(left, right)
      else { assert.equal(await digest(left), await digest(right), `镜像静态文件不符：${relative(artifacts, left)}`); count++ }
    }
    return count
  }
  try {
    docker('network', 'create', '--label', 'ai02.owner=AI-02', '--label', `ai02.run=${prefix}`, network); networkCreated = true
    docker('network', 'connect', '--alias', 'database', network, pg); pgConnected = true
    docker('create', '--name', app, '--label', 'ai02.owner=AI-02', '--label', `ai02.run=${prefix}`, '--network', network, '--network-alias', 'application', '--memory', '384m',
      '--env-file', envFile, '--entrypoint', 'java', process.env.AI02_DOCKER_APPLICATION_IMAGE, '-Xmx192m', '-jar', '/app/app.jar'); appCreated = true
    docker('start', app)
    docker('create', '--name', gateway, '--label', 'ai02.owner=AI-02', '--label', `ai02.run=${prefix}`, '--network', network, '--memory', '64m', '-p', '127.0.0.1:15183:8080',
      '--mount', `type=bind,source=${nginx},target=/etc/nginx/nginx.conf,readonly`, process.env.AI02_DOCKER_GATEWAY_IMAGE); gatewayCreated = true
    docker('start', gateway)
    report.applicationImage = docker('inspect', '--format', '{{.Image}}', app)
    report.gatewayImage = docker('inspect', '--format', '{{.Image}}', gateway)
    const request = await browser.newContext()
    try {
      const deadline = Date.now() + 90000
      let ready = false, lastFailure = '尚未收到健康响应'
      while (Date.now() < deadline) {
        try { const response = await request.request.get('http://127.0.0.1:15183/actuator/health', { timeout: 3000 }); ready = response.ok() && (await response.json()).status === 'UP'; if (!ready) lastFailure = `健康状态未UP，HTTP ${response.status()}` }
        catch (error) { lastFailure = error.message }
        if (ready) break
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      assert.ok(ready, `Docker应用须在90秒内真实启动并连接本轮PG：${lastFailure}`)
    } finally { await request.close() }
    await mkdir(join(output, 'image-dist'), { recursive: true })
    docker('cp', `${app}:/app/app.jar`, join(output, 'image-app.jar'))
    assert.equal(await digest(join(artifacts, 'app.jar')), await digest(join(output, 'image-app.jar')))
    report.jarSha256 = await digest(join(output, 'image-app.jar'))
    docker('cp', `${gateway}:/usr/share/nginx/html/.`, join(output, 'image-dist'))
    report.staticFilesCompared = await compareTree(join(artifacts, 'dist'), join(output, 'image-dist'))
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const token = snapshot.lgs_hold.length ? 'AI02-TEST-211' : 'AI02-TEST-221'
    await context.addInitScript(token => { localStorage.setItem('jxc.token', token); localStorage.setItem('jxc.countryId', '101') }, token)
    const page = await context.newPage(), errors = [], mutations = [], ownerReferences = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push(`${request.method()} ${new URL(request.url()).pathname}`) })
    page.on('response', response => {
      const url = new URL(response.url())
      if (url.pathname.startsWith('/api/') && response.status() >= 400) errors.push(`${response.status()} ${url.pathname}`)
      if (url.pathname.endsWith('/sys/business-user-options') && url.searchParams.get('purpose') === 'LOGISTICS_HOLD')
        ownerReferences.push({ status: response.status(), purpose: 'LOGISTICS_HOLD' })
    })
    const checks = snapshot.lgs_hold.length
      ? [{ route: `/logistics/shipments/${snapshot.lgs_shipment[0].id}`, docNo: snapshot.lgs_shipment[0].doc_no },
         { route: '/logistics/holds', docNo: snapshot.lgs_hold[0].doc_no }]
      : snapshot.lgs_receipt.map(receipt => ({ route: `/logistics/receipts/${receipt.id}`, docNo: receipt.doc_no, receipt }))
    assert.equal(checks.length, snapshot.lgs_hold.length ? 2 : 1)
    report.pages = []
    for (const [index, check] of checks.entries()) {
      ownerReferences.length = 0
      await page.goto(`http://127.0.0.1:15183${check.route}`, { waitUntil: 'networkidle' })
      await page.getByText(check.docNo, { exact: false }).first().waitFor({ state: 'visible' })
      if (check.receipt) await assertReceiptFacts(page, check.receipt)
      else await selectHoldOwner(page, check.route, ownerReferences)
      await page.screenshot({ path: join(output, `docker-${index}.png`), fullPage: true })
      report.pages.push({ route: check.route, docNo: check.docNo, status: 'passed', ownerReferences: [...ownerReferences] })
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(mutations, [], '镜像实收读回不应发起业务写请求')
    report.status = 'ok'; report.ownerReferences = report.pages.flatMap(check => check.ownerReferences); report.actualPageReads = checks.length; report.businessPostCommands = 0
  } catch (error) { report.reason = error.message; throw error }
  finally {
    const cleanup = []
    async function clean(action, work) { try { await work(); cleanup.push({ action, status: 'ok' }) } catch (error) { cleanup.push({ action, status: 'error', reason: error.message }) } }
    await clean('close-own-context', async () => context?.close())
    if (appCreated) await clean('capture-own-app-log', async () => writeFile(join(output, 'docker-application.log'), docker('logs', app), 'utf8'))
    if (gatewayCreated) await clean('remove-own-gateway', async () => docker('rm', '-f', gateway))
    if (appCreated) await clean('remove-own-app', async () => docker('rm', '-f', app))
    if (pgConnected) await clean('disconnect-own-test-pg', async () => docker('network', 'disconnect', network, pg))
    if (networkCreated) await clean('remove-own-network', async () => docker('network', 'rm', network))
    await clean('delete-own-private-env', async () => unlink(envFile))
    report.cleanup = cleanup
    if (cleanup.some(item => item.status === 'error')) report.status = 'error'
    await writeFile(join(output, 'docker-result.json'), JSON.stringify(report, null, 2), 'utf8')
    if (!report.reason) assert.equal(report.status, 'ok', '本组Docker资源清理失败，详见结构化结果')
  }
}
