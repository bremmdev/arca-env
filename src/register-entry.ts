// `@bremmdev/arca-env/register`. See src/register.ts. Must never throw: the app runs either way.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OFF, addToNodeOptions, maskProcess, secretsFromEnv } from './register-mask.js'

const host = { process, console: globalThis.console }
try {
  // Processes started by `arca run` or a loading register only mask. The loader (and the
  // keychain code with it) is imported only when this process loads values itself.
  if (process.env.ARCA_ACTIVE) maskProcess(secretsFromEnv(process.env), host)
  else if (!process.env[OFF]) {
    const [{ loadSecrets }, { processIO }] = await Promise.all([import('./register.js'), import('./io.js')])
    const script = process.argv[1]
    const outcome = await loadSecrets(processIO(), script ? dirname(resolve(script)) : undefined)
    if (outcome.kind !== 'skipped') maskProcess(outcome.secrets, host)
    // Children get the CommonJS build (--require also runs in worker threads), next to this file.
    if (outcome.kind === 'loaded') addToNodeOptions(process.env, fileURLToPath(new URL('./register.cjs', import.meta.url)))
  }
} catch (e) {
  process.stderr.write(`arca: the register loader failed (${(e as Error).message}). Running without secrets.\n`)
}
