import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Redactor, needlesFor } from '../src/redact.js'
import { loadSecrets } from '../src/register.js'
import { addToNodeOptions, isJestMain, maskDeep, maskJsonStringify, maskProcess, maskWorkerMessages, maskWrites } from '../src/register-mask.js'
import { PASSPHRASE, cleanEnv, fakeIO, harness, tempDir, writeJson, type Harness } from './helpers.js'

const KEY = 'sk_test_register_4f8a2c9e'
const DB_DEV = 'postgres://app:dev-pass-111@localhost:5432/acme'
const DB_ACC = 'postgres://app:acc-pass-222@db-acc.example.com:5432/acme'
const ID = 'arc_register22222222'

async function project(): Promise<Harness> {
  const h = harness()
  writeJson(join(h.dir, 'arca.json'), {
    id: ID,
    name: 'acme-web',
    defaultProfile: 'dev',
    profiles: { dev: {}, acc: { extends: 'dev' } },
    envFiles: ['.env.arca'],
    vars: { API_KEY: { required: true }, DATABASE_URL: { required: true }, PORT: { sensitive: false } },
  })
  writeFileSync(join(h.dir, '.env.arca'), 'PORT=3000\n')
  expect((await h.human(['set', 'API_KEY'], { stdin: `${KEY}\n` })).code).toBe(0)
  expect((await h.human(['set', 'DATABASE_URL'], { stdin: `${DB_DEV}\n` })).code).toBe(0)
  expect((await h.human(['set', 'DATABASE_URL', '-p', 'acc'], { stdin: `${DB_ACC}\n` })).code).toBe(0)
  return h
}

/** A process that loads the register: an IDE test run or a debugger (no marker, no terminal). */
function proc(h: Harness, env: NodeJS.ProcessEnv = {}, cwd = h.dir) {
  // These tests run in a vitest worker themselves.
  const base = cleanEnv({ ARCA_HOME: h.store, ARCA_PASSPHRASE: PASSPHRASE, ...env })
  delete base.VITEST_WORKER_ID
  delete base.VITEST_POOL_ID
  return fakeIO({ cwd, env: { ...base, ...env } })
}

