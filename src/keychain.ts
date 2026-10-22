import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MASTER_KEY_BYTES, newMasterKey, unwrapMasterKey, wrapMasterKey, type WrappedKey } from './crypto.js'
import { ArcaError } from './errors.js'
import type { IO } from './io.js'
import { atomicWrite, ensureDir, type Store } from './store.js'
import { storeRoot } from './paths.js'

// One random master key per user, kept in the OS keychain (Windows Credential Manager,
// macOS Keychain, Linux Secret Service). Where no persistent keychain exists (WSL,
// headless Linux), it's wrapped with a passphrase instead.

const SERVICE = 'arca'

export type Backend = 'os' | 'passphrase'

/** The keychain account. A custom ARCA_HOME gets its own entry so stores never share keys by accident. */
export function keychainAccount(store: Store, io: IO): string {
  const defaultRoot = storeRoot({ ...io.env, ARCA_HOME: undefined }, io.platform)
  if (store.root === defaultRoot) return 'master-key/v1'
  const hash = createHash('sha256').update(store.root).digest('hex').slice(0, 12)
  return `master-key/v1/${hash}`
}

export function chooseBackend(store: Store, io: IO): Backend {
  const configured = store.readGlobalConfig().keychain ?? io.env.ARCA_KEYCHAIN
  if (configured === 'os' || configured === 'passphrase') return configured
  if (io.platform === 'linux') {
    // keyutils (the Linux fallback) is in-memory: a reboot would destroy the only copy of the key.
    const wsl = readSafe('/proc/version').toLowerCase().includes('microsoft')
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
        'Use passphrase mode instead: set ARCA_KEYCHAIN=passphrase before the first `npx arca set`.',
    )
  }
}

export interface MasterKeyOptions {
  /** Create the key if it doesn't exist yet (only for writes). */
  create: boolean
}

export async function loadMasterKey(store: Store, io: IO, opts: MasterKeyOptions): Promise<Buffer | null> {
  const backend = chooseBackend(store, io)
  const key = backend === 'os' ? await readOsKey(store, io) : await readPassphraseKey(store, io)
  if (key) return key
  if (!opts.create) return null
  if (store.hasAnyVault()) {
    throw new ArcaError(
      'arca: the master key is missing from your keychain, but encrypted vaults exist in\n' +
        `  ${store.root}\n` +
        'Without the key they cannot be decrypted. Restore the keychain entry, or delete that folder to start over.',
    )
  }
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
        `  Store: ${store.root}\n  Run \`npx arca doctor\` for details.`,
    )
  }
  return key
}

async function readOsKey(store: Store, io: IO): Promise<Buffer | null> {
  const Entry = await osEntry()
  let value: string | null
  try {
    value = new Entry(SERVICE, keychainAccount(store, io)).getPassword()
  } catch (e) {
    throw new ArcaError(
      `arca: could not read the OS keychain (${(e as Error).message}).\n` +
        'If this machine has no keychain, use passphrase mode: set ARCA_KEYCHAIN=passphrase.',
    )
  }
  if (!value) return null
  const key = Buffer.from(value, 'base64')
  if (key.length !== MASTER_KEY_BYTES) throw new ArcaError('arca: the master key in the keychain is malformed.')
  return key
}

async function writeOsKey(store: Store, io: IO, key: Buffer): Promise<void> {
  const Entry = await osEntry()
  const entry = new Entry(SERVICE, keychainAccount(store, io))
  entry.setPassword(key.toString('base64'))
  // Read it back: some backends (Linux keyutils) accept writes that don't persist.
  if (entry.getPassword() !== key.toString('base64')) {
    throw new ArcaError('arca: the OS keychain did not keep the master key. Use passphrase mode: set ARCA_KEYCHAIN=passphrase.')
  }
}

export async function deleteOsKey(store: Store, io: IO): Promise<boolean> {
  const Entry = await osEntry()
  return new Entry(SERVICE, keychainAccount(store, io)).deletePassword()
}

function wrappedFile(store: Store): string {
  return join(store.root, 'master.key.enc')
}

async function readPassphraseKey(store: Store, io: IO): Promise<Buffer | null> {
  const file = wrappedFile(store)
  if (!existsSync(file)) return null
  const wrapped = JSON.parse(readFileSync(file, 'utf8')) as WrappedKey
  const passphrase = await getPassphrase(io, 'arca passphrase')
  return unwrapMasterKey(wrapped, passphrase)
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
  atomicWrite(wrappedFile(store), JSON.stringify(wrapMasterKey(key, passphrase), null, 2) + '\n')
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
