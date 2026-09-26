import type { LlmClient, LlmEvent, LlmRequest } from './client'

export interface Scripted {
  /** the answer, delivered in these pieces (the way the network would split it) */
  chunks?: string[]
  usage?: { inputTokens?: number; outputTokens?: number }
  /** throw this after delivering the chunks */
  then?: Error
  /** throw this before delivering anything */
  first?: Error
}

/** A model that answers from a script. For tests, and for running the pipeline end to end with no key. */
export class ScriptedClient implements LlmClient {
  readonly name = 'scripted'
  calls: LlmRequest[] = []
  active = 0
  maxActive = 0
  constructor(private readonly answer: (req: LlmRequest, call: number) => Scripted | Promise<Scripted>, private readonly delayMs = 0) {}

  async *stream(req: LlmRequest): AsyncGenerator<LlmEvent> {
    const n = this.calls.push(req) - 1
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
      const s = await this.answer(req, n)
      if (s.first) throw s.first
      if (s.usage) yield { type: 'usage', ...s.usage }
      for (const c of s.chunks ?? []) yield { type: 'text', text: c }
      if (s.then) throw s.then
    } finally { this.active-- }
  }
}

/** Cuts text into pieces of `size` characters, to imitate how a stream arrives. */
export const pieces = (text: string, size: number) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size))
