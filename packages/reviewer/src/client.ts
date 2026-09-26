export interface LlmRequest {
  system: string
  user: string
  maxTokens: number
  signal?: AbortSignal
}

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }

/** The only thing the reviewer needs from a model: send a prompt, get text back as it is written. */
export interface LlmClient {
  readonly name: string
  stream(req: LlmRequest): AsyncIterable<LlmEvent>
}

/** The provider is busy or slow (HTTP 429, 5xx, 529 overloaded, a network drop): trying again later may work. */
export class RetriableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message)
  }
}

/** The request itself is wrong (bad key, unknown model, too large): trying again will not help. */
export class FatalError extends Error {}

/** Splits a server-sent-events byte stream into frames, whatever way the network chunks it. */
export class SseParser {
  private buf = ''
  push(chunk: string): { event: string; data: string }[] {
    this.buf += chunk
    const out: { event: string; data: string }[] = []
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buf)
      if (!m) break
      const raw = this.buf.slice(0, m.index)
      this.buf = this.buf.slice(m.index + m[0].length)
      let event = 'message'
      const data: string[] = []
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith(':')) continue // comment / keep-alive
        const i = line.indexOf(':')
        const field = i < 0 ? line : line.slice(0, i)
        const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '')
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      if (data.length) out.push({ event, data: data.join('\n') })
    }
    return out
  }
}

export interface AnthropicOptions {
  apiKey: string
  model: string
  baseUrl?: string
  /** give up on a request after this long (ms) */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const retriable = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500

/**
 * Anthropic Messages API with streaming, over plain fetch. The key is only ever sent as a header: it is never
 * logged, put in an error message, or kept anywhere but this object.
 */
export class AnthropicClient implements LlmClient {
  readonly name: string
  private readonly opts: Required<Omit<AnthropicOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch }

  constructor(o: AnthropicOptions) {
    if (!o.apiKey) throw new FatalError('no API key given')
    this.opts = { baseUrl: 'https://api.anthropic.com', timeoutMs: 120_000, fetchImpl: fetch, ...o }
    this.name = `anthropic:${o.model}`
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    let res: Response
    try {
      res = await this.opts.fetchImpl(`${this.opts.baseUrl}/v1/messages`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'x-api-key': this.opts.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: this.opts.model,
          max_tokens: req.maxTokens,
          temperature: 0,
          stream: true,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
        }),
      })
    } catch (e) {
      throw new RetriableError(`network error: ${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message}`)
    }
    if (!res.ok) {
      let detail = ''
      try { detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '' } catch { /* not json */ }
      const secs = Number(res.headers.get('retry-after'))
      const msg = `Anthropic API HTTP ${res.status}${detail ? `: ${detail}` : ''}`
      if (retriable(res.status)) throw new RetriableError(msg, Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined)
      throw new FatalError(msg)
    }
    if (!res.body) throw new RetriableError('empty response body')

    const sse = new SseParser()
    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    try {
      for (;;) {
        let r: ReadableStreamReadResult<Uint8Array>
        try { r = await reader.read() } catch (e) { throw new RetriableError(`stream broke: ${(e as Error).message}`) }
        if (r.done) break
        for (const f of sse.push(decoder.decode(r.value, { stream: true }))) {
          let d: any
          try { d = JSON.parse(f.data) } catch { continue }
          if (f.event === 'content_block_delta' && d.delta?.type === 'text_delta' && typeof d.delta.text === 'string') yield { type: 'text', text: d.delta.text }
          else if (f.event === 'message_start') yield { type: 'usage', inputTokens: d.message?.usage?.input_tokens, outputTokens: d.message?.usage?.output_tokens }
          else if (f.event === 'message_delta' && d.usage) yield { type: 'usage', outputTokens: d.usage.output_tokens }
          else if (f.event === 'error') {
            const t = d.error?.type as string | undefined
            const msg = `Anthropic stream error: ${d.error?.message ?? t ?? 'unknown'}`
            if (t === 'overloaded_error' || t === 'api_error' || t === 'rate_limit_error') throw new RetriableError(msg)
            throw new FatalError(msg)
          }
        }
      }
    } finally { reader.releaseLock() }
  }
}
