import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { harness, tempDir, tempStore, writeJson, type Harness } from './helpers.js'

const DB = 'postgres://app:s3cr3t-pass@localhost:5432/acme'
const STRIPE = 'sk_test_51HxYzAbCdEf123456'

// A child process that proves which values it got, printing them (arca must mask them).
const PRINT = `
const e = process.env
console.log('stripe=' + e.STRIPE_SECRET_KEY)
console.error('db error: password authentication failed for ' + e.DATABASE_URL)
console.log('port=' + e.PORT + ' public=' + e.NEXT_PUBLIC_POSTHOG_KEY)
console.log('stripe-ok=' + (e.STRIPE_SECRET_KEY === ${JSON.stringify(STRIPE)}) + ' len=' + (e.STRIPE_SECRET_KEY || '').length)
console.log('active=' + e.ARCA_ACTIVE)
process.exitCode = Number(process.argv[2] || 0)
`

function makeProject(): Harness {
  const h = harness()
  writeJson(join(h.dir, 'package.json'), {
    name: '@acme/web',
    scripts: { dev: 'node print.js', build: 'next build', start: 'next start', lint: 'eslint .' },
    devDependencies: { next: '^16.0.0' },
  })
  writeFileSync(join(h.dir, 'print.js'), PRINT)
  writeFileSync(
    join(h.dir, '.env.local'),
    ['# local overrides', `DATABASE_URL=${DB}`, `STRIPE_SECRET_KEY=${STRIPE}`, 'PORT=3000', 'NEXT_PUBLIC_POSTHOG_KEY=phc_publickey123', ''].join('\n'),
  )
  return h
}

