import type { DiffFile } from './diff'
import type { Finding, Kind, Severity } from './findings'

interface Rule {
  id: string
  kind: Kind
  severity: Severity
  /** tested against each ADDED line of a source file */
  test: RegExp
  message: string
}

/**
 * The simple reviewer: patterns matched line by line. It exists so that every smarter reviewer has a number to beat.
 * It cannot understand code (it will never notice an off-by-one, a race, or a missing await), and it can be fooled by
 * a pattern inside a string or a comment. That is the point of measuring it.
 */
const RULES: Rule[] = [
  { id: 'eval', kind: 'security', severity: 'high', test: /\beval\s*\(|\bnew Function\s*\(/, message: 'eval / new Function runs arbitrary code. If any part of the input can be influenced by a user, this is remote code execution.' },
  { id: 'secret', kind: 'security', severity: 'high', test: /(pass(word)?|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"\s]{8,}['"]|AKIA[0-9A-Z]{16}/i, message: 'This looks like a credential committed to source. Move it to an environment variable or a secret store, and rotate it, since it is now in history.' },
  { id: 'sql-concat', kind: 'security', severity: 'high', test: /\b(select|insert|update|delete)\b[^;\n]*['"`]\s*\+|\b(select|insert|update|delete)\b[^;\n]*\$\{/i, message: 'SQL built by joining strings is open to injection. Use placeholders / parameterised queries.' },
  { id: 'inner-html', kind: 'security', severity: 'medium', test: /dangerouslySetInnerHTML|\.innerHTML\s*=/, message: 'Writing HTML from a string can allow cross-site scripting unless it is sanitised.' },
  { id: 'tls-off', kind: 'security', severity: 'high', test: /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|NODE_TLS_REJECT_UNAUTHORIZED/, message: 'This turns off TLS certificate checking, which makes the connection open to interception.' },
  { id: 'weak-hash', kind: 'security', severity: 'medium', test: /createHash\(\s*['"](md5|sha1)['"]\s*\)/i, message: 'MD5 and SHA-1 are broken for security purposes. Use SHA-256 or better (and a password hash such as argon2 or bcrypt for passwords).' },
  { id: 'shell-exec', kind: 'security', severity: 'high', test: /\bexec(Sync)?\(\s*[`'"][^`'"]*(\$\{|['"]\s*\+)|\bexec(Sync)?\(\s*\w+\s*\+/, message: 'Building a shell command from variables allows command injection. Pass arguments as an array to execFile / spawn instead.' },
  { id: 'empty-catch', kind: 'error-handling', severity: 'medium', test: /catch\s*(\([^)]*\))?\s*\{\s*\}/, message: 'The error is swallowed, so a failure here will be invisible. At least log it, or handle it deliberately.' },
  { id: 'assign-in-if', kind: 'bug', severity: 'high', test: /\bif\s*\(\s*[\w.]+\s*=(?!=)\s*[^=]/, message: 'This assigns inside the condition (=). Did you mean a comparison (=== )?' },
  { id: 'nan-compare', kind: 'bug', severity: 'high', test: /[!=]==?\s*NaN\b|\bNaN\s*[!=]==?/, message: 'Nothing is equal to NaN, so this is always false (or always true). Use Number.isNaN().' },
  { id: 'async-foreach', kind: 'bug', severity: 'medium', test: /\.forEach\(\s*async\b/, message: 'forEach does not wait for async callbacks, so the code after it runs before they finish. Use for...of or Promise.all with map.' },
  { id: 'debug-log', kind: 'maintainability', severity: 'low', test: /\bconsole\.log\(|\bdebugger\b/, message: 'Leftover debug output.' },
  { id: 'deep-clone-json', kind: 'performance', severity: 'low', test: /JSON\.parse\(\s*JSON\.stringify\(/, message: 'A JSON round-trip is a slow, lossy deep clone (it drops undefined, functions, dates). Consider structuredClone.' },
]

const isTest = (p: string) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$/.test(p)
const isSource = (p: string) => /\.(ts|tsx|js|jsx|mjs|py|go|rs|java|rb)$/.test(p) && !isTest(p)

export function baselineReview(files: readonly DiffFile[]): Finding[] {
  const out: Finding[] = []
  let sourceChanged = 0
  let testsChanged = 0
  let biggest: { path: string; line: number; added: number } | null = null

  for (const f of files) {
    if (f.binary || f.status === 'deleted') continue
    const added = f.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'add' && l.newLine !== null)
    if (isTest(f.path)) { testsChanged += added.length; continue }
    if (!isSource(f.path)) continue
    sourceChanged += added.length
    if (added.length > 0 && (!biggest || added.length > biggest.added)) biggest = { path: f.path, line: added[0].newLine as number, added: added.length }
    for (const l of added) {
      for (const r of RULES) {
        if (r.test.test(l.text)) out.push({ path: f.path, line: l.newLine as number, kind: r.kind, severity: r.severity, message: r.message, source: `baseline:${r.id}` })
      }
    }
  }
  if (biggest && sourceChanged >= 20 && testsChanged === 0) {
    out.push({ path: biggest.path, line: biggest.line, kind: 'tests', severity: 'low', message: `${sourceChanged} lines of code changed and no test was added or changed.`, source: 'baseline:no-tests' })
  }
  return out
}
