import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { IO } from './io.js'

// Who is calling arca: a human at a terminal, an AI agent, an IDE task, CI…
// Agent detection is a cooperative convention, not a security boundary.

export interface AgentInfo {
  detected: boolean
  name?: string
  via?: string
}

export type Invocation =
  | { kind: 'script'; name: string; verified: boolean; reason?: string }
  | { kind: 'adhoc' }

export interface Context {
  agent: AgentInfo
  /** stdout and stderr are terminals. */
  interactiveOutput: boolean
  stdinIsTTY: boolean
  ci: boolean
  /** Project ID of an outer `arca run`, if any. */
  activeProject: string | null
}

/**
 * Env vars that agent tools set in the commands they run. Order matters: the first hit names
 * the agent. Only markers specific to agent-launched processes belong here, not ones an IDE
 * sets in every terminal (those would lock humans out). To verify per tool in spike S3.
 */
export const AGENT_MARKERS: { env: string; name: string }[] = [
  { env: 'ARCA_AGENT', name: 'agent' },
  { env: 'AI_AGENT', name: 'agent' },
  { env: 'CLAUDECODE', name: 'claude-code' },
  { env: 'CLAUDE_CODE_ENTRYPOINT', name: 'claude-code' },
  { env: 'CURSOR_AGENT', name: 'cursor' },
  { env: 'CODEX_SANDBOX', name: 'codex' },
  { env: 'CODEX_THREAD_ID', name: 'codex' },
  { env: 'GEMINI_CLI', name: 'gemini-cli' },
  { env: 'OPENCODE', name: 'opencode' },
  { env: 'AUGMENT_AGENT', name: 'augment' },
  { env: 'CLINE_ACTIVE', name: 'cline' },
  { env: 'GOOSE_TERMINAL', name: 'goose' },
  { env: 'REPL_ID', name: 'replit' },
]

const FALSY = new Set(['', '0', 'false', 'no', 'off'])

export function detectAgent(env: NodeJS.ProcessEnv, extraMarkers: string[] = []): AgentInfo {
  const markers = [...AGENT_MARKERS, ...extraMarkers.map((e) => ({ env: e, name: 'agent' }))]
  for (const m of markers) {
    const v = env[m.env]
    if (v === undefined || FALSY.has(v.trim().toLowerCase())) continue
    // AI_AGENT / ARCA_AGENT may carry the agent's name, e.g. AI_AGENT=claude-code_2-1_agent.
    let name = m.name
    if ((m.env === 'AI_AGENT' || m.env === 'ARCA_AGENT') && v !== '1' && v.toLowerCase() !== 'true') {
      name = v.split(/[_\s]/)[0] || m.name
    }
    return { detected: true, name, via: m.env }
  }
  return { detected: false }
}