describe('register: loading', () => {
  it('loads the active profile into the env and masks every profile', async () => {
    const h = await project()
    const io = proc(h)
    const r = await loadSecrets(io)
    expect(r.kind).toBe('loaded')
    expect(io.env.API_KEY).toBe(KEY)
    expect(io.env.DATABASE_URL).toBe(DB_DEV)
    expect(io.env.PORT).toBe('3000') // envFiles, like `arca run`
    expect(io.env).toMatchObject({ ARCA_ACTIVE: ID, ARCA_PROFILE: 'dev', ARCA_PROJECT: 'acme-web', ARCA_MASK: 'API_KEY,DATABASE_URL' })
    expect(io.env.ARCA_PASSPHRASE).toBeUndefined()
    if (r.kind !== 'loaded') return
    expect(r.secrets.map((s) => s.name).sort()).toEqual(['API_KEY', 'DATABASE_URL', 'DATABASE_URL@acc'])
    expect(io.all()).not.toContain(KEY)
  })

  it('picks the profile like `arca run`, with the banner', async () => {
    const h = await project()
    const io = proc(h, { ARCA_PROFILE: 'acc' })
    expect((await loadSecrets(io)).kind).toBe('loaded')
    expect(io.env.DATABASE_URL).toBe(DB_ACC)
    expect(io.env.API_KEY).toBe(KEY) // inherited through extends
    expect(io.err()).toContain('arca ▸ profile acc (via ARCA_PROFILE)')
  })

  it('vault wins over the inherited env, with a notice; envFiles never do', async () => {
    const h = await project()
    const io = proc(h, { API_KEY: 'from-the-shell', PORT: '4000' })
    await loadSecrets(io)
    expect(io.env.API_KEY).toBe(KEY)
    expect(io.env.PORT).toBe('4000')
    expect(io.err()).toContain('API_KEY from arca overrides a different value')
  })

  it('warns about missing required values but still loads', async () => {
    const h = await project()
    await h.human(['unset', 'API_KEY'])
    const io = proc(h)
    expect((await loadSecrets(io)).kind).toBe('loaded')
    expect(io.env.DATABASE_URL).toBe(DB_DEV)
    expect(io.err()).toContain('API_KEY')
    expect(io.err()).toContain('npx arca setup')
  })

  it('finds arca.json from the script folder when the working folder has none', async () => {
    const h = await project()
    const io = proc(h, {}, tempDir())
    expect((await loadSecrets(io)).kind).toBe('skipped')
    expect(io.env.API_KEY).toBeUndefined()
    expect(io.all()).toBe('') // silent: NODE_OPTIONS may load it in every Node process
    const sub = join(h.dir, 'scripts')
    mkdirSync(sub)
    const io2 = proc(h, {}, tempDir())
    expect((await loadSecrets(io2, sub)).kind).toBe('loaded')
    expect(io2.env.API_KEY).toBe(KEY)
  })

  it('loads nothing for an AI agent, and its child processes stay quiet', async () => {
    const h = await project()
    const io = proc(h, { CLAUDECODE: '1' })
    expect(await loadSecrets(io)).toEqual({ kind: 'skipped', reason: 'agent' })
    expect(io.env.API_KEY).toBeUndefined()
    expect(io.env.ARCA_ACTIVE).toBeUndefined()
    expect(io.err()).toContain("secrets aren't loaded into commands AI agents start themselves")
    expect(io.err()).toContain('"test": "arca run -- vitest"')
    const child = fakeIO({ cwd: h.dir, env: { ...io.env } })
    expect(await loadSecrets(child)).toEqual({ kind: 'skipped', reason: 'off' })
    expect(child.all()).toBe('')
  })

  it('loads nothing in a test worker (setupFiles), and says to load it in the config', async () => {
    const h = await project()
    for (const marker of ['VITEST_WORKER_ID', 'JEST_WORKER_ID']) {
      const io = proc(h, { [marker]: '1' })
      expect(await loadSecrets(io)).toEqual({ kind: 'skipped', reason: 'worker' })
      expect(io.env.API_KEY).toBeUndefined()
      expect(io.err()).toContain("import '@bremmdev/arca-env/register'")
      expect(io.err()).toContain("require('@bremmdev/arca-env/register')")
    }
    // Loaded by the config, the workers inherit the values and only mask.
    const parent = proc(h)
    await loadSecrets(parent)
    expect((await loadSecrets(fakeIO({ cwd: h.dir, env: { ...parent.env, VITEST_WORKER_ID: '1' } }))).kind).toBe('nested')
  })

  it('only masks inside `arca run` or under a process that loaded the values', async () => {
    const h = await project()
    const parent = proc(h)
    await loadSecrets(parent)
    const child = fakeIO({ cwd: h.dir, env: { ...parent.env } })
    const r = await loadSecrets(child)
    expect(r).toEqual({ kind: 'nested', secrets: [{ name: 'API_KEY', value: KEY }, { name: 'DATABASE_URL', value: DB_DEV }] })
    expect(child.all()).toBe('')
  })

  it('runs without secrets when the store cannot be unlocked, and says why', async () => {
    const h = await project()
    const io = proc(h, { ARCA_PASSPHRASE: undefined })
    expect(await loadSecrets(io)).toEqual({ kind: 'skipped', reason: 'error' })
    expect(io.env.API_KEY).toBeUndefined()
    expect(io.err()).toContain('this store uses a passphrase')
    expect(io.err()).toContain('running without secrets')
  })

  it('says so when nothing is stored yet', async () => {
    const h = harness()
    writeJson(join(h.dir, 'arca.json'), { id: ID, name: 'acme-web', vars: { API_KEY: {} } })
    const io = proc(h)
    expect(await loadSecrets(io)).toEqual({ kind: 'skipped', reason: 'no-vault' })
    expect(io.err()).toContain('no secrets stored for acme-web')
  })
})

