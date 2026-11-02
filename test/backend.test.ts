import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chooseBackend, loadMasterKey } from '../src/keychain.js'
import { Store } from '../src/store.js'
import { PASSPHRASE, fakeIO, tempDir } from './helpers.js'

// Which key storage a store gets, per platform. Pure decisions, so they run on every OS.

function procVersion(): string {
  try {
    return readFileSync('/proc/version', 'utf8')
  } catch {
    return ''
  }
}
const onWsl = /microsoft/i.test(procVersion())

function decide(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, store = new Store(tempDir())) {
  return chooseBackend(store, { ...fakeIO({ cwd: store.root, env }), platform })
}

describe('which key storage a new store gets', () => {
  it('Windows: Credential Manager', () => {
    expect(decide('win32', {})).toBe('os')
  })

  it.skipIf(onWsl)('Linux with a D-Bus session: Secret Service', () => {
    expect(decide('linux', { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' })).toBe('os')
  })

  it('Linux without D-Bus (headless, SSH, containers): passphrase', () => {
    expect(decide('linux', {})).toBe('passphrase')
  })

  it('WSL: passphrase, even with a D-Bus session', () => {
    expect(decide('linux', { WSL_DISTRO_NAME: 'Ubuntu', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' })).toBe('passphrase')
  })

  it('ARCA_KEYCHAIN overrides the guess; unknown values are ignored', () => {
    expect(decide('linux', { ARCA_KEYCHAIN: 'os' })).toBe('os')
    expect(decide('win32', { ARCA_KEYCHAIN: 'passphrase' })).toBe('passphrase')
    expect(decide('win32', { ARCA_KEYCHAIN: 'vault' })).toBe('os')
  })

  it("the store's recorded backend wins over ARCA_KEYCHAIN", () => {
    const store = new Store(tempDir())
    writeFileSync(join(store.root, 'config.json'), JSON.stringify({ keychain: 'passphrase' }))
    expect(decide('win32', { ARCA_KEYCHAIN: 'os' }, store)).toBe('passphrase')
  })
})

describe('Linux with D-Bus but no working Secret Service', () => {
  // A bus address that can't connect, so the real keyring is never touched.
  it.runIf(process.platform === 'linux' && !onWsl)('the first key falls back to a passphrase, with a note', async () => {
    const saved = process.env.DBUS_SESSION_BUS_ADDRESS
    process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/arca-test-bus'
    try {
      const store = new Store(tempDir())
      const env = { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, ARCA_PASSPHRASE: PASSPHRASE }
      const io = fakeIO({ cwd: store.root, env })
      expect(chooseBackend(store, io)).toBe('os') // the guess
      const key = await loadMasterKey(store, io, { create: true })
      expect(key).toHaveLength(32)
      expect(io.err()).toContain('no working Secret Service keyring')
      expect(io.err()).toContain('Using a passphrase instead')
      expect(store.readGlobalConfig().keychain).toBe('passphrase')
      expect(existsSync(join(store.root, 'master.key.enc'))).toBe(true)

      const again = fakeIO({ cwd: store.root, env })
      expect(await loadMasterKey(store, again, { create: false })).toEqual(key)
      expect(again.err()).toBe('')
    } finally {
      if (saved === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS
      else process.env.DBUS_SESSION_BUS_ADDRESS = saved
    }
  })
})
