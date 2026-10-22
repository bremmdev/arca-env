import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { ArcaError } from './errors.js'

// `arca.json`: committed, names only, never values. JSON (not JS) so that reading it
// never executes code.

export const CONFIG_FILE = 'arca.json'
export const SCHEMA_REF = './node_modules/@bremmdev/arca-env/schema.json'

/** The profile a project has when arca.json declares none. */
export const DEFAULT_PROFILE = 'default'

/** Lowercase because vault files are named after profiles, on case-insensitive file systems. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/
/** `policy.vault` sits next to the profile vaults. */
const RESERVED_PROFILES = new Set(['policy'])

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

export interface ProfileDecl {
  extends?: string
  envFiles: string[]
}

export interface ArcaConfig {
  id: string
  name: string
  envFiles: string[]
  leakGuard: { ignore: string[] }
  vars: Record<string, VarDecl>
  /** Always holds at least the default profile. */
  profiles: Record<string, ProfileDecl>
  defaultProfile: string
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

  const { profiles, defaultProfile } = parseProfiles(o, fail, warnings)

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
      profiles,
      defaultProfile,
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

export function normalizeProfile(name: string): string {
  return name.trim().toLowerCase()
}

/** Why a profile name can't be used, or null when it can. */
export function invalidProfileName(name: string): string | null {
  if (!PROFILE_NAME.test(name)) return `"${name}" is not a valid profile name (letters, digits, - and _, up to 40 characters)`
  if (RESERVED_PROFILES.has(name)) return `"${name}" is reserved, pick another profile name`
  return null
}

function parseProfiles(
  o: Record<string, unknown>,
  fail: (m: string) => never,
  warnings: string[],
): { profiles: Record<string, ProfileDecl>; defaultProfile: string } {
  let defaultProfile: string | undefined
  if (o.defaultProfile !== undefined) {
    if (typeof o.defaultProfile !== 'string') fail('"defaultProfile" must be a profile name')
    defaultProfile = normalizeProfile(o.defaultProfile as string)
    const bad = invalidProfileName(defaultProfile)
    if (bad) fail(`defaultProfile: ${bad}`)
  }
  const raw = o.profiles ?? {}
  if (!isObject(raw)) fail('"profiles" must be an object like { "ontwikkel": {}, "acceptatie": { "extends": "ontwikkel" } }')

  const profiles: Record<string, ProfileDecl> = {}
  for (const [rawName, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = normalizeProfile(rawName)
    const bad = invalidProfileName(name)
    if (bad) fail(`profiles: ${bad}`)
    if (name in profiles) fail(`profiles: "${rawName}" and another profile differ only in case. Profile names are case-insensitive.`)
    if (!isObject(value)) fail(`profiles.${rawName} must be an object (use {} for no options)`)
    const v = value as Record<string, unknown>
    const decl: ProfileDecl = { envFiles: [] }
    if (v.extends !== undefined) {
      if (typeof v.extends !== 'string') fail(`profiles.${rawName}.extends must be a profile name`)
      decl.extends = normalizeProfile(v.extends as string)
    }
    if (v.envFiles !== undefined) {
      if (!Array.isArray(v.envFiles) || v.envFiles.some((f) => typeof f !== 'string')) fail(`profiles.${rawName}.envFiles must be an array of file names`)
      decl.envFiles = v.envFiles as string[]
    }
    for (const key of Object.keys(v)) {
      if (key !== 'extends' && key !== 'envFiles') warnings.push(`Unknown field "${key}" in profiles.${rawName} is ignored.`)
    }
    profiles[name] = decl
  }

  const declared = Object.keys(profiles)
  if (declared.length === 0) {
    const name = defaultProfile ?? DEFAULT_PROFILE
    return { profiles: { [name]: { envFiles: [] } }, defaultProfile: name }
  }
  if (defaultProfile === undefined) defaultProfile = DEFAULT_PROFILE in profiles ? DEFAULT_PROFILE : declared[0]!
  else if (!(defaultProfile in profiles)) fail(`"defaultProfile" is "${defaultProfile}", which isn't in "profiles" (${declared.join(', ')})`)

  for (const [name, decl] of Object.entries(profiles)) {
    if (decl.extends === undefined) continue
    if (!(decl.extends in profiles)) fail(`profiles.${name} extends "${decl.extends}", which isn't in "profiles" (${declared.join(', ')})`)
    const seen = [name]
    for (let p: string | undefined = decl.extends; p !== undefined; p = profiles[p]!.extends) {
      if (seen.includes(p)) fail(`profiles: "extends" loops: ${[...seen, p].join(' → ')}`)
      seen.push(p)
    }
  }
  return { profiles, defaultProfile: defaultProfile! }
}

/** The profile followed by the profiles it extends, nearest first. */
export function profileChain(config: ArcaConfig, profile: string): string[] {
  const chain: string[] = []
  for (let p: string | undefined = profile; p !== undefined && !chain.includes(p); p = config.profiles[p]?.extends) chain.push(p)
  return chain
}

/** Config files arca loads for a profile: top-level envFiles, then the chain's, the profile's own last (later files win). */
export function profileEnvFiles(config: ArcaConfig, profile: string): string[] {
  const files = [...config.envFiles]
  for (const p of profileChain(config, profile).reverse()) {
    for (const f of config.profiles[p]?.envFiles ?? []) if (!files.includes(f)) files.push(f)
  }
  return files
}

/** Profiles that extend `profile` directly. */
export function profileChildren(config: ArcaConfig, profile: string): string[] {
  return Object.entries(config.profiles)
    .filter(([, d]) => d.extends === profile)
    .map(([n]) => n)
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

/**
 * Adds a profile to arca.json. A file without "profiles" gets its implicit default profile
 * written out too, so the values stored for it keep working.
 */
export function addProfileToConfig(project: Project, name: string, decl: { extends?: string }): void {
  updateConfigFile(project.file, (raw) => {
    const existing = isObject(raw.profiles) && Object.keys(raw.profiles).length > 0
    const profiles = (existing ? raw.profiles : { [project.config.defaultProfile]: {} }) as Record<string, unknown>
    profiles[name] = decl.extends ? { extends: decl.extends } : {}
    raw.profiles = profiles
  })
}

export function removeProfileFromConfig(file: string, name: string): void {
  updateConfigFile(file, (raw) => {
    if (!isObject(raw.profiles)) return
    const profiles = raw.profiles as Record<string, unknown>
    for (const key of Object.keys(profiles)) if (normalizeProfile(key) === name) delete profiles[key]
  })
}

export function newConfig(name: string): Record<string, unknown> {
  return { $schema: SCHEMA_REF, id: newProjectId(), name, vars: {} }
}
