import { existsSync } from 'node:fs'
import { runCli } from './cli'

if (existsSync('.env')) process.loadEnvFile('.env')

const code = await runCli(process.argv.slice(2), process.env, {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  cwd: process.cwd(),
  color: !!process.stdout.isTTY && !process.env.NO_COLOR,
  readStdin: async () => {
    const parts: Buffer[] = []
    for await (const c of process.stdin) parts.push(c as Buffer)
    return Buffer.concat(parts).toString('utf8')
  },
})
process.exit(code)
