// Started by register-cjs.ts with spawnSync. Loads the values the way register-entry.ts does,
// and prints the result as JSON on stdout, which is a pipe to the parent. Notes and passphrase
// prompts go to stderr and stdin, which are the parent's terminal.
import { processIO } from './io.js'
import { loadSecrets } from './register.js'
import { OFF } from './register-mask.js'

export interface HelperResult {
  kind: 'loaded' | 'nested' | 'skipped'
  secrets: { name: string; value: string }[]
  /** Env changes for the parent to apply. null: delete. */
  env: Record<string, string | null>
}

// The parent sets it so a register in NODE_OPTIONS stays out of this process. Not meant for us.
delete process.env[OFF]
const before = { ...process.env }
const outcome = await loadSecrets(processIO(), process.argv[2] || undefined)
const env: Record<string, string | null> = {}
for (const key of new Set([...Object.keys(before), ...Object.keys(process.env)])) {
  if (before[key] !== process.env[key]) env[key] = process.env[key] ?? null
}
const result: HelperResult = { kind: outcome.kind, secrets: outcome.kind === 'skipped' ? [] : outcome.secrets, env }
process.stdout.write(JSON.stringify(result))
