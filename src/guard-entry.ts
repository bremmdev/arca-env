// Preloaded by `arca run` through NODE_OPTIONS=--import. Must never throw.
import { installFromEnv } from './guard.js'

try {
  installFromEnv()
} catch {
  // Masking of stdout/stderr by the arca process still applies.
}
