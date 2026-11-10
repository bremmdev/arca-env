// `require('@bremmdev/arca-env/register')`: the CommonJS twin of register-entry.ts, for Jest's
// setupFiles, `node -r`, and Playwright configs in projects without "type": "module". require()
// can't wait for the keychain or a passphrase prompt, so a short-lived helper process loads the
// values (spawnSync) and hands them back over a pipe. That costs one Node startup. Processes
// started from here only mask, which needs no helper. Must never throw: the app runs either way.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import type { HelperResult } from './register-helper.js'
import { OFF, addToNodeOptions, maskProcess, secretsFromEnv } from './register-mask.js'

try {
  load()
} catch (e) {
  process.stderr.write(`arca: the register loader failed (${(e as Error).message}). Running without secrets.\n`)
}

function load(): void {
  const env = process.env
  if (env.ARCA_ACTIVE) return maskProcess(secretsFromEnv(env), { process, console: globalThis.console })
  if (env[OFF]) return
  const script = process.argv[1]
  const r = spawnSync(process.execPath, [join(__dirname, 'register-helper.mjs'), script ? dirname(resolve(script)) : ''], {
    env: { ...env, [OFF]: 'helper' },
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    windowsHide: true,
  })
  if (r.error || r.status !== 0) {
    env[OFF] = 'error'
    const why = r.error?.message ?? `exit code ${r.status ?? r.signal}`
    process.stderr.write(`arca: the register loader failed (${why}). Running without secrets.\n`)
    return
  }
  const result = JSON.parse(r.stdout) as HelperResult
  for (const [key, value] of Object.entries(result.env)) {
    if (value === null) delete env[key]
    else env[key] = value
  }
  if (result.kind !== 'skipped') maskProcess(result.secrets, { process, console: globalThis.console })
  if (result.kind === 'loaded') addToNodeOptions(env, __filename)
}
