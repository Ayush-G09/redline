import { FatalError, RetriableError, SseParser } from './client'
import type { LlmClient, LlmEvent, LlmRequest } from './client'

export interface GeminiOptions {
  apiKey: string
  /** a model id as listed by the API, e.g. "gemini-flash-latest" (see listGeminiModels) */
  model: string
  baseUrl?: string
  timeoutMs?: number
  /** override the size of prompt to send (characters) */
  budgetChars?: number
  fetchImpl?: typeof fetch
}

const BASE = 'https://generativelanguage.googleapis.com'

/** "33s", "0.5s" or "1.2s" as Google writes retry delays, in milliseconds. */
export function parseDelay(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const m = /^(\d+(?:\.\d+)?)s$/.exec(v)
  return m ? Math.round(Number(m[1]) * 1000) : undefined
}

/** Longest we will wait for a rate limit to clear. Past this, it is a "come back later" the reviewer should not sit through. */
const MAX_WAIT_MS = 90_000

/**
 * Turns a Gemini error into something the reviewer can act on: wait and retry (a short rate limit or a busy server), or
 * stop with a message that says what to do (a daily quota that is used up, a bad key, an unknown model).
 */
export function geminiError(status: number, body: any, retryAfterHeader: string | null): RetriableError | FatalError {
  const e = body?.error ?? {}
  const text = `${e.message ?? ''}`.trim()
  const raw = JSON.stringify(body ?? {})
  const base = `Gemini API HTTP ${status}${e.status ? ` ${e.status}` : ''}${text ? `: ${text}` : ''}`
  if (status === 429 || e.status === 'RESOURCE_EXHAUSTED') {
    if (/PerDay/i.test(raw)) return new FatalError(`${base}. The free daily quota for this model is used up: try again tomorrow, or pick another model (each has its own quota).`)
    const info = Array.isArray(e.details) ? e.details.find((d: any) => String(d?.['@type'] ?? '').endsWith('RetryInfo')) : undefined
    const wait = parseDelay(info?.retryDelay) ?? (Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) * 1000 : 20_000)
    if (wait > MAX_WAIT_MS) return new FatalError(`${base}. Rate limited for about ${Math.round(wait / 1000)}s; try again later.`)
    return new RetriableError(base, wait)
  }
  if (status >= 500 || e.status === 'UNAVAILABLE' || e.status === 'INTERNAL' || e.status === 'DEADLINE_EXCEEDED') return new RetriableError(base)
  if (status === 404) return new FatalError(`${base}. That model name is not available to this key: list the ones that are with "npm run models".`)
  if (status === 400 && /api key/i.test(text)) return new FatalError(`${base}. Check the key.`)
  return new FatalError(base)
}

/**
 * Google's Gemini API over plain fetch, streaming. The key goes in a header (never in the URL, where it would end up in
 * logs), and is never included in an error message. Gemini's free tier allows a limited number of requests per day, so
 * the default prompt size is large: most pull requests then need a single request.
 */
export class GeminiClient implements LlmClient {
  readonly name: string
  readonly budgetChars: number
  readonly maxConcurrency = 1
  private readonly o: Required<Omit<GeminiOptions, 'budgetChars' | 'fetchImpl'>> & { fetchImpl: typeof fetch }

  constructor(o: GeminiOptions) {
    if (!o.apiKey) throw new FatalError('no Gemini API key given')
    // the free tier's streaming endpoint occasionally hangs under load with no response at all; fail that fast so a retry
    // gets a fresh connection instead of sitting out a long timeout
    this.o = { model: o.model, apiKey: o.apiKey, baseUrl: (o.baseUrl ?? BASE).replace(/\/$/, ''), timeoutMs: o.timeoutMs ?? 45_000, fetchImpl: o.fetchImpl ?? fetch }
    this.name = `gemini:${o.model}`
    this.budgetChars = o.budgetChars ?? 300_000
  }

  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    const debug = !!process.env.REDLINE_DEBUG
    const t0 = Date.now()
    const timeout = AbortSignal.timeout(this.o.timeoutMs)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    const model = this.o.model.replace(/^models\//, '')
    if (debug) console.error(`    [gemini] request start (timeout ${this.o.timeoutMs}ms)`)
    let res: Response
    try {
      // belt and suspenders: race the fetch itself against our own timer, in case a hung connection does not honour
      // the abort signal the way we expect on this platform.
      const guard = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('local guard timeout')), this.o.timeoutMs + 5000))
      res = await Promise.race([
        this.o.fetchImpl(`${this.o.baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.o.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: req.system }] },
            contents: [{ role: 'user', parts: [{ text: req.user }] }],
            // room for the model's own reasoning as well as the answer, which count against the same limit
            generationConfig: { temperature: 0, maxOutputTokens: Math.max(req.maxTokens, 8192) },
          }),
        }),
        guard,
      ])
      if (debug) console.error(`    [gemini] got response headers after ${Date.now() - t0}ms, status ${res.status}`)
    } catch (e) {
      if (debug) console.error(`    [gemini] fetch failed after ${Date.now() - t0}ms: ${(e as Error).name} ${(e as Error).message}`)
      throw new RetriableError(`network error: ${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message}`)
    }
    if (!res.ok) {
      let body: any
      try { body = await res.json() } catch { /* not json */ }
      throw geminiError(res.status, body, res.headers.get('retry-after'))
    }
    if (!res.body) throw new RetriableError('empty response body')

    const sse = new SseParser()
    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    let usage: { inputTokens?: number; outputTokens?: number } | undefined // Gemini repeats running totals in every chunk, so keep only the last
    try {
      for (;;) {
        let r: ReadableStreamReadResult<Uint8Array>
        try { r = await reader.read() } catch (e) { throw new RetriableError(`stream broke: ${(e as Error).message}`) }
        if (r.done) break
        for (const f of sse.push(decoder.decode(r.value, { stream: true }))) {
          let d: any
          try { d = JSON.parse(f.data) } catch { continue }
          if (d.error) throw geminiError(Number(d.error.code) || 500, d, null)
          if (d.promptFeedback?.blockReason) throw new FatalError(`Gemini refused the prompt (${d.promptFeedback.blockReason})`)
          for (const p of d.candidates?.[0]?.content?.parts ?? []) {
            if (typeof p.text === 'string' && p.thought !== true) yield { type: 'text', text: p.text }
          }
          const fin = d.candidates?.[0]?.finishReason
          if (fin && ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(fin)) throw new FatalError(`Gemini stopped the answer (${fin})`)
          if (d.usageMetadata) usage = { inputTokens: d.usageMetadata.promptTokenCount, outputTokens: d.usageMetadata.candidatesTokenCount }
        }
      }
    } finally { reader.releaseLock() }
    if (usage) yield { type: 'usage', ...usage }
  }
}

/** The models this key can use for generating text, so nobody has to guess names that change. */
export async function listGeminiModels(apiKey: string, fetchImpl: typeof fetch = fetch, baseUrl = BASE): Promise<{ id: string; description: string }[]> {
  const out: { id: string; description: string }[] = []
  let page = ''
  for (let i = 0; i < 10; i++) {
    const res = await fetchImpl(`${baseUrl}/v1beta/models?pageSize=100${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, { headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw geminiError(res.status, await res.json().catch(() => undefined), res.headers.get('retry-after'))
    const j = (await res.json()) as { models?: any[]; nextPageToken?: string }
    for (const m of j.models ?? []) {
      if (Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent')) out.push({ id: String(m.name).replace(/^models\//, ''), description: String(m.displayName ?? '') })
    }
    if (!j.nextPageToken) break
    page = j.nextPageToken
  }
  return out
}