describe('migrating a project with a mixed .env.local', () => {
  const h = makeProject()

  it('init sorts secrets from config, imports secrets, leaves files alone, wraps scripts', async () => {
    const { code, io } = await h.human(['init'], {
      answers: {
        text: ['acme-web'],
        multiselect: [['DATABASE_URL', 'STRIPE_SECRET_KEY'], ['dev']],
        confirm: [true, true], // start:local, AGENTS.md
      },
    })
    expect(io.err()).toContain('Detected Next.js 16.0.0')
    expect(code).toBe(0)
    const cfg = JSON.parse(readFileSync(join(h.dir, 'arca.json'), 'utf8'))
    expect(cfg.id).toMatch(/^arc_/)
    expect(cfg.vars).toEqual({
      DATABASE_URL: { required: true },
      STRIPE_SECRET_KEY: { required: true },
      PORT: { sensitive: false },
      NEXT_PUBLIC_POSTHOG_KEY: { sensitive: false },
    })
    expect(io.err()).toContain('Imported 2 secrets')
    expect(readFileSync(join(h.dir, '.env.local'), 'utf8')).toContain(STRIPE) // untouched
    const pkg = JSON.parse(readFileSync(join(h.dir, 'package.json'), 'utf8'))
    expect(pkg.scripts.dev).toBe('arca run -- node print.js')
    expect(pkg.scripts.start).toBe('next start') // production start stays unwrapped
    expect(pkg.scripts['start:local']).toBe('arca run -- next start')
    expect(io.err()).toContain('start: production start, left alone on purpose')
    expect(readFileSync(join(h.dir, 'AGENTS.md'), 'utf8')).toContain('## Secrets (arca)')
    expect(io.all()).not.toContain(STRIPE)
    expect(io.all()).not.toContain('s3cr3t-pass')
  })

  it('the leak guard reports the plaintext copies, by name only', async () => {
    const { code, io } = await h.task(['check', '--strict'])
    expect(code).toBe(1)
    expect(io.out()).toContain('Leak guard: 2 possible secrets')
    const doc = await h.task(['doctor'])
    expect(doc.io.out()).toContain('STRIPE_SECRET_KEY is stored in arca but also in plaintext in .env.local')
    expect(doc.io.all()).not.toContain(STRIPE)
  })

  it('import --delete removes only the imported entries', async () => {
    const { code } = await h.human(['import', '--delete'])
    expect(code).toBe(0)
    const left = readFileSync(join(h.dir, '.env.local'), 'utf8')
    expect(left).toBe('# local overrides\nPORT=3000\nNEXT_PUBLIC_POSTHOG_KEY=phc_publickey123\n')
    const check = await h.task(['check', '--strict'])
    expect(check.code).toBe(0)
  })

  it('run injects secrets and masks them in stdout and stderr, for humans too', async () => {
    writeJson(join(h.dir, 'arca.json'), { ...JSON.parse(readFileSync(join(h.dir, 'arca.json'), 'utf8')), envFiles: ['.env.local'] })
    const { code, io } = await h.human(['run', '--', 'node', 'print.js'])
    expect(code).toBe(0)
    expect(io.out()).toContain('stripe=[arca:STRIPE_SECRET_KEY]')
    expect(io.out()).toContain('stripe-ok=true len=26')
    expect(io.out()).toContain('port=3000 public=phc_publickey123') // config from .env.local is not masked
    expect(io.err()).toContain('password authentication failed for [arca:DATABASE_URL]')
    expect(io.all()).not.toContain(STRIPE)
    expect(io.all()).not.toContain('s3cr3t-pass')
  })

  it('passes the exit code through', async () => {
    const { code } = await h.human(['run', '--', 'node', 'print.js', '3'])
    expect(code).toBe(3)
  })

  it('vault wins over the shell, with a names-only notice', async () => {
    const { io } = await h.human(['run', '--', 'node', 'print.js'], { env: { STRIPE_SECRET_KEY: 'sk_test_fromshell_9999' } })
    expect(io.out()).toContain('stripe-ok=true')
    expect(io.err()).toContain('STRIPE_SECRET_KEY from arca overrides a different value inherited from your shell')
    expect(io.all()).not.toContain('sk_test_fromshell_9999'.slice(0, 8) + 'fromshell')
    const keep = await h.human(['run', '--no-override', '--', 'node', 'print.js'], { env: { STRIPE_SECRET_KEY: 'sk_test_fromshell_9999' } })
    expect(keep.io.out()).toContain('stripe-ok=false')
  })

  it('a git worktree (same arca.json id, other folder) sees the same secrets', async () => {
    const wt = tempDir()
    writeFileSync(join(wt, 'arca.json'), readFileSync(join(h.dir, 'arca.json')))
    writeFileSync(join(wt, 'print.js'), PRINT)
    const w = harness(wt, h.store)
    const { io } = await w.human(['run', '--', 'node', 'print.js'])
    expect(io.out()).toContain('stripe-ok=true')
  })

  describe('as an AI agent (CLAUDECODE=1, no terminal)', () => {
    const asScript = { npm_lifecycle_event: 'dev', npm_lifecycle_script: 'arca run -- node print.js' }

    it('may run the declared package script, masked', async () => {
      const { code, io } = await h.agent(['run', '--', 'node', 'print.js'], { env: { ...asScript, npm_package_json: join(h.dir, 'package.json') } })
      expect(code).toBe(0)
      expect(io.out()).toContain('stripe=[arca:STRIPE_SECRET_KEY]')
      expect(io.out()).toContain('stripe-ok=true')
    })

    it('is refused for ad-hoc commands', async () => {
      const { code, io } = await h.agent(['run', '--', 'node', '-e', 'console.log(process.env)'])
      expect(code).toBe(1)
      expect(io.err()).toContain('AI agents can only use secrets through package.json scripts (detected: claude-code via CLAUDECODE)')
      expect(io.all()).not.toContain(STRIPE)
    })

    it('is refused when the command differs from the script', async () => {
      const { code, io } = await h.agent(['run', '--', 'node', '-e', 'console.log(process.env)'], { env: asScript })
      expect(code).toBe(1)
      expect(io.err()).toContain("the command doesn't match")
    })

    it('cannot reveal, export, set, unset or import', async () => {
      for (const args of [['reveal', 'STRIPE_SECRET_KEY'], ['export'], ['set', 'X', 'y'], ['unset', 'STRIPE_SECRET_KEY'], ['import'], ['setup'], ['restore', 'X']]) {
        const { code, io } = await h.agent(args)
        expect(code, args.join(' ')).toBe(1)
        expect(io.err()).toMatch(/cannot be shown to AI agents|only a human can change/)
        expect(io.all()).not.toContain(STRIPE)
      }
    })

    it('can list names and check, never values', async () => {
      const list = await h.agent(['list'])
      expect(list.code).toBe(0)
      expect(list.io.out()).toMatch(/STRIPE_SECRET_KEY\s+✔ arca\s+secret/)
      expect(list.io.out()).toMatch(/PORT\s+✔ \.env\.local\s+config/)
      expect(list.io.all()).not.toContain(STRIPE)
      const json = JSON.parse((await h.agent(['list', '--json'])).io.out())
      expect(JSON.stringify(json)).not.toContain(STRIPE)
      expect((await h.agent(['check'])).code).toBe(0)
    })
  })

  describe('changing values (human)', () => {
    it('set from stdin, positional (warns), generate, restore and unset', async () => {
      let r = await h.human(['set', 'STRIPE_SECRET_KEY'], { stdin: 'sk_test_rotated_000000\n' })
      expect(r.code).toBe(0)
      expect((await h.human(['reveal', 'STRIPE_SECRET_KEY'])).io.out()).toBe('sk_test_rotated_000000\n')
      r = await h.human(['restore', 'STRIPE_SECRET_KEY'])
      expect((await h.human(['reveal', 'STRIPE_SECRET_KEY'])).io.out()).toBe(STRIPE + '\n')

      r = await h.human(['set', 'AUTH_SECRET', 'local-auth-secret'], { answers: { confirm: [true] } })
      expect(r.io.err()).toContain('shell history')
      expect(JSON.parse(readFileSync(join(h.dir, 'arca.json'), 'utf8')).vars.AUTH_SECRET).toEqual({ required: true })

      r = await h.human(['set', 'AUTH_SECRET', '--generate'])
      const generated = (await h.human(['reveal', 'AUTH_SECRET'])).io.out().trim()
      expect(generated).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(r.io.all()).not.toContain(generated)

      r = await h.human(['unset', 'AUTH_SECRET'])
      expect(r.code).toBe(0)
      expect((await h.human(['reveal', 'AUTH_SECRET'])).code).toBe(1)
      await h.human(['restore', 'AUTH_SECRET'])
      expect((await h.human(['reveal', 'AUTH_SECRET'])).io.out().trim()).toBe(generated)
    })

    it('suggests a declared name for a typo', async () => {
      const r = await h.human(['set', 'DATABSE_URL'], { answers: { confirm: [true], password: [DB] } })
      expect(r.code).toBe(0)
      expect(r.io.err()).toContain('Updated DATABASE_URL')
    })

    it('refuses writes without a terminal, even without an agent marker', async () => {
      const r = await h.task(['set', 'X', 'y'])
      expect(r.code).toBe(1)
      expect(r.io.err()).toContain('needs a person at an interactive terminal')
    })
  })
})

