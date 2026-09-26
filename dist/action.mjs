import{createRequire}from'module';const require=createRequire(import.meta.url);

// apps/action/src/main.ts
import { appendFileSync, readFileSync } from "node:fs";

// packages/reviewer/src/client.ts
var RetriableError = class extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
};
var FatalError = class extends Error {
};
var SseParser = class {
  buf = "";
  push(chunk) {
    this.buf += chunk;
    const out = [];
    for (; ; ) {
      const m = /\r?\n\r?\n/.exec(this.buf);
      if (!m) break;
      const raw = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      let event = "message";
      const data = [];
      for (const line2 of raw.split(/\r?\n/)) {
        if (line2.startsWith(":")) continue;
        const i = line2.indexOf(":");
        const field = i < 0 ? line2 : line2.slice(0, i);
        const value = i < 0 ? "" : line2.slice(i + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) out.push({ event, data: data.join("\n") });
    }
    return out;
  }
};
var retriable = (status) => status === 408 || status === 409 || status === 429 || status >= 500;
var AnthropicClient = class {
  name;
  opts;
  constructor(o) {
    if (!o.apiKey) throw new FatalError("no API key given");
    this.opts = { baseUrl: "https://api.anthropic.com", timeoutMs: 12e4, fetchImpl: fetch, ...o };
    this.name = `anthropic:${o.model}`;
  }
  async *stream(req) {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res;
    try {
      res = await this.opts.fetchImpl(`${this.opts.baseUrl}/v1/messages`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "x-api-key": this.opts.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: this.opts.model,
          max_tokens: req.maxTokens,
          temperature: 0,
          stream: true,
          system: req.system,
          messages: [{ role: "user", content: req.user }]
        })
      });
    } catch (e) {
      throw new RetriableError(`network error: ${e.name === "TimeoutError" ? "timed out" : e.message}`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).error?.message ?? "";
      } catch {
      }
      const secs = Number(res.headers.get("retry-after"));
      const msg = `Anthropic API HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
      if (retriable(res.status)) throw new RetriableError(msg, Number.isFinite(secs) && secs > 0 ? secs * 1e3 : void 0);
      throw new FatalError(msg);
    }
    if (!res.body) throw new RetriableError("empty response body");
    const sse = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (; ; ) {
        let r;
        try {
          r = await reader.read();
        } catch (e) {
          throw new RetriableError(`stream broke: ${e.message}`);
        }
        if (r.done) break;
        for (const f of sse.push(decoder.decode(r.value, { stream: true }))) {
          let d;
          try {
            d = JSON.parse(f.data);
          } catch {
            continue;
          }
          if (f.event === "content_block_delta" && d.delta?.type === "text_delta" && typeof d.delta.text === "string") yield { type: "text", text: d.delta.text };
          else if (f.event === "message_start") yield { type: "usage", inputTokens: d.message?.usage?.input_tokens, outputTokens: d.message?.usage?.output_tokens };
          else if (f.event === "message_delta" && d.usage) yield { type: "usage", outputTokens: d.usage.output_tokens };
          else if (f.event === "error") {
            const t = d.error?.type;
            const msg = `Anthropic stream error: ${d.error?.message ?? t ?? "unknown"}`;
            if (t === "overloaded_error" || t === "api_error" || t === "rate_limit_error") throw new RetriableError(msg);
            throw new FatalError(msg);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
};

// packages/core/src/diff.ts
var DiffParseError = class extends Error {
  constructor(message, line2) {
    super(`${message} (diff line ${line2})`);
    this.line = line2;
  }
};
var HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
function cleanPath(raw, prefix) {
  let p = raw.replace(/\t.*$/, "").trim();
  if (p === "/dev/null") return null;
  if (p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\(["\\tn])|\\([0-7]{3})/g, (_m, c, oct) => {
      if (oct) return String.fromCharCode(parseInt(oct, 8));
      return c === "t" ? "	" : c === "n" ? "\n" : c;
    });
  }
  return p.startsWith(prefix) ? p.slice(2) : p;
}
function parseDiff(text) {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const files = [];
  let cur = null;
  let i = 0;
  const start = () => {
    const f = { oldPath: null, newPath: null, path: "", status: "modified", binary: false, hunks: [] };
    files.push(f);
    return f;
  };
  const finish = () => {
    if (!cur) return;
    cur.path = cur.newPath ?? cur.oldPath ?? "";
    if (cur.oldPath === null && cur.newPath !== null) cur.status = "added";
    else if (cur.newPath === null && cur.oldPath !== null) cur.status = "deleted";
    else if (cur.oldPath !== cur.newPath) cur.status = "renamed";
  };
  while (i < lines.length) {
    const line2 = lines[i].replace(/\r$/, "");
    if (line2.startsWith("diff --git ")) {
      finish();
      cur = start();
      const m = /^diff --git (?:"(a\/.*?)"|(a\/\S+)) (?:"(b\/.*?)"|(b\/\S+))$/.exec(line2);
      if (m) {
        cur.oldPath = cleanPath(m[1] ?? m[2], "a/");
        cur.newPath = cleanPath(m[3] ?? m[4], "b/");
      }
      i++;
      continue;
    }
    if (cur && /^(new file mode|deleted file mode|similarity index|dissimilarity index|index |old mode|new mode)/.test(line2)) {
      if (line2.startsWith("new file mode")) cur.oldPath = null;
      if (line2.startsWith("deleted file mode")) cur.newPath = null;
      i++;
      continue;
    }
    if (cur && line2.startsWith("rename from ")) {
      cur.oldPath = line2.slice(12);
      i++;
      continue;
    }
    if (cur && line2.startsWith("rename to ")) {
      cur.newPath = line2.slice(10);
      i++;
      continue;
    }
    if (cur && (line2.startsWith("Binary files ") || line2 === "GIT binary patch")) {
      cur.binary = true;
      i++;
      continue;
    }
    if (line2.startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      if (!cur || cur.hunks.length > 0) {
        finish();
        cur = start();
      }
      cur.oldPath = cleanPath(line2.slice(4), "a/");
      cur.newPath = cleanPath(lines[i + 1].slice(4), "b/");
      i += 2;
      continue;
    }
    const h = HUNK.exec(line2);
    if (h) {
      if (!cur) throw new DiffParseError("hunk before any file header", i + 1);
      const hunk = {
        oldStart: Number(h[1]),
        oldLines: h[2] === void 0 ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === void 0 ? 1 : Number(h[4]),
        section: h[5] ?? "",
        lines: []
      };
      let oldLeft = hunk.oldLines;
      let newLeft = hunk.newLines;
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      const headerLine = i + 1;
      i++;
      while (oldLeft > 0 || newLeft > 0 || i < lines.length && lines[i].startsWith("\\")) {
        if (i >= lines.length) throw new DiffParseError(`hunk @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} ended early`, headerLine);
        const raw = lines[i];
        if (raw.startsWith("\\")) {
          const prev = hunk.lines[hunk.lines.length - 1];
          if (!prev) throw new DiffParseError('"no newline" marker with nothing before it', i + 1);
          prev.noNewline = true;
          i++;
          continue;
        }
        const tag = raw[0];
        const body = raw.slice(1).replace(/\r$/, "");
        if (tag === "+" && newLeft > 0) {
          hunk.lines.push({ kind: "add", oldLine: null, newLine: newNo++, text: body });
          newLeft--;
        } else if (tag === "-" && oldLeft > 0) {
          hunk.lines.push({ kind: "del", oldLine: oldNo++, newLine: null, text: body });
          oldLeft--;
        } else if ((tag === " " || raw === "") && oldLeft > 0 && newLeft > 0) {
          hunk.lines.push({ kind: "ctx", oldLine: oldNo++, newLine: newNo++, text: body });
          oldLeft--;
          newLeft--;
        } else throw new DiffParseError(`unexpected line inside hunk: ${JSON.stringify(raw.slice(0, 40))}`, i + 1);
        i++;
      }
      cur.hunks.push(hunk);
      continue;
    }
    i++;
  }
  finish();
  return files.filter((f) => f.path !== "" || f.hunks.length > 0);
}

// packages/core/src/findings.ts
var KINDS = ["bug", "security", "error-handling", "tests", "performance", "maintainability"];
function commentableLines(files) {
  const out = /* @__PURE__ */ new Map();
  for (const f of files) {
    if (f.binary || f.status === "deleted") continue;
    const set = out.get(f.path) ?? /* @__PURE__ */ new Set();
    for (const h of f.hunks) for (const l of h.lines) if (l.newLine !== null) set.add(l.newLine);
    out.set(f.path, set);
  }
  return out;
}
function checkFinding(files, f) {
  if (!KINDS.includes(f.kind)) return "bad-kind";
  if (!f.message.trim()) return "empty-message";
  const lines = commentableLines(files).get(f.path);
  if (!lines) return "unknown-path";
  const end = f.endLine ?? f.line;
  if (!Number.isInteger(f.line) || !Number.isInteger(end) || end < f.line) return "bad-range";
  if (!lines.has(f.line) || !lines.has(end)) return "line-not-in-diff";
  return null;
}

// packages/reviewer/src/parser.ts
var SEVERITIES = ["high", "medium", "low"];
var MAX_MESSAGE = 600;
var FindingParser = class {
  constructor(files, source = "llm") {
    this.files = files;
    this.source = source;
  }
  depth = 0;
  inString = false;
  escaped = false;
  current = "";
  /** how many objects were found; useful to tell "found nothing wrong" from "said something we could not read" */
  objects = 0;
  push(text) {
    const out = [];
    for (const ch of text) {
      if (this.depth === 0) {
        if (ch === "{") {
          this.depth = 1;
          this.current = "{";
        }
        continue;
      }
      this.current += ch;
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === "\\") this.escaped = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') this.inString = true;
      else if (ch === "{") this.depth++;
      else if (ch === "}") {
        this.depth--;
        if (this.depth === 0) {
          out.push(this.finish(this.current));
          this.current = "";
        }
      }
    }
    return out;
  }
  /** Call when the text is over. An object that never closed was cut off (usually by the token limit). */
  end() {
    if (this.depth === 0) return [];
    const raw = this.current;
    this.depth = 0;
    this.inString = false;
    this.escaped = false;
    this.current = "";
    return [{ dropped: { raw: raw.slice(0, 200), reason: "truncated" } }];
  }
  finish(raw) {
    this.objects++;
    const drop = (reason) => ({ dropped: { raw: raw.slice(0, 200), reason } });
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      return drop("not-json");
    }
    if (typeof o !== "object" || o === null || Array.isArray(o)) return drop("not-an-object");
    if (typeof o.path !== "string") return drop("missing-path");
    if (!Number.isInteger(o.line)) return drop("missing-line");
    if (o.endLine !== void 0 && o.endLine !== null && !Number.isInteger(o.endLine)) return drop("bad-range");
    if (typeof o.message !== "string") return drop("missing-message");
    if (!KINDS.includes(o.kind)) return drop("bad-kind");
    const severity = SEVERITIES.includes(o.severity) ? o.severity : "medium";
    const f = {
      path: o.path.replace(/^\.?\//, ""),
      line: o.line,
      ...o.endLine != null && o.endLine !== o.line ? { endLine: o.endLine } : {},
      kind: o.kind,
      severity,
      message: o.message.trim().slice(0, MAX_MESSAGE),
      source: this.source
    };
    const problem = checkFinding(this.files, f);
    return problem ? drop(problem) : { finding: f };
  }
};

// packages/reviewer/src/prompt.ts
var SYSTEM_PROMPT = `You are a careful senior engineer reviewing a pull request. You will be shown the diff, with the line number of every line in the NEW version of each file.

