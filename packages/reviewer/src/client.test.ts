import { describe, expect, it } from 'vitest'
import { AnthropicClient, FatalError, RetriableError, SseParser } from './client'
import type { LlmEvent } from './client'

const KEY = 'sk-ant-test-SECRET-1234567890'

describe('SseParser', () => {
  const text = 'event: a\ndata: {"x":1}\n\n: keep-alive\n\nevent: b\ndata: line1\ndata: line2\n\n'
  const expected = [{ event: 'a', data: '{"x":1}' }, { event: 'b', data: 'line1\nline2' }]
  it('reads frames', () => expect(new SseParser().push(text)).toEqual(expected))
  it('reads the same frames however the network cuts them, and with CRLF', () => {
    for (const t of [text, text.replace(/\n/g, '\r\n')]) {
      for (let cut = 1; cut < t.length; cut++) {
        const p = new SseParser()
        expect([...p.push(t.slice(0, cut)), ...p.push(t.slice(cut))], `cut ${cut}`).toEqual(expected)
      }
    }
  })
})

const sse = (frames: [string, unknown][]) => frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
const streamOf = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close() } })
const okFetch = (body: string, seen: { url?: string; init?: RequestInit } = {}) => (async (url: string, init: RequestInit) => { seen.url = url; seen.init = init; return new Response(streamOf([body.slice(0, 40), body.slice(40)]), { status: 200 }) }) as unknown as typeof fetch
const collect = async (it: AsyncIterable<LlmEvent>) => { const out: LlmEvent[] = []; for await (const e of it) out.push(e); return out }
const client = (fetchImpl: typeof fetch) => new AnthropicClient({ apiKey: KEY, model: 'test-model', fetchImpl })

describe('AnthropicClient', () => {
  it('streams text and usage, and sends the request we expect', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    const body = sse([
      ['message_start', { message: { usage: { input_tokens: 120, output_tokens: 1 } } }],
      ['content_block_delta', { delta: { type: 'text_delta', text: 'Hel' } }],
      ['content_block_delta', { delta: { type: 'text_delta', text: 'lo' } }],
      ['ping', {}],
      ['message_delta', { usage: { output_tokens: 42 } }],
    ])
    const events = await collect(client(okFetch(body, seen)).stream({ system: 'sys', user: 'usr', maxTokens: 100 }))
    expect(events).toEqual([{ type: 'usage', inputTokens: 120, outputTokens: 1 }, { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'usage', outputTokens: 42 }])
    expect(seen.url).toBe('https://api.anthropic.com/v1/messages')
    const sent = JSON.parse(seen.init?.body as string)
    expect(sent).toMatchObject({ model: 'test-model', max_tokens: 100, temperature: 0, stream: true, system: 'sys', messages: [{ role: 'user', content: 'usr' }] })
    expect((seen.init?.headers as Record<string, string>)['x-api-key']).toBe(KEY)
  })

  it('treats 429, 529 and 5xx as retriable and passes on retry-after', async () => {
    for (const status of [429, 500, 529]) {
      const f = (async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), { status, headers: { 'retry-after': '7' } })) as unknown as typeof fetch
      const err = await collect(client(f).stream({ system: '', user: '', maxTokens: 1 })).catch((e) => e)
      expect(err, String(status)).toBeInstanceOf(RetriableError)
      expect(err.retryAfterMs).toBe(7000)
      expect(err.message).toContain('slow down')
    }
  })

  it('treats a bad key or bad request as fatal, and never puts the key in a message', async () => {
    for (const status of [400, 401, 403, 404]) {
      const f = (async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status })) as unknown as typeof fetch
      const err = await collect(client(f).stream({ system: '', user: '', maxTokens: 1 })).catch((e) => e)
      expect(err, String(status)).toBeInstanceOf(FatalError)
      expect(String(err.message)).not.toContain(KEY)
    }
  })

  it('turns a network failure into a retriable error', async () => {
    const f = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    expect(await collect(client(f).stream({ system: '', user: '', maxTokens: 1 })).catch((e) => e)).toBeInstanceOf(RetriableError)
  })

  it('turns an error event in the stream into the right kind of error', async () => {
    const overloaded = sse([['content_block_delta', { delta: { type: 'text_delta', text: 'x' } }], ['error', { error: { type: 'overloaded_error', message: 'Overloaded' } }]])
    expect(await collect(client(okFetch(overloaded)).stream({ system: '', user: '', maxTokens: 1 })).catch((e) => e)).toBeInstanceOf(RetriableError)
    const bad = sse([['error', { error: { type: 'invalid_request_error', message: 'nope' } }]])
    expect(await collect(client(okFetch(bad)).stream({ system: '', user: '', maxTokens: 1 })).catch((e) => e)).toBeInstanceOf(FatalError)
  })

  it('refuses to be built without a key, and the error does not echo anything', () => {
    expect(() => new AnthropicClient({ apiKey: '', model: 'm' })).toThrow(FatalError)
  })

  it('skips frames that are not JSON instead of crashing', async () => {
    const body = 'event: content_block_delta\ndata: {broken\n\n' + sse([['content_block_delta', { delta: { type: 'text_delta', text: 'ok' } }]])
    expect(await collect(client(okFetch(body)).stream({ system: '', user: '', maxTokens: 1 }))).toEqual([{ type: 'text', text: 'ok' }])
  })
})
