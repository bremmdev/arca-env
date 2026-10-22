import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_PROFILE, isSensitive, loadProject, normalizeProfile, profileChain, profileEnvFiles, type Project } from './config.js'
import { buildContext, type Context } from './context.js'
import { findEnvFiles, readEnvFile, type EnvFile } from './envfiles.js'
import { ArcaError, EXIT_USAGE } from './errors.js'
import type { IO } from './io.js'
import { loadMasterKey, requireMasterKey } from './keychain.js'
import { storeRoot } from './paths.js'
import type { Secret } from './redact.js'
import { Store, emptyVault, type VaultData } from './store.js'
import { painter, type Paint } from './style.js'
import { suggest } from './util.js'

/** Where the profile of this invocation came from. */
export type ProfileSource = 'flag' | 'env' | 'use' | 'default'

/** A value as a profile sees it: its own, or inherited through `extends`. */
export interface ResolvedVar {
  value: string
  /** The profile whose vault holds the value. */
  profile: string
  updatedAt: string
}

interface PickedProfile {
  profile: string
  source: ProfileSource
  stale?: string
}

/** Per-invocation state shared by all commands. */
export class Session {
  readonly store: Store
  readonly ctx: Context
  readonly project: Project | null
  readonly out: Paint
  readonly err: Paint
  readonly profile: string
  readonly profileSource: ProfileSource
  /** The `arca use` profile, when arca.json no longer declares it. */
  readonly staleActiveProfile: string | null = null
  quiet = false
  json = false
  private master: Buffer | null = null
  private vaults = new Map<string, VaultData>()

  constructor(
    readonly io: IO,
    opts: { projectDir?: string; profile?: string } = {},
  ) {
    this.store = new Store(storeRoot(io.env, io.platform))
    const markers = safeMarkers(this.store)
    this.ctx = buildContext(io, markers)
    this.project = loadProject(opts.projectDir ? resolve(io.cwd, opts.projectDir) : io.cwd)
    this.out = painter(io.stdout, io.env)
    this.err = painter(io.stderr, io.env)

    const picked: PickedProfile = this.project ? this.pickProfile(this.project, opts.profile) : { profile: DEFAULT_PROFILE, source: 'default' }
    this.profile = picked.profile
    this.profileSource = picked.source
    this.staleActiveProfile = picked.stale ?? null
  }

  /** Precedence: --profile > ARCA_PROFILE > `arca use` > defaultProfile. */
  private pickProfile(project: Project, flag: string | undefined): PickedProfile {
    const { profiles, defaultProfile, id } = project.config
    if (flag !== undefined) return { profile: this.checkProfile(project, flag, '--profile'), source: 'flag' }
    // An outer `arca run` of another project sets ARCA_PROFILE for its own app, not for us.
    const fromEnv = this.io.env.ARCA_PROFILE
    const outer = this.ctx.activeProject
    if (fromEnv && (!outer || outer === id)) return { profile: this.checkProfile(project, fromEnv, 'ARCA_PROFILE'), source: 'env' }
    const active = this.store.readState(id).activeProfile
    if (active !== undefined) {
      if (active in profiles) return { profile: active, source: active === defaultProfile ? 'default' : 'use' }
      return { profile: defaultProfile, source: 'default', stale: active }
    }
    return { profile: defaultProfile, source: 'default' }
  }