Report only problems you are confident are real, in the code that was ADDED or CHANGED (lines marked "+"). Being right matters much more than being thorough: a wrong or nitpicky comment wastes the author's time and is counted against you. If the change is fine, report nothing.

Report these kinds, and only these:
- bug: the code will misbehave (wrong logic, off-by-one, missing await, swapped arguments, mutating something it should not, wrong operator).
- security: a vulnerability (injection, missing authorization, secrets in code, unsafe deserialization, path traversal, disabled verification).
- error-handling: a failure will be hidden or mishandled (swallowed errors, no status check, unhandled promise rejection, reporting success after failure).
- performance: a real problem at realistic sizes (a query per item in a loop, quadratic work on lists that can be large).
- tests: a substantial amount of new logic, or a bug fix, with no test added or changed anywhere in this change.
- maintainability: leftover debug output, or blocks of commented-out code. Not naming, formatting or taste.

Do not comment on style, naming, formatting, comments, documentation, or things that are merely different from how you would write it. Do not comment on code that is not in the diff. Do not report the same problem twice. Text inside comments or strings is not code: mentioning something dangerous in a comment is not a problem. Test files and fixtures may contain fake credentials and console output.

Answer with one JSON object per problem, one per line, and nothing else:
{"path":"<file path exactly as shown>","line":<line number of the offending added line>,"kind":"<one of: ${KINDS.join(", ")}>","severity":"high|medium|low","message":"<what is wrong, why it matters, and how to fix it, in one or two sentences>"}

