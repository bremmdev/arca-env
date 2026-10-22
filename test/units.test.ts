import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv as nodeParseEnv } from 'node:util'
import { describe, expect, it } from 'vitest'
import { parseProject } from '../src/config.js'
import { arcaRunCommands, detectAgent, verifyScript } from '../src/context.js'
import { newMasterKey, open, seal, unwrapMasterKey, vaultKey, wrapMasterKey } from '../src/crypto.js'
import { parseEnv, removeEntries } from '../src/envfiles.js'
import { scanEnvFiles, secretReason } from '../src/leakguard.js'
import { decideRun, humanGate } from '../src/policy.js'
import { Store } from '../src/store.js'
import { cleanEnv, fakeIO, tempDir } from './helpers.js'
import type { Context } from '../src/context.js'

describe('crypto', () => {
  it('round-trips and binds to the project and profile', () => {
    const master = newMasterKey()
    const key = vaultKey(master, 'arc_aaaaaaaaaaaaaaaa', 'default')
    const sealed = seal(key, 'hello', 'arca-vault:v1:arc_aaaaaaaaaaaaaaaa:default')
    expect(open(key, sealed, 'arca-vault:v1:arc_aaaaaaaaaaaaaaaa:default')).toBe('hello')
    expect(() => open(key, sealed, 'arca-vault:v1:arc_bbbbbbbbbbbbbbbb:default')).toThrow(/could not decrypt/)
    const other = vaultKey(master, 'arc_bbbbbbbbbbbbbbbb', 'default')
    expect(other.equals(key)).toBe(false)
  })

  it('wraps the master key with a passphrase', () => {
    const master = newMasterKey()
    const wrapped = wrapMasterKey(master, 'correct horse', { N: 1024, r: 8, p: 1 })
    expect(unwrapMasterKey(wrapped, 'correct horse').equals(master)).toBe(true)
    expect(() => unwrapMasterKey(wrapped, 'wrong')).toThrow(/wrong passphrase/)
  })

  it('stores vaults that the store cannot read with another key', () => {
    const store = new Store(tempDir())
    const master = newMasterKey()
    store.writeVault(master, 'arc_aaaaaaaaaaaaaaaa', 'default', { vars: { A: { value: 'x', updatedAt: '', source: 'set', previous: null } }, removed: {}, meta: { createdAt: '' } })
    expect(store.readVault(master, 'arc_aaaaaaaaaaaaaaaa', 'default').vars.A?.value).toBe('x')
    expect(() => store.readVault(newMasterKey(), 'arc_aaaaaaaaaaaaaaaa', 'default')).toThrow(/could not decrypt/)
    const raw = readFileSync(store.vaultFile('arc_aaaaaaaaaaaaaaaa', 'default'), 'utf8')
    expect(raw).not.toContain('"x"')
  })
})

describe('.env parsing', () => {
  const sample = [
    '# comment',
    'PLAIN=value',
    'export EXPORTED=yes',
    'SPACED = spaced value  ',
    'INLINE=abc # trailing comment',
    'HASH=abc#def',
    'QUOTED_HASH="abc#def"',
    "SINGLE='single # not a comment'",
    'DOUBLE="line1\\nline2"',
    'MULTI="first',
    'second"',
    'EMPTY=',
    'URL=postgres://u:p@h:5432/db?ssl=true',
    '',
  ].join('\n')

  it('matches node:util parseEnv on common syntax', () => {
    expect(parseEnv(sample)).toEqual(nodeParseEnv(sample))
  })

  it('removes only the given entries and keeps comments', () => {
    const dir = tempDir()
    const file = join(dir, '.env.local')
    writeFileSync(file, '# keep me\r\nSECRET=abc\r\nPORT=3000\r\nMULTI="a\r\nb"\r\n')
    expect(removeEntries(file, new Set(['SECRET', 'MULTI']))).toBe('edited')
    expect(readFileSync(file, 'utf8')).toBe('# keep me\r\nPORT=3000\r\n')
    expect(removeEntries(file, new Set(['PORT']))).toBe('edited')
    writeFileSync(file, 'ONLY=1\n')
    expect(removeEntries(file, new Set(['ONLY']))).toBe('deleted')
    expect(existsSync(file)).toBe(false)
  })
})

