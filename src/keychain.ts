import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MASTER_KEY_BYTES, newMasterKey, unwrapMasterKey, wrapMasterKey, type WrappedKey } from './crypto.js'
import { ArcaError } from './errors.js'
import type { IO } from './io.js'
import { arca, installCommand } from './hint.js'
import { atomicWrite, ensureDir, type Store } from './store.js'
import { storeRoot } from './paths.js'

// One random master key per user, kept in the OS keychain (Windows Credential Manager,
// Linux Secret Service). Where no persistent keychain exists (WSL, headless Linux),
// it's wrapped with a passphrase instead.

const SERVICE = 'arca'

export type Backend = 'os' | 'passphrase'

/** The keychain account. A custom ARCA_HOME gets its own entry so stores never share keys by accident. */
export function keychainAccount(store: Store, io: IO): string {
  const defaultRoot = storeRoot({ ...io.env, ARCA_HOME: undefined }, io.platform)
  if (store.root === defaultRoot) return 'master-key/v1'
  const hash = createHash('sha256').update(store.root).digest('hex').slice(0, 12)
  return `master-key/v1/${hash}`
}

/** The backend this store was created with, or the one ARCA_KEYCHAIN asks for. */
function configuredBackend(store: Store, io: IO): Backend | undefined {
  const configured = store.readGlobalConfig().keychain ?? io.env.ARCA_KEYCHAIN
  return configured === 'os' || configured === 'passphrase' ? configured : undefined
}

export function chooseBackend(store: Store, io: IO): Backend {
  const configured = configuredBackend(store, io)
  if (configured) return configured
  if (io.platform === 'linux') {
    const wsl = Boolean(io.env.WSL_DISTRO_NAME) || readSafe('/proc/version').toLowerCase().includes('microsoft')
    if (wsl || !io.env.DBUS_SESSION_BUS_ADDRESS) return 'passphrase'
  }
  return 'os'
}

