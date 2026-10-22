import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// A dotenv parser that also remembers where each entry sits, so `import --delete`
// can remove single entries and leave comments and config lines alone.
// Values follow the dotenv rules frameworks use (and Node's util.parseEnv).

export interface EnvEntry {
  key: string
  value: string
  /** First and last line (0-based, inclusive) of the entry in the file. */
  startLine: number
  endLine: number
}

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s?(.*)$/

export function parseEnvEntries(text: string): EnvEntry[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const entries: EnvEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = LINE.exec(line)
    if (!m) continue
    const key = m[1]!
    let rest = m[2]!.trimStart()
    const start = i
    let value: string
    const quote = rest[0]
    if (quote === '"' || quote === "'" || quote === '`') {
      // Quoted values may span lines; find the closing quote.
      let body = rest.slice(1)
      let close = findClose(body, quote)
      while (close === -1 && i + 1 < lines.length) {
        i++
        body += '\n' + lines[i]!
        close = findClose(body, quote)
      }
      if (close === -1) {
        // Unterminated: dotenv takes the raw line.
        i = start
        value = stripInlineComment(rest)
      } else {
        value = body.slice(0, close)
        if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"')
      }
    } else {
      value = stripInlineComment(rest)
    }
    entries.push({ key, value, startLine: start, endLine: i })
  }
  return entries
}

function findClose(body: string, quote: string): number {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && quote === '"') {
      i++
      continue
    }
    if (body[i] === quote) return i
  }
  return -1
}

/** Like dotenv (used by Next.js and Vite): an unquoted value ends at the first `#`. */
function stripInlineComment(raw: string): string {
  const hash = raw.indexOf('#')
  return (hash === -1 ? raw : raw.slice(0, hash)).trim()
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of parseEnvEntries(text)) out[e.key] = e.value
  return out
}

export interface EnvFile {
  /** Absolute path. */
  path: string
  /** Path relative to the project root, for messages. */
  name: string
  entries: EnvEntry[]
}

export function readEnvFile(path: string, name = path): EnvFile | null {
  if (!existsSync(path)) return null
  try {
    if (!statSync(path).isFile()) return null
    return { path, name, entries: parseEnvEntries(readFileSync(path, 'utf8')) }
  } catch {
    return null
  }
}

const DOTENV_NAME = /^\.env(\..+)?$/

/** Every `.env*` file in the given directories (`.env`, `.env.local`, `.env.example`, …). */
export function findEnvFiles(dirs: string[]): EnvFile[] {
  const seen = new Set<string>()
  const out: EnvFile[] = []
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names.sort()) {
      if (!DOTENV_NAME.test(n)) continue
      const path = resolve(dir, n)
      if (seen.has(path)) continue
      seen.add(path)
      const f = readEnvFile(path, n)
      if (f) out.push(f)
    }
  }
  return out
}

/** Files a framework loads in development, lowest precedence first. */
export const DEV_FILES = ['.env', '.env.development', '.env.local', '.env.development.local']

/** Files that hold examples, not real values. Import skips them. */
export function isTemplateFile(name: string): boolean {
  return /\.(example|sample|template|dist|defaults)$/i.test(name)
}

/** Merged values of the given files (later files win). */
export function loadEnvFiles(root: string, files: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of files) {
    const file = readEnvFile(join(root, f), f)
    if (!file) continue
    for (const e of file.entries) out[e.key] = e.value
  }
  return out
}

/**
 * Removes the entries for `keys` from a dotenv file. Comments and other lines stay.
 * Deletes the file only if nothing but whitespace is left. Returns what happened.
 */
export function removeEntries(path: string, keys: Set<string>): 'unchanged' | 'edited' | 'deleted' {
  const text = readFileSync(path, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const drop = new Set<number>()
  for (const e of parseEnvEntries(text)) {
    if (!keys.has(e.key)) continue
    for (let i = e.startLine; i <= e.endLine; i++) drop.add(i)
  }
  if (drop.size === 0) return 'unchanged'
  const kept = lines.filter((_, i) => !drop.has(i))
  const out = kept.join(eol)
  if (out.trim() === '') {
    rmSync(path)
    return 'deleted'
  }
  writeFileSync(path, out)
  return 'edited'
}
