import { FatalError, RetriableError } from './client'
import type { LlmClient, LlmEvent, LlmRequest } from './client'

export interface OllamaOptions {
  model: string
  /** where Ollama is listening */
  host?: string
  /**
   * The context window to ask for, in tokens. Ollama's own default is small (4096) and it silently cuts off the start of
   * a longer prompt, so the reviewer would quietly lose the instructions. Bigger costs more memory.
   */
  numCtx?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * A model running on this machine through Ollama: free, and nothing leaves the computer. It needs no key. The prompt is
 * sized to fit the context window (about three characters per token, leaving room for the instructions and the answer).
 */
export class OllamaClient implements LlmClient {
  readonly name: string
  readonly budgetChars: number
  readonly maxConcurrency = 1
  private readonly o: Required<Omit<OllamaOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch }

  constructor(o: OllamaOptions) {
    // options passed as undefined mean "use the default" (a plain spread would let them wipe the defaults out)
    this.o = { model: o.model, host: (o.host ?? 'http://localhost:11434').replace(/\/$/, ''), numCtx: o.numCtx ?? 16384, timeoutMs: o.timeoutMs ?? 15 * 60_000, fetchImpl: o.fetchImpl ?? fetch }
    this.name = `ollama:${o.model}`
    this.budgetChars = Math.max(4000, (this.o.numCtx - 3500 - 2048) * 3)
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    const timeout = AbortSignal.timeout(this.o.timeoutMs)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    let res: Response
    try {
      res = await this.o.fetchImpl(`${this.o.host}/api/chat`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.o.model,
          stream: true,
          messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
          options: { temperature: 0, num_ctx: this.o.numCtx, num_predict: req.maxTokens },
        }),
      })
    } catch (e) {
      const name = (e as Error).name
      if (name === 'TimeoutError') throw new RetriableError('Ollama took too long to answer')
      if (name === 'AbortError') throw e
      throw new FatalError(`Cannot reach Ollama at ${this.o.host}. Is it installed and running? (start it with "ollama serve")`)
    }
    if (!res.ok) {
      let detail = ''
      try { detail = ((await res.json()) as { error?: string }).error ?? '' } catch { /* not json */ }
      if (res.status === 404 || /not found/i.test(detail)) throw new FatalError(`Ollama does not have the model "${this.o.model}". Download it with: ollama pull ${this.o.model}`)
      const msg = `Ollama HTTP ${res.status}${detail ? `: ${detail}` : ''}`
      if (res.status >= 500 || res.status === 429) throw new RetriableError(msg)
      throw new FatalError(msg)
    }
    if (!res.body) throw new RetriableError('empty response body')

    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    let buf = ''
    const lines = function* (flush: boolean) {
      for (;;) {
        const i = buf.indexOf('\n')
        if (i < 0) break
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) yield line
      }
      if (flush && buf.trim()) { const l = buf.trim(); buf = ''; yield l }
    }
    const handle = function* (line: string): Generator<LlmEvent> {
      let d: any
      try { d = JSON.parse(line) } catch { return }
      if (d.error) throw new FatalError(`Ollama error: ${d.error}`)
      if (typeof d.message?.content === 'string' && d.message.content) yield { type: 'text', text: d.message.content }
      if (d.done) yield { type: 'usage', inputTokens: d.prompt_eval_count, outputTokens: d.eval_count }
    }
    try {
      for (;;) {
        let r: ReadableStreamReadResult<Uint8Array>
        try { r = await reader.read() } catch (e) { throw new RetriableError(`stream broke: ${(e as Error).message}`) }
        if (r.done) { buf += decoder.decode(); for (const l of lines(true)) yield* handle(l); break }
        buf += decoder.decode(r.value, { stream: true })
        for (const l of lines(false)) yield* handle(l)
      }
    } finally { reader.releaseLock() }
  }
}

/** The models already downloaded to this machine, so a wrong name gets a useful answer instead of an error. */
export async function listOllamaModels(host = 'http://localhost:11434', fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${host.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new FatalError(`Ollama HTTP ${res.status}`)
  return (((await res.json()) as { models?: { name: string }[] }).models ?? []).map((m) => m.name)
}
