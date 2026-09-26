import { existsSync } from 'node:fs'
import { createClient } from '@redline/reviewer'
import { loadConfig } from './config'
import { GitHubClient } from './github'
import { createServer } from './server'

if (existsSync('.env')) process.loadEnvFile('.env')

let config
try {
  config = loadConfig()
} catch (e) {
  console.error(`Cannot start: ${(e as Error).message}`)
  process.exit(2)
}

const github = new GitHubClient({ appId: config.appId, privateKey: config.privateKey, apiUrl: config.githubApi })
let llm
try {
  llm = createClient(process.env)
} catch (e) {
  console.error(`Cannot start: ${(e as Error).message}`)
  process.exit(2)
}
const server = createServer({ config, github, llm, log: (m) => console.log(`${new Date().toISOString()} ${m}`) })
const port = await server.listen(config.port)
console.log(`Redline listening on :${port}, reviewing repositories of: ${config.allowedOwners.join(', ')} with ${llm.name}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { console.log(`${sig}: finishing current reviews`); void server.close().then(() => process.exit(0)) })
}
