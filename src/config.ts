import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { ArcaError } from './errors.js'

// `arca.json`: committed, names only, never values. JSON (not JS) so that reading it
// never executes code.

export const CONFIG_FILE = 'arca.json'
export const SCHEMA_REF = './node_modules/@bremmdev/arca-env/schema.json'

/** Profiles aren't implemented yet. Everything uses this single set internally. */
export const DEFAULT_PROFILE = 'default'

export type Encoding = 'base64url' | 'base64' | 'hex'

export interface VarDecl {
  description?: string
  required?: boolean
  /** Defaults to true: the value must come from arca. `false` = config that lives in `.env`. */
  sensitive?: boolean
  example?: string
  docs?: string
  generate?: { bytes?: number; encoding?: Encoding }
}

export interface ArcaConfig {
  id: string
  name: string
  envFiles: string[]
  leakGuard: { ignore: string[] }
  vars: Record<string, VarDecl>
}

export interface Project {
  /** Directory that holds arca.json. */
  root: string
  file: string
  config: ArcaConfig
  warnings: string[]
}

export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isSensitive(decl: VarDecl | undefined): boolean {
  return decl?.sensitive !== false
}

export function newProjectId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const bytes = randomBytes(16)
  let id = 'arc_'
  for (const b of bytes) id += alphabet[b % 32]
  return id
}

/** Walks up from `cwd` to the nearest arca.json. */
export function findConfigFile(cwd: string): string | null {
  let dir = resolve(cwd)
  for (;;) {
    const file = join(dir, CONFIG_FILE)
    if (existsSync(file)) return file
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function loadProject(cwd: string): Project | null {
  const file = findConfigFile(cwd)
  if (!file) return null
  return parseProject(readFileSync(file, 'utf8'), file)
}

export function parseProject(text: string, file: string): Project {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new ArcaError(`arca: ${file} is not valid JSON (${(e as Error).message}).`)
  }
  const warnings: string[] = []
  const fail = (msg: string): never => {
    throw new ArcaError(`arca: invalid ${CONFIG_FILE}: ${msg}\n  in ${file}`)
  }
  if (!isObject(raw)) fail('expected an object')
  const o = raw as Record<string, unknown>

  if (typeof o.id !== 'string' || !/^arc_[a-z2-7]{8,}$/.test(o.id)) {
    fail('"id" must be an arca project ID like "arc_7k2m9q4x8w1z3p5n". Run `npx arca init` to create one.')
  }
  const name = o.name === undefined ? dirnameName(file) : o.name
  if (typeof name !== 'string') fail('"name" must be a string')

  const envFiles = o.envFiles ?? []
  if (!Array.isArray(envFiles) || envFiles.some((f) => typeof f !== 'string')) fail('"envFiles" must be an array of file names')

  const lg = o.leakGuard ?? {}
  if (!isObject(lg)) fail('"leakGuard" must be an object')
  const ignore = (lg as Record<string, unknown>).ignore ?? []
  if (!Array.isArray(ignore) || ignore.some((k) => typeof k !== 'string')) fail('"leakGuard.ignore" must be an array of variable names')

  const vars: Record<string, VarDecl> = {}
  const rawVars = o.vars ?? {}
  if (!isObject(rawVars)) fail('"vars" must be an object')
  for (const [key, value] of Object.entries(rawVars as Record<string, unknown>)) {
    if (!VAR_NAME.test(key)) fail(`"${key}" is not a valid environment variable name`)
    if (!isObject(value)) fail(`vars.${key} must be an object (use {} for no options)`)
    vars[key] = parseDecl(key, value as Record<string, unknown>, fail)
  }

  for (const key of ['profiles', 'defaultProfile']) {
    if (key in o) warnings.push(`"${key}" in ${CONFIG_FILE} is ignored: profiles aren't available in this version yet.`)
  }
  const known = new Set(['$schema', 'id', 'name', 'envFiles', 'leakGuard', 'vars', 'profiles', 'defaultProfile'])
  for (const key of Object.keys(o)) if (!known.has(key)) warnings.push(`Unknown field "${key}" in ${CONFIG_FILE} is ignored.`)

  return {
    root: dirname(file),
    file,
    config: {
      id: o.id as string,
      name: name as string,
      envFiles: envFiles as string[],
      leakGuard: { ignore: ignore as string[] },
      vars,
    },
    warnings,
  }
}

function parseDecl(key: string, v: Record<string, unknown>, fail: (m: string) => never): VarDecl {
  const d: VarDecl = {}
  for (const field of ['description', 'example', 'docs'] as const) {
    if (v[field] !== undefined) {
      if (typeof v[field] !== 'string') fail(`vars.${key}.${field} must be a string`)
      d[field] = v[field] as string
    }
  }
  for (const field of ['required', 'sensitive'] as const) {
    if (v[field] !== undefined) {
      if (typeof v[field] !== 'boolean') fail(`vars.${key}.${field} must be true or false`)
      d[field] = v[field] as boolean
    }
  }
  if ('default' in v || 'value' in v) {
    fail(`vars.${key} has a value. ${CONFIG_FILE} holds names only: put secrets in arca (\`npx arca set ${key}\`) and config in .env.`)
  }
  if (v.generate !== undefined) {
    const g = v.generate
    if (!isObject(g)) fail(`vars.${key}.generate must be an object like { "bytes": 32 }`)
    const gen = g as Record<string, unknown>
    const bytes = gen.bytes ?? 32
    const encoding = gen.encoding ?? 'base64url'
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 8 || bytes > 1024) fail(`vars.${key}.generate.bytes must be an integer from 8 to 1024`)
    if (encoding !== 'base64url' && encoding !== 'base64' && encoding !== 'hex') fail(`vars.${key}.generate.encoding must be "base64url", "base64" or "hex"`)
    d.generate = { bytes: bytes as number, encoding: encoding as Encoding }
  }
  return d
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function dirnameName(file: string): string {
  return dirname(file).split(/[\\/]/).pop() ?? 'project'
}

/**
 * Edits arca.json as raw JSON, so fields arca doesn't know about (and their order) survive.
 * Comments aren't supported because the file is plain JSON.
 */
export function updateConfigFile(file: string, mutate: (raw: Record<string, unknown>) => void): void {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  mutate(raw)
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
}

export function declareVars(file: string, decls: Record<string, VarDecl>): void {
  updateConfigFile(file, (raw) => {
    const vars = (isObject(raw.vars) ? raw.vars : {}) as Record<string, unknown>
    for (const [name, decl] of Object.entries(decls)) {
      if (!(name in vars)) vars[name] = decl
    }
    raw.vars = vars
  })
}

export function newConfig(name: string): Record<string, unknown> {
  return { $schema: SCHEMA_REF, id: newProjectId(), name, vars: {} }
}
