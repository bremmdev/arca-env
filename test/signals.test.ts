import { execFileSync, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { constants } from 'node:os'
import { beforeAll, describe, expect, it } from 'vitest'
import { PASSPHRASE, cleanEnv, harness, writeJson } from './helpers.js'

// Stopping `arca run` the ways it really gets stopped: a terminal closing, `kill`, an IDE's
// stop button, a process-tree kill. That needs arca as a real process, so this file builds
// the CLI first, into node_modules/.cache (dist/ is left alone).
//
// Not covered here: Ctrl+C in a real terminal (a TTY on Linux, a console on Windows). That's
// on the manual checklist (M1, M6 in .vault/10).

const SECRET = 'sk_test_signals_4f5e6d7c8b'
const root = join(import.meta.dirname, '..')

const CHILD = `const trap = process.argv[2] === 'trap'
if (trap) {
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(s, () => {
      console.log('child got ' + s)
      process.exit(3)
    })
  }
}
console.log('pid=' + process.pid + ' key=' + process.env.API_KEY)
setInterval(() => {}, 1000)
`

const h = harness()
let cli = ''

beforeAll(async () => {
  const { build } = await import('tsdown')
  const outDir = join(root, 'node_modules', '.cache', 'arca-signals-test')
  await build({ config: join(root, 'tsdown.config.ts'), outDir, dts: false, logLevel: 'silent' })
  cli = join(outDir, 'cli.mjs')

  writeJson(join(h.dir, 'arca.json'), { id: 'arc_signaltest', name: 'signal-test', vars: { API_KEY: { required: true } } })
  writeFileSync(join(h.dir, 'child.cjs'), CHILD)
  expect((await h.human(['set', 'API_KEY'], { stdin: SECRET })).code).toBe(0)
}, 60_000)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function gone(pid: number, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (!alive(pid)) return true
  return !alive(pid)
}

/** `arca run -- node child.cjs <mode>`, masked, with stdin a pipe (no terminal). */
async function start(mode: 'trap' | 'plain') {
  const arca = spawn(process.execPath, [cli, 'run', '--', process.execPath, 'child.cjs', mode], {
    cwd: h.dir,
    env: cleanEnv({ ARCA_HOME: h.store, ARCA_PASSPHRASE: PASSPHRASE, NO_COLOR: '1' }),
    stdio: 'pipe',
  })
  let out = ''
  arca.stdout.on('data', (d: Buffer) => (out += d.toString()))
  arca.stderr.on('data', (d: Buffer) => (out += d.toString()))
  const exit = new Promise<number | null>((resolve) => arca.on('close', (code) => resolve(code)))
  for (const end = Date.now() + 10_000; !/pid=\d+/.test(out); await sleep(20)) {
    if (Date.now() > end || arca.exitCode !== null) throw new Error(`the child never started:\n${out}`)
  }
  const childPid = Number(/pid=(\d+)/.exec(out)![1])
  return { arca, childPid, exit, out: () => out }
}

describe.runIf(process.platform === 'linux')('signals reach the child (Linux)', () => {
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    it(`${sig} reaches the child; arca exits with its code and keeps its last output, masked`, async () => {
      const run = await start('trap')
      run.arca.kill(sig)
      expect(await run.exit).toBe(3)
      expect(run.out()).toContain(`child got ${sig}`)
      expect(run.out()).toContain('key=[arca:API_KEY]')
      expect(run.out()).not.toContain(SECRET)
      expect(await gone(run.childPid)).toBe(true)
    })

    it(`a child that doesn't handle ${sig} is stopped; arca exits 128 + signal`, async () => {
      const run = await start('plain')
      run.arca.kill(sig)
      expect(await run.exit).toBe(128 + constants.signals[sig])
      expect(await gone(run.childPid)).toBe(true)
    })
  }
})

describe.runIf(process.platform === 'win32')('stopping arca stops the child (Windows)', () => {
  it('killing only arca ends the child too (libuv puts children in a kill-on-close job)', async () => {
    const run = await start('plain')
    run.arca.kill()
    await run.exit
    expect(await gone(run.childPid)).toBe(true)
  })

  it('a process-tree kill (taskkill /T, what IDEs and agent tools use) ends both', async () => {
    const run = await start('plain')
    execFileSync('taskkill', ['/T', '/F', '/PID', String(run.arca.pid)], { stdio: 'ignore' })
    await run.exit
    expect(await gone(run.childPid)).toBe(true)
    expect(await gone(run.arca.pid!)).toBe(true)
  })
})
