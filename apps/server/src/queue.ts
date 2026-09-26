/** A handler throws this to say "try this job again later". Anything else it throws is a real failure. */
export class RetryJob extends Error {
  constructor(message: string, readonly afterMs?: number) { super(message) }
}

export interface QueueOptions {
  /** jobs for different keys that may run at once */
  concurrency: number
  /** extra attempts after the first */
  retries: number
  backoffMs: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  onEvent?: (e: { type: 'start' | 'done' | 'retry' | 'failed' | 'superseded' | 'cancelled'; key: string; detail?: string }) => void
}

export interface Failed<T> { key: string; data: T; error: string; at: number }

const abortableSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve()
  const t = setTimeout(() => { signal.removeEventListener('abort', done); resolve() }, ms)
  const done = () => { clearTimeout(t); resolve() }
  signal.addEventListener('abort', done, { once: true })
})

/**
 * A queue where jobs have a key (here, one pull request). Rules:
 *  - a key never has two jobs running at once;
 *  - if a newer job arrives for a key, any job still waiting for that key is dropped, and one already running is told to
 *    stop (its signal aborts), because the newer one makes it out of date. Only the latest is ever waiting;
 *  - jobs for different keys run in parallel up to `concurrency`, oldest first;
 *  - a job that asks to be retried waits (with backoff) and runs again, unless something newer arrived in the meantime.
 */
export class KeyedQueue<T> {
  private readonly waiting = new Map<string, T>()
  private readonly order: string[] = []
  private readonly running = new Map<string, AbortController>()
  private active = 0
  private idleWaiters: (() => void)[] = []
  readonly stats = { enqueued: 0, completed: 0, failed: 0, retried: 0, superseded: 0 }
  readonly failed: Failed<T>[] = []

  constructor(private readonly handler: (data: T, ctx: { signal: AbortSignal; attempt: number; key: string }) => Promise<void>, private readonly opts: QueueOptions) {}

  get size() { return this.waiting.size + this.running.size }

  enqueue(key: string, data: T): 'queued' | 'replaced' {
    this.stats.enqueued++
    const replaced = this.waiting.has(key)
    if (replaced) { this.stats.superseded++; this.opts.onEvent?.({ type: 'superseded', key, detail: 'waiting job replaced' }) }
    else this.order.push(key)
    this.waiting.set(key, data)
    const r = this.running.get(key)
    if (r && !r.signal.aborted) { r.abort(); this.stats.superseded++; this.opts.onEvent?.({ type: 'superseded', key, detail: 'running job told to stop' }) }
    this.pump()
    return replaced ? 'replaced' : 'queued'
  }

  /** Resolves when nothing is running or waiting. */
  idle(): Promise<void> {
    if (this.size === 0) return Promise.resolve()
    return new Promise((r) => this.idleWaiters.push(r))
  }

  private pump() {
    while (this.active < this.opts.concurrency) {
      const at = this.order.findIndex((k) => !this.running.has(k))
      if (at < 0) break
      const [key] = this.order.splice(at, 1)
      const data = this.waiting.get(key) as T
      this.waiting.delete(key)
      this.start(key, data)
    }
  }

  private start(key: string, data: T) {
    this.active++
    const ctl = new AbortController()
    this.running.set(key, ctl)
    void this.run(key, data, ctl).finally(() => {
      this.running.delete(key)
      this.active--
      this.pump()
      if (this.size === 0) { const w = this.idleWaiters; this.idleWaiters = []; w.forEach((r) => r()) }
    })
  }

  private async run(key: string, data: T, ctl: AbortController) {
    const sleep = this.opts.sleep ?? abortableSleep
    for (let attempt = 0; ; attempt++) {
      if (ctl.signal.aborted) { this.opts.onEvent?.({ type: 'cancelled', key }); return }
      this.opts.onEvent?.({ type: 'start', key, detail: `attempt ${attempt + 1}` })
      try {
        await this.handler(data, { signal: ctl.signal, attempt, key })
        if (ctl.signal.aborted) { this.opts.onEvent?.({ type: 'cancelled', key }); return } // finished, but a newer job made it out of date
        this.stats.completed++
        this.opts.onEvent?.({ type: 'done', key })
        return
      } catch (e) {
        if (ctl.signal.aborted) { this.opts.onEvent?.({ type: 'cancelled', key }); return }
        if (e instanceof RetryJob && attempt < this.opts.retries) {
          this.stats.retried++
          this.opts.onEvent?.({ type: 'retry', key, detail: e.message })
          await sleep(e.afterMs ?? this.opts.backoffMs * 2 ** attempt, ctl.signal)
          continue
        }
        this.stats.failed++
        this.failed.push({ key, data, error: (e as Error).message, at: Date.now() })
        if (this.failed.length > 100) this.failed.shift()
        this.opts.onEvent?.({ type: 'failed', key, detail: (e as Error).message })
        return
      }
    }
  }
}
