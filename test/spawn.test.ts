import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { harness, tempDir, writeJson } from './helpers.js'

// Child processes the way real projects start them: `arca run -- next dev` inside an npm
// script finds `next` in node_modules/.bin. There npm puts its own shims: a `.cmd` file on
// Windows (run through cmd.exe, where quoting and `%` are the classic traps), a symlink on
// Linux. A tiny local package with a bin, installed by real npm, gives the same setup.

const SECRET = 'sk_test_spawn_9f8e7d6c5b4a'
const UNICODE_SECRET = 'pässwörd-🙂-geheim-漢字-1234'

const TOOL = `#!/usr/bin/env node
const [mode, ...rest] = process.argv.slice(2)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  if (mode === 'args') console.log(JSON.stringify(rest))
  else if (mode === 'secret') console.log('key=' + process.env.API_KEY)
  else if (mode === 'exit') process.exitCode = Number(rest[0])
  else if (mode === 'drip') {
    // One byte per write, with pauses, so every byte arrives in its own chunk.
    for (const byte of Buffer.from('drip=' + process.env[rest[0]] + '\\n')) {
      process.stdout.write(Buffer.from([byte]))
      await wait(3)
    }
  } else if (mode === 'big') {
    const s = process.env.API_KEY
    process.stdout.write('x'.repeat(512 * 1024) + s + 'y'.repeat(512 * 1024) + s)
  }
}
main()
`

/** npm's own entry point, so it runs without a shell on every OS. */
function npmCli(): string {
  const candidates = [
    process.env.npm_execpath ?? '',
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const found = candidates.find((c) => /npm-cli\.c?js$/.test(c) && existsSync(c))
  if (!found) throw new Error(`npm-cli.js not found near ${process.execPath}`)
  return found
}

/** PATH with the project's node_modules/.bin first, under the key this OS uses (`Path` on Windows). */
function pathWithBin(dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { [key]: join(dir, 'node_modules', '.bin') + delimiter + (process.env[key] ?? '') }
}

describe('commands from node_modules/.bin, through the real npm shim', () => {
  const h = harness(tempDir('arca spawn '))
  const env = pathWithBin(h.dir)
  const run = (args: string[]) => h.human(['run', '--', 'echo-tool', ...args], { env })

  beforeAll(async () => {
    mkdirSync(join(h.dir, 'tool'))
    writeJson(join(h.dir, 'tool', 'package.json'), { name: 'echo-tool', version: '1.0.0', bin: { 'echo-tool': 'cli.js' } })
    writeFileSync(join(h.dir, 'tool', 'cli.js'), TOOL)
    writeJson(join(h.dir, 'package.json'), { name: 'spawn-test', private: true })
    writeJson(join(h.dir, 'arca.json'), { id: 'arc_spawntest', name: 'spawn-test', vars: { API_KEY: { required: true }, UNICODE_KEY: {} } })
    const npm = spawnSync(process.execPath, [npmCli(), 'install', '--no-audit', '--no-fund', '--offline', './tool'], { cwd: h.dir, encoding: 'utf8' })
    if (npm.status !== 0) throw new Error(`npm install failed:\n${npm.stdout}${npm.stderr}`)
    expect(existsSync(join(h.dir, 'node_modules', '.bin', process.platform === 'win32' ? 'echo-tool.cmd' : 'echo-tool'))).toBe(true)
    expect((await h.human(['set', 'API_KEY'], { stdin: SECRET })).code).toBe(0)
    expect((await h.human(['set', 'UNICODE_KEY'], { stdin: UNICODE_SECRET })).code).toBe(0)
  }, 60_000)

  it('arguments arrive unchanged: spaces, quotes, cmd.exe metacharacters, %VAR%, unicode', async () => {
    const args = [
      'plain',
      'with space',
      '  leading and trailing  ',
      'double"quote',
      "single'quote",
      'amp&ersand',
      'pipe|bar',
      'angle<in>out',
      'caret^',
      'bang!',
      'paren(x)',
      'semi;colon',
      'comma,',
      'glob*?',
      'percent%PATH%',
      '%',
      'back\\slash',
      'trailing\\',
      'unicode-é-漢字-🙂',
      '--flag=a b',
      '',
    ]
    const { code, io } = await run(['args', ...args])
    expect(code).toBe(0)
    const line = io.out().split('\n').find((l) => l.startsWith('['))
    expect(line, io.all()).toBeDefined()
    expect(JSON.parse(line!)).toEqual(args)
  })

  it('the secret is injected and masked', async () => {
    const { code, io } = await run(['secret'])
    expect(code).toBe(0)
    expect(io.out()).toContain('key=[arca:API_KEY]')
    expect(io.all()).not.toContain(SECRET)
  })

  it('exit codes pass through the shim', async () => {
    expect((await run(['exit', '7'])).code).toBe(7)
    expect((await run(['exit', '0'])).code).toBe(0)
  })

  it('a missing command exits 127 with a clear message', async () => {
    const { code, io } = await h.human(['run', '--', 'no-such-tool-arca-test'], { env })
    expect(code).toBe(127)
    expect(io.err()).toContain('command not found: no-such-tool-arca-test')
  })

  it('a secret written one byte at a time is still masked', async () => {
    const { io } = await run(['drip', 'API_KEY'])
    expect(io.out()).toContain('drip=[arca:API_KEY]')
    expect(io.all()).not.toContain(SECRET)
  })

  it('a multi-byte value split across chunks is decoded and masked', async () => {
    const { io } = await run(['drip', 'UNICODE_KEY'])
    expect(io.out()).toContain('drip=[arca:UNICODE_KEY]')
    expect(io.all()).not.toContain(UNICODE_SECRET)
    expect(io.all()).not.toContain('�') // no broken characters
  })

  it('secrets inside a 1 MB line without a newline are masked', async () => {
    const { code, io } = await run(['big'])
    expect(code).toBe(0)
    expect(io.out()).not.toContain(SECRET)
    expect(io.out().split('[arca:API_KEY]')).toHaveLength(3)
    expect(io.out().length).toBe(1024 * 1024 + 2 * '[arca:API_KEY]'.length)
  })
})
