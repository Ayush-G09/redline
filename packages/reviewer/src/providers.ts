import { AnthropicClient, FatalError } from './client'
import type { LlmClient } from './client'
import { GeminiClient } from './gemini'
import { OllamaClient } from './ollama'

export const PROVIDERS = ['gemini', 'ollama', 'anthropic'] as const
export type Provider = (typeof PROVIDERS)[number]

export const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: 'gemini-flash-lite-latest',
  ollama: 'qwen2.5-coder:3b',
  anthropic: 'claude-sonnet-5',
}

/** Which key or setting each provider needs (Ollama needs none), for messages and docs. */
export const KEY_NAME: Record<Provider, string | null> = { gemini: 'GEMINI_API_KEY', ollama: null, anthropic: 'ANTHROPIC_API_KEY' }

/**
 * Builds a model client from settings in the environment, so the command line, the GitHub Action and the server all
 * choose a model the same way:
 *   REDLINE_PROVIDER = gemini | ollama | anthropic   (default: gemini if a key is present, else ollama)
 *   REDLINE_MODEL    = the model name (a sensible default per provider)
 *   GEMINI_API_KEY / ANTHROPIC_API_KEY, OLLAMA_HOST, OLLAMA_NUM_CTX, GEMINI_BASE_URL (for a proxy or tests)
 */
export function createClient(env: Record<string, string | undefined>, overrides: { provider?: string; model?: string } = {}): LlmClient {
  const wanted = (overrides.provider ?? env.REDLINE_PROVIDER)?.trim().toLowerCase()
  const provider = (wanted || (env.GEMINI_API_KEY ? 'gemini' : env.ANTHROPIC_API_KEY ? 'anthropic' : 'ollama')) as Provider
  if (!(PROVIDERS as readonly string[]).includes(provider)) throw new FatalError(`Unknown provider "${wanted}". Choose one of: ${PROVIDERS.join(', ')}`)
  const model = (overrides.model ?? env.REDLINE_MODEL)?.trim() || DEFAULT_MODEL[provider]
  const key = KEY_NAME[provider]
  if (key && !env[key]?.trim()) throw new FatalError(`${key} is not set. ${provider === 'gemini' ? 'Get a free key at https://aistudio.google.com/apikey and ' : ''}put it in the environment or a .env file.`)
  switch (provider) {
    case 'gemini': return new GeminiClient({ apiKey: env.GEMINI_API_KEY as string, model, baseUrl: env.GEMINI_BASE_URL || undefined })
    case 'anthropic': return new AnthropicClient({ apiKey: env.ANTHROPIC_API_KEY as string, model })
    case 'ollama': {
      const numCtx = env.OLLAMA_NUM_CTX ? Number(env.OLLAMA_NUM_CTX) : undefined
      if (numCtx !== undefined && (!Number.isInteger(numCtx) || numCtx < 2048)) throw new FatalError('OLLAMA_NUM_CTX must be a whole number of at least 2048')
      return new OllamaClient({ model, host: env.OLLAMA_HOST || undefined, numCtx })
    }
  }
}