describe('register: masking', () => {
  const redactor = () => new Redactor(needlesFor({ name: 'API_KEY', value: KEY }))
  const sink = () => {
    const calls: unknown[][] = []
    return { calls, stream: { write: (...a: unknown[]) => (calls.push(a), true) } }
  }

  it('masks strings and buffers, and passes encoding and callback through', () => {
    const { calls, stream } = sink()
    maskWrites(stream, redactor())
    const cb = () => {}
    stream.write(`key=${KEY}\n`, cb)
    stream.write(Buffer.from(`buf=${KEY}`), 'utf8', cb)
    stream.write(Buffer.from('plain'))
    stream.write('6869', 'hex') // not text: left alone
    expect(calls[0]).toEqual(['key=[arca:API_KEY]\n', cb])
    expect(calls[1]).toEqual(['buf=[arca:API_KEY]', 'utf8', cb])
    expect(Buffer.isBuffer(calls[2]![0])).toBe(true) // nothing to mask: the original buffer
    expect(calls[3]).toEqual(['6869', 'hex'])
  })

  it('patches a stream once', () => {
    const { calls, stream } = sink()
    expect(maskWrites(stream, redactor())).toBe(true)
    expect(maskWrites(stream, redactor())).toBe(false)
    stream.write(KEY)
    expect(calls).toEqual([['[arca:API_KEY]']])
  })

  it('masks stdout, stderr and console arguments of the process', () => {
    const out = sink()
    const err = sink()
    const logged: unknown[][] = []
    const host = { process: { stdout: out.stream, stderr: err.stream }, console: { log: (...a: unknown[]) => logged.push(a) } as unknown as Console }
    maskProcess([{ name: 'API_KEY', value: KEY }], host)
    host.process.stdout.write(KEY)
    host.process.stderr.write(KEY)
    host.console.log({ key: KEY })
    expect(JSON.stringify([out.calls, err.calls, logged])).not.toContain(KEY)
    expect(logged[0]![0]).toContain('[arca:API_KEY]')
  })

  it('adds itself to NODE_OPTIONS as a quoted --require once, after what was there', () => {
    const env: NodeJS.ProcessEnv = { NODE_OPTIONS: '--max-old-space-size=4096' }
    addToNodeOptions(env, String.raw`C:\Program Files\app\register.cjs`)
    addToNodeOptions(env, String.raw`C:\Program Files\app\register.cjs`)
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096 --require="C:/Program Files/app/register.cjs"')
  })
})

describe('register: what test workers send to their runner', () => {
  const redactor = () => new Redactor(needlesFor({ name: 'API_KEY', value: KEY }))

  it('masks every string in a message, and leaves messages without a secret untouched', () => {
    const port = { kind: 'opaque' }
    const buf = Buffer.from(KEY)
    const error = Object.assign(new Error(`bad key ${KEY}`), { actual: KEY, expected: 'wrong' })
    const msg = { type: 'onTaskUpdate', packs: [[1, { state: 'fail', errors: [{ message: `expected '${KEY}' to be 'wrong'`, actual: KEY }] }]], error, buf, map: new Map([['k', KEY]]), port }
    ;(msg as Record<string, unknown>).self = msg
    const out = maskDeep(msg, redactor())
    expect(out).not.toBe(msg)
    expect(JSON.stringify(out.packs)).not.toContain(KEY)
    expect(out.packs[0]![1]).toMatchObject({ errors: [{ message: "expected '[arca:API_KEY]' to be 'wrong'", actual: '[arca:API_KEY]' }] })
    expect(out.error).toBeInstanceOf(Error)
    expect(out.error.message).toBe('bad key [arca:API_KEY]')
    expect(out.error.stack).not.toContain(KEY)
    expect((out.error as unknown as { actual: string }).actual).toBe('[arca:API_KEY]')
    expect(out.map.get('k')).toBe('[arca:API_KEY]')
    expect(out.buf).toBe(buf) // binary data passes as it is
    expect((out as Record<string, unknown>).self).toBe(out) // cycles survive
    expect(JSON.stringify(msg.packs)).toContain(KEY) // the original isn't changed
    const clean = { type: 'ready', n: 1 }
    expect(maskDeep(clean, redactor())).toBe(clean)
  })

  it('masks process.send only while the process is a test worker', () => {
    const sent: unknown[] = []
    const env: NodeJS.ProcessEnv = {}
    const proc = { send: (m: unknown) => (sent.push(m), true) } as unknown as NodeJS.Process
    maskWorkerMessages(redactor(), env, proc)
    proc.send!({ log: KEY })
    env.VITEST_WORKER_ID = '1' // runners set it after the preload ran
    proc.send!({ log: KEY })
    env.VITEST_WORKER_ID = undefined
    env.TEST_WORKER_INDEX = '0' // Playwright
    proc.send!({ log: KEY })
    expect(sent).toEqual([{ log: KEY }, { log: '[arca:API_KEY]' }, { log: '[arca:API_KEY]' }])
  })

  it("masks JSON.stringify output in Jest's main process", () => {
    expect(isJestMain(['node', String.raw`C:\app\node_modules\jest\bin\jest.js`])).toBe(true)
    expect(isJestMain(['node', '/app/node_modules/.bin/jest'])).toBe(true)
    expect(isJestMain(['node', '/app/node_modules/vitest/vitest.mjs'])).toBe(false)
    expect(isJestMain(['node', '/app/server.js'])).toBe(false)
    const json = { stringify: JSON.stringify, parse: JSON.parse } as unknown as JSON
    maskJsonStringify(redactor(), json)
    expect(json.stringify({ failureMessages: [`Received: "${KEY}"`] })).not.toContain(KEY)
    expect(json.stringify(undefined)).toBeUndefined()
  })
})
