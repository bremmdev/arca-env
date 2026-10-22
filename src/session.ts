import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_PROFILE, isSensitive, loadProject, type Project } from './config.js'
import { buildContext, type Context } from './context.js'
import { findEnvFiles, readEnvFile, type EnvFile } from './envfiles.js'
import { ArcaError } from './errors.js'
import type { IO } from './io.js'
import { loadMasterKey, requireMasterKey } from './keychain.js'
import { storeRoot } from './paths.js'
import type { Secret } from './redact.js'
import { Store, emptyVault, type VaultData } from './store.js'
import { painter, type Paint } from './style.js'

/** Per-invocation state shared by all commands. */
export class Session {
  readonly store: Store
  readonly ctx: Context
  readonly project: Project | null
  readonly out: Paint
  readonly err: Paint
  readonly profile = DEFAULT_PROFILE
  quiet = false
  json = false
  private master: Buffer | null = null

  constructor(
    readonly io: IO,
    opts: { projectDir?: string } = {},
  ) {
    this.store = new Store(storeRoot(io.env, io.platform))
    const markers = safeMarkers(this.store)
    this.ctx = buildContext(io, markers)
    this.project = loadProject(opts.projectDir ? resolve(io.cwd, opts.projectDir) : io.cwd)
    this.out = painter(io.stdout, io.env)
    this.err = painter(io.stderr, io.env)
  }

  print(text = ''): void {
    this.io.stdout.write(text + '\n')
  }

  /** Status and warnings go to stderr, so stdout stays clean for data. */
  note(text: string): void {
    this.io.stderr.write(text + '\n')
  }

  warnConfig(): void {
    if (!this.project || this.quiet) return
    for (const w of this.project.warnings) this.note(this.err('yellow', `arca: ${w}`))
  }

  requireProject(): Project {
    if (!this.project) {
      throw new ArcaError('arca: no arca.json found in this folder or any parent. Run `npx arca init` to set up arca for this project.')
    }
    return this.project
  }

  get projectId(): string {
    return this.requireProject().config.id
  }

  hasVault(): boolean {
    return this.project ? this.store.hasVault(this.project.config.id, this.profile) : false
  }

  async masterKey(create = false): Promise<Buffer> {
    if (this.master) return this.master
    this.master = create ? await loadMasterKey(this.store, this.io, { create: true }) : await requireMasterKey(this.store, this.io)
    if (!this.master) throw new ArcaError('arca: no master key.')
    return this.master
  }

  /** The project's vault. Doesn't touch the keychain when no vault exists yet. */
  async readVault(): Promise<VaultData> {
    if (!this.hasVault()) return emptyVault()
    return this.store.readVault(await this.masterKey(), this.projectId, this.profile)
  }

  async writeVault(data: VaultData): Promise<void> {
    const project = this.requireProject()
    const master = await this.masterKey(true)
    this.store.writeVault(master, project.config.id, this.profile, data)
    const prev = this.store.touchRegistry(project.config.id, { name: project.config.name, root: project.root, gitRemote: gitRemote(project.root) })
    this.warnCollision(prev)
  }

  warnCollision(prev: { roots: string[]; gitRemote: string | null } | undefined): void {
    const project = this.project
    if (!project || !prev?.gitRemote) return
    const remote = gitRemote(project.root)
    if (remote && remote !== prev.gitRemote) {
      this.note(
        this.err(
          'yellow',
          `arca: arca.json id ${project.config.id} is also used by ${prev.roots[0] ?? 'another project'} (git remote ${prev.gitRemote}).\n` +
            '  Two different repos share secrets. If that is wrong, run `npx arca init --new-id` in one of them.',
        ),
      )
    }
  }

  async policy() {
    if (!this.project || !this.store.hasPolicy(this.project.config.id)) return { agentRun: 'scripts' as const }
    return this.store.readPolicy(await this.masterKey(), this.project.config.id)
  }

  /** Stored values that count as secrets (masking needles, leak-guard exact matches). */
  secrets(vault: VaultData): Secret[] {
    const decls = this.project?.config.vars ?? {}
    return Object.entries(vault.vars)
      .filter(([name]) => isSensitive(decls[name]))
      .map(([name, v]) => ({ name, value: v.value }))
  }

  /** Nearest directory with a package.json, from cwd up to the project root. */
  packageRoot(): string | null {
    let dir = resolve(this.io.cwd)
    for (;;) {
      if (existsSync(join(dir, 'package.json'))) return dir
      const parent = dirname(dir)
      if (parent === dir || (this.project && dir === this.project.root)) return null
      dir = parent
    }
  }

  /** Every .env* file the leak guard reads: project root, nearest package root, and envFiles. */
  envFilesForGuard(): EnvFile[] {
    const project = this.requireProject()
    const dirs = [project.root]
    const pkg = this.packageRoot()
    if (pkg && pkg !== project.root) dirs.push(pkg)
    const files = findEnvFiles(dirs)
    for (const f of project.config.envFiles) {
      const path = resolve(project.root, f)
      if (files.some((x) => x.path === path)) continue
      const file = readEnvFile(path, f)
      if (file) files.push(file)
    }
    return files
  }
}

function safeMarkers(store: Store): string[] {
  try {
    return store.readGlobalConfig().agentMarkers ?? []
  } catch {
    return []
  }
}

export function gitRemote(root: string): string | null {
  try {
    const out = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
    return out.trim() || null
  } catch {
    return null
  }
}
