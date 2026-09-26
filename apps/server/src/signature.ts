import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Checks GitHub's `X-Hub-Signature-256` header against the raw request body. Must be the exact bytes GitHub sent, not
 * re-serialised JSON. The comparison takes the same time whatever the input, so the secret cannot be guessed byte by byte.
 */
export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!secret || !header || !header.startsWith('sha256=')) return false
  const given = Buffer.from(header.slice(7), 'hex')
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export const sign = (secret: string, rawBody: Buffer | string) => 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
