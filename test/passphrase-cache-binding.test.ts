import { describe, expect, it, vi } from 'vitest'
import { loadMasterKey } from '../src/keychain.js'
import { main } from '../src/main.js'
import { Store } from '../src/store.js'
import { PASSPHRASE, fakeIO, tempStore } from './helpers.js'

// A project installed from Windows and run from WSL has only the Windows build of the
// keyring module. Passphrase mode still works, but the cache can't, and arca says why.
vi.mock('@napi-rs/keyring', () => {
  throw new Error('Cannot find native binding')
})

function linuxIO(store: Store, password: string[] = []) {
  const io = fakeIO({ cwd: store.root, env: { ARCA_HOME: store.root }, tty: true, answers: { password } })
  return Object.assign(io, { platform: 'linux' as const })
}

describe('passphrase cache without the native keyring module', () => {
  it('asks every time and says why', async () => {
    const store = new Store(tempStore())
    const io = linuxIO(store, [PASSPHRASE])
    expect(await loadMasterKey(store, io, { create: false })).toHaveLength(32)
    expect(io.err()).toContain("the passphrase can't be remembered")
    expect(io.err()).toContain('npm install')
    await expect(loadMasterKey(store, linuxIO(store), { create: false })).rejects.toThrow('unexpected password prompt')
  })

  it('doctor warns that the cache is unavailable', async () => {
    const store = new Store(tempStore())
    const io = linuxIO(store, [PASSPHRASE])
    await main(['doctor'], io)
    expect(io.out()).toContain('Passphrase cache unavailable')
  })
})
