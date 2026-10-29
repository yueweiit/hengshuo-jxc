import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './contracts/load-ts-module.mjs'

const { createPurchaseImportCatalogImages } = loadTsModule(new URL('../src/modules/purchase/purchaseImportCatalogImages.ts', import.meta.url))
const photo = (id, productId, extra = {}) => ({ id, productId, isPrimary: false, sortOrder: 0, ...extra })
const blob = () => new Blob(['photo'], { type: 'image/png' })

test('商品目录主图优先且相同商品并发只读一次，图片字节复用原图片读取器', async t => {
  let finish, calls = 0, reads = 0
  const cache = createPurchaseImportCatalogImages(async () => { calls++; return new Promise(resolve => { finish = resolve }) }, async () => { reads++; return blob() }, () => '101:batch')
  t.after(() => cache.reset())
  const first = cache.loadProduct(501), second = cache.loadProduct(501)
  assert.equal(first, second); assert.equal(cache.entries.value[501].status, 'loading')
  finish([photo(11, 501), photo(12, 501, { isPrimary: true, sortOrder: 9 })])
  assert.deepEqual(await first, { status: 'ok', imageId: 12 })
  assert.deepEqual(await cache.loadProduct(501), { status: 'ok', imageId: 12 }); assert.equal(calls, 1)
  const loaded = await cache.images.load(12)
  assert.equal(loaded.status, 'ok'); assert.equal((await cache.images.load(12)).url, loaded.url); assert.equal(reads, 1)
})

test('无商品照片是成功空结果，目录调用失败保留原因并可重试', async t => {
  let fail = true
  const cache = createPurchaseImportCatalogImages(async id => { if (id === 502 && fail) throw new Error('照片目录无权访问'); return [] }, async () => blob(), () => '101:batch')
  t.after(() => cache.reset())
  assert.deepEqual(await cache.loadProduct(501), { status: 'ok', imageId: null })
  assert.deepEqual(await cache.loadProduct(502), { status: 'error', message: '照片目录无权访问' })
  fail = false
  assert.deepEqual(await cache.loadProduct(502), { status: 'ok', imageId: null })
})

test('错误目录结构和其他商品图片不会冒充无图或当前商品照片', async t => {
  for (const payload of [{ records: [] }, [photo(9, 999)], [photo(0, 501)]]) {
    const cache = createPurchaseImportCatalogImages(async () => payload, async () => blob(), () => '101:batch')
    t.after(() => cache.reset())
    const result = await cache.loadProduct(501)
    assert.equal(result.status, 'error'); assert.match(result.message, /商品照片目录响应/)
  }
})

test('切国家或批次后丢弃迟到照片目录并中止请求，新上下文可重新加载相同商品', async t => {
  let finish, oldSignal, scope = '101:batch', calls = 0
  const cache = createPurchaseImportCatalogImages(async (_id, signal) => {
    if (++calls === 1) { oldSignal = signal; return new Promise(resolve => { finish = resolve }) }
    return [photo(22, 501)]
  }, async () => blob(), () => scope)
  t.after(() => cache.reset())
  const stale = cache.loadProduct(501)
  scope = '102:other'; cache.reset()
  assert.equal(oldSignal.aborted, true)
  assert.deepEqual(await cache.loadProduct(501), { status: 'ok', imageId: 22 })
  finish([photo(11, 501)])
  assert.deepEqual(await stale, { status: 'stale' }); assert.equal(cache.entries.value[501].imageId, 22)
})

test('实际命中照片读取失败如实保留且可重试，不以目录其他照片替代', async t => {
  let fail = true, lists = 0
  const cache = createPurchaseImportCatalogImages(async () => { lists++; return [photo(99, 501)] }, async id => {
    assert.equal(id, 12)
    if (fail) throw new Error('本次命中照片已失效')
    return blob()
  }, () => '101:batch')
  t.after(() => cache.reset())
  assert.deepEqual(await cache.images.load(12), { status: 'error', message: '本次命中照片已失效' })
  fail = false; assert.equal((await cache.images.load(12)).status, 'ok'); assert.equal(lists, 0)
})

test('图片字节无法显示时可以单图重新读取，替换失效URL而保留其他照片缓存', async t => {
  let reads = 0
  const cache = createPurchaseImportCatalogImages(async () => [], async () => { reads++; return blob() }, () => '101:batch')
  t.after(() => cache.reset())
  const first = await cache.images.load(12), other = await cache.images.load(13)
  const retried = await cache.images.reload(12)
  assert.equal(retried.status, 'ok'); assert.notEqual(retried.url, first.url)
  assert.equal((await cache.images.load(13)).url, other.url); assert.equal(reads, 3)
})