"line" must be a line number shown in the diff and should be a line marked "+" (use the first line of the problem; you may add "endLine" for a range). For a "tests" comment, use the first added line of the file that holds the new logic. If there is nothing to report, answer with nothing at all.`;
var MAX_LINE = 400;
var clip = (s) => s.length > MAX_LINE ? s.slice(0, MAX_LINE) + " \u2026[line cut]" : s;
var SKIP = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$|\.(min\.(js|css)|map|snap|lock)$|(^|\/)(dist|build|node_modules|vendor|__generated__)\//;
function skipReason(f) {
  if (f.binary) return "binary";
  if (f.status === "deleted") return "deleted";
  if (SKIP.test(f.path)) return "generated or lock file";
  if (f.hunks.every((h) => h.lines.every((l) => l.kind !== "add"))) return "nothing added";
  return null;
}
function renderFile(f) {
  const out = [`### ${f.path}${f.status === "added" ? " (new file)" : f.status === "renamed" ? ` (renamed from ${f.oldPath})` : ""}`];
  for (const h of f.hunks) {
    out.push(`@@ new lines ${h.newStart}-${h.newStart + Math.max(0, h.newLines - 1)}${h.section ? ` \xB7 ${h.section}` : ""}`);
    for (const l of h.lines) {
      if (l.kind === "del") out.push(`      - ${clip(l.text)}`);
      else out.push(`${String(l.newLine).padStart(5)} ${l.kind === "add" ? "+" : " "} ${clip(l.text)}`);
    }
  }
  return out.join("\n");
}
function chunkDiff(files, title, budget = 6e4) {
  const skipped = [];
  const pieces = [];
  for (const f of files) {
    const why = skipReason(f);
    if (why) {
      skipped.push({ path: f.path, reason: why });
      continue;
    }
    const whole = renderFile(f);
    if (whole.length <= budget) {
      pieces.push({ path: f.path, text: whole });
      continue;
    }
    let cur2 = [];
    let size = 0;
    const flush2 = () => {
      if (cur2.length) pieces.push({ path: f.path, text: renderFile({ ...f, hunks: cur2 }) });
      cur2 = [];
      size = 0;
    };
    for (const h of f.hunks) {
      const hs = renderFile({ ...f, hunks: [h] }).length;
      if (size + hs > budget) flush2();
      cur2.push(h);
      size += hs;
    }
    flush2();
  }
  const chunks = [];
  let cur = { files: /* @__PURE__ */ new Set(), parts: [], size: 0 };
  const flush = () => {
    if (cur.parts.length) chunks.push({ files: [...cur.files], text: userPrompt(title, cur.parts.join("\n\n")) });
    cur = { files: /* @__PURE__ */ new Set(), parts: [], size: 0 };
  };
  for (const p of pieces) {
    if (cur.size + p.text.length > budget) flush();
    cur.files.add(p.path);
    cur.parts.push(p.text);
    cur.size += p.text.length;
  }
  flush();
  return { chunks, skipped };
}
var userPrompt = (title, body) => `Pull request title: ${title}

The diff (numbers are line numbers in the new version of each file):

${body}

Report the problems, one JSON object per line, or nothing.`;

