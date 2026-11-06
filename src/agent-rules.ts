import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Deny rules for agent tools that read them from a file in the project. arca refuses these
// commands for agents anyway; the rules stop the agent from trying, so it asks the user straight
// away instead of hitting a refusal. A second layer only: Claude Code's docs say command rules
// cover "the invocation Claude usually produces" and aren't a boundary around the program.
//
// Only tools where a project file adds to the user's own rules get one (spike, 2026-11-06):
// - Cursor CLI: a project `.cursor/cli.json` replaces the user's `permissions.deny` array instead
//   of adding to it, so it would drop their own deny rules.
// - Gemini CLI: project policy files are switched off, and a `tools.exclude` entry with a command
//   (`run_shell_command(arca reveal)`) doesn't block anything in 0.67's policy engine.
// - OpenCode 1.x deep-merges a project's `permission.bash` object over a user's `"bash": "ask"`,
//   which turns every other command to allow. 2.x stacks rules safely.
// - Copilot CLI has no project-level deny.

/** Commands that show or change secret values. Agents get refused, so they shouldn't try. */
export const DENIED_COMMANDS = ['reveal', 'export', 'set', 'import']

/** `reveal, export, set or import` */
export const DENIED_LIST = `${DENIED_COMMANDS.slice(0, -1).join(', ')} or ${DENIED_COMMANDS.at(-1)}`

const REFUSAL = 'arca refuses this for AI agents: it shows or changes secret values. Ask the user to run it in their own terminal.'

/** What init does with one agent tool's rule file. */
export type RulePlan = { kind: 'current' } | { kind: 'invalid' } | { kind: 'add'; count: number }

export interface RuleTarget {
  /** The tool's name, as shown to the user. */
  agent: string
  /** The rule file, relative to the project root, with forward slashes. */
  file: string
  /** The agent name `detectAgent` gives the tool, so an init it runs adds its rules. */
  detectedAs: string
  /** The project shows signs of using the tool. */
  used(root: string): boolean
  plan(root: string, runner: string): RulePlan
  apply(root: string, runner: string): void
  /** The confirmation after `apply`. */
  done(count: number): string
}

// ── Claude Code: permissions.deny in .claude/settings.json ─────────────────

/**
 * The store's default folders on Windows and Linux, written from the home folder so the rules
 * hold for every teammate. A custom `ARCA_HOME` or `XDG_DATA_HOME` isn't covered.
 */
const STORE_READS = ['Read(~/AppData/Local/arca/**)', 'Read(~/.local/share/arca/**)']

/**
 * Claude Code `permissions.deny` rules for `runner` (`npx arca`, `pnpm arca`, …) and a bare
 * `arca`, in Bash and PowerShell. A trailing ` *` also matches the command without arguments.
 * No leading `*`: it would also match a commit message or a grep that mentions arca.
 */
export function claudeDenyRules(runner: string): string[] {
  const prefixes = [...new Set(['arca', runner])]
  const commands = DENIED_COMMANDS.flatMap((c) => prefixes.map((p) => `${p} ${c} *`))
  return [...commands.map((c) => `Bash(${c})`), ...commands.map((c) => `PowerShell(${c})`), ...STORE_READS]
}

const claude: RuleTarget = {
  agent: 'Claude Code',
  file: '.claude/settings.json',
  detectedAs: 'claude-code',
  used: (root) => existsSync(join(root, '.claude')) || existsSync(join(root, 'CLAUDE.md')),
  plan(root, runner) {
    const rules = claudeDenyRules(runner)
    const settings = readJson(join(root, this.file))
    if (settings === null) return { kind: 'invalid' }
    const deny = settings?.permissions
    const have = new Set(isObject(deny) && Array.isArray(deny.deny) ? deny.deny : [])
    const count = rules.filter((r) => !have.has(r)).length
    return count ? { kind: 'add', count } : { kind: 'current' }
  },
  apply(root, runner) {
    editJson(join(root, this.file), (settings) => {
      const permissions = isObject(settings.permissions) ? settings.permissions : (settings.permissions = {})
      const deny: unknown[] = Array.isArray(permissions.deny) ? permissions.deny : []
      permissions.deny = [...deny, ...claudeDenyRules(runner).filter((r) => !deny.includes(r))]
    })
  },
  done: (count) => `Added ${count} deny ${count === 1 ? 'rule' : 'rules'} to .claude/settings.json: Claude Code won't try arca ${DENIED_LIST}, or read the store`,
}

// ── Codex: a prefix_rule file in .codex/rules ──────────────────────────────

const RUNNERS = ['npx', 'pnpm', 'yarn', 'bun', 'bunx']

/**
 * Codex rules (Starlark), checked with `codex execpolicy check` (0.167). Codex matches the
 * command's leading words exactly and validates the `match` / `not_match` examples when it loads.
 */
export function codexRules(): string {
  const commands = JSON.stringify(DENIED_COMMANDS).replace(/,/g, ', ')
  const runners = JSON.stringify(RUNNERS).replace(/,/g, ', ')
  const rule = (pattern: string, match: string[], notMatch: string[]) =>
    [
      'prefix_rule(',
      `    pattern = ${pattern},`,
      '    decision = "forbidden",',
      `    justification = ${JSON.stringify(REFUSAL)},`,
      `    match = ${JSON.stringify(match).replace(/","/g, '", "')},`,
      `    not_match = ${JSON.stringify(notMatch).replace(/","/g, '", "')},`,
      ')',
    ].join('\n')
  return [
    '# Added by `arca init`. arca refuses these commands for AI agents anyway; this rule stops',
    '# Codex from trying, so it asks you instead. Codex loads it once you trust the project.',
    rule(`["arca", ${commands}]`, ['arca reveal API_KEY', 'arca set API_KEY'], ['arca list', 'arca run -- next dev']),
    rule(`[${runners}, "arca", ${commands}]`, ['npx arca reveal API_KEY', 'pnpm arca export'], ['npx arca list', 'npm run dev']),
    '',
  ].join('\n')
}

const codex: RuleTarget = {
  agent: 'Codex',
  file: '.codex/rules/arca.rules',
  detectedAs: 'codex',
  used: (root) => existsSync(join(root, '.codex')),
  plan(root) {
    const file = join(root, this.file)
    // The file is arca's own, so an older version gets the current text.
    if (existsSync(file) && readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === codexRules()) return { kind: 'current' }
    return { kind: 'add', count: 2 }
  },
  apply(root) {
    const file = join(root, this.file)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, codexRules())
  },
  done: () => `Wrote .codex/rules/arca.rules: Codex won't run arca ${DENIED_LIST} (it loads the rules once you trust the project)`,
}

export const RULE_TARGETS: RuleTarget[] = [claude, codex]

// ── JSON files ─────────────────────────────────────────────────────────────

/** The file's object, `undefined` if there's no file, `null` if it isn't a valid JSON object. */
function readJson(file: string): Record<string, unknown> | null | undefined {
  if (!existsSync(file)) return undefined
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isObject(v) ? v : null
  } catch {
    return null
  }
}

/** Changes a JSON file in place, keeping its indent and line endings. Creates it if needed. */
function editJson(file: string, edit: (o: Record<string, unknown>) => void): void {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const parsed = readJson(file)
  // Never overwrite a file that doesn't parse: the user has to fix it first.
  if (parsed === null) throw new Error(`${file} isn't valid JSON`)
  const o = parsed ?? {}
  if (parsed === undefined) mkdirSync(dirname(file), { recursive: true })
  edit(o)
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  '
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(file, JSON.stringify(o, null, indent).replace(/\n/g, eol) + eol)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