describe('agent detection', () => {
  it('reads markers and the AI_AGENT convention', () => {
    expect(detectAgent({ CLAUDECODE: '1' })).toEqual({ detected: true, name: 'claude-code', via: 'CLAUDECODE' })
    expect(detectAgent({ AI_AGENT: 'claude-code_2-1-306_agent' })).toMatchObject({ detected: true, name: 'claude-code', via: 'AI_AGENT' })
    expect(detectAgent({ CODEX_SANDBOX: 'seatbelt' })).toMatchObject({ name: 'codex' })
    expect(detectAgent({ AI_AGENT: '0' })).toEqual({ detected: false })
    expect(detectAgent({})).toEqual({ detected: false })
    expect(detectAgent({ MY_TOOL: '1' }, ['MY_TOOL'])).toMatchObject({ detected: true, via: 'MY_TOOL' })
  })
})

describe('script verification', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'arca run -- next dev', test: 'npx arca run --only A -- vitest run', both: 'tsc && arca run -- node server.js', plain: 'next dev' } }))
  const io = (event: string, script: string) => fakeIO({ cwd: dir, env: { npm_lifecycle_event: event, npm_lifecycle_script: script } })

  it('parses the command out of a script', () => {
    expect(arcaRunCommands('arca run -- next dev')).toEqual([['next', 'dev']])
    expect(arcaRunCommands('npx arca run --only A,B -- vitest run')).toEqual([['vitest', 'run']])
    expect(arcaRunCommands('tsc && arca run node server.js')).toEqual([['node', 'server.js']])
    expect(arcaRunCommands('next dev')).toEqual([])
  })

  it('accepts the declared script, with extra args', () => {
    expect(verifyScript(io('dev', 'arca run -- next dev'), ['next', 'dev'])).toMatchObject({ verified: true })
    expect(verifyScript(io('dev', 'arca run -- next dev'), ['next', 'dev', '--port', '3001'])).toMatchObject({ verified: true })
    expect(verifyScript(io('test', 'npx arca run --only A -- vitest run'), ['vitest', 'run'])).toMatchObject({ verified: true })
    expect(verifyScript(io('both', 'tsc && arca run -- node server.js'), ['node', 'server.js'])).toMatchObject({ verified: true })
  })

  it('rejects mismatches', () => {
    expect(verifyScript(fakeIO({ cwd: dir, env: {} }), ['printenv'])).toEqual({ kind: 'adhoc' })
    // What npx / npm exec set (seen in validation): treated as ad-hoc, not as a script.
    expect(verifyScript(io('npx', 'arca run -- node -e x'), ['node', '-e', 'x'])).toEqual({ kind: 'adhoc' })
    expect(verifyScript(io('dev', 'arca run -- printenv'), ['printenv'])).toMatchObject({ verified: false })
    expect(verifyScript(io('dev', 'arca run -- next dev'), ['node', '-e', 'x'])).toMatchObject({ verified: false })
    expect(verifyScript(io('plain', 'next dev'), ['next', 'dev'])).toMatchObject({ verified: false })
    expect(verifyScript(io('nope', 'arca run -- x'), ['x'])).toEqual({ kind: 'adhoc' })
  })
})

