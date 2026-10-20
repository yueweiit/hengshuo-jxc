/** Remove only this app's former demo interceptor. Business storage is never touched. */
export async function retireMockWorker(
  workers: Pick<ServiceWorkerContainer, 'getRegistrations' | 'controller'> | undefined,
  cacheStorage: Pick<CacheStorage, 'keys' | 'delete'> | undefined,
): Promise<boolean> {
  const isMock = (url: string | undefined) => !!url && /\/mockServiceWorker\.js(?:\?|$)/.test(url)
  const controlled = isMock(workers?.controller?.scriptURL)
  if (workers) {
    const registrations = await workers.getRegistrations()
    await Promise.all(registrations.filter(registration =>
      [registration.active, registration.waiting, registration.installing].some(worker => isMock(worker?.scriptURL)),
    ).map(registration => registration.unregister()))
  }
  if (cacheStorage) {
    const names = await cacheStorage.keys()
    await Promise.all(names.filter(name => /^(?:msw[:\-]|mock-service-worker)/i.test(name)).map(name => cacheStorage.delete(name)))
  }
  return controlled
}
