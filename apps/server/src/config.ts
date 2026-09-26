export interface Config {
  port: number
  appId: string
  privateKey: string
  webhookSecret: string
  githubApi: string
  /** only these accounts' repositories are ever reviewed (each review costs money) */
  allowedOwners: string[]
  concurrency: number
  postClean: boolean
  maxFiles: number
  /** most reviews per pull request per hour, so a loop or a flood of pushes cannot run up a bill */
  maxReviewsPerPrPerHour: number
}

/** Reads settings from the environment. On a problem it lists the names that are wrong, never their values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'ALLOWED_OWNERS'].filter((k) => !env[k]?.trim())
  if (missing.length) throw new Error(`Missing settings: ${missing.join(', ')} (see .env.example)`)
  const int = (k: string, d: number) => {
    const v = env[k]
    if (v === undefined || v === '') return d
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) throw new Error(`${k} must be a whole number`)
    return n
  }
  const privateKey = (env.GITHUB_PRIVATE_KEY as string).replace(/\\n/g, '\n')
  if (!privateKey.includes('BEGIN') || !privateKey.includes('PRIVATE KEY')) throw new Error('GITHUB_PRIVATE_KEY does not look like a PEM private key (newlines may be written as \\n)')
  const owners = (env.ALLOWED_OWNERS as string).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (owners.length === 0) throw new Error('ALLOWED_OWNERS is empty')
  return {
    port: int('PORT', 3200),
    appId: (env.GITHUB_APP_ID as string).trim(),
    privateKey,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET as string,
    githubApi: env.GITHUB_API_URL?.trim() || 'https://api.github.com',
    allowedOwners: owners,
    concurrency: Math.max(1, int('CONCURRENCY', 2)),
    postClean: env.POST_CLEAN !== 'false',
    maxFiles: int('MAX_FILES', 150),
    maxReviewsPerPrPerHour: int('MAX_REVIEWS_PER_PR_PER_HOUR', 12),
  }
}