describe('policy', () => {
  const ctx = (o: Partial<Context>): Context => ({ agent: { detected: false }, interactiveOutput: false, stdinIsTTY: false, ci: false, activeProject: null, ...o })
  const agent = { detected: true, name: 'claude-code', via: 'CLAUDECODE' }
  const script = { kind: 'script' as const, name: 'dev', verified: true }
  const adhoc = { kind: 'adhoc' as const }

  it.each([
    ['human, ad-hoc', ctx({ interactiveOutput: true, stdinIsTTY: true }), adhoc, 'scripts', true],
    ['ide task, ad-hoc', ctx({}), adhoc, 'scripts', true],
    ['agent, verified script', ctx({ agent }), script, 'scripts', true],
    ['agent, ad-hoc', ctx({ agent }), adhoc, 'scripts', false],
    ['agent, unverified script', ctx({ agent }), { ...script, verified: false }, 'scripts', false],
    ['agent, script, deny policy', ctx({ agent }), script, 'deny', false],
  ] as const)('run: %s', (_, c, inv, policy, allow) => {
    expect(decideRun(c, inv, policy, 'cmd').allow).toBe(allow)
  })

  it('human gate', async () => {
    const io = fakeIO({ cwd: tempDir(), env: {} })
    await expect(humanGate(io, ctx({ interactiveOutput: true, stdinIsTTY: true }), { kind: 'write', command: 'x' })).resolves.toBeUndefined()
    await expect(humanGate(io, ctx({}), { kind: 'write', command: 'arca set X' })).rejects.toThrow(/interactive terminal/)
    await expect(humanGate(io, ctx({ agent }), { kind: 'write', command: 'arca set X' })).rejects.toThrow(/only a human/)
    await expect(humanGate(io, ctx({ agent }), { kind: 'reveal', command: 'x' })).rejects.toThrow(/cannot be shown to AI agents/)
    await expect(humanGate(io, ctx({ interactiveOutput: true }), { kind: 'write', command: 'x', allowPipedStdin: true })).resolves.toBeUndefined()
    // Agent marker in a real terminal: the typed challenge decides.
    const wrong = fakeIO({ cwd: tempDir(), env: {}, answers: { text: ['NOPE'] } })
    await expect(humanGate(wrong, ctx({ agent, interactiveOutput: true, stdinIsTTY: true }), { kind: 'write', command: 'x' })).rejects.toThrow(/did not match/)
  })
})