  checkProfile(project: Project, raw: string, via: string): string {
    const name = normalizeProfile(raw)
    const names = Object.keys(project.config.profiles)
    if (name in project.config.profiles) return name
    const guess = suggest(name, names)
    const hint =
      names.length === 1
        ? `${project.config.name} has one profile (${names[0]}). Add one with \`npx arca profiles add ${name}\`.`
        : `Profiles: ${names.join(', ')}.${guess ? ` Did you mean ${guess}?` : ''}`
    throw new ArcaError(`arca: profile "${raw}" (from ${via}) isn't declared in arca.json. ${hint}`, EXIT_USAGE)
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
    if (this.staleActiveProfile) {
      this.note(
        this.err(
          'yellow',
          `arca: the active profile "${this.staleActiveProfile}" (set with \`arca use\`) isn't in arca.json any more. Using ${this.profile}. \`npx arca use --reset\` clears it.`,
        ),
      )
    }
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

  // ── profiles ────────────────────────────────────────────────────────────

  /** Every declared profile, default first. */
  get profiles(): string[] {
    if (!this.project) return [DEFAULT_PROFILE]
    const { profiles, defaultProfile } = this.project.config
    return [defaultProfile, ...Object.keys(profiles).filter((p) => p !== defaultProfile)]
  }

  get defaultProfile(): string {
    return this.project?.config.defaultProfile ?? DEFAULT_PROFILE
  }

  get multiProfile(): boolean {
    return this.profiles.length > 1
  }

  /** "acme-web", or "acme-web (profile acceptatie)" once a project has several profiles. */
  forWhom(profile = this.profile): string {
    const name = this.requireProject().config.name
    return this.multiProfile ? `${name} (profile ${profile})` : name
  }

  /** ` --profile X` for commands we tell people to run, when X isn't the default. */
  profileFlag(profile = this.profile): string {
    return profile === this.defaultProfile ? '' : ` --profile ${profile}`
  }

  chain(profile = this.profile): string[] {
    return this.project ? profileChain(this.project.config, profile) : [profile]
  }

  envFiles(profile = this.profile): string[] {
    return this.project ? profileEnvFiles(this.project.config, profile) : []
  }

  // ── vaults ──────────────────────────────────────────────────────────────

  /**
   * A vault written before the project declared profiles is `default.vault`. When arca.json
   * now names another default profile, those values belong to it.
   */
  private legacyVaultPending(): boolean {
    const p = this.project
    if (!p || p.config.defaultProfile === DEFAULT_PROFILE || DEFAULT_PROFILE in p.config.profiles) return false
    return this.store.hasVault(p.config.id, DEFAULT_PROFILE) && !this.store.hasVault(p.config.id, p.config.defaultProfile)
  }

  private async migrateLegacyVault(): Promise<void> {
    if (!this.legacyVaultPending()) return
    const { id, defaultProfile } = this.requireProject().config
    const master = await this.masterKey()
    const data = this.store.readVault(master, id, DEFAULT_PROFILE)
    this.store.writeVault(master, id, defaultProfile, data)
    this.store.removeVault(id, DEFAULT_PROFILE)
    this.note(this.err('dim', `arca: moved the values stored before this project had profiles into profile ${defaultProfile}.`))
  }

  /** Whether `profile` itself has stored values on this machine. */
  ownsVault(profile: string): boolean {
    if (!this.project) return false
    if (this.store.hasVault(this.project.config.id, profile)) return true
    return profile === this.project.config.defaultProfile && this.legacyVaultPending()
  }

  /** Whether the profile or any profile it extends has stored values. */
  hasVault(profile = this.profile): boolean {
    return this.chain(profile).some((p) => this.ownsVault(p))
  }

  async masterKey(create = false): Promise<Buffer> {
    if (this.master) return this.master
    this.master = create ? await loadMasterKey(this.store, this.io, { create: true }) : await requireMasterKey(this.store, this.io)
    if (!this.master) throw new ArcaError('arca: no master key.')
    return this.master
  }

  /** A profile's own values. Doesn't touch the keychain when it has no vault. */
  async readVault(profile = this.profile): Promise<VaultData> {
    const cached = this.vaults.get(profile)
    if (cached) return cached
    if (!this.ownsVault(profile)) return emptyVault()
    if (profile === this.defaultProfile) await this.migrateLegacyVault()
    const data = this.store.readVault(await this.masterKey(), this.projectId, profile)
    this.vaults.set(profile, data)
    return data
  }

  async writeVault(data: VaultData, profile = this.profile): Promise<void> {
    const project = this.requireProject()
    const master = await this.masterKey(true)
    if (profile === this.defaultProfile) await this.migrateLegacyVault()
    this.store.writeVault(master, project.config.id, profile, data)
    this.vaults.set(profile, data)
    const prev = this.store.touchRegistry(project.config.id, { name: project.config.name, root: project.root, gitRemote: gitRemote(project.root) })
    this.warnCollision(prev)
  }

  /** The values a profile sees: its own first, then each profile up its `extends` chain. */
  async resolve(profile = this.profile): Promise<Map<string, ResolvedVar>> {
    const out = new Map<string, ResolvedVar>()
    for (const p of this.chain(profile)) {
      const vault = await this.readVault(p)
      for (const [name, v] of Object.entries(vault.vars)) {
        if (!out.has(name)) out.set(name, { value: v.value, profile: p, updatedAt: v.updatedAt })
      }
    }
    return out
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

  /** Stored values of `profile` (with its chain) that count as secrets. */
  secretsOf(values: Map<string, ResolvedVar>): Secret[] {
    const decls = this.project?.config.vars ?? {}
    return [...values].filter(([name]) => isSensitive(decls[name])).map(([name, v]) => ({ name, value: v.value }))
  }

  /**
   * Masking needles and leak-guard matches: the active profile's secrets first, then the
   * values of every other profile, named `NAME@profile` so output says where they belong.
   */
  async allSecrets(profile = this.profile): Promise<Secret[]> {
    if (!this.project) return []
    await this.migrateLegacyVault()
    const out = this.secretsOf(await this.resolve(profile))
    const decls = this.project.config.vars
    const others = new Set([...this.profiles, ...this.store.vaultProfiles(this.project.config.id)])
    for (const p of others) {
      if (p === profile || !this.ownsVault(p)) continue
      for (const [name, v] of Object.entries((await this.readVault(p)).vars)) {
        if (isSensitive(decls[name])) out.push({ name: `${name}@${p}`, value: v.value })
      }
    }
    return out
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

  /** Every .env* file the leak guard reads: project root, nearest package root, and every profile's envFiles. */
  envFilesForGuard(): EnvFile[] {
    const project = this.requireProject()
    const dirs = [project.root]
    const pkg = this.packageRoot()
    if (pkg && pkg !== project.root) dirs.push(pkg)
    const files = findEnvFiles(dirs)
    const listed = new Set([...project.config.envFiles, ...Object.values(project.config.profiles).flatMap((p) => p.envFiles)])
    for (const f of listed) {
      const path = resolve(project.root, f)
      if (files.some((x) => x.path === path)) continue
      const file = readEnvFile(path, f)
      if (file) files.push(file)
    }
    return files
  }

  /** The .env* files that can provide values for `profile`: all of them, minus other profiles' own envFiles. */
  envFilesFor(profile = this.profile): EnvFile[] {
    const project = this.requireProject()
    const mine = new Set(this.envFiles(profile).map((f) => resolve(project.root, f)))
    const others = new Set(
      Object.values(project.config.profiles)
        .flatMap((p) => p.envFiles)
        .map((f) => resolve(project.root, f))
        .filter((f) => !mine.has(f)),
    )
    return this.envFilesForGuard().filter((f) => !others.has(f.path))
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
