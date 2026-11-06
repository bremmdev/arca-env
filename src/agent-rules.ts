import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Deny rules for agent tools that have them (Claude Code only, for now). arca refuses these
// commands for agents anyway; the rules stop the agent from trying, so it asks the user straight
// away instead of hitting a refusal. A second layer only: Claude Code's docs say command rules
// cover "the invocation Claude usually produces" and aren't a boundary around the program.

/** Commands that show or change secret values. Agents get refused, so they shouldn't try. */
export const DENIED_COMMANDS = ['reveal', 'export', 'set', 'import']

/**
 * The store's default folders on Windows and Linux, written from the home folder so the rules
 * hold for every teammate. A custom `ARCA_HOME` or `XDG_DATA_HOME` isn't covered.
 */
const STORE_READS = ['Read(~/AppData/Local/arca/**)', 'Read(~/.local/share/arca/**)']

/**
 * Claude Code `permissions.deny` rules for `runner` (`npx arca`, `pnpm arca`, …) and a bare
 * `arca`, in Bash and PowerShell. A trailing ` *` also matches the command without arguments.
 */
export function claudeDenyRules(runner: string): string[] {
  const prefixes = [...new Set(['arca', runner])]
  const commands = DENIED_COMMANDS.flatMap((c) => prefixes.map((p) => `${p} ${c} *`))
  return [...commands.map((c) => `Bash(${c})`), ...commands.map((c) => `PowerShell(${c})`), ...STORE_READS]
}

/** As shown in messages; the file is `join(root, '.claude', 'settings.json')`. */
export const CLAUDE_SETTINGS = '.claude/settings.json'

/** True when the project shows signs of Claude Code: a `.claude` folder or a CLAUDE.md. */
export function usesClaudeCode(root: string): boolean {
  return existsSync(join(root, '.claude')) || existsSync(join(root, 'CLAUDE.md'))
}

/** The rules from `rules` that `.claude/settings.json` doesn't have yet. Null if the file isn't valid JSON. */
export function missingDenyRules(root: string, rules: string[]): string[] | null {
  const file = join(root, '.claude', 'settings.json')
  if (!existsSync(file)) return rules
  const settings = readSettings(file)
  if (!settings) return null
  const deny = new Set(denyList(settings))
  return rules.filter((r) => !deny.has(r))
}

/** Adds `rules` to `permissions.deny` in `.claude/settings.json`, keeping everything else (and its indent and line endings). */
export function addDenyRules(root: string, rules: string[]): void {
  const file = join(root, '.claude', 'settings.json')
  let text = ''
  let settings: Record<string, unknown> = {}
  if (existsSync(file)) {
    text = readFileSync(file, 'utf8')
    const parsed = readSettings(file)
    // Never overwrite a file Claude Code would reject anyway; the user has to fix it first.
    if (!parsed) throw new Error(`${CLAUDE_SETTINGS} isn't valid JSON`)
    settings = parsed
  } else mkdirSync(join(root, '.claude'), { recursive: true })
  const permissions = isObject(settings.permissions) ? settings.permissions : (settings.permissions = {})
  const deny: unknown[] = Array.isArray(permissions.deny) ? permissions.deny : []
  permissions.deny = [...deny, ...rules.filter((r) => !deny.includes(r))]
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  '
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(file, JSON.stringify(settings, null, indent).replace(/\n/g, eol) + eol)
}

function readSettings(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

function denyList(settings: Record<string, unknown>): string[] {
  const p = settings.permissions
  return isObject(p) && Array.isArray(p.deny) ? p.deny.filter((r): r is string => typeof r === 'string') : []
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
