import type { GoldenCase } from './builder'

// Each case is a small pull request. `planted` lists the real problems in it; a case with none is a clean change,
// and any comment on it counts as a false alarm. Several cases are traps: they contain something that LOOKS bad to a
// pattern matcher but is fine.

const ROUTES = ['import express from "express"', 'const app = express()', '']

export const CASES: GoldenCase[] = [
  // ------------------------------------------------------------------------------------------ security
  {
    id: 'sec-eval', title: 'Add a calculator endpoint',
    files: [{ path: 'src/calc.ts', before: [...ROUTES, 'app.get("/health", (_req, res) => res.send("ok"))'], after: [...ROUTES, 'app.get("/health", (_req, res) => res.send("ok"))', '', 'app.get("/calc", (req, res) => {', '  const result = eval(String(req.query.expr))', '  res.json({ result })', '})'] }],
    planted: [{ path: 'src/calc.ts', contains: 'eval(String', kind: 'security', why: 'user input reaches eval: remote code execution' }],
  },
  {
    id: 'sec-key', title: 'Send receipts by email',
    files: [{ path: 'src/mail.ts', before: ['import { Client } from "./client"', '', 'export function mailer() {', '  return new Client({ host: "smtp.example.com" })', '}'], after: ['import { Client } from "./client"', '', 'const SENDGRID_API_KEY = "SG.q8f2Zk1xT0aVb9d3LrMw.7Hn4pQ2sYc6uEj1oAiXtBvKg"', '', 'export function mailer() {', '  return new Client({ host: "smtp.example.com", apiKey: SENDGRID_API_KEY })', '}'] }],
    planted: [{ path: 'src/mail.ts', contains: 'SENDGRID_API_KEY = ', kind: 'security', why: 'a live-looking key is committed to source' }],
  },
  {
    id: 'sec-sqli', title: 'Look up users by name',
    files: [{ path: 'src/users.ts', before: ['import { db } from "./db"', '', 'export async function byId(id: number) {', '  return db.query("SELECT * FROM users WHERE id = $1", [id])', '}'], after: ['import { db } from "./db"', '', 'export async function byId(id: number) {', '  return db.query("SELECT * FROM users WHERE id = $1", [id])', '}', '', 'export async function byName(name: string) {', '  return db.query("SELECT * FROM users WHERE name = \'" + name + "\'")', '}'] }],
    planted: [{ path: 'src/users.ts', contains: 'WHERE name =', kind: 'security', why: 'string-built SQL: injection' }],
  },
  {
    id: 'sec-xss', title: 'Show a search banner',
    files: [{ path: 'src/banner.ts', before: ['export function render(el: HTMLElement) {', '  el.textContent = "Welcome"', '}'], after: ['export function render(el: HTMLElement) {', '  el.textContent = "Welcome"', '  const q = new URLSearchParams(location.search).get("q") ?? ""', '  el.innerHTML = "<p>Results for " + q + "</p>"', '}'] }],
    planted: [{ path: 'src/banner.ts', contains: 'el.innerHTML', kind: 'security', why: 'query string written as HTML: XSS' }],
  },
  {
    id: 'sec-tls', title: 'Fix the flaky partner API call',
    files: [{ path: 'src/partner.ts', before: ['import https from "node:https"', '', 'export const agent = new https.Agent({ keepAlive: true })'], after: ['import https from "node:https"', '', 'export const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false })'] }],
    planted: [{ path: 'src/partner.ts', contains: 'rejectUnauthorized', kind: 'security', why: 'certificate checking turned off' }],
  },
  {
    id: 'sec-traversal', title: 'Serve uploaded files',
    files: [{ path: 'src/files.ts', before: [...ROUTES, 'const BASE = "/srv/uploads"'], after: [...ROUTES, 'const BASE = "/srv/uploads"', '', 'app.get("/files", async (req, res) => {', '  const data = await readFile(path.join(BASE, String(req.query.name)))', '  res.send(data)', '})'] }],
    planted: [{ path: 'src/files.ts', contains: 'readFile(path.join(BASE', kind: 'security', why: 'name can contain ../ and escape the uploads folder' }],
  },
  {
    id: 'sec-noauth', title: 'Add an admin endpoint to delete users',
    files: [{ path: 'src/admin.ts', before: [...ROUTES, 'app.get("/admin/stats", requireAdmin, (_req, res) => res.json(stats()))'], after: [...ROUTES, 'app.get("/admin/stats", requireAdmin, (_req, res) => res.json(stats()))', 'app.delete("/admin/users/:id", async (req, res) => {', '  await db.users.remove(req.params.id)', '  res.sendStatus(204)', '})'] }],
    planted: [{ path: 'src/admin.ts', contains: 'app.delete("/admin/users', kind: 'security', why: 'the sibling route uses requireAdmin; this one has no authorization at all' }],
  },
  {
    id: 'sec-jwt', title: 'Read the user from the token',
    files: [{ path: 'src/auth.ts', before: ['import jwt from "jsonwebtoken"', '', 'export function userFrom(token: string) {', '  return jwt.verify(token, process.env.JWT_SECRET as string)', '}'], after: ['import jwt from "jsonwebtoken"', '', 'export function userFrom(token: string) {', '  return jwt.decode(token)', '}'] }],
    planted: [{ path: 'src/auth.ts', contains: 'jwt.decode', kind: 'security', why: 'decode does not check the signature, so anyone can forge a token' }],
  },

  // ------------------------------------------------------------------------------------------ bugs
  {
    id: 'bug-offbyone', title: 'Sum the prices in a cart',
    files: [{ path: 'src/cart.ts', before: ['export function count(items: number[]) {', '  return items.length', '}'], after: ['export function count(items: number[]) {', '  return items.length', '}', '', 'export function total(prices: number[]) {', '  let sum = 0', '  for (let i = 0; i <= prices.length; i++) {', '    sum += prices[i]', '  }', '  return sum', '}'] }],
    planted: [{ path: 'src/cart.ts', contains: 'i <= prices.length', kind: 'bug', why: 'runs one past the end and adds undefined, giving NaN' }],
  },
  {
    id: 'bug-await', title: 'Charge the customer before shipping',
    files: [{ path: 'src/order.ts', before: ['export async function ship(order: Order) {', '  await warehouse.pick(order)', '}'], after: ['export async function ship(order: Order) {', '  const charge = payments.charge(order.customerId, order.total)', '  if (charge.ok) {', '    await warehouse.pick(order)', '  }', '}'] }],
    planted: [{ path: 'src/order.ts', contains: 'const charge = payments.charge', kind: 'bug', why: 'missing await: charge is a Promise, so charge.ok is undefined and nothing ships' }],
  },
  {
    id: 'bug-assign', title: 'Grant admins extra quota',
    files: [{ path: 'src/quota.ts', before: ['export function limit(user: User) {', '  return 100', '}'], after: ['export function limit(user: User) {', '  if (user.role = "admin") {', '    return 10000', '  }', '  return 100', '}'] }],
    planted: [{ path: 'src/quota.ts', contains: 'user.role = "admin"', kind: 'bug', why: 'assignment, not comparison: everyone becomes an admin' }],
  },
  {
    id: 'bug-nan', title: 'Validate the amount field',
    files: [{ path: 'src/validate.ts', before: ['export function amount(raw: string) {', '  return Number(raw)', '}'], after: ['export function amount(raw: string) {', '  const n = Number(raw)', '  if (n === NaN) throw new Error("bad amount")', '  return n', '}'] }],
    planted: [{ path: 'src/validate.ts', contains: 'n === NaN', kind: 'bug', why: 'NaN is never equal to anything, so bad input is never rejected' }],
  },
  {
    id: 'bug-foreach', title: 'Send the welcome emails',
    files: [{ path: 'src/welcome.ts', before: ['export async function run(users: User[]) {', '  log("starting")', '}'], after: ['export async function run(users: User[]) {', '  log("starting")', '  users.forEach(async (u) => {', '    await sendWelcome(u)', '  })', '  log("done")', '}'] }],
    planted: [{ path: 'src/welcome.ts', contains: 'users.forEach(async', kind: 'bug', why: '"done" is logged and run() returns before any email is sent; failures are lost' }],
  },
  {
    id: 'bug-swapped', title: 'Refund a payment',
    files: [{ path: 'src/refund.ts', before: ['// moves money from one account to another', 'export function transfer(from: Account, to: Account, amount: number) {', '  from.balance -= amount', '  to.balance += amount', '}'], after: ['// moves money from one account to another', 'export function transfer(from: Account, to: Account, amount: number) {', '  from.balance -= amount', '  to.balance += amount', '}', '', 'export function refund(merchant: Account, customer: Account, amount: number) {', '  transfer(customer, merchant, amount)', '}'] }],
    planted: [{ path: 'src/refund.ts', contains: 'transfer(customer, merchant', kind: 'bug', why: 'arguments swapped: a refund would take money from the customer' }],
  },
  {
    id: 'bug-midpoint', title: 'Binary search helper',
    files: [{ path: 'src/search.ts', before: ['export function has(sorted: number[], x: number) {', '  return sorted.includes(x)', '}'], after: ['export function has(sorted: number[], x: number) {', '  let lo = 0', '  let hi = sorted.length - 1', '  while (lo <= hi) {', '    const mid = (lo + hi) / 2', '    if (sorted[mid] === x) return true', '    if (sorted[mid] < x) lo = mid + 1', '    else hi = mid - 1', '  }', '  return false', '}'] }],
    planted: [{ path: 'src/search.ts', contains: 'const mid = (lo + hi) / 2', kind: 'bug', why: 'not rounded, so mid is fractional and sorted[mid] is undefined' }],
  },
  {
    id: 'bug-mutate', title: 'Show the newest posts first',
    files: [{ path: 'src/Feed.tsx', before: ['export function Feed({ posts }: { posts: Post[] }) {', '  return <List items={posts} />', '}'], after: ['export function Feed({ posts }: { posts: Post[] }) {', '  const newest = posts.sort((a, b) => b.at - a.at)', '  return <List items={newest} />', '}'] }],
    planted: [{ path: 'src/Feed.tsx', contains: 'posts.sort(', kind: 'bug', why: 'sort() reorders the array passed in as a prop, changing the parent\'s data' }],
  },

  // ------------------------------------------------------------------------------------------ error handling
  {
    id: 'err-empty', title: 'Cache the config to disk',
    files: [{ path: 'src/cache.ts', before: ['export function save(cfg: Config) {', '  fs.writeFileSync(PATH, JSON.stringify(cfg))', '}'], after: ['export function save(cfg: Config) {', '  try {', '    fs.writeFileSync(PATH, JSON.stringify(cfg))', '  } catch (e) {}', '}'] }],
    planted: [{ path: 'src/cache.ts', contains: 'catch (e) {}', kind: 'error-handling', why: 'a failed save is silently ignored' }],
  },
  {
    id: 'err-swallow', title: 'Make the sync job safer',
    files: [{ path: 'src/sync.ts', before: ['export async function sync(): Promise<{ ok: boolean }> {', '  await pull()', '  return { ok: true }', '}'], after: ['export async function sync(): Promise<{ ok: boolean }> {', '  try {', '    await pull()', '  } catch (e) {', '    console.warn("sync failed")', '  }', '  return { ok: true }', '}'] }],
    planted: [{ path: 'src/sync.ts', contains: 'console.warn("sync failed")', kind: 'error-handling', why: 'the failure is only logged and the function still reports success' }],
  },
  {
    id: 'err-fetchok', title: 'Load the profile',
    files: [{ path: 'src/profile.ts', before: ['export async function load(id: string) {', '  return null', '}'], after: ['export async function load(id: string) {', '  const res = await fetch("/api/profile/" + id)', '  return res.json()', '}'] }],
    planted: [{ path: 'src/profile.ts', contains: 'return res.json()', kind: 'error-handling', why: 'no res.ok check: a 500 error page is parsed as JSON and throws a confusing error' }],
  },
  {
    id: 'err-floating', title: 'Record a login event',
    files: [{ path: 'src/login.ts', before: [...ROUTES, 'app.post("/login", async (req, res) => {', '  const user = await verify(req.body)', '  res.json(user)', '})'], after: [...ROUTES, 'app.post("/login", async (req, res) => {', '  const user = await verify(req.body)', '  audit.record("login", user.id)', '  res.json(user)', '})'] }],
    planted: [{ path: 'src/login.ts', contains: 'audit.record(', kind: 'error-handling', why: 'audit.record returns a promise that is neither awaited nor caught: a rejection crashes the process' }],
  },

  // ------------------------------------------------------------------------------------------ performance
  {
    id: 'perf-clone', title: 'Copy the state before editing',
    files: [{ path: 'src/state.ts', before: ['export function edit(s: State) {', '  return s', '}'], after: ['export function edit(s: State) {', '  const copy = JSON.parse(JSON.stringify(s))', '  return copy', '}'] }],
    planted: [{ path: 'src/state.ts', contains: 'JSON.parse(JSON.stringify', kind: 'performance', why: 'slow, lossy deep copy' }],
  },
  {
    id: 'perf-n1', title: 'Show the order list with customer names',
    files: [{ path: 'src/orders.ts', before: ['export async function list() {', '  return db.orders.all()', '}'], after: ['export async function list() {', '  const orders = await db.orders.all()', '  const out = []', '  for (const o of orders) {', '    const customer = await db.customers.find(o.customerId)', '    out.push({ ...o, customer })', '  }', '  return out', '}'] }],
    planted: [{ path: 'src/orders.ts', contains: 'await db.customers.find', kind: 'performance', why: 'one query per order (N+1); fetch the customers in one query' }],
  },
  {
    id: 'perf-quadratic', title: 'Find users who are in both lists',
    files: [{ path: 'src/overlap.ts', before: ['export const both = (a: string[], b: string[]) => []'], after: ['export function both(a: string[], b: string[]) {', '  return a.filter((id) => b.includes(id))', '}'] }],
    planted: [{ path: 'src/overlap.ts', contains: 'b.includes(id)', kind: 'performance', why: 'quadratic: use a Set for b' }],
  },

  // ------------------------------------------------------------------------------------------ tests
  {
    id: 'tests-none', title: 'Add a discount engine',
    files: [{ path: 'src/discount.ts', before: ['export const VERSION = 1'], after: ['export const VERSION = 1', '', 'export function discount(total: number, code: string) {', '  if (code === "SAVE10") return total * 0.9', '  if (code === "SAVE20" && total > 100) return total * 0.8', '  if (code === "FREESHIP") return total - 5', '  if (code.startsWith("VIP")) return total * 0.7', '  return total', '}', '', 'export function stack(total: number, codes: string[]) {', '  return codes.reduce((t, c) => discount(t, c), total)', '}', '', 'export function best(total: number, codes: string[]) {', '  return Math.min(...codes.map((c) => discount(total, c)), total)', '}', '', 'export function label(code: string) {', '  return code.toUpperCase().trim()', '}'] }],
    planted: [{ path: 'src/discount.ts', contains: 'export function discount(', kind: 'tests', why: 'twenty lines of pricing logic and no test' }],
  },
  {
    id: 'tests-regression', title: 'Fix: negative quantities allowed in the cart',
    files: [{ path: 'src/qty.ts', before: ['export function clamp(q: number) {', '  return q', '}'], after: ['export function clamp(q: number) {', '  return Math.max(0, q)', '}'] }],
    planted: [{ path: 'src/qty.ts', contains: 'return Math.max(0, q)', kind: 'tests', why: 'a bug fix with no regression test' }],
  },

  // ------------------------------------------------------------------------------------------ maintainability
  {
    id: 'maint-log', title: 'Debug the checkout total',
    files: [{ path: 'src/checkout.ts', before: ['export function total(items: Item[]) {', '  return items.reduce((s, i) => s + i.price, 0)', '}'], after: ['export function total(items: Item[]) {', '  const t = items.reduce((s, i) => s + i.price, 0)', '  console.log("TOTAL IS", t, items)', '  return t', '}'] }],
    planted: [{ path: 'src/checkout.ts', contains: 'console.log("TOTAL IS"', kind: 'maintainability', why: 'leftover debug output in production code' }],
  },
  {
    id: 'maint-dead', title: 'Try a new tax calculation',
    files: [{ path: 'src/tax.ts', before: ['export function tax(n: number) {', '  return n * 0.2', '}'], after: ['export function tax(n: number) {', '  // const rate = region === "EU" ? 0.21 : 0.2', '  // const base = n - shipping(n)', '  // const rounded = Math.round(base * rate * 100) / 100', '  // return rounded', '  return n * 0.2', '}'] }],
    planted: [{ path: 'src/tax.ts', contains: '// const rate =', kind: 'maintainability', why: 'a block of commented-out code left in' }],
  },

  // ------------------------------------------------------------------------------------------ clean changes and traps
  {
    id: 'clean-rename', title: 'Rename a variable for clarity', files: [{ path: 'src/greet.ts', before: ['export function greet(n: string) {', '  return "hi " + n', '}'], after: ['export function greet(name: string) {', '  return "hi " + name', '}'] }], planted: [],
  },
  {
    id: 'clean-test-only', title: 'Add tests for discount',
    files: [{ path: 'src/discount.test.ts', after: ['import { describe, expect, it } from "vitest"', 'import { discount } from "./discount"', '', 'describe("discount", () => {', '  it("takes 10% off with SAVE10", () => {', '    expect(discount(100, "SAVE10")).toBe(90)', '  })', '})'] }], planted: [],
  },
  {
    id: 'clean-docs', title: 'Explain how to run locally',
    files: [{ path: 'README.md', before: ['# App', '', 'A small app.'], after: ['# App', '', 'A small app.', '', '## Run it', '', 'Install dependencies with `npm install`, then start it with `npm run dev`.'] }], planted: [],
  },
  {
    id: 'clean-good-query', title: 'Look up an order safely',
    files: [{ path: 'src/order-lookup.ts', before: ['import { db } from "./db"'], after: ['import { db } from "./db"', '', 'export async function find(id: number) {', '  try {', '    const rows = await db.query("SELECT * FROM orders WHERE id = $1", [id])', '    return rows[0] ?? null', '  } catch (err) {', '    logger.error({ err, id }, "order lookup failed")', '    throw err', '  }', '}'] }], planted: [],
  },
  {
    id: 'trap-comment', title: 'Document why we never use eval',
    files: [{ path: 'src/parse.ts', before: ['export function parse(s: string) {', '  return JSON.parse(s)', '}'], after: ['// Do not use eval(...) or new Function(...) here: input is untrusted, so we only ever JSON.parse it.', 'export function parse(s: string) {', '  return JSON.parse(s)', '}'] }], planted: [],
  },
  {
    id: 'trap-cli', title: 'Print the version from the CLI',
    files: [{ path: 'bin/cli.ts', before: ['const args = process.argv.slice(2)', ''], after: ['const args = process.argv.slice(2)', '', 'if (args.includes("--version")) {', '  console.log("app 1.4.0")', '  process.exit(0)', '}'] }], planted: [],
  },
  {
    id: 'trap-fixture', title: 'Test login with a fixture user',
    files: [{ path: 'src/login.test.ts', before: ['import { login } from "./login"'], after: ['import { login } from "./login"', '', 'const user = { name: "test", password: "correct-horse-battery" }', '', 'it("logs in", async () => {', '  expect(await login(user)).toBeTruthy()', '})'] }], planted: [],
  },
]
