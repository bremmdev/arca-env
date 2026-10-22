import { existsSync } from 'node:fs'
import { constants } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import spawn from 'cross-spawn'
import { isSensitive, type Project } from './config.js'
import { verifyScript } from './context.js'
import { isTemplateFile, loadEnvFiles } from './envfiles.js'
import { ArcaError } from './errors.js'
import { scanEnvFiles, summarizeFindings } from './leakguard.js'
import { decideRun } from './policy.js'
import { Redactor, createMaskedWriter, needlesFor } from './redact.js'
import type { Session } from './session.js'

export interface RunOptions {
  command: string[]
  only?: string[]
  passthrough?: boolean
  noOverride?: boolean
}

export async function runCommand(s: Session, opts: RunOptions): Promise<number> {
  const { io, ctx } = s
  const command = opts.command
  if (command.length === 0) throw new ArcaError('arca: nothing to run. Usage: arca run -- <command> [args…]', 2)
  const project = s.project

  if (!project) {
    if (!ctx.ci) s.note(s.err('dim', 'arca: no arca.json found, running without secrets. Set up arca with `npx arca init`.'))
    return spawnChild(s, command, io.env, null)
  }
  s.warnConfig()

  // Nested run (`npm run dev` → `arca run -- turbo dev` → `arca run -- next dev`): the outer
  // arca already injected the secrets and is masking the output.
  if (ctx.activeProject === project.config.id) return spawnChild(s, command, io.env, null)

  const display = command.join(' ')
  if (ctx.agent.detected) {
    const decision = decideRun(ctx, verifyScript(io, command), (await s.policy()).agentRun, display)
    if (!decision.allow) throw new ArcaError(decision.message)
  }

  const envFileValues = loadEnvFiles(project.root, project.config.envFiles)

  if (!s.hasVault()) {
    const env = { ...envFileValues, ...io.env }
    const missing = missingRequired(s, project, env)
    if (ctx.ci || opts.passthrough) {
      // CI, Vercel, Docker: no store here. Use the platform's env, and check it's complete.
      if (missing.length) throw new ArcaError(missingMessage(project, missing, true))
      return spawnChild(s, command, env, null)
    }
    const missingSecrets = missing.filter((n) => isSensitive(project.config.vars[n]))
    if (missingSecrets.length) throw new ArcaError(missingMessage(project, missing, false))
    s.note(s.err('dim', `arca: no secrets stored for ${project.config.name} on this machine yet. Running without them.`))
    return spawnChild(s, command, env, null)
  }

  const vault = await s.readVault()
  const only = opts.only ? new Set(opts.only) : null
  const vaultValues: Record<string, string> = {}
  for (const [name, v] of Object.entries(vault.vars)) {
    if (!only || only.has(name)) vaultValues[name] = v.value
  }
  if (only) {
    const unknown = [...only].filter((n) => !(n in vault.vars))
    if (unknown.length) s.note(s.err('yellow', `arca: --only names not stored in arca: ${unknown.join(', ')}`))
  }

  // Precedence: vault > inherited shell env > envFiles loaded by arca > the framework's own .env files.
  const overridden = Object.keys(vaultValues).filter((k) => io.env[k] !== undefined && io.env[k] !== vaultValues[k])
  const env: NodeJS.ProcessEnv = opts.noOverride
    ? { ...envFileValues, ...vaultValues, ...io.env }
    : { ...envFileValues, ...io.env, ...vaultValues }
  if (overridden.length && !opts.noOverride && !s.quiet) {
    const names = overridden.join(', ')
    const verb = overridden.length === 1 ? 'overrides a different value' : 'override different values'
    s.note(s.err('dim', `arca: ${names} from arca ${verb} inherited from your shell (use --no-override to keep the shell's).`))
  }

  const missing = missingRequired(s, project, env)
  if (missing.length) throw new ArcaError(missingMessage(project, missing, false))

  const secrets = s.secrets(vault)
  if (!s.quiet) {
    const findings = scanEnvFiles(project, s.envFilesForGuard(), secrets)
    if (findings.length) s.note(s.err('yellow', summarizeFindings(findings)))
  }

  env.ARCA_ACTIVE = project.config.id
  env.ARCA_PROJECT = project.config.name
  delete env.ARCA_PASSPHRASE
  addConsoleGuard(env, secrets.map((x) => x.name))
  const needles = secrets.flatMap(needlesFor)
  return spawnChild(s, command, env, needles)
}

/**
 * Preloads the console guard into every Node process the command starts, so values are
 * masked before in-process console wrappers (e.g. dev tools that forward server logs to the
 * browser) can see them. Only names are passed; the guard reads values from its own env.
 */
export function addConsoleGuard(env: NodeJS.ProcessEnv, names: string[], guardFile = defaultGuardFile()): void {
  if (names.length === 0 || !guardFile) return
  env.ARCA_MASK = names.join(',')
  const flag = `--import=${pathToFileURL(guardFile).href}`
  const current = env.NODE_OPTIONS ?? ''
  if (!current.includes(flag)) env.NODE_OPTIONS = current ? `${current} ${flag}` : flag
}