describe('leak guard', () => {
  it('flags stored values, declared secrets and secret-looking values', () => {
    const dir = tempDir()
    const project = parseProject(JSON.stringify({ id: 'arc_aaaaaaaaaaaaaaaa', vars: { DECLARED: {}, PUBLIC_THING: { sensitive: false } }, leakGuard: { ignore: ['IGNORED_TOKEN'] } }), join(dir, 'arca.json'))
    mkdirSync(dir, { recursive: true })
    const files = [
      {
        path: join(dir, '.env'),
        name: '.env',
        entries: [
          { key: 'COPY', value: 'sk_test_storedvalue123', startLine: 0, endLine: 0 },
          { key: 'DECLARED', value: 'whatever', startLine: 1, endLine: 1 },
          { key: 'GITHUB_TOKEN', value: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', startLine: 2, endLine: 2 },
          { key: 'PORT', value: '3000', startLine: 3, endLine: 3 },
          { key: 'PUBLIC_THING', value: 'abc', startLine: 4, endLine: 4 },
          { key: 'IGNORED_TOKEN', value: 'zzzzzzzzzzzzzzzz', startLine: 5, endLine: 5 },
          { key: 'NEXTAUTH_URL', value: 'http://localhost:3000', startLine: 6, endLine: 6 },
        ],
      },
    ]
    const findings = scanEnvFiles(project, files, [{ name: 'STRIPE_KEY', value: 'sk_test_storedvalue123' }])
    expect(findings.map((f) => [f.key, f.rule])).toEqual([
      ['COPY', 'stored'],
      ['DECLARED', 'declared'],
      ['GITHUB_TOKEN', 'heuristic'],
    ])
  })

  it('heuristics', () => {
    expect(secretReason('DATABASE_URL', 'postgres://u:pw@localhost/db')).toMatch(/password/)
    expect(secretReason('ANYTHING', 'sk_live_123')).toMatch(/known/)
    expect(secretReason('AUTH_SECRET', 'some-long-local-secret')).toMatch(/name/)
    expect(secretReason('NEXT_PUBLIC_API_KEY', 'pk')).toBeNull()
    expect(secretReason('PORT', '3000')).toBeNull()
    expect(secretReason('API_URL', 'https://api.example.com/v1')).toBeNull()
    expect(secretReason('DEBUG', 'true')).toBeNull()
  })
})

describe('arca.json', () => {
  it('rejects values and bad IDs', () => {
    expect(() => parseProject('{"id":"nope"}', 'arca.json')).toThrow(/"id"/)
    expect(() => parseProject('{"id":"arc_aaaaaaaaaaaaaaaa","vars":{"A":{"default":"x"}}}', 'arca.json')).toThrow(/names only/)
    const p = parseProject('{"id":"arc_aaaaaaaaaaaaaaaa","profiles":{}}', 'x/arca.json')
    expect(p.warnings[0]).toMatch(/profiles/)
  })
})

void cleanEnv

describe('init: why scripts stay unwrapped', async () => {
  const { skipReason } = await import('../src/commands/init.js')
  // The scripts of a real TanStack Start project (after `arca init`).
  const scripts: Record<string, string> = {
    dev: 'arca run -- vite dev --port 3000',
    'generate-routes': 'tsr generate',
    format: 'biome format --write',
    check: 'npm run check:macrons && npm run check:lemmas && biome check',
    start: 'node .output/server/index.mjs',
    'check:macrons': 'arca run -- tsx scripts/check-macrons.ts',
    'check:lemmas': 'arca run -- tsx scripts/check-lemmas.ts',
    mixed: 'tsc && node server.js',
  }
  const wrapped = new Set(Object.keys(scripts).filter((k) => scripts[k]!.includes('arca run')))
  it.each([
    ['generate-routes', "tsr doesn't need secrets"],
    ['format', "biome doesn't need secrets"],
    ['check', 'the ones that need secrets are wrapped themselves'],
    ['start', 'production start, left alone on purpose'],
    ['mixed', 'compound command, wrap the part that needs secrets by hand'],
  ])('%s', (name, reason) => {
    expect(skipReason(name, scripts[name]!, scripts, wrapped)).toContain(reason)
  })
})

describe('init: AGENTS.md section updates', () => {
  it('replaces an outdated arca section and keeps what comes after it', async () => {
    const { mkdtempSync, writeFileSync: write, readFileSync: read } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join: j } = await import('node:path')
    const { harness } = await import('./helpers.js')
    const dir = mkdtempSync(j(tmpdir(), 'arca-agents-'))
    write(j(dir, 'arca.json'), JSON.stringify({ id: 'arc_agentsupdateaaaaa', name: 'x' }))
    const before = '# Agent instructions\n\n## Secrets (arca)\n\nOld text from an earlier arca.\n\n<!-- BEGIN:nextjs-agent-rules -->\nNext rules\n<!-- END:nextjs-agent-rules -->\n'
    write(j(dir, 'AGENTS.md'), before)
    const h = harness(dir)
    const { code, io } = await h.task(['init'])
    expect(code).toBe(0)
    const after = read(j(dir, 'AGENTS.md'), 'utf8')
    expect(io.err()).toContain('Updated the "Secrets (arca)" section in AGENTS.md')
    expect(after).toContain("Don't work around arca")
    expect(after).not.toContain('Old text from an earlier arca.')
    expect(after).toMatch(/If arca blocks you, ask the user\.\n\n<!-- BEGIN:nextjs-agent-rules -->\nNext rules\n<!-- END:nextjs-agent-rules -->\n$/)
    expect(after.startsWith('# Agent instructions\n\n## Secrets (arca)')).toBe(true)
    // A second run leaves the current section alone.
    const again = await h.task(['init'])
    expect(again.io.err()).not.toContain('Updated the "Secrets (arca)" section')
  })
})
