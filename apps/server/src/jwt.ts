import { createSign } from 'node:crypto'

const b64 = (x: Buffer | string) => Buffer.from(x).toString('base64url')

/**
 * The short-lived token a GitHub App uses to prove who it is (RS256, signed with the app's private key). GitHub accepts
 * at most 10 minutes; we use 9 and back-date by a minute in case our clock is a little fast.
 */
export function appJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000)
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKeyPem)
  return `${head}.${body}.${b64(sig)}`
}