function readSafe(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

async function osEntry() {
  try {
    const { Entry } = await import('@napi-rs/keyring')
    return Entry
  } catch (e) {
    throw new ArcaError(
      `arca: the OS keychain binding could not be loaded (${(e as Error).message}).\n` +
        `Use passphrase mode instead: set ARCA_KEYCHAIN=passphrase before the first \`${arca()} set\`.`,
    )
  }
}

export interface MasterKeyOptions {
  /** Create the key if it doesn't exist yet (only for writes). */
  create: boolean
}

export async function loadMasterKey(store: Store, io: IO, opts: MasterKeyOptions): Promise<Buffer | null> {
  const backend = chooseBackend(store, io)
  // On Linux before the first key, 'os' is a guess from D-Bus being there. If the Secret
  // Service doesn't actually work, the store gets a passphrase instead of an error.
  const guessed = backend === 'os' && io.platform === 'linux' && configuredBackend(store, io) === undefined
  let key: Buffer | null
  if (backend === 'passphrase') key = await readPassphraseKey(store, io)
  else {
    try {
      key = await readOsKey(store, io)
    } catch (e) {
      if (!guessed) throw e
      key = null
    }
  }
  if (key) return key
  if (!opts.create) return null
  if (store.hasAnyVault()) {
    throw new ArcaError(
      'arca: the master key is missing from your keychain, but encrypted vaults exist in\n' +
        `  ${store.root}\n` +
        'Without the key they cannot be decrypted. Restore the keychain entry, or delete that folder to start over.',
    )
  }
  if (!guessed) return createMasterKey(store, io, backend)
  try {
    return await createMasterKey(store, io, 'os')
  } catch (e) {
    const reason = (e as Error).message.replace(/^arca: /, '').split('\n')[0]
    io.stderr.write(`arca: no working Secret Service keyring (${reason}). Using a passphrase instead.\n`)
    return createMasterKey(store, io, 'passphrase')
  }
}

async function createMasterKey(store: Store, io: IO, backend: Backend): Promise<Buffer> {
  const fresh = newMasterKey()
  if (backend === 'os') await writeOsKey(store, io, fresh)
  else await writePassphraseKey(store, io, fresh)
  store.writeGlobalConfig({ ...store.readGlobalConfig(), keychain: backend })
  return fresh
}

/** Like loadMasterKey without create, but fails with a clear message. */
export async function requireMasterKey(store: Store, io: IO): Promise<Buffer> {
  const key = await loadMasterKey(store, io, { create: false })
  if (!key) {
    throw new ArcaError(
      'arca: no master key found, so the stored secrets cannot be decrypted.\n' +
        `  Store: ${store.root}\n  Run \`${arca()} doctor\` for details.`,
    )
  }
  return key
}

async function osKeyEntry(store: Store, io: IO) {
  const Entry = await osEntry()
  // Pinned to the Secret Service on Linux. Unpinned, the binding silently falls back to the
  // kernel keyring, which is in memory: a reboot would destroy the only copy of the key.
  return new Entry(SERVICE, keychainAccount(store, io), io.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined)
}

async function readOsKey(store: Store, io: IO): Promise<Buffer | null> {
  let value: string | null
  try {
    value = (await osKeyEntry(store, io)).getPassword()
  } catch (e) {
    if (e instanceof ArcaError) throw e
    const message = (e as Error).message
    // A locked keyring (SSH, automatic login) only needs unlocking; switching to passphrase mode wouldn't help.
    const tip = /unlock|locked/i.test(message)
      ? 'Your keyring is locked. Unlock it (log in to the desktop, or use Seahorse / KWalletManager) and run the command again.'
      : 'If this machine has no keychain, use passphrase mode: set ARCA_KEYCHAIN=passphrase.'
    throw new ArcaError(`arca: could not read the OS keychain (${message}).\n${tip}`)
  }
  if (!value) return null
  const key = Buffer.from(value, 'base64')
  if (key.length !== MASTER_KEY_BYTES) throw new ArcaError('arca: the master key in the keychain is malformed.')
  return key
}

async function writeOsKey(store: Store, io: IO, key: Buffer): Promise<void> {
  let kept: string | null
  try {
    const entry = await osKeyEntry(store, io)
    entry.setPassword(key.toString('base64'))
    // Read it back before any vault depends on it.
    kept = entry.getPassword()
  } catch (e) {
    if (e instanceof ArcaError) throw e
    throw new ArcaError(
      `arca: could not write to the OS keychain (${(e as Error).message}).\n` +
        'If this machine has no keychain, use passphrase mode: set ARCA_KEYCHAIN=passphrase.',
    )
  }
  if (kept !== key.toString('base64')) {
    throw new ArcaError('arca: the OS keychain did not keep the master key. Use passphrase mode: set ARCA_KEYCHAIN=passphrase.')
  }
}

export async function deleteOsKey(store: Store, io: IO): Promise<boolean> {
  return (await osKeyEntry(store, io)).deletePassword()
}

function wrappedFile(store: Store): string {
  return join(store.root, 'master.key.enc')
}

async function readPassphraseKey(store: Store, io: IO): Promise<Buffer | null> {
  const file = wrappedFile(store)
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const cached = await readCachedKey(store, io, text)
  if (cached && 'key' in cached) return cached.key
  // Containers block the kernel keyring by design, so only a fixable cause gets a line on every run.
  if (cached?.binding) io.stderr.write(`arca: the passphrase can't be remembered: ${cached.problem}.\n`)
  const key = unwrapMasterKey(JSON.parse(text) as WrappedKey, await getPassphrase(io, 'arca passphrase'))
  if (!cached) await cacheKey(store, io, key, text)
  return key
}

async function writePassphraseKey(store: Store, io: IO, key: Buffer): Promise<void> {
  let passphrase = io.env.ARCA_PASSPHRASE
  if (!passphrase) {
    passphrase = await getPassphrase(io, 'Choose an arca passphrase (protects all your vaults on this machine)')
    const again = await getPassphrase(io, 'Repeat the passphrase')
    if (again !== passphrase) throw new ArcaError('arca: the passphrases did not match.')
  }
  if (passphrase.length < 8) throw new ArcaError('arca: use a passphrase of at least 8 characters.')
  ensureDir(store.root)
  const text = JSON.stringify(wrapMasterKey(key, passphrase), null, 2) + '\n'
  atomicWrite(wrappedFile(store), text)
  await cacheKey(store, io, key, text)
}

// ── passphrase cache ─────────────────────────────────────────────────────
// On Linux the unwrapped key is cached in the kernel keyring (keyutils), so the passphrase is
// typed once per boot or day instead of on every run. That keyring is in memory and per user:
// a reboot clears it. Fine for a cache, never for the only copy (see osKeyEntry). Like the OS
// keychain, it's readable by any process of the same user.

const DEFAULT_CACHE_HOURS = 12

/** How long a typed passphrase is remembered, in ms. 0 when the cache is off. */
function cacheMs(io: IO): number {
  // ARCA_PASSPHRASE needs no prompt, so there's nothing to remember.
  if (io.platform !== 'linux' || io.env.ARCA_PASSPHRASE) return 0
  const raw = io.env.ARCA_PASSPHRASE_CACHE
  const hours = raw === undefined || raw.trim() === '' || !Number.isFinite(Number(raw)) ? DEFAULT_CACHE_HOURS : Math.max(0, Number(raw))
  return hours * 60 * 60 * 1000
}

interface CachedKey {
  key: string
  expires: number
  /** Fingerprint of master.key.enc: a re-created store never gets an old key. */
  file: string
}

async function cacheEntry(store: Store, io: IO) {
  const Entry = await osEntry()
  return new Entry(SERVICE, `${keychainAccount(store, io)}/passphrase-cache`, { linux: { store: 'keyutils' } })
}

const fingerprint = (wrapped: string) => createHash('sha256').update(wrapped).digest('hex').slice(0, 16)

/** Why the kernel keyring can't be used. `binding`: the native module is missing, which a reinstall fixes. */
interface CacheProblem {
  problem: string
  binding: boolean
}

function cacheProblem(e: unknown): CacheProblem {
  // osEntry throws an ArcaError only when @napi-rs/keyring has no build for this OS. The usual
  // cause: node_modules was installed from Windows and the project is now run from WSL.
  if (e instanceof ArcaError) {
    return {
      problem: `the Linux build of the keyring module isn't installed. This happens when node_modules was installed from Windows: run \`${installCommand()}\` again from WSL or Linux`,
      binding: true,
    }
  }
  return { problem: `no usable kernel keyring (${(e as Error).message})`, binding: false }
}

async function readCachedKey(store: Store, io: IO, wrapped: string): Promise<{ key: Buffer; expires: number } | CacheProblem | null> {
  if (cacheMs(io) === 0) return null
  try {
    const raw = (await cacheEntry(store, io)).getPassword()
    if (!raw) return null
    const c = JSON.parse(raw) as CachedKey
    const key = Buffer.from(c.key, 'base64')
    if (c.file === fingerprint(wrapped) && Date.now() < c.expires && key.length === MASTER_KEY_BYTES) return { key, expires: c.expires }
    await forgetCachedKey(store, io)
    return null
  } catch (e) {
    // No usable kernel keyring (containers block it by default): just ask for the passphrase.
    return cacheProblem(e)
  }
}

async function cacheKey(store: Store, io: IO, key: Buffer, wrapped: string): Promise<void> {
  const ms = cacheMs(io)
  if (ms === 0) return
  const value: CachedKey = { key: key.toString('base64'), expires: Date.now() + ms, file: fingerprint(wrapped) }
  try {
    ;(await cacheEntry(store, io)).setPassword(JSON.stringify(value))
  } catch {
    // Same as above: without a kernel keyring, every run asks.
  }
}

export async function forgetCachedKey(store: Store, io: IO): Promise<void> {
  try {
    ;(await cacheEntry(store, io)).deletePassword()
  } catch {
    // nothing cached, or no kernel keyring
  }
}

/** For `doctor`: until when a typed passphrase is remembered, 'off', why it can't be, or null when nothing is cached. */
export async function passphraseCacheStatus(store: Store, io: IO): Promise<number | 'off' | { problem: string } | null> {
  if (io.platform !== 'linux' || io.env.ARCA_PASSPHRASE) return null
  if (cacheMs(io) === 0) return 'off'
  const file = wrappedFile(store)
  if (!existsSync(file)) return null
  const cached = await readCachedKey(store, io, readFileSync(file, 'utf8'))
  if (!cached) return null
  return 'key' in cached ? cached.expires : { problem: cached.problem }
}

async function getPassphrase(io: IO, message: string): Promise<string> {
  if (io.env.ARCA_PASSPHRASE) return io.env.ARCA_PASSPHRASE
  if (!io.stdinIsTTY || !io.stderr.isTTY) {
    throw new ArcaError('arca: this store uses a passphrase. Run the command in an interactive terminal, or set ARCA_PASSPHRASE.')
  }
  const value = await io.prompts.password(message)
  if (value === null) throw new ArcaError('arca: cancelled.')
  return value
}
