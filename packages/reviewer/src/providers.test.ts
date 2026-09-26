import { describe, expect, it } from 'vitest'
import { FatalError, RetriableError } from './client'
import type { LlmEvent } from './client'
import { GeminiClient, geminiError, listGeminiModels, parseDelay } from './gemini'
import { listOllamaModels, OllamaClient } from './ollama'
import { createClient, DEFAULT_MODEL } from './providers'

const KEY = 'AIzaSyTEST-SECRET-KEY-0123456789'
const streamOf = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close() } })
const collect = async (it: AsyncIterable<LlmEvent>) => { const out: LlmEvent[] = []; for await (const e of it) out.push(e); return out }
const text = (events: LlmEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')
const req = { system: 'sys', user: 'usr', maxTokens: 1000 }

const chunk = (parts: unknown[], extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ candidates: [{ content: { parts } }], ...extra })}\r\n\r\n`
const geminiFetch = (body: string, seen: { url?: string; init?: RequestInit } = {}) => (async (url: string, init: RequestInit) => { seen.url = url; seen.init = init; return new Response(streamOf([body.slice(0, 37), body.slice(37)]), { status: 200 }) }) as unknown as typeof fetch
const gemini = (f: typeof fetch, model = 'gemini-test') => new GeminiClient({ apiKey: KEY, model, fetchImpl: f })
const errResponse = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) => (async () => new Response(JSON.stringify({ error }), { status, headers })) as unknown as typeof fetch

describe('GeminiClient', () => {
  it('streams text, skips the model\'s private reasoning, and reports usage once', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const body = chunk([{ text: 'thinking...', thought: true }, { text: 'Hel' }]) + chunk([{ text: 'lo' }], { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 3 } }) + chunk([{ text: '!' }], { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5 } })
    const ev = await collect(gemini(geminiFetch(body, seen)).stream(req))
    expect(text(ev)).toBe('Hello!')
    expect(ev.filter((e) => e.type === 'usage')).toEqual([{ type: 'usage', inputTokens: 50, outputTokens: 5 }]) // the running totals are not added up
    expect(seen.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse')
    const sent = JSON.parse(seen.init?.body as string)
    expect(sent.systemInstruction.parts[0].text).toBe('sys')
    expect(sent.contents).toEqual([{ role: 'user', parts: [{ text: 'usr' }] }])
    expect(sent.generationConfig).toMatchObject({ temperature: 0 })
    expect(sent.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(8192)
  })

  it('sends the key in a header, never in the URL', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    await collect(gemini(geminiFetch(chunk([{ text: 'x' }]), seen)).stream(req))
    expect(seen.url).not.toContain(KEY)
    expect(seen.url).not.toContain('key=')
    expect((seen.init?.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY)
  })

  it('accepts a model written as models/<name>', async () => {
    const seen: { url?: string } = {}
    await collect(gemini(geminiFetch(chunk([{ text: 'x' }]), seen), 'models/gemini-x').stream(req))
    expect(seen.url).toContain('/models/gemini-x:stream')
  })

  it('has a big prompt budget and runs one prompt at a time (the free tier counts requests)', () => {
    const c = gemini(geminiFetch(''))
    expect(c.budgetChars).toBeGreaterThan(100_000)
    expect(c.maxConcurrency).toBe(1)
  })

  it('stops with a clear message when the answer is blocked', async () => {
    const blocked = chunk([], { promptFeedback: { blockReason: 'OTHER' } })
    expect(await collect(gemini(geminiFetch(blocked)).stream(req)).catch((e) => e)).toBeInstanceOf(FatalError)
    const stopped = `data: ${JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] })}\r\n\r\n`
    expect(await collect(gemini(geminiFetch(stopped)).stream(req)).catch((e) => e)).toBeInstanceOf(FatalError)
  })

  it('refuses to be built without a key', () => expect(() => new GeminiClient({ apiKey: '', model: 'm' })).toThrow(FatalError))

  it('turns a network failure into a retriable error', async () => {
    const f = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    expect(await collect(gemini(f).stream(req)).catch((e) => e)).toBeInstanceOf(RetriableError)
  })

  it('handles an error that arrives in the middle of the stream', async () => {
    const body = chunk([{ text: 'partial' }]) + `data: ${JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } })}\r\n\r\n`
    const err = await collect(gemini(geminiFetch(body)).stream(req)).catch((e) => e)
    expect(err).toBeInstanceOf(RetriableError)
  })
})

describe('Gemini errors: what to do about each', () => {
  const retryInfo = (delay: string) => [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }]
  it('a short rate limit is retried after the wait Google names', () => {
    const e = geminiError(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'slow', details: retryInfo('33s') } }, null)
    expect(e).toBeInstanceOf(RetriableError)
    expect((e as RetriableError).retryAfterMs).toBe(33_000)
  })
  it('falls back to retry-after, then to a default wait', () => {
    expect((geminiError(429, { error: { status: 'RESOURCE_EXHAUSTED' } }, '7') as RetriableError).retryAfterMs).toBe(7000)
    expect((geminiError(429, { error: { status: 'RESOURCE_EXHAUSTED' } }, null) as RetriableError).retryAfterMs).toBe(20_000)
  })
  it('a used-up daily quota is not retried: it says what to do', () => {
    const e = geminiError(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } }, null)
    expect(e).toBeInstanceOf(FatalError)
    expect(e.message).toMatch(/tomorrow|another model/)
  })
  it('a rate limit that would take minutes to clear is not sat through', () => {
    expect(geminiError(429, { error: { status: 'RESOURCE_EXHAUSTED', details: retryInfo('600s') } }, null)).toBeInstanceOf(FatalError)
  })
  it('server trouble is retried; a wrong model, a bad key and other client errors are not', () => {
    expect(geminiError(503, { error: { status: 'UNAVAILABLE' } }, null)).toBeInstanceOf(RetriableError)
    expect(geminiError(500, undefined, null)).toBeInstanceOf(RetriableError)
    expect(geminiError(404, { error: { message: 'models/x is not found' } }, null).message).toContain('npm run models')
    expect(geminiError(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }, null).message).toContain('Check the key')
    expect(geminiError(403, { error: { message: 'denied' } }, null)).toBeInstanceOf(FatalError)
  })
  it('an HTTP error response becomes the right kind of error, and the key is never in the message', async () => {
    const err = await collect(gemini(errResponse(429, { status: 'RESOURCE_EXHAUSTED', message: 'slow', details: retryInfo('2s') })).stream(req)).catch((e) => e)
    expect(err).toBeInstanceOf(RetriableError)
    expect(String(err.message)).not.toContain(KEY)
  })
  it('reads the delay formats Google uses', () => {
    expect([parseDelay('33s'), parseDelay('0.5s'), parseDelay('1.25s'), parseDelay('soon'), parseDelay(undefined)]).toEqual([33_000, 500, 1250, undefined, undefined])
  })
})

describe('listGeminiModels', () => {
  it('lists the models that can generate text, across pages', async () => {
    const pages = [
      { models: [{ name: 'models/a', displayName: 'A', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'p2' },
      { models: [{ name: 'models/b', displayName: 'B', supportedGenerationMethods: ['generateContent', 'countTokens'] }] },
    ]
    let i = 0
    const f = (async (url: string) => { expect(url).not.toContain(KEY); return new Response(JSON.stringify(pages[i++])) }) as unknown as typeof fetch
    expect((await listGeminiModels(KEY, f)).map((m) => m.id)).toEqual(['a', 'b'])
  })
  it('reports a bad key', async () => {
    await expect(listGeminiModels(KEY, errResponse(400, { message: 'API key not valid' }))).rejects.toThrow(/key/i)
  })
})

const ndjson = (objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
const ollamaFetch = (body: string, seen: { url?: string; init?: RequestInit } = {}, cut = 23) => (async (url: string, init: RequestInit) => { seen.url = url; seen.init = init; return new Response(streamOf([body.slice(0, cut), body.slice(cut)]), { status: 200 }) }) as unknown as typeof fetch

describe('OllamaClient', () => {
  it('streams text however the lines are cut, and reports usage at the end', async () => {
    const body = ndjson([{ message: { role: 'assistant', content: 'Hel' }, done: false }, { message: { content: 'lo' }, done: false }, { message: { content: '' }, done: true, prompt_eval_count: 90, eval_count: 7 }])
    for (const cut of [1, 5, 23, 60, 100]) {
      const ev = await collect(new OllamaClient({ model: 'm', fetchImpl: ollamaFetch(body, {}, cut) }).stream(req))
      expect(text(ev), `cut ${cut}`).toBe('Hello')
      expect(ev.at(-1)).toEqual({ type: 'usage', inputTokens: 90, outputTokens: 7 })
    }
  })

  it('reads a last line with no newline after it', async () => {
    const body = JSON.stringify({ message: { content: 'x' }, done: false }) + '\n' + JSON.stringify({ message: { content: 'y' }, done: true })
    expect(text(await collect(new OllamaClient({ model: 'm', fetchImpl: ollamaFetch(body) }).stream(req)))).toBe('xy')
  })

  it('asks for a big enough context window, and no randomness', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    await collect(new OllamaClient({ model: 'qwen', numCtx: 12000, fetchImpl: ollamaFetch(ndjson([{ done: true }]), seen) }).stream({ ...req, maxTokens: 777 }))
    expect(seen.url).toBe('http://localhost:11434/api/chat')
    const sent = JSON.parse(seen.init?.body as string)
    expect(sent).toMatchObject({ model: 'qwen', stream: true, options: { temperature: 0, num_ctx: 12000, num_predict: 777 } })
    expect(sent.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user'])
  })

  it('sizes prompts to fit the context window', () => {
    const small = new OllamaClient({ model: 'm', numCtx: 8192 })
    const big = new OllamaClient({ model: 'm', numCtx: 32768 })
    expect(big.budgetChars).toBeGreaterThan(small.budgetChars)
    expect(small.budgetChars).toBeLessThan(8192 * 3) // never more characters than the window can hold
    expect(small.maxConcurrency).toBe(1)
  })

  it('says how to fix it when Ollama is not running', async () => {
    const f = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const err = await collect(new OllamaClient({ model: 'm', fetchImpl: f }).stream(req)).catch((e) => e)
    expect(err).toBeInstanceOf(FatalError)
    expect(err.message).toMatch(/ollama serve/)
  })

  it('says how to fix it when the model is not downloaded', async () => {
    const f = (async () => new Response(JSON.stringify({ error: "model 'nope' not found" }), { status: 404 })) as unknown as typeof fetch
    const err = await collect(new OllamaClient({ model: 'nope', fetchImpl: f }).stream(req)).catch((e) => e)
    expect(err).toBeInstanceOf(FatalError)
    expect(err.message).toContain('ollama pull nope')
  })

  it('retries server errors, and reports an error line in the stream', async () => {
    const f = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch
    expect(await collect(new OllamaClient({ model: 'm', fetchImpl: f }).stream(req)).catch((e) => e)).toBeInstanceOf(RetriableError)
    const err = await collect(new OllamaClient({ model: 'm', fetchImpl: ollamaFetch(ndjson([{ error: 'out of memory' }])) }).stream(req)).catch((e) => e)
    expect(err.message).toContain('out of memory')
  })

  it('lists downloaded models', async () => {
    const f = (async () => new Response(JSON.stringify({ models: [{ name: 'a:3b' }, { name: 'b:7b' }] }))) as unknown as typeof fetch
    expect(await listOllamaModels('http://localhost:11434/', f)).toEqual(['a:3b', 'b:7b'])
  })
})

describe('createClient', () => {
  it('uses Gemini when there is a Gemini key, with its default model', () => {
    const c = createClient({ GEMINI_API_KEY: KEY })
    expect(c.name).toBe(`gemini:${DEFAULT_MODEL.gemini}`)
  })
  it('falls back to a local model when there is no key at all', () => {
    expect(createClient({}).name).toBe(`ollama:${DEFAULT_MODEL.ollama}`)
  })
  it('honours an explicit provider and model, from settings or overrides', () => {
    expect(createClient({ REDLINE_PROVIDER: 'ollama', REDLINE_MODEL: 'llama3.2:3b', GEMINI_API_KEY: KEY }).name).toBe('ollama:llama3.2:3b')
    expect(createClient({ GEMINI_API_KEY: KEY }, { provider: 'gemini', model: 'gemini-x' }).name).toBe('gemini:gemini-x')
    expect(createClient({ ANTHROPIC_API_KEY: 'k' }).name).toBe(`anthropic:${DEFAULT_MODEL.anthropic}`)
  })
  it('says what is missing, without ever printing a key', () => {
    let msg = ''
    try { createClient({ REDLINE_PROVIDER: 'gemini' }) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('GEMINI_API_KEY')
    expect(msg).toContain('aistudio.google.com')
    expect(() => createClient({ REDLINE_PROVIDER: 'nope' })).toThrow(/Unknown provider/)
  })
  it('checks the Ollama context setting', () => {
    expect(() => createClient({ REDLINE_PROVIDER: 'ollama', OLLAMA_NUM_CTX: 'big' })).toThrow(/OLLAMA_NUM_CTX/)
    expect(() => createClient({ REDLINE_PROVIDER: 'ollama', OLLAMA_NUM_CTX: '512' })).toThrow(/OLLAMA_NUM_CTX/)
    expect(createClient({ REDLINE_PROVIDER: 'ollama', OLLAMA_NUM_CTX: '32768' }).budgetChars).toBeGreaterThan(50_000)
  })
})