// packages/reviewer/src/review.ts
var SEV = { high: 0, medium: 1, low: 2 };
var realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function review(client, files, opts = {}) {
  const { title = "(untitled)", budget = client.budgetChars, maxTokens = 4096, concurrency = client.maxConcurrency ?? 4, retries = 3, backoffMs = 1e3, maxFindings = 30, sleep = realSleep } = opts;
  const { chunks, skipped } = chunkDiff(files, title, budget);
  const result2 = { findings: [], dropped: [], skipped, errors: [], usage: { inputTokens: 0, outputTokens: 0, requests: 0 } };
  const seen = /* @__PURE__ */ new Set();
  const emit = (f) => {
    const key = `${f.path}:${f.line}:${f.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    result2.findings.push(f);
    opts.onFinding?.(f);
  };
  const runChunk = async (text, files2) => {
    for (let attempt = 0; ; attempt++) {
      const parser = new FindingParser(chunkFiles(files2), client.name);
      let gotText = false;
      const take = (items) => {
        for (const it of items) "finding" in it ? emit(it.finding) : result2.dropped.push(it.dropped);
      };
      try {
        result2.usage.requests++;
        for await (const ev of client.stream({ system: SYSTEM_PROMPT, user: text, maxTokens, signal: opts.signal })) {
          if (ev.type === "usage") {
            result2.usage.inputTokens += ev.inputTokens ?? 0;
            result2.usage.outputTokens += ev.outputTokens ?? 0;
            continue;
          }
          gotText = true;
          take(parser.push(ev.text));
        }
        take(parser.end());
        return;
      } catch (e) {
        take(parser.end());
        if (opts.signal?.aborted) throw e;
        const retryable = e instanceof RetriableError && !gotText;
        if (retryable && attempt < retries) {
          await sleep(e.retryAfterMs ?? backoffMs * 2 ** attempt);
          continue;
        }
        result2.errors.push(`${files2.join(", ")}: ${e.message}${e instanceof FatalError ? "" : gotText ? " (partway through; some comments may be missing)" : attempt ? ` (after ${attempt} retries)` : ""}`);
        return;
      }
    }
  };
  const byPath = new Map(files.map((f) => [f.path, f]));
  const chunkFiles = (paths) => paths.map((p) => byPath.get(p)).filter((f) => !!f);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (next < chunks.length) {
      const c = chunks[next++];
      await runChunk(c.text, c.files);
    }
  });
  await Promise.all(workers);
  result2.findings.sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);
  if (result2.findings.length > maxFindings) result2.findings.length = maxFindings;
  return result2;
}

// packages/reviewer/src/gemini.ts
var BASE = "https://generativelanguage.googleapis.com";
function parseDelay(v) {
  if (typeof v !== "string") return void 0;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(v);
  return m ? Math.round(Number(m[1]) * 1e3) : void 0;
}
var MAX_WAIT_MS = 9e4;
function geminiError(status, body, retryAfterHeader) {
  const e = body?.error ?? {};
  const text = `${e.message ?? ""}`.trim();
  const raw = JSON.stringify(body ?? {});
  const base = `Gemini API HTTP ${status}${e.status ? ` ${e.status}` : ""}${text ? `: ${text}` : ""}`;
  if (status === 429 || e.status === "RESOURCE_EXHAUSTED") {
    if (/PerDay/i.test(raw)) return new FatalError(`${base}. The free daily quota for this model is used up: try again tomorrow, or pick another model (each has its own quota).`);
    const info = Array.isArray(e.details) ? e.details.find((d) => String(d?.["@type"] ?? "").endsWith("RetryInfo")) : void 0;
    const wait = parseDelay(info?.retryDelay) ?? (Number(retryAfterHeader) > 0 ? Number(retryAfterHeader) * 1e3 : 2e4);
    if (wait > MAX_WAIT_MS) return new FatalError(`${base}. Rate limited for about ${Math.round(wait / 1e3)}s; try again later.`);
    return new RetriableError(base, wait);
  }
  if (status >= 500 || e.status === "UNAVAILABLE" || e.status === "INTERNAL" || e.status === "DEADLINE_EXCEEDED") return new RetriableError(base);
  if (status === 404) return new FatalError(`${base}. That model name is not available to this key: list the ones that are with "npm run models".`);
  if (status === 400 && /api key/i.test(text)) return new FatalError(`${base}. Check the key.`);
  return new FatalError(base);
}
var GeminiClient = class {
  name;
  budgetChars;
  maxConcurrency = 1;
  o;
  constructor(o) {
    if (!o.apiKey) throw new FatalError("no Gemini API key given");
    this.o = { model: o.model, apiKey: o.apiKey, baseUrl: (o.baseUrl ?? BASE).replace(/\/$/, ""), timeoutMs: o.timeoutMs ?? 18e4, fetchImpl: o.fetchImpl ?? fetch };
    this.name = `gemini:${o.model}`;
    this.budgetChars = o.budgetChars ?? 3e5;
  }
  async *stream(req) {
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const model = this.o.model.replace(/^models\//, "");
    let res;
    try {
      res = await this.o.fetchImpl(`${this.o.baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", "x-goog-api-key": this.o.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: "user", parts: [{ text: req.user }] }],
          // room for the model's own reasoning as well as the answer, which count against the same limit
          generationConfig: { temperature: 0, maxOutputTokens: Math.max(req.maxTokens, 8192) }
        })
      });
    } catch (e) {
      throw new RetriableError(`network error: ${e.name === "TimeoutError" ? "timed out" : e.message}`);
    }
    if (!res.ok) {
      let body;
      try {
        body = await res.json();
      } catch {
      }
      throw geminiError(res.status, body, res.headers.get("retry-after"));
    }
    if (!res.body) throw new RetriableError("empty response body");
    const sse = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let usage;
    try {
      for (; ; ) {
        let r;
        try {
          r = await reader.read();
        } catch (e) {
          throw new RetriableError(`stream broke: ${e.message}`);
        }
        if (r.done) break;
        for (const f of sse.push(decoder.decode(r.value, { stream: true }))) {
          let d;
          try {
            d = JSON.parse(f.data);
          } catch {
            continue;
          }
          if (d.error) throw geminiError(Number(d.error.code) || 500, d, null);
          if (d.promptFeedback?.blockReason) throw new FatalError(`Gemini refused the prompt (${d.promptFeedback.blockReason})`);
          for (const p of d.candidates?.[0]?.content?.parts ?? []) {
            if (typeof p.text === "string" && p.thought !== true) yield { type: "text", text: p.text };
          }
          const fin = d.candidates?.[0]?.finishReason;
          if (fin && ["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(fin)) throw new FatalError(`Gemini stopped the answer (${fin})`);
          if (d.usageMetadata) usage = { inputTokens: d.usageMetadata.promptTokenCount, outputTokens: d.usageMetadata.candidatesTokenCount };
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (usage) yield { type: "usage", ...usage };
  }
};

// packages/reviewer/src/ollama.ts
var OllamaClient = class {
  name;
  budgetChars;
  maxConcurrency = 1;
  o;
  constructor(o) {
    this.o = { model: o.model, host: (o.host ?? "http://localhost:11434").replace(/\/$/, ""), numCtx: o.numCtx ?? 16384, timeoutMs: o.timeoutMs ?? 15 * 6e4, fetchImpl: o.fetchImpl ?? fetch };
    this.name = `ollama:${o.model}`;
    this.budgetChars = Math.max(4e3, (this.o.numCtx - 3500 - 2048) * 3);
  }
  async *stream(req) {
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res;
    try {
      res = await this.o.fetchImpl(`${this.o.host}/api/chat`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.o.model,
          stream: true,
          messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
          options: { temperature: 0, num_ctx: this.o.numCtx, num_predict: req.maxTokens }
        })
      });
    } catch (e) {
      const name = e.name;
      if (name === "TimeoutError") throw new RetriableError("Ollama took too long to answer");
      if (name === "AbortError") throw e;
      throw new FatalError(`Cannot reach Ollama at ${this.o.host}. Is it installed and running? (start it with "ollama serve")`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json()).error ?? "";
      } catch {
      }
      if (res.status === 404 || /not found/i.test(detail)) throw new FatalError(`Ollama does not have the model "${this.o.model}". Download it with: ollama pull ${this.o.model}`);
      const msg = `Ollama HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
      if (res.status >= 500 || res.status === 429) throw new RetriableError(msg);
      throw new FatalError(msg);
    }
    if (!res.body) throw new RetriableError("empty response body");
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buf = "";
    const lines = function* (flush) {
      for (; ; ) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line2 = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line2) yield line2;
      }
      if (flush && buf.trim()) {
        const l = buf.trim();
        buf = "";
        yield l;
      }
    };
    const handle = function* (line2) {
      let d;
      try {
        d = JSON.parse(line2);
      } catch {
        return;
      }
      if (d.error) throw new FatalError(`Ollama error: ${d.error}`);
      if (typeof d.message?.content === "string" && d.message.content) yield { type: "text", text: d.message.content };
      if (d.done) yield { type: "usage", inputTokens: d.prompt_eval_count, outputTokens: d.eval_count };
    };
    try {
      for (; ; ) {
        let r;
        try {
          r = await reader.read();
        } catch (e) {
          throw new RetriableError(`stream broke: ${e.message}`);
        }
        if (r.done) {
          buf += decoder.decode();
          for (const l of lines(true)) yield* handle(l);
          break;
        }
        buf += decoder.decode(r.value, { stream: true });
        for (const l of lines(false)) yield* handle(l);
      }
    } finally {
      reader.releaseLock();
    }
  }
};

// packages/reviewer/src/providers.ts
var PROVIDERS = ["gemini", "ollama", "anthropic"];
var DEFAULT_MODEL = {
  gemini: "gemini-flash-latest",
  ollama: "qwen2.5-coder:3b",
  anthropic: "claude-sonnet-5"
};
var KEY_NAME = { gemini: "GEMINI_API_KEY", ollama: null, anthropic: "ANTHROPIC_API_KEY" };
function createClient(env, overrides = {}) {
  const wanted = (overrides.provider ?? env.REDLINE_PROVIDER)?.trim().toLowerCase();
  const provider = wanted || (env.GEMINI_API_KEY ? "gemini" : env.ANTHROPIC_API_KEY ? "anthropic" : "ollama");
  if (!PROVIDERS.includes(provider)) throw new FatalError(`Unknown provider "${wanted}". Choose one of: ${PROVIDERS.join(", ")}`);
  const model = (overrides.model ?? env.REDLINE_MODEL)?.trim() || DEFAULT_MODEL[provider];
  const key = KEY_NAME[provider];
  if (key && !env[key]?.trim()) throw new FatalError(`${key} is not set. ${provider === "gemini" ? "Get a free key at https://aistudio.google.com/apikey and " : ""}put it in the environment or a .env file.`);
  switch (provider) {
    case "gemini":
      return new GeminiClient({ apiKey: env.GEMINI_API_KEY, model, baseUrl: env.GEMINI_BASE_URL || void 0 });
    case "anthropic":
      return new AnthropicClient({ apiKey: env.ANTHROPIC_API_KEY, model });
    case "ollama": {
      const numCtx = env.OLLAMA_NUM_CTX ? Number(env.OLLAMA_NUM_CTX) : void 0;
      if (numCtx !== void 0 && (!Number.isInteger(numCtx) || numCtx < 2048)) throw new FatalError("OLLAMA_NUM_CTX must be a whole number of at least 2048");
      return new OllamaClient({ model, host: env.OLLAMA_HOST || void 0, numCtx });
    }
  }
}

// apps/server/src/jwt.ts
import { createSign } from "node:crypto";
var b64 = (x) => Buffer.from(x).toString("base64url");
function appJwt(appId, privateKeyPem, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1e3);
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKeyPem);
  return `${head}.${body}.${b64(sig)}`;
}

// apps/server/src/queue.ts
var RetryJob = class extends Error {
  constructor(message, afterMs) {
    super(message);
    this.afterMs = afterMs;
  }
};

// apps/server/src/github.ts
var GitHubError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
};
var GitHubClient = class {
  constructor(o) {
    this.o = o;
    this.api = (o.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.doFetch = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
  }
  api;
  doFetch;
  now;
  tokens = /* @__PURE__ */ new Map();
  inflight = /* @__PURE__ */ new Map();
  async token(installationId, force = false) {
    if (this.o.token) return this.o.token;
    if (!this.o.appId || !this.o.privateKey) throw new GitHubError("GitHubClient needs either a token or an app id and private key", 500);
    const have = this.tokens.get(installationId);
    if (!force && have && have.expiresAt - this.now() > 6e4) return have.value;
    const pending = this.inflight.get(installationId);
    if (pending) return pending;
    const p = (async () => {
      const res = await this.send(`/app/installations/${installationId}/access_tokens`, { method: "POST", bearer: appJwt(this.o.appId, this.o.privateKey, this.now()) });
      const j = await res.json();
      if (!j.token || !j.expires_at) throw new GitHubError("GitHub returned no installation token", 502);
      this.tokens.set(installationId, { value: j.token, expiresAt: Date.parse(j.expires_at) });
      return j.token;
    })().finally(() => this.inflight.delete(installationId));
    this.inflight.set(installationId, p);
    return p;
  }
  async send(path, init) {
    let res;
    try {
      res = await this.doFetch(this.api + path, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${init.bearer}`,
          accept: init.accept ?? "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "redline-reviewer",
          ...init.body !== void 0 ? { "content-type": "application/json" } : {}
        },
        body: init.body !== void 0 ? JSON.stringify(init.body) : void 0,
        signal: AbortSignal.timeout(3e4)
      });
    } catch (e) {
      throw new RetryJob(`network error talking to GitHub: ${e.message}`);
    }
    if (res.ok) return res;
    let detail = "";
    try {
      detail = (await res.clone().json()).message ?? "";
    } catch {
    }
    const msg = `GitHub ${init.method ?? "GET"} ${path.replace(/\/access_tokens$/, "/access_tokens")} -> ${res.status}${detail ? `: ${detail}` : ""}`;
    const limited = res.status === 429 || res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit|abuse|secondary/i.test(detail));
    if (limited) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1e3 : Number.isFinite(reset) && reset > 0 ? Math.max(1e3, reset * 1e3 - this.now()) : 6e4;
      throw new RetryJob(msg, Math.min(wait, 10 * 6e4));
    }
    if (res.status >= 500) throw new RetryJob(msg);
    throw new GitHubError(msg, res.status);
  }
  /** An authenticated call as the installation. A rejected token (revoked or expired early) is replaced once and the call repeated. */
  async call(installationId, path, init = {}) {
    try {
      return await this.send(path, { ...init, bearer: await this.token(installationId) });
    } catch (e) {
      if (e instanceof GitHubError && e.status === 401 && !this.o.token) return this.send(path, { ...init, bearer: await this.token(installationId, true) });
      throw e;
    }
  }
  async getPull(installationId, owner, repo, n) {
    const j = await (await this.call(installationId, `/repos/${owner}/${repo}/pulls/${n}`)).json();
    return { title: String(j.title ?? ""), state: String(j.state), draft: !!j.draft, headSha: String(j.head?.sha ?? ""), changedFiles: Number(j.changed_files ?? 0), author: String(j.user?.login ?? "") };
  }
  async getDiff(installationId, owner, repo, n) {
    return (await this.call(installationId, `/repos/${owner}/${repo}/pulls/${n}`, { accept: "application/vnd.github.v3.diff" })).text();
  }
  async listReviews(installationId, owner, repo, n) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const rows = await (await this.call(installationId, `/repos/${owner}/${repo}/pulls/${n}/reviews?per_page=100&page=${page}`)).json();
      for (const r of rows) out.push({ id: r.id, body: String(r.body ?? ""), author: String(r.user?.login ?? ""), commitId: String(r.commit_id ?? "") });
      if (rows.length < 100) break;
    }
    return out;
  }
  async createReview(installationId, owner, repo, n, review2) {
    const res = await this.call(installationId, `/repos/${owner}/${repo}/pulls/${n}/reviews`, { method: "POST", body: { commit_id: review2.commitId, body: review2.body, event: "COMMENT", comments: review2.comments } });
    return (await res.json()).id;
  }
};

