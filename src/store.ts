import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs'
import { join } from 'node:path'
import { open, policyKey, seal, vaultKey, type Sealed } from './crypto.js'
import { ArcaError } from './errors.js'

// Store layout (outside every project):
//   config.json      global, non-secret prefs
//   registry.json    non-secret: id -> name, roots, git remote, lastUsed
//   master.key.enc   passphrase mode only
//   projects/<id>/<profile>.vault (+ .bak), policy.vault, state.json (active profile)

export interface VaultVar {
  value: string
  updatedAt: string
  source: string
  previous: { value: string; updatedAt: string } | null
}

export interface VaultData {
  vars: Record<string, VaultVar>
  /** Values removed with `arca unset`, so `arca restore` can bring them back. */
  removed: Record<string, { value: string; updatedAt: string }>
  meta: { createdAt: string }
}

export type AgentRunPolicy = 'scripts' | 'deny'

export interface PolicyData {
  agentRun: AgentRunPolicy
}

export interface ProjectState {
  activeProfile?: string
  setAt?: string
}

export interface GlobalConfig {
  keychain?: 'os' | 'passphrase'
  /** Extra env var names that mark an AI agent. */
  agentMarkers?: string[]
}

export interface RegistryEntry {
  name: string
  roots: string[]
  gitRemote: string | null
  lastUsed: string
}

interface Envelope extends Sealed {
  format: 'arca-vault' | 'arca-policy'
  v: 1
  projectId: string
  profile?: string
  kdf: 'hkdf-sha256'
  alg: 'aes-256-gcm'
}

export class Store {
  constructor(public readonly root: string) {}

  projectDir(id: string): string {
    return join(this.root, 'projects', id)
  }

  vaultFile(id: string, profile: string): string {
    return join(this.projectDir(id), `${profile}.vault`)
  }

  hasVault(id: string, profile: string): boolean {
    return existsSync(this.vaultFile(id, profile))
  }

  /** True when any vault exists, used to refuse creating a new master key over old data. */
  hasAnyVault(): boolean {
    const dir = join(this.root, 'projects')
    if (!existsSync(dir)) return false
    for (const id of readdirSync(dir)) {
      const pdir = join(dir, id)
      try {
        if (readdirSync(pdir).some((f) => f.endsWith('.vault'))) return true
      } catch {
        // not a directory
      }
    }
    return false
  }

  /** Profiles with a vault file for this project. */
  vaultProfiles(id: string): string[] {
    const dir = this.projectDir(id)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.vault') && f !== 'policy.vault')
      .map((f) => f.slice(0, -'.vault'.length))
  }

  removeVault(id: string, profile: string): void {
    this.withLock(id, () => {
      const file = this.vaultFile(id, profile)
      rmSync(file, { force: true })
      rmSync(`${file}.bak`, { force: true })
    })
  }

  // ── active profile (`arca use`), plaintext because it isn't secret ─────────

  stateFile(id: string): string {
    return join(this.projectDir(id), 'state.json')
  }

