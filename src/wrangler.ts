import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addItems, addMember, applyEdits, member, parseJsonc, type Edit } from './jsonc.js'

// Cloudflare Workers. `wrangler dev` and Cloudflare's Vite plugin build the Worker's bindings from
// `.dev.vars` or `.env` files, and add `process.env` only when the config declares `secrets`
// (spike S6, Wrangler 4.158). Then exactly the declared names are bound, from arca's env. Without
// it the Worker sees none of arca's secrets.

/** Wrangler's own lookup order. */
export const WRANGLER_CONFIGS = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']

export function findWranglerConfig(root: string): string | null {
  return WRANGLER_CONFIGS.find((f) => existsSync(join(root, f))) ?? null
}

/**
 * Projects that build through Cloudflare's Vite plugin. A build that runs with the secrets in its
 * env and declared in the config copies them into `dist/<worker>/.dev.vars` for `vite preview`,
 * as plain text, so `init` leaves those builds unwrapped.
 */
export function usesCloudflareVitePlugin(deps: Record<string, string>): boolean {
  return Boolean(deps['@cloudflare/vite-plugin'] || deps['@astrojs/cloudflare'])
}

export type SecretsPlan = (
  | { kind: 'current' }
  | { kind: 'invalid' }
  | { kind: 'add'; missing: string[] }
  /** A TOML `secrets` table arca doesn't edit: the user adds the names. */
  | { kind: 'manual'; missing: string[] }
) & {
  /** `env.<name>` sections without their own `secrets`: Wrangler doesn't inherit it. */
  envs: string[]
}

/** What `secrets.required` in the Wrangler config lacks of `names`. */
export function planSecrets(root: string, file: string, names: string[]): SecretsPlan {
  const text = readFileSync(join(root, file), 'utf8')
  if (file.endsWith('.toml')) return planToml(text, names)
  const doc = parseJsonc(text)
  if (doc?.type !== 'object') return { kind: 'invalid', envs: [] }
  const env = member(doc, 'env')
  const envs = env?.type === 'object' ? env.members.filter((m) => m.value.type === 'object' && !member(m.value, 'secrets')).map((m) => m.key) : []
  const secrets = member(doc, 'secrets')
  const required = member(secrets, 'required')
  if ((secrets && secrets.type !== 'object') || (required && required.type !== 'array')) return { kind: 'invalid', envs }
  const have = new Set(required?.type === 'array' ? required.items.map((n) => (n.type === 'value' ? n.value : undefined)) : [])
  const missing = names.filter((n) => !have.has(n))
  return missing.length ? { kind: 'add', missing, envs } : { kind: 'current', envs }
}

/** Adds `names` to `secrets.required`, keeping the file's comments and layout. */
export function declareSecrets(root: string, file: string, names: string[]): void {
  const path = join(root, file)
  const text = readFileSync(path, 'utf8')
  const list = names.map((n) => JSON.stringify(n))
  if (file.endsWith('.toml')) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const sep = text === '' || text.endsWith('\n') ? '' : eol
    writeFileSync(path, `${text}${sep}${eol}[secrets]${eol}required = [${list.join(', ')}]${eol}`)
    return
  }
  const doc = parseJsonc(text)
  if (doc?.type !== 'object') throw new Error(`${file} isn't valid JSON`)
  const secrets = member(doc, 'secrets')
  const required = member(secrets, 'required')
  let edits: Edit[]
  if (!secrets) edits = addMember(text, doc, 'secrets', `{ "required": [${list.join(', ')}] }`)
  else if (secrets.type === 'object' && !required) edits = addMember(text, secrets, 'required', `[${list.join(', ')}]`)
  else if (required?.type === 'array') edits = addItems(text, required, list)
  else throw new Error(`${file}: secrets isn't an object`)
  writeFileSync(path, applyEdits(text, edits))
}

/**
 * TOML, read just far enough: arca appends a `[secrets]` table when there's none, and leaves an
 * existing one to the user.
 */
function planToml(text: string, names: string[]): SecretsPlan {
  const lines = text.split(/\r?\n/)
  const header = (l: string) => /^\s*\[/.test(l)
  const firstTable = lines.findIndex(header)
  const top = firstTable === -1 ? lines : lines.slice(0, firstTable)
  const envs = [...new Set(lines.flatMap((l) => /^\s*\[\s*env\.([\w-]+)\s*\]/.exec(l)?.[1] ?? []))].filter(
    (e) => !lines.some((l) => new RegExp(`^\\s*\\[\\s*env\\.${e}\\.secrets\\s*\\]`).test(l)),
  )
  const table = lines.findIndex((l) => /^\s*\[\s*secrets\s*\]\s*(#.*)?$/.test(l))
  const dotted = top.some((l) => /^\s*secrets\s*[.=]/.test(l))
  if (table === -1 && !dotted) return { kind: 'add', missing: names, envs }
  let section: string
  if (table !== -1) {
    const next = lines.findIndex((l, i) => i > table && header(l))
    section = lines.slice(table, next === -1 ? undefined : next).join('\n')
  } else section = top.join('\n')
  const required = /required\s*=\s*\[([\s\S]*?)\]/.exec(section)?.[1] ?? ''
  const have = new Set([...required.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]))
  const missing = names.filter((n) => !have.has(n))
  return missing.length ? { kind: 'manual', missing, envs } : { kind: 'current', envs }
}
