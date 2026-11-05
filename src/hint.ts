import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// The commands arca suggests are written for the project's package manager. `npx arca` doesn't
// work under yarn Plug'n'Play (there's no node_modules/.bin), and wherever arca isn't installed
// it fetches the unrelated `arca` package from npm. `yarn arca`, `pnpm arca` and `bun arca`
// only ever run the local install.

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['pnpm-workspace.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['.pnp.cjs', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
]

function parsePm(spec: unknown): PackageManager | null {
  if (typeof spec !== 'string') return null
  const name = spec.split('@')[0]
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : null
}

/**
 * The package manager of the project around `dir`: the `packageManager` field, else the
 * lockfile, walking up so a workspace package finds the root's. Stops at the repo root or a
 * workspace root. Falls back to the package manager running arca, then npm.
 */
export function detectPackageManager(dir: string, env: NodeJS.ProcessEnv): PackageManager {
  for (let d = resolve(dir); ; ) {
    let workspaceRoot = false
    const pkgPath = join(d, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { packageManager?: unknown; workspaces?: unknown }
        const pm = parsePm(pkg.packageManager)
        if (pm) return pm
        workspaceRoot = pkg.workspaces !== undefined
      } catch {
        // An unreadable package.json says nothing about the package manager.
      }
    }
    for (const [file, pm] of LOCKFILES) if (existsSync(join(d, file))) return pm
    const parent = dirname(d)
    if (workspaceRoot || existsSync(join(d, '.git')) || parent === d) break
    d = parent
  }
  // npm_config_user_agent looks like "pnpm/10.2.0 npm/? node/v24.1.0 linux x64".
  return parsePm(env.npm_config_user_agent?.split('/')[0]) ?? 'npm'
}

let current: PackageManager = 'npm'

/** Called once per CLI invocation, before any message is built. */
export function setPackageManager(pm: PackageManager): void {
  current = pm
}

/** How to run arca in a terminal: `npx arca`, `yarn arca`, `pnpm arca` or `bun arca`. */
export function arca(): string {
  return current === 'npm' ? 'npx arca' : `${current} arca`
}

/** How to run a package.json script: `npm run dev`, `yarn dev`, `pnpm dev`, `bun run dev`. */
export function runScript(name: string): string {
  if (current === 'npm') return name === 'test' ? 'npm test' : `npm run ${name}`
  // `bun test` is bun's own test runner, not the script.
  return current === 'bun' ? `bun run ${name}` : `${current} ${name}`
}

/** How to install the project's dependencies. */
export function installCommand(): string {
  return `${current} install`
}

/** How to add a dev dependency. */
export function addDevCommand(pkg: string): string {
  if (current === 'npm') return `npm i -D ${pkg}`
  return `${current} add ${current === 'bun' ? '-d' : '-D'} ${pkg}`
}
