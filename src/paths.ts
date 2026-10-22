import { homedir } from 'node:os'
import { join } from 'node:path'

/** The store lives outside every project: never in the repo, never in `.vault/`. */
export function storeRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.ARCA_HOME) return env.ARCA_HOME
  if (platform === 'win32') {
    // Local, not roaming, so domain profiles don't sync it.
    return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'arca')
  }
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'arca')
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'arca')
}
