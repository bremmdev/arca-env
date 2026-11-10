import { dirname } from 'node:path'
import { findConfigFile } from './config.js'
import { loadEnvFiles } from './envfiles.js'
import { ArcaError } from './errors.js'
import { detectPackageManager, runScript, setPackageManager } from './hint.js'
import type { IO } from './io.js'
import { scanEnvFiles, summarizeFindings } from './leakguard.js'
import type { Secret } from './redact.js'
import { OFF, isTestWorker, secretsFromEnv } from './register-mask.js'
import { banner, missingMessage, missingRequired } from './runner.js'
import { Session } from './session.js'

// `@bremmdev/arca-env/register`: the in-process loader, for what doesn't start through a
// package script (IDE test explorers, debuggers, "Run file" buttons):
//   node --import @bremmdev/arca-env/register app.js
//   import '@bremmdev/arca-env/register'   (first line of vitest.config.ts)
// It loads the active profile's values into process.env (vault wins, like `arca run`), and
// masks this process's stdout, stderr and console arguments. Node processes it starts load it
// again through NODE_OPTIONS, but only to mask: ARCA_ACTIVE says the values are already there.
// Masking is per write, so a value split over two writes isn't caught, and output written
// straight to the file descriptor (fs.writeSync(1, …)) isn't masked. `arca run` has neither gap.
// Entries: register-entry.ts (import, --import) and register-cjs.ts (require, -r).

export type RegisterOutcome =
  /** Values loaded. `secrets` are for masking: the active profile's and every other profile's. */
  | { kind: 'loaded'; names: string[]; secrets: Secret[] }
  /** Inside `arca run` or a process that loaded them: the values are in the env, only mask. */
  | { kind: 'nested'; secrets: Secret[] }
  | { kind: 'skipped'; reason: 'no-project' | 'off' | 'agent' | 'worker' | 'no-vault' | 'error' }

/**
 * Decides whether to load, and loads into `io.env`. Never throws: problems are printed, and the
 * process runs without secrets. `scriptDir` (the main script's folder) is where to look for
 * arca.json when the working folder has none, e.g. a debugger started from a monorepo root.
 */
export async function loadSecrets(io: IO, scriptDir?: string): Promise<RegisterOutcome> {
  const env = io.env
  if (env.ARCA_ACTIVE) return { kind: 'nested', secrets: secretsFromEnv(env) }
  if (env[OFF]) return { kind: 'skipped', reason: 'off' }
  const configFile = findConfigFile(io.cwd) ?? (scriptDir ? findConfigFile(scriptDir) : null)
  if (!configFile) return { kind: 'skipped', reason: 'no-project' }
  const projectDir = dirname(configFile)
  const skip = (reason: 'agent' | 'worker' | 'no-vault' | 'error'): RegisterOutcome => {
    env[OFF] = reason
    return { kind: 'skipped', reason }
  }

  try {
    setPackageManager(detectPackageManager(projectDir, env))
    const s = new Session(io, { projectDir })
    const project = s.requireProject()
    if (s.ctx.agent.detected) {
      s.note(agentMessage(s))
      return skip('agent')
    }
    // Loaded by a test worker (setupFiles) rather than the runner's main process: the main
    // process prints failure messages ("Received: …") with nothing masking them.
    if (isTestWorker(env)) {
      s.note(s.err('yellow', workerMessage()))
      return skip('worker')
    }
    s.warnConfig()
    if (!s.hasVault()) {
      if (!s.ctx.ci) s.note(s.err('dim', `arca: no secrets stored for ${s.forWhom()} on this machine yet. Running without them.`))
      return skip('no-vault')
    }

    // Everything that can fail comes before env changes: values must never land in the env unmasked.
    const values = await s.resolve()
    const secrets = await s.allSecrets()
    const injected = s.secretsOf(values)
    const envFileValues = loadEnvFiles(project.root, s.envFiles())

    const vaultValues: Record<string, string> = {}
    for (const [name, v] of values) vaultValues[name] = v.value
    // Same precedence as `arca run`: vault > inherited env > envFiles loaded by arca.
    const overridden = Object.keys(vaultValues).filter((k) => env[k] !== undefined && env[k] !== vaultValues[k])
    for (const [k, v] of Object.entries(envFileValues)) if (env[k] === undefined) env[k] = v
    Object.assign(env, vaultValues)
    env.ARCA_ACTIVE = project.config.id
    env.ARCA_PROFILE = s.profile
    env.ARCA_PROJECT = project.config.name
    env.ARCA_MASK = injected.map((x) => x.name).join(',')
    delete env.ARCA_PASSPHRASE
    const loaded: RegisterOutcome = { kind: 'loaded', names: Object.keys(vaultValues), secrets }

    // From here on the values are in the env, so a failing notice must not turn this into a skip.
    try {
      if (overridden.length) {
        const verb = overridden.length === 1 ? 'overrides a different value' : 'override different values'
        s.note(s.err('dim', `arca: ${overridden.join(', ')} from arca ${verb} inherited from the environment.`))
      }
      const findings = scanEnvFiles(project, s.envFilesForGuard(), secrets)
      if (findings.length) s.note(s.err('yellow', summarizeFindings(findings)))
      // A warning, not a refusal: the app's own error says more than a stopped test run.
      const missing = missingRequired(s, project, env)
      if (missing.length) s.note(s.err('yellow', missingMessage(s, missing, false)))
      banner(s, injected.length, true)
    } catch {
      // Only notices failed.
    }
    return loaded
  } catch (e) {
    const message = e instanceof ArcaError ? e.message : `arca: unexpected error: ${(e as Error).stack ?? String(e)}`
    io.stderr.write(`${message}\narca: running without secrets.\n`)
    return skip('error')
  }
}

function agentMessage(s: Session): string {
  const { name, via } = s.ctx.agent
  return [
    `arca: secrets aren't loaded into commands AI agents start themselves (detected: ${name} via ${via}).`,
    `Run it through a package.json script that uses \`arca run\`, e.g. \`${runScript('test')}\`.`,
    'If the script doesn\'t use `arca run` yet, ask the user to add it, e.g. "test": "arca run -- vitest".',
  ].join('\n')
}

function workerMessage(): string {
  return [
    'arca: @bremmdev/arca-env/register was loaded in a test worker (setupFiles), so the test',
    "runner's own output, such as failure messages, wouldn't be masked. Load it in the config instead:",
    "  vitest.config.ts:  import '@bremmdev/arca-env/register'   (first line)",
    "  jest.config.js:    require('@bremmdev/arca-env/register')  (first line)",
    'Running without secrets.',
  ].join('\n')
}