const CI_VARS = ['CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'GITHUB_ACTIONS', 'GITLAB_CI', 'VERCEL', 'NETLIFY', 'BUILDKITE', 'CIRCLECI', 'TF_BUILD', 'CODEBUILD_BUILD_ID', 'BITBUCKET_BUILD_NUMBER', 'CF_PAGES', 'RENDER', 'RAILWAY_ENVIRONMENT']

export function detectCI(env: NodeJS.ProcessEnv): boolean {
  return CI_VARS.some((k) => env[k] !== undefined && !FALSY.has(env[k]!.trim().toLowerCase()))
}

export function buildContext(io: IO, extraMarkers: string[] = []): Context {
  return {
    agent: detectAgent(io.env, extraMarkers),
    interactiveOutput: io.stdout.isTTY && io.stderr.isTTY,
    stdinIsTTY: io.stdinIsTTY,
    ci: detectCI(io.env),
    activeProject: io.env.ARCA_ACTIVE || null,
  }
}

/** True when a person is (very likely) at the keyboard. */
export function isInteractive(ctx: Context, allowPipedStdin = false): boolean {
  return ctx.interactiveOutput && (ctx.stdinIsTTY || allowPipedStdin)
}

// ── script verification ────────────────────────────────────────────────────

/**
 * Checks that this `arca run` was started by a package.json script: the package manager's
 * lifecycle vars must match the script in package.json, the script must contain `arca run`,
 * and the command arca was asked to run must be the one written in the script (extra
 * arguments appended by `npm run x -- …` are allowed).
 */
export function verifyScript(io: IO, command: string[]): Invocation {
  const name = io.env.npm_lifecycle_event
  const script = io.env.npm_lifecycle_script
  if (!name || script === undefined) return { kind: 'adhoc' }
  const pkgPath = findPackageJson(io)
  if (!pkgPath) return { kind: 'script', name, verified: false, reason: 'no package.json found' }
  let scripts: Record<string, unknown> = {}
  try {
    scripts = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {}
  } catch {
    return { kind: 'script', name, verified: false, reason: 'package.json is not valid JSON' }
  }
  // `npx …` / `npm exec …` set npm_lifecycle_event=npx with the ad-hoc command as the "script".
  if (!Object.hasOwn(scripts, name)) return { kind: 'adhoc' }
  if (scripts[name] !== script) {
    return { kind: 'script', name, verified: false, reason: `the "${name}" script in package.json doesn't match what the package manager ran` }
  }
  const declared = arcaRunCommands(script)
  if (declared.length === 0) return { kind: 'script', name, verified: false, reason: `the "${name}" script doesn't use \`arca run\`` }
  const ok = declared.some((cmd) => cmd.length > 0 && cmd.length <= command.length && cmd.every((t, i) => sameToken(t, command[i]!)))
  if (!ok) return { kind: 'script', name, verified: false, reason: `the command doesn't match the "${name}" script` }
  return { kind: 'script', name, verified: true }
}

function sameToken(a: string, b: string): boolean {
  return a === b
}

function findPackageJson(io: IO): string | null {
  // npm, pnpm and yarn berry set npm_package_json. Otherwise walk up from cwd.
  const fromEnv = io.env.npm_package_json
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  let dir = resolve(io.cwd)
  for (;;) {
    const p = join(dir, 'package.json')
    if (existsSync(p)) return p
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The commands after `arca run [opts] --` in a script, one per `arca run` occurrence. */
export function arcaRunCommands(script: string): string[][] {
  const out: string[][] = []
  for (const segment of splitShell(script)) {
    const tokens = tokenize(segment)
    for (let i = 0; i < tokens.length - 1; i++) {
      const isArca = /(^|[\\/])arca(\.cmd|\.js|\.mjs)?$/.test(tokens[i]!) && tokens[i + 1] === 'run'
      if (!isArca) continue
      out.push(commandAfterRunOptions(tokens.slice(i + 2)))
    }
  }
  return out
}

/** Skips arca's own options and returns the command (matches the CLI's parsing). */
export function commandAfterRunOptions(tokens: string[]): string[] {
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '--') return tokens.slice(i + 1)
    if (!t.startsWith('-')) return tokens.slice(i)
    i += RUN_OPTIONS_WITH_VALUE.has(t) ? 2 : 1
  }
  return []
}

export const RUN_OPTIONS_WITH_VALUE = new Set(['--only', '--project-dir', '--profile', '-p'])

/** Splits a script on && || ; | (outside quotes). */
function splitShell(script: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!
    if (quote) {
      if (c === quote) quote = null
      cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    if (c === ';' || c === '|' || c === '&') {
      parts.push(cur)
      cur = ''
      if (script[i + 1] === c) i++
      continue
    }
    cur += c
  }
  parts.push(cur)
  return parts
}

export function tokenize(s: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let has = false
  let quote: string | null = null
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
      continue
    }
    if (/\s/.test(c)) {
      if (has || cur) tokens.push(cur)
      cur = ''
      has = false
      continue
    }
    cur += c
  }
  if (has || cur) tokens.push(cur)
  return tokens
}
