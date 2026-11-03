import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newMasterKey, wrapMasterKey } from '../src/crypto.js'
import { forgetCachedKey, loadMasterKey } from '../src/keychain.js'
import { main } from '../src/main.js'
import { Store } from '../src/store.js'
import { PASSPHRASE, fakeIO, tempDir, tempStore, type Answers } from './helpers.js'

// Passphrase mode remembers the unlocked key in the Linux kernel keyring for a while, so
// WSL and headless Linux don't ask on every run. A fake prompt with no answers left throws
// "unexpected password prompt", which is how these tests see whether arca asked.

/** Containers block the kernel keyring by default; there the cache is off and arca just asks. */
async function keyutilsWorks(): Promise<boolean> {
  if (process.platform !== 'linux') return false
  try {
    const { Entry } = await import('@napi-rs/keyring')
    const e = new Entry('arca-test', `probe-${process.pid}`, { linux: { store: 'keyutils' } })
    e.setPassword('x')
    const ok = e.getPassword() === 'x'
    e.deletePassword()
    return ok
  } catch {
    return false
  }
}
const keyutils = await keyutilsWorks()

const used: Store[] = []
afterEach(async () => {
  for (const store of used.splice(0)) await forgetCachedKey(store, io(store))
})

function io(store: Store, o: { answers?: Answers; cache?: string; platform?: NodeJS.Platform } = {}) {
  const env = { ARCA_HOME: store.root, ...(o.cache === undefined ? {} : { ARCA_PASSPHRASE_CACHE: o.cache }) }
  const fake = fakeIO({ cwd: store.root, env, tty: true, answers: o.answers })
  return o.platform ? { ...fake, platform: o.platform } : fake
}

function passphraseStore(): Store {
  const store = new Store(tempStore())
  used.push(store)
  return store
}

const unlock = (store: Store, o: Parameters<typeof io>[1] = {}) => loadMasterKey(store, io(store, { answers: { password: [PASSPHRASE] }, ...o }), { create: false })
const quietly = (store: Store, o: Parameters<typeof io>[1] = {}) => loadMasterKey(store, io(store, o), { create: false })

describe.runIf(keyutils)('passphrase cache (Linux with a usable kernel keyring)', () => {
  it('the first unlock is remembered: the next run asks nothing', async () => {
    const store = passphraseStore()
    const key = await unlock(store)
    expect(await quietly(store)).toEqual(key)
  })

  it('creating the key with a typed passphrase is remembered too', async () => {
    const store = new Store(tempDir())
    used.push(store)
    writeFileSync(join(store.root, 'config.json'), JSON.stringify({ keychain: 'passphrase' }))
    const key = await loadMasterKey(store, io(store, { answers: { password: [PASSPHRASE, PASSPHRASE] } }), { create: true })
    expect(await quietly(store)).toEqual(key)
  })

  it('a wrong passphrase is not remembered', async () => {
    const store = passphraseStore()
    await expect(loadMasterKey(store, io(store, { answers: { password: ['wrong-passphrase'] } }), { create: false })).rejects.toThrow('wrong passphrase')
    await expect(quietly(store)).rejects.toThrow('unexpected password prompt')
  })

  it('expires after ARCA_PASSPHRASE_CACHE hours', async () => {
    const store = passphraseStore()
    await unlock(store, { cache: '0.0003' }) // about 1 s
    await new Promise((r) => setTimeout(r, 1300))
    await expect(quietly(store, { cache: '0.0003' })).rejects.toThrow('unexpected password prompt')
  })

  it('ARCA_PASSPHRASE_CACHE=0 turns it off', async () => {
    const store = passphraseStore()
    await unlock(store, { cache: '0' })
    await expect(quietly(store, { cache: '0' })).rejects.toThrow('unexpected password prompt')
  })

  it('a re-created master.key.enc never gets the old key', async () => {
    const store = passphraseStore()
    const old = await unlock(store)
    const fresh = newMasterKey()
    writeFileSync(join(store.root, 'master.key.enc'), JSON.stringify(wrapMasterKey(fresh, PASSPHRASE, { N: 1024, r: 8, p: 1 })))
    const key = await unlock(store)
    expect(key).toEqual(fresh)
    expect(key).not.toEqual(old)
  })

  it('each store has its own entry', async () => {
    const a = passphraseStore()
    const b = passphraseStore()
    await unlock(a)
    await expect(quietly(b)).rejects.toThrow('unexpected password prompt')
  })

  it('doctor says until when the passphrase is remembered', async () => {
    const store = passphraseStore()
    await unlock(store)
    const out = io(store)
    await main(['doctor'], out)
    expect(out.out()).toContain('Passphrase remembered until')
  })
})

describe('passphrase cache, everywhere', () => {
  it.runIf(process.platform === 'linux' && !keyutils)('Linux without a usable kernel keyring (containers): asks every time, no error', async () => {
    const store = passphraseStore()
    const key = await unlock(store)
    expect(key).toHaveLength(32)
    await expect(quietly(store)).rejects.toThrow('unexpected password prompt')
  })

  it('Windows: passphrase mode asks every time (no kernel keyring)', async () => {
    const store = passphraseStore()
    await unlock(store, { platform: 'win32' })
    await expect(quietly(store, { platform: 'win32' })).rejects.toThrow('unexpected password prompt')
  })
})
