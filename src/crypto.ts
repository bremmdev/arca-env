import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from 'node:crypto'
import { ArcaError } from './errors.js'

// Envelope encryption: one random master key (in the OS keychain), and a key per
// vault file derived from it with HKDF. Only node:crypto, no third-party crypto.

export const MASTER_KEY_BYTES = 32

export function newMasterKey(): Buffer {
  return randomBytes(MASTER_KEY_BYTES)
}

export function vaultKey(master: Buffer, projectId: string, profile: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, projectId, `arca/vault/v1/${profile}`, 32))
}

export function policyKey(master: Buffer, projectId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, projectId, 'arca/policy/v1', 32))
}

export interface Sealed {
  iv: string
  tag: string
  ct: string
}

export function seal(key: Buffer, plaintext: string, aad: string): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') }
}

export function open(key: Buffer, sealed: Sealed, aad: string): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new ArcaError(
      'arca: could not decrypt the vault. The master key in your keychain does not match this store, or the file was modified.',
    )
  }
}

// Passphrase mode (no persistent keychain): the master key is wrapped with scrypt.

export const SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const

export interface WrappedKey extends Sealed {
  format: 'arca-master-key'
  v: 1
  kdf: 'scrypt'
  salt: string
  N: number
  r: number
  p: number
}

function scryptKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase.normalize('NFC'), salt, 32, { ...params, maxmem: 256 * 1024 * 1024 })
}

export function wrapMasterKey(master: Buffer, passphrase: string, params: { N: number; r: number; p: number } = SCRYPT): WrappedKey {
  const salt = randomBytes(16)
  const sealed = seal(scryptKey(passphrase, salt, params), master.toString('base64'), 'arca-master-key:v1')
  return { format: 'arca-master-key', v: 1, kdf: 'scrypt', salt: salt.toString('base64'), ...params, ...sealed }
}

export function unwrapMasterKey(wrapped: WrappedKey, passphrase: string): Buffer {
  const key = scryptKey(passphrase, Buffer.from(wrapped.salt, 'base64'), wrapped)
  try {
    return Buffer.from(open(key, wrapped, 'arca-master-key:v1'), 'base64')
  } catch {
    throw new ArcaError('arca: wrong passphrase.')
  }
}

export function generateSecret(bytes: number, encoding: 'base64url' | 'base64' | 'hex'): string {
  return randomBytes(bytes).toString(encoding)
}
