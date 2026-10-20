export interface CommandIntent {
  run<T>(context: string, endpoint: string, body: unknown, send: (key: string) => Promise<T>): Promise<T>
  reset(): void
}

export function commandPayloadFingerprint(body: unknown): string {
  // Match JSON transport semantics first (Dates, omitted undefined properties), then ignore object-key order.
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]))
    return value
  }
  return JSON.stringify(normalize(JSON.parse(JSON.stringify(body ?? null))))
}

/** Explicit per-page/dialog intent. It sends once, retains a failed key, and never retries a request itself. */
export function createCommandIntent(newKey: () => string = newIdempotencyKey): CommandIntent {
  type Pending = { fingerprint: string; key: string; promise?: Promise<unknown> }
  const pending = new Map<string, Pending>()
  let previousContext: string | undefined
  return {
    reset() { pending.clear() },
    run<T>(context: string, endpoint: string, body: unknown, send: (key: string) => Promise<T>): Promise<T> {
      if (previousContext !== context) { pending.clear(); previousContext = context }
      const fingerprint = commandPayloadFingerprint(body)
      let operation = pending.get(endpoint)
      if (!operation || operation.fingerprint !== fingerprint) {
        operation = { fingerprint, key: newKey() }
        pending.set(endpoint, operation)
      }
      if (operation.promise) return operation.promise as Promise<T>
      const active = operation
      const promise = Promise.resolve().then(() => send(active.key)).then(
        result => { if (pending.get(endpoint) === active) pending.delete(endpoint); return result },
        error => { active.promise = undefined; throw error },
      )
      active.promise = promise
      return promise
    },
  }
}

/** The server version read at dialog open survives display and submit transforms. */
export function withEditVersion<T extends object>(payload: T, originalVersion: number | undefined): T & { version: number | undefined } {
  return { ...payload, version: originalVersion }
}

export function newIdempotencyKey() { return crypto.randomUUID() }