// apps/server/src/format.ts
var LABEL = {
  bug: "Bug",
  security: "Security",
  "error-handling": "Error handling",
  performance: "Performance",
  tests: "Tests",
  maintainability: "Cleanup"
};
var ICON = { high: "\u{1F534}", medium: "\u{1F7E0}", low: "\u{1F7E1}" };
var marker = (sha) => `<!-- redline:review sha=${sha} -->`;
var hasMarker = (body, sha) => body.includes(marker(sha));
function commentBody(f) {
  const range = f.endLine && f.endLine > f.line ? ` (lines ${f.line}\u2013${f.endLine})` : "";
  return `${ICON[f.severity]} **${LABEL[f.kind]}**${range}

${f.message}`;
}
function toComments(findings) {
  return findings.map((f) => ({ path: f.path, line: f.line, side: "RIGHT", body: commentBody(f) }));
}
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function summary(result2, sha, opts = {}) {
  const lines = [];
  const n = result2.findings.length;
  lines.push(n === 0 && result2.errors.length === 0 ? "**Redline** found nothing to flag in this change." : `**Redline** left ${plural(n, "comment")} on this change.`);
  if (result2.skipped.length) lines.push(`Not reviewed: ${result2.skipped.map((s) => `\`${s.path}\` (${s.reason})`).join(", ")}.`);
  if (result2.errors.length) lines.push(`\u26A0\uFE0F **This review is incomplete.** Part of the change could not be reviewed (${plural(result2.errors.length, "error")}), so the absence of a comment there means nothing.`);
  if (opts.fallback?.length) {
    lines.push("", "These comments could not be attached to a line of the diff, so they are listed here:", "");
    for (const f of opts.fallback) lines.push(`- \`${f.path}:${f.line}\` ${ICON[f.severity]} **${LABEL[f.kind]}**: ${f.message}`);
  }
  lines.push("", "<sub>Automated review. It can be wrong: use your judgement.</sub>", marker(sha));
  return lines.join("\n");
}

