import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { deleteOsKey, keychainAccount } from '../src/keychain.js'
import { Store } from '../src/store.js'
import { cleanEnv, fakeIO, harness, tempDir, writeJson, type Harness } from './helpers.js'

// The real OS keychain: Windows Credential Manager, or the Secret Service on Linux.
// Opt-in with ARCA_TEST_OS_KEYCHAIN=1 (CI sets it where a keychain is available).
// Every store is a temp ARCA_HOME, so its entry is `master-key/v1/<hash>`, never the
// user's real `master-key/v1`. Entries are deleted afterwards.

const enabled = process.env.ARCA_TEST_OS_KEYCHAIN === '1'

const stores: string[] = []

function ioFor(root: string) {
  return fakeIO({ cwd: root, env: cleanEnv({ ARCA_HOME: root }) })
}

/** A project whose store has no config yet, so the first `set` picks the backend itself. */
function project(): Harness {
  const store = tempDir('arca-store-')
  stores.push(store)
  const h = harness(tempDir(), store)
  writeJson(join(h.dir, 'arca.json'), { id: 'arc_keychaintest', name: 'keychain-test', vars: { API_KEY: { required: true } } })
  return h
}

async function valueSeen(h: Harness, expected: string) {
  const r = await h.human(['run', '--', 'node', '-e', `console.log('ok=' + (process.env.API_KEY === ${JSON.stringify(expected)}))`])
  return { code: r.code, out: r.io.out(), err: r.io.err() }
}

describe.runIf(enabled)('real OS keychain', () => {
  afterAll(async () => {
    for (const root of stores) await deleteOsKey(new Store(root), ioFor(root)).catch(() => {})
  })

  const a = project()
  const b = project()

  it('the first set creates the master key in the OS keychain, not a passphrase file', async () => {
    const set = await a.human(['set', 'API_KEY'], { stdin: 'value-from-store-a-1234' })
    expect(set.code).toBe(0)
    expect(JSON.parse(readFileSync(join(a.store, 'config.json'), 'utf8')).keychain).toBe('os')
    expect(existsSync(join(a.store, 'master.key.enc'))).toBe(false)
    expect(await valueSeen(a, 'value-from-store-a-1234')).toMatchObject({ code: 0, out: expect.stringContaining('ok=true') })
  })

  it('each store has its own keychain entry', async () => {
    const set = await b.human(['set', 'API_KEY'], { stdin: 'value-from-store-b-5678' })
    expect(set.code).toBe(0)
    expect(keychainAccount(new Store(a.store), ioFor(a.store))).not.toBe(keychainAccount(new Store(b.store), ioFor(b.store)))
    expect((await valueSeen(a, 'value-from-store-a-1234')).out).toContain('ok=true')
    expect((await valueSeen(b, 'value-from-store-b-5678')).out).toContain('ok=true')
  })

  it('doctor names the OS keychain and finds the key', async () => {
    const { io } = await a.task(['doctor'])
    expect(io.out()).toMatch(/Key storage: (Windows Credential Manager|Secret Service)/)
    expect(io.out()).toContain('Master key found')
  })

  it('a lost keychain entry is reported, never silently replaced', async () => {
    expect(await deleteOsKey(new Store(a.store), ioFor(a.store))).toBe(true)

    const run = await valueSeen(a, 'value-from-store-a-1234')
    expect(run.code).not.toBe(0)
    expect(run.err).toContain('no master key found')

    const set = await a.human(['set', 'API_KEY'], { stdin: 'a-new-value-0000' })
    expect(set.code).not.toBe(0)
    expect(set.io.err()).toContain('no master key found')
    // No new key was created over the old vaults.
    expect(await deleteOsKey(new Store(a.store), ioFor(a.store))).toBe(false)

    const { io } = await a.task(['doctor'])
    expect(io.out()).toContain('Master key missing, but vaults exist')

    // The other store is unaffected.
    expect((await valueSeen(b, 'value-from-store-b-5678')).out).toContain('ok=true')
  })
})