function defaultGuardFile(): string | null {
  // dist/guard.mjs sits next to the bundled CLI. Running from source (tests) there is none.
  const file = fileURLToPath(new URL('./guard.mjs', import.meta.url))
  return existsSync(file) ? file : null
}

/** Required declared vars that are neither in the env nor in a .env file the framework will load. */
function missingRequired(s: Session, project: Project, env: NodeJS.ProcessEnv): string[] {
  const required = Object.entries(project.config.vars).filter(([, d]) => d.required).map(([n]) => n)
  if (required.length === 0) return []
  let fileKeys: Set<string> | null = null
  return required.filter((name) => {
    if (env[name] !== undefined && env[name] !== '') return false
    fileKeys ??= new Set(
      s
        .envFilesForGuard()
        .filter((f) => !isTemplateFile(f.name))
        .flatMap((f) => f.entries.filter((e) => e.value !== '').map((e) => e.key)),
    )
    return !fileKeys.has(name)
  })
}

function missingMessage(project: Project, missing: string[], ci: boolean): string {
  const n = missing.length
  const head = `arca: ${n} required variable${n === 1 ? ' is' : 's are'} not set for ${project.config.name}:\n  ${missing.join(', ')}`
  if (ci) return `${head}\nAdd ${n === 1 ? 'it' : 'them'} to your CI or hosting platform's environment variables.`
  return `${head}\nRun \`npx arca setup\` to set them. Takes about a minute. (AI agents: ask the user to run it.)`
}

/** Spawns the command. With needles, stdout and stderr are piped through the masker. */
function spawnChild(s: Session, command: string[], env: NodeJS.ProcessEnv, needles: ReturnType<typeof needlesFor> | null): Promise<number> {
  const { io } = s
  const masked = needles !== null
  if (masked) forwardTerminalHints(s, env)
  const [file, ...args] = command as [string, ...string[]]
  // Unmasked runs (no secrets) inherit the terminal; tests pipe so they can read the output.
  const plain = io.childStdin === 'inherit' ? 'inherit' : 'pipe'
  const child = spawn(file, args, {
    env,
    cwd: io.cwd,
    shell: false,
    stdio: masked ? [io.childStdin, 'pipe', 'pipe'] : [io.childStdin, plain, plain],
  })

  return new Promise<number>((resolvePromise, reject) => {
    const writers: { end(): void }[] = []
    if (masked) {
      const out = createMaskedWriter(new Redactor(needles), (t) => io.stdout.write(t))
      const err = createMaskedWriter(new Redactor(needles), (t) => io.stderr.write(t))
      child.stdout!.on('data', (c: Buffer) => out.write(c))
      child.stderr!.on('data', (c: Buffer) => err.write(c))
      writers.push(out, err)
    } else if (io.childStdin === 'ignore') {
      // Tests: collect plain output through the IO object too.
      child.stdout?.on('data', (c: Buffer) => io.stdout.write(c.toString('utf8')))
      child.stderr?.on('data', (c: Buffer) => io.stderr.write(c.toString('utf8')))
    }

    const cleanups = io.handleSignals ? forwardSignals(child, io) : []
    child.on('error', (e: NodeJS.ErrnoException) => {
      cleanups.forEach((c) => c())
      if (e.code === 'ENOENT') reject(new ArcaError(`arca: command not found: ${file}`, 127))
      else reject(e)
    })
    child.on('close', (code, signal) => {
      cleanups.forEach((c) => c())
      for (const w of writers) w.end()
      if (code !== null) resolvePromise(code)
      else resolvePromise(128 + ((signal && constants.signals[signal]) || 1))
    })
  })
}

/** The child's output is a pipe, so tell it about colours and the terminal size. */
function forwardTerminalHints(s: Session, env: NodeJS.ProcessEnv): void {
  const { stdout } = s.io
  if (stdout.isTTY) {
    if (env.FORCE_COLOR === undefined && !env.NO_COLOR) {
      const depth = stdout.colorDepth ?? 4
      env.FORCE_COLOR = depth >= 24 ? '3' : depth >= 8 ? '2' : depth >= 4 ? '1' : '0'
    }
    if (stdout.columns && env.COLUMNS === undefined) env.COLUMNS = String(stdout.columns)
    if (stdout.rows && env.LINES === undefined) env.LINES = String(stdout.rows)
  }
}

function forwardSignals(child: ReturnType<typeof spawn>, io: Session['io']): (() => void)[] {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
  if (process.platform === 'win32') signals.push('SIGBREAK')
  const cleanups: (() => void)[] = []
  for (const sig of signals) {
    const handler = () => {
      // Ctrl+C in a terminal already reaches the whole process group (and the whole
      // console on Windows). Forwarding it again would look like a second Ctrl+C.
      if (sig === 'SIGINT' && (io.stdinIsTTY || process.platform === 'win32')) return
      if (process.platform === 'win32' && sig !== 'SIGTERM') return
      try {
        child.kill(sig)
      } catch {
        // already gone
      }
    }
    process.on(sig, handler)
    cleanups.push(() => process.off(sig, handler))
  }
  return cleanups
}