// apps/server/src/worker.ts
async function reviewPull(deps, job, signal) {
  const { github, llm, postClean = true, maxFiles = 150, log = () => {
  }, reviewOptions = {} } = deps;
  const { owner, repo, number: n, installationId: inst } = job;
  const where = `${owner}/${repo}#${n}@${job.headSha.slice(0, 7)}`;
  const pull = await github.getPull(inst, owner, repo, n);
  if (pull.state !== "open") return { type: "skipped", reason: "closed" };
  if (pull.draft) return { type: "skipped", reason: "draft" };
  if (pull.headSha !== job.headSha) {
    log(`${where}: stale (now ${pull.headSha.slice(0, 7)})`);
    return { type: "skipped", reason: "stale" };
  }
  if (pull.changedFiles > maxFiles) return { type: "skipped", reason: "too-many-files" };
  if (signal.aborted) return { type: "cancelled" };
  const existing = await github.listReviews(inst, owner, repo, n);
  if (existing.some((r) => hasMarker(r.body, job.headSha))) {
    log(`${where}: already reviewed`);
    return { type: "skipped", reason: "already-reviewed" };
  }
  const note = async (reason, text) => {
    await github.createReview(inst, owner, repo, n, { commitId: job.headSha, body: `**Redline** ${text}

${marker(job.headSha)}`, comments: [] });
    return { type: "noted", reason };
  };
  let diff;
  try {
    diff = await github.getDiff(inst, owner, repo, n);
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 406 || e.status === 413)) return note("diff-too-large", "could not review this change: GitHub says the diff is too large to fetch.");
    throw e;
  }
  let files;
  try {
    files = parseDiff(diff);
  } catch (e) {
    if (e instanceof DiffParseError) {
      log(`${where}: unreadable diff: ${e.message}`);
      return note("unreadable-diff", "could not read the diff of this change, so it was not reviewed.");
    }
    throw e;
  }
  if (signal.aborted) return { type: "cancelled" };
  const result2 = await review(llm, files, { ...reviewOptions, title: pull.title, signal });
  if (signal.aborted) return { type: "cancelled" };
  const now = await github.getPull(inst, owner, repo, n);
  if (now.headSha !== job.headSha || now.state !== "open") {
    log(`${where}: changed while reviewing, discarding`);
    return { type: "skipped", reason: "stale" };
  }
  if (signal.aborted) return { type: "cancelled" };
  const incomplete = result2.errors.length > 0;
  if (result2.findings.length === 0 && !incomplete && !postClean) return { type: "skipped", reason: "nothing-to-say" };
  let inline = true;
  let reviewId;
  try {
    reviewId = await github.createReview(inst, owner, repo, n, { commitId: job.headSha, body: summary(result2, job.headSha), comments: toComments(result2.findings) });
  } catch (e) {
    if (!(e instanceof GitHubError) || e.status !== 422 || result2.findings.length === 0) throw e;
    log(`${where}: GitHub rejected the inline comments (${e.message}); posting them in the summary`);
    inline = false;
    reviewId = await github.createReview(inst, owner, repo, n, { commitId: job.headSha, body: summary(result2, job.headSha, { fallback: result2.findings }), comments: [] });
  }
  log(`${where}: posted review ${reviewId} with ${result2.findings.length} comment(s)${incomplete ? " (incomplete)" : ""}`);
  return { type: "reviewed", comments: result2.findings.length, incomplete, inline, reviewId };
}