  readState(id: string): ProjectState {
    const file = this.stateFile(id)
    if (!existsSync(file)) return {}
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as ProjectState
      return typeof data.activeProfile === 'string' ? data : {}
    } catch {
      return {}
    }
  }

  writeState(id: string, state: ProjectState): void {
    this.withLock(id, () => {
      if (state.activeProfile === undefined) rmSync(this.stateFile(id), { force: true })
      else atomicWrite(this.stateFile(id), JSON.stringify(state, null, 2) + '\n')
    })
  }

  projectIds(): string[] {
    const dir = join(this.root, 'projects')
    return existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith('arc_')) : []
  }

  // ── vaults ──────────────────────────────────────────────────────────────

  readVault(master: Buffer, id: string, profile: string): VaultData {
    const file = this.vaultFile(id, profile)
    if (!existsSync(file)) return emptyVault()
    const env = readEnvelope(file, 'arca-vault')
    if (env.projectId !== id || env.profile !== profile) {
      throw new ArcaError(`arca: ${file} belongs to a different project or profile.`)
    }
    const data = JSON.parse(open(vaultKey(master, id, profile), env, vaultAad(id, profile))) as Partial<VaultData>
    return { vars: data.vars ?? {}, removed: data.removed ?? {}, meta: data.meta ?? { createdAt: new Date().toISOString() } }
  }

  writeVault(master: Buffer, id: string, profile: string, data: VaultData): void {
    const sealed = seal(vaultKey(master, id, profile), JSON.stringify(data), vaultAad(id, profile))
    const envelope: Envelope = {
      format: 'arca-vault',
      v: 1,
      projectId: id,
      profile,
      kdf: 'hkdf-sha256',
      alg: 'aes-256-gcm',
      ...sealed,
    }
    this.withLock(id, () => {
      const file = this.vaultFile(id, profile)
      if (existsSync(file)) copyFileSync(file, `${file}.bak`)
      atomicWrite(file, JSON.stringify(envelope, null, 2) + '\n')
    })
  }

  // ── policy ──────────────────────────────────────────────────────────────

  policyFile(id: string): string {
    return join(this.projectDir(id), 'policy.vault')
  }

  readPolicy(master: Buffer | null, id: string): PolicyData {
    const file = this.policyFile(id)
    if (!existsSync(file) || !master) return { agentRun: 'scripts' }
    const env = readEnvelope(file, 'arca-policy')
    const data = JSON.parse(open(policyKey(master, id), env, `arca-policy:v1:${id}`)) as Partial<PolicyData>
    return { agentRun: data.agentRun === 'deny' ? 'deny' : 'scripts' }
  }

  hasPolicy(id: string): boolean {
    return existsSync(this.policyFile(id))
  }

  writePolicy(master: Buffer, id: string, data: PolicyData): void {
    const sealed = seal(policyKey(master, id), JSON.stringify(data), `arca-policy:v1:${id}`)
    const envelope: Envelope = { format: 'arca-policy', v: 1, projectId: id, kdf: 'hkdf-sha256', alg: 'aes-256-gcm', ...sealed }
    this.withLock(id, () => atomicWrite(this.policyFile(id), JSON.stringify(envelope, null, 2) + '\n'))
  }

  removeProject(id: string): void {
    rmSync(this.projectDir(id), { recursive: true, force: true })
    const reg = this.readRegistry()
    delete reg[id]
    this.writeJson('registry.json', reg)
  }

  // ── global files ────────────────────────────────────────────────────────

  readGlobalConfig(): GlobalConfig {
    return this.readJson<GlobalConfig>('config.json') ?? {}
  }

  writeGlobalConfig(cfg: GlobalConfig): void {
    this.writeJson('config.json', cfg)
  }

  readRegistry(): Record<string, RegistryEntry> {
    return this.readJson<Record<string, RegistryEntry>>('registry.json') ?? {}
  }

  /** Records where a project lives. Returns the previous entry so callers can detect ID collisions. */
  touchRegistry(id: string, info: { name: string; root: string; gitRemote: string | null }): RegistryEntry | undefined {
    const reg = this.readRegistry()
    const prev = reg[id]
    const roots = new Set(prev?.roots ?? [])
    roots.add(info.root)
    reg[id] = {
      name: info.name,
      roots: [...roots],
      gitRemote: info.gitRemote ?? prev?.gitRemote ?? null,
      lastUsed: new Date().toISOString(),
    }
    this.writeJson('registry.json', reg)
    return prev
  }

  readJson<T>(name: string): T | null {
    const file = join(this.root, name)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch {
      throw new ArcaError(`arca: ${file} is corrupt (not valid JSON).`)
    }
  }

  writeJson(name: string, data: unknown): void {
    ensureDir(this.root)
    atomicWrite(join(this.root, name), JSON.stringify(data, null, 2) + '\n')
  }

  /** Serialises writes to one project's files across processes. */
  withLock<T>(id: string, fn: () => T): T {
    const dir = this.projectDir(id)
    ensureDir(dir)
    const lock = join(dir, '.lock')
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx'))
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        try {
          if (Date.now() - statSync(lock).mtimeMs > 10_000) {
            rmSync(lock, { force: true })
            continue
          }
        } catch {
          continue
        }
        if (Date.now() > deadline) throw new ArcaError(`arca: the store is locked by another arca process (${lock}).`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      }
    }
    try {
      return fn()
    } finally {
      rmSync(lock, { force: true })
    }
  }
}

export function emptyVault(): VaultData {
  return { vars: {}, removed: {}, meta: { createdAt: new Date().toISOString() } }
}

function vaultAad(id: string, profile: string): string {
  return `arca-vault:v1:${id}:${profile}`
}

function readEnvelope(file: string, format: Envelope['format']): Envelope {
  let env: Envelope
  try {
    env = JSON.parse(readFileSync(file, 'utf8')) as Envelope
  } catch {
    throw new ArcaError(`arca: ${file} is corrupt. A previous version may be in ${file}.bak.`)
  }
  if (env.format !== format || env.v !== 1) throw new ArcaError(`arca: ${file} has an unknown format.`)
  return env
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

export function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeFileSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  // On Windows a rename can briefly fail while antivirus or an indexer holds the file.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file)
      break
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        rmSync(tmp, { force: true })
        throw e
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  if (process.platform !== 'win32') chmodSync(file, 0o600)
}