describe('teammates, CI and edge cases', () => {
  let cfg: Record<string, unknown>
  beforeAll(() => {
    cfg = { id: 'arc_teammate2222222222', name: 'acme-web', vars: { STRIPE_SECRET_KEY: { required: true, description: 'Stripe test key', docs: 'https://dashboard.stripe.com/test/apikeys' }, AUTH_SECRET: { required: true, generate: { bytes: 32 } }, PORT: { sensitive: false } } }
  })

  function project(store = tempStore()): Harness {
    const h = harness(tempDir(), store)
    writeJson(join(h.dir, 'arca.json'), cfg)
    writeFileSync(join(h.dir, 'print.js'), PRINT)
    return h
  }

  it('a fresh clone is told which variables are missing, and setup fills them', async () => {
    const h = project()
    const run = await h.human(['run', '--', 'node', 'print.js'])
    expect(run.code).toBe(1)
    expect(run.io.err()).toContain('2 required variables are not set for acme-web')
    expect(run.io.err()).toContain('npx arca setup')
    const setup = await h.human(['setup'], { answers: { password: [STRIPE], confirm: [true] } })
    expect(setup.code).toBe(0)
    expect(setup.io.err()).toContain('https://dashboard.stripe.com/test/apikeys')
    const again = await h.human(['run', '--', 'node', 'print.js'])
    expect(again.code).toBe(0)
    expect(again.io.out()).toContain('stripe-ok=true')
  })

  it('CI without a store passes through and validates required names', async () => {
    const h = project(tempDir())
    const fail = await h.task(['run', '--', 'node', 'print.js'], { env: { CI: 'true' } })
    expect(fail.code).toBe(1)
    expect(fail.io.err()).toContain('STRIPE_SECRET_KEY, AUTH_SECRET')
    expect(fail.io.err()).toContain("CI or hosting platform's environment variables")
    const ok = await h.task(['run', '--', 'node', 'print.js'], { env: { CI: 'true', STRIPE_SECRET_KEY: STRIPE, AUTH_SECRET: 'x'.repeat(10) } })
    expect(ok.code).toBe(0)
    expect(ok.io.out()).toContain('stripe-ok=true')
  })

  it('nested runs reuse the outer run instead of injecting again', async () => {
    const h = project()
    await h.human(['setup'], { answers: { password: [STRIPE], confirm: [true] } })
    const { io } = await h.human(['run', '--', 'node', 'print.js'], { env: { ARCA_ACTIVE: 'arc_teammate2222222222' } })
    expect(io.out()).toContain('stripe-ok=false') // the outer arca would have injected it
  })

  it('without arca.json, run just runs the command', async () => {
    const h = harness()
    writeFileSync(join(h.dir, 'print.js'), PRINT)
    const { code, io } = await h.human(['run', '--', 'node', 'print.js'])
    expect(code).toBe(0)
    expect(io.err()).toContain('no arca.json found')
  })

  it('reports unknown commands and the profile flag clearly', async () => {
    const h = project()
    expect((await h.human(['lst'])).io.err()).toContain('Did you mean `npx arca list`')
    const p = await h.human(['run', '--profile', 'acc', '--', 'node', 'print.js'])
    expect(p.code).toBe(2)
    expect(p.io.err()).toContain('profiles are not available in this version yet')
  })

  it('an agent-run init scaffolds config but leaves the values to a human', async () => {
    const h = harness()
    writeJson(join(h.dir, 'package.json'), { name: 'app', scripts: { dev: 'vite' } })
    writeFileSync(join(h.dir, '.env'), `API_TOKEN=${STRIPE}\nVITE_TITLE=Hello\n`)
    const { code, io } = await h.agent(['init'])
    expect(code).toBe(0)
    expect(io.err()).toContain('Moving secret values into arca needs a human')
    expect(JSON.parse(readFileSync(join(h.dir, 'arca.json'), 'utf8')).vars).toEqual({ API_TOKEN: { required: true }, VITE_TITLE: { sensitive: false } })
    expect(JSON.parse(readFileSync(join(h.dir, 'package.json'), 'utf8')).scripts.dev).toBe('arca run -- vite')
    expect(existsSync(join(h.store, 'projects'))).toBe(false)
  })

  it('the policy can deny agents entirely', async () => {
    const h = project()
    await h.human(['setup'], { answers: { password: [STRIPE], confirm: [true] } })
    expect((await h.human(['policy', 'set', 'agent-run', 'deny'])).code).toBe(0)
    const pkgDir = h.dir
    writeJson(join(pkgDir, 'package.json'), { scripts: { dev: 'arca run -- node print.js' } })
    const r = await h.agent(['run', '--', 'node', 'print.js'], { env: { npm_lifecycle_event: 'dev', npm_lifecycle_script: 'arca run -- node print.js' } })
    expect(r.code).toBe(1)
    expect(r.io.err()).toContain('turned off secrets for AI agents')
    expect((await h.agent(['policy', 'set', 'agent-run', 'scripts'])).code).toBe(1)
  })
})

void mkdirSync