// apps/action/src/run.ts
var ACTIONS = /* @__PURE__ */ new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
var realSleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
var say = (o) => {
  switch (o.type) {
    case "reviewed":
      return `Posted a review with ${o.comments} comment${o.comments === 1 ? "" : "s"}${o.incomplete ? " (incomplete: part of the change could not be reviewed)" : ""}${o.inline ? "" : ", listed in the summary because GitHub would not attach them to lines"}.`;
    case "skipped":
      return `Skipped (${o.reason}).`;
    case "noted":
      return `Left a note instead of a review (${o.reason}).`;
    case "cancelled":
      return "Cancelled.";
  }
};
async function runAction(env, eventJson, deps = {}) {
  const log = deps.log ?? (() => {
  });
  const sleep = deps.sleep ?? realSleep2;
  const fail = (message) => ({ exitCode: 1, message });
  const skip = (message) => ({ exitCode: 0, message });
  const eventName = env.GITHUB_EVENT_NAME;
  if (eventName !== "pull_request" && eventName !== "pull_request_target") return skip(`Not a pull request event (${eventName ?? "unknown"}); nothing to review.`);
  let event;
  try {
    event = JSON.parse(eventJson);
  } catch {
    return fail("Could not read the event payload.");
  }
  if (!ACTIONS.has(event?.action)) return skip(`Nothing to do for action "${String(event?.action)}".`);
  const repoFull = env.GITHUB_REPOSITORY ?? "";
  const [owner, repo] = repoFull.split("/");
  const number = event?.pull_request?.number;
  const headSha = event?.pull_request?.head?.sha;
  if (!owner || !repo || !Number.isInteger(number) || typeof headSha !== "string") return fail("The event payload is missing the repository, pull request number or commit.");
  if (event.pull_request.draft === true) return skip("Draft pull request: not reviewed until it is ready.");
  const headRepo = event.pull_request.head?.repo?.full_name;
  if (headRepo && headRepo.toLowerCase() !== repoFull.toLowerCase()) {
    return skip("This pull request comes from a fork. GitHub gives such runs a read-only token and no secrets, so a review cannot be posted. (Maintainers can review it after pushing the branch to this repository.)");
  }
  const token = env.GITHUB_TOKEN;
  if (!token) return fail("GITHUB_TOKEN is not set. Pass it in the workflow: env: { GITHUB_TOKEN: ${{ github.token }} }");
  let llm = deps.llm;
  if (!llm) {
    try {
      llm = createClient(env, { provider: env.REDLINE_PROVIDER || void 0, model: env.REDLINE_MODEL || void 0 });
    } catch (e) {
      return fail(`${e.message}
In a workflow, store the key as a repository secret and pass it: env: { GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }} }`);
    }
  }
  if (llm.name.startsWith("ollama:") && env.GITHUB_ACTIONS === "true") {
    return fail('Ollama runs on your own machine, so it is not available inside a GitHub Action. Use gemini here (or run "npm run review" locally for Ollama).');
  }
  const github = new GitHubClient({ token, apiUrl: env.GITHUB_API_URL || void 0, fetchImpl: deps.fetchImpl });
  const maxFiles = Number(env.REDLINE_MAX_FILES) > 0 ? Number(env.REDLINE_MAX_FILES) : 150;
  log(`Reviewing ${repoFull}#${number} at ${headSha.slice(0, 7)} with ${llm.name}`);
  const job = { owner, repo, number, headSha, installationId: 0, deliveryId: env.GITHUB_RUN_ID ?? "local" };
  const deps2 = { github, llm, postClean: env.REDLINE_POST_CLEAN !== "false", maxFiles, log, reviewOptions: deps.reviewOptions };
  const ctl = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, ctl.signal]) : ctl.signal;
  for (let attempt = 0; ; attempt++) {
    try {
      const outcome = await reviewPull(deps2, job, signal);
      return { exitCode: 0, message: say(outcome), outcome };
    } catch (e) {
      if (e instanceof RetryJob && attempt < 3) {
        const wait = Math.min(e.afterMs ?? 2e3 * 2 ** attempt, 9e4);
        log(`${e.message}; trying again in ${Math.round(wait / 1e3)}s`);
        await sleep(wait);
        continue;
      }
      if (e instanceof GitHubError && (e.status === 403 || e.status === 401)) {
        return fail(`GitHub refused: ${e.message}
The workflow needs: permissions: { contents: read, pull-requests: write }`);
      }
      return fail(`The review failed: ${e.message}`);
    }
  }
}

// apps/action/src/main.ts
var fromInput = (input, name) => {
  const v = process.env[`INPUT_${input.toUpperCase()}`];
  if (v && !process.env[name]) process.env[name] = v;
};
fromInput("provider", "REDLINE_PROVIDER");
fromInput("model", "REDLINE_MODEL");
fromInput("max-files", "REDLINE_MAX_FILES");
fromInput("post-clean", "REDLINE_POST_CLEAN");
if (!process.env.GITHUB_TOKEN && process.env.INPUT_TOKEN) process.env.GITHUB_TOKEN = process.env.INPUT_TOKEN;
var eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  console.error("GITHUB_EVENT_PATH is not set: this is meant to run inside a GitHub Action.");
  process.exit(1);
}
var result = await runAction(process.env, readFileSync(eventPath, "utf8"), { log: (l) => console.log(l) });
var line = result.message.replace(/\r?\n/g, "%0A");
console.log(result.exitCode === 0 ? `::notice title=Redline::${line}` : `::error title=Redline::${line}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Redline

${result.message}
`);
  } catch {
  }
}
process.exit(result.exitCode);
