import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Same folder as TEST_ROOT in helpers.ts (not imported, so this file stays free of src/ imports).
const root = join(tmpdir(), 'arca-tests')

// Best-effort on both ends: on Windows a child process that is still exiting can hold a
// handle for a moment, so anything left behind is removed at the start of the next run.
function clean(): void {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10 })
  } catch {}
}

export function setup(): () => void {
  clean()
  return clean
}
