import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { harness, tempDir, writeJson, type Harness } from './helpers.js'

const DB_O = 'postgres://app:ontw-pass-111@db-ontw.local:5432/acme'
const DB_A = 'postgres://app:acc-pass-222@db-acc.example.com:5432/acme'
const STRIPE = 'sk_test_51HxYzAbCdEf123456'
const ID = 'arc_profiles22222222'

// Prints what it got. The host names aren't secret, so they show which set was injected.
const PRINT = `
const e = process.env
console.log('db=' + e.DATABASE_URL)
console.log('host=' + (e.DATABASE_URL ? new URL(e.DATABASE_URL).hostname : 'none'))
console.log('stripe-ok=' + (e.STRIPE_SECRET_KEY === ${JSON.stringify(STRIPE)}))
console.log('profile=' + e.ARCA_PROFILE + ' base=' + e.API_BASE_URL + ' node_env=' + e.NODE_ENV)
if (process.argv[2]) console.log('fixture=' + require('fs').readFileSync(process.argv[2], 'utf8').trim())
`

const SCRIPTS = { dev: 'arca run -- node print.js', 'test:acc': 'arca run --profile acceptatie -- node print.js' }

function project(config: Record<string, unknown> = {}): Harness {
  const h = harness()
  writeJson(join(h.dir, 'arca.json'), {
    id: ID,
    name: 'acme-web',
    defaultProfile: 'ontwikkel',
    profiles: {
      ontwikkel: {},
      acceptatie: { extends: 'ontwikkel', envFiles: ['.env.acceptatie'] },
      test: { extends: 'ontwikkel' },
    },
    vars: { DATABASE_URL: { required: true }, STRIPE_SECRET_KEY: { required: true }, API_BASE_URL: { sensitive: false } },
    ...config,
  })
  writeJson(join(h.dir, 'package.json'), { name: 'acme-web', scripts: SCRIPTS })
  writeFileSync(join(h.dir, 'print.js'), PRINT)
  writeFileSync(join(h.dir, '.env.acceptatie'), 'API_BASE_URL=https://api.acc.example.com\n')
  return h
}

/** What npm sets when it runs a package script. */
function script(h: Harness, name: keyof typeof SCRIPTS): NodeJS.ProcessEnv {
  return { npm_lifecycle_event: name, npm_lifecycle_script: SCRIPTS[name], npm_package_json: join(h.dir, 'package.json') }
}

async function seed(h: Harness): Promise<void> {
  expect((await h.human(['set', 'DATABASE_URL'], { stdin: DB_O + '\n' })).code).toBe(0)
  expect((await h.human(['set', 'STRIPE_SECRET_KEY'], { stdin: STRIPE + '\n' })).code).toBe(0)
  const r = await h.human(['set', 'DATABASE_URL', '--profile', 'acceptatie'], { stdin: DB_A + '\n' })
  expect(r.code).toBe(0)
  expect(r.io.err()).toContain('Set DATABASE_URL for acme-web (profile acceptatie)')
}

describe('switching between sets of values', () => {
  const h = project()

  it('the default profile runs without a banner', async () => {
    await seed(h)
    const { code, io } = await h.human(['run', '--', 'node', 'print.js'])
    expect(code).toBe(0)
    expect(io.out()).toContain('host=db-ontw.local')
    expect(io.out()).toContain('db=[arca:DATABASE_URL]')
    expect(io.out()).toContain('profile=ontwikkel base=undefined')
    expect(io.err()).not.toContain('arca ▸')
  })

  it('an agent can switch with `arca use`, and the package script follows it', async () => {
    const use = await h.agent(['use', 'ACCEPTATIE'])
    expect(use.code).toBe(0)
    expect(use.io.err()).toContain('acme-web now uses profile acceptatie for every arca run on this machine')
    expect(use.io.err()).toContain('Back to ontwikkel:  npx arca use --reset')

    const { code, io } = await h.agent(['run', '--', 'node', 'print.js'], { env: script(h, 'dev') })
    expect(code).toBe(0)
    expect(io.err()).toContain('arca ▸ profile acceptatie (via arca use) · 2 secrets · output masked')
    expect(io.out()).toContain('host=db-acc.example.com')
    expect(io.out()).toContain('stripe-ok=true') // inherited from ontwikkel
    expect(io.out()).toContain('profile=acceptatie base=https://api.acc.example.com') // the profile's envFiles
    expect(io.out()).toContain(`node_env=${process.env.NODE_ENV}`) // a profile isn't a framework mode: NODE_ENV is untouched
    expect(io.all()).not.toContain('acc-pass-222')
  })

  it('values of other profiles are masked too, named after their profile', async () => {
    writeFileSync(join(h.dir, 'fixture.txt'), `copied from ontwikkel: ${DB_O}`)
    const { io } = await h.human(['run', '--', 'node', 'print.js', 'fixture.txt'])
    expect(io.out()).toContain('fixture=copied from ontwikkel: [arca:DATABASE_URL@ontwikkel]')
    expect(io.all()).not.toContain('ontw-pass-111')
  })

  it('precedence: --profile > ARCA_PROFILE > arca use > default', async () => {
    const env = await h.human(['run', '--', 'node', 'print.js'], { env: { ARCA_PROFILE: 'test' } })
    expect(env.io.err()).toContain('arca ▸ profile test (via ARCA_PROFILE)')
    expect(env.io.out()).toContain('host=db-ontw.local') // test extends ontwikkel and stores nothing itself
    const flag = await h.human(['run', '--profile', 'ontwikkel', '--', 'node', 'print.js'], { env: { ARCA_PROFILE: 'test' } })
    expect(flag.io.out()).toContain('profile=ontwikkel')
    expect(flag.io.err()).not.toContain('arca ▸')
    // A script that names a profile keeps it.
    await h.agent(['use', 'test'])
    const pinned = await h.agent(['run', '--profile', 'acceptatie', '--', 'node', 'print.js'], { env: script(h, 'test:acc') })
    expect(pinned.code).toBe(0)
    expect(pinned.io.err()).toContain('arca ▸ profile acceptatie (via --profile)')
    await h.agent(['use', 'acceptatie'])
  })

  it('ARCA_PROFILE from an outer arca run of another project is ignored', async () => {
    const { code, io } = await h.human(['run', '--', 'node', 'print.js'], { env: { ARCA_PROFILE: 'staging', ARCA_ACTIVE: 'arc_otherproject2222' } })
    expect(code).toBe(0)
    expect(io.out()).toContain('profile=acceptatie')
  })

  it('list shows a matrix with inherited values and the active profile', async () => {
    const { code, io } = await h.agent(['list'])
    expect(code).toBe(0)
    const out = io.out()
    expect(out).toMatch(/ontwikkel\s+acceptatie ●\s+test/)
    expect(out).toMatch(/DATABASE_URL\s+✔ set\s+✔ set\s+↳ ontwikkel/)
    expect(out).toMatch(/STRIPE_SECRET_KEY\s+✔ set\s+↳ ontwikkel\s+↳ ontwikkel/)
    expect(out).toMatch(/API_BASE_URL\s+–\s+\.env\.acceptatie\s+–/)
    // A profile's envFiles become process env, so they beat the framework's own .env.local.
    writeFileSync(join(h.dir, '.env.local'), 'API_BASE_URL=http://localhost:4000\n')
    expect((await h.agent(['list'])).io.out()).toMatch(/API_BASE_URL\s+\.env\.local\s+\.env\.acceptatie\s+\.env\.local/)
    writeFileSync(join(h.dir, '.env.local'), '')
    const one = await h.agent(['list', '--profile', 'test'])
    expect(one.io.out()).toMatch(/DATABASE_URL\s+✔ arca ↳ ontwikkel\s+secret/)
    const json = JSON.parse((await h.agent(['list', '--json'])).io.out())
    expect(json.find((r: { name: string }) => r.name === 'STRIPE_SECRET_KEY')).toMatchObject({ status: 'arca', profile: 'ontwikkel' })
  })

  it('profiles, diff and check --all-profiles report names only', async () => {
    const list = await h.agent(['profiles'])
    expect(list.code).toBe(0)
    expect(list.io.out()).toMatch(/● acceptatie\s+ontwikkel\s+1 set, 1 inherited/)
    expect(list.io.out()).toMatch(/ {2}test\s+ontwikkel\s+0 set, 2 inherited/)

    const diff = await h.agent(['profiles', 'diff', 'ontwikkel', 'acceptatie'])
    expect(diff.io.out()).toMatch(/DATABASE_URL\s+✔ own value\s+✔ own value/)
    expect(diff.io.out()).toMatch(/STRIPE_SECRET_KEY\s+✔ own value\s+↳ ontwikkel/)
    expect(diff.io.out()).toContain('acceptatie sets DATABASE_URL itself')

    const check = await h.agent(['check', '--all-profiles'])
    expect(check.code).toBe(0)
    expect(check.io.out()).toContain('All 2 required variables set for acme-web (profile test)')
    for (const r of [list, diff, check]) {
      expect(r.io.all()).not.toContain('pass-')
      expect(r.io.all()).not.toContain(STRIPE)
    }
  })

  it('unset refuses a value the profile only inherits', async () => {
    const r = await h.human(['unset', 'STRIPE_SECRET_KEY'])
    expect(r.code).toBe(1)
    expect(r.io.err()).toContain("STRIPE_SECRET_KEY isn't stored in profile acceptatie itself, it's inherited from ontwikkel")
    const own = await h.human(['unset', 'DATABASE_URL'])
    expect(own.code).toBe(0)
    expect(own.io.err()).toContain('acceptatie now inherits DATABASE_URL from ontwikkel')
    await h.human(['restore', 'DATABASE_URL'])
    expect((await h.human(['reveal', 'DATABASE_URL'])).io.out().trim()).toBe(DB_A)
  })

  it('agents are told the exact command, with the profile', async () => {
    const r = await h.agent(['set', 'DATABASE_URL'])
    expect(r.code).toBe(1)
    expect(r.io.err()).toContain('npx arca set DATABASE_URL --profile acceptatie')
    for (const args of [['profiles', 'copy', 'ontwikkel', 'test'], ['profiles', 'rm', 'test']]) {
      expect((await h.agent(args)).io.err()).toContain('only a human can change secret values')
    }
  })

  it('copy seeds a profile, rm removes it and its values', async () => {
    const copy = await h.human(['profiles', 'copy', 'acceptatie', 'test', '--only', 'DATABASE_URL'])
    expect(copy.code).toBe(0)
    expect(copy.io.err()).toContain('Copied 1 value from acceptatie to test: DATABASE_URL')
    expect((await h.human(['reveal', 'DATABASE_URL', '-p', 'test'])).io.out().trim()).toBe(DB_A)

    await h.agent(['use', 'test'])
    expect((await h.human(['profiles', 'rm', 'ontwikkel'])).io.err()).toContain('is the default profile')
    const no = await h.human(['profiles', 'rm', 'acceptatie'], { answers: { confirm: [false] } })
    expect(no.code).toBe(1)
    expect(no.io.err()).toContain('cancelled')
    const rm = await h.human(['profiles', 'rm', 'test'], { answers: { confirm: [true] } })
    expect(rm.code).toBe(0)
    expect(rm.io.err()).toContain('Removed profile test and its 1 value')
    expect(Object.keys(JSON.parse(readFileSync(join(h.dir, 'arca.json'), 'utf8')).profiles)).toEqual(['ontwikkel', 'acceptatie'])
    expect(existsSync(join(h.store, 'projects', ID, 'test.vault'))).toBe(false)
    const after = await h.agent(['use'])
    expect(after.io.out()).toContain('ontwikkel') // the active profile was removed, so back to the default
  })

  it('use --reset goes back to the default, unknown profiles get a suggestion', async () => {
    await h.agent(['use', 'acceptatie'])
    expect((await h.agent(['use', '--reset'])).io.err()).toContain('acme-web is back on ontwikkel')
    const bad = await h.agent(['use', 'acceptate'])
    expect(bad.code).toBe(2)
    expect(bad.io.err()).toContain('Did you mean acceptatie?')
  })
})

describe('profiles in existing projects', () => {
  it('values stored before profiles existed move to the new default profile', async () => {
    const h = project({ defaultProfile: undefined, profiles: undefined })
    await h.human(['set', 'DATABASE_URL'], { stdin: DB_O + '\n' })
    await h.human(['set', 'STRIPE_SECRET_KEY'], { stdin: STRIPE + '\n' })
    expect(existsSync(join(h.store, 'projects', ID, 'default.vault'))).toBe(true)

    const cfg = JSON.parse(readFileSync(join(h.dir, 'arca.json'), 'utf8'))
    writeJson(join(h.dir, 'arca.json'), { ...cfg, defaultProfile: 'ontwikkel', profiles: { ontwikkel: {}, acceptatie: { extends: 'ontwikkel' } } })
    const run = await h.human(['run', '--', 'node', 'print.js'])
    expect(run.code).toBe(0)
    expect(run.io.err()).toContain('moved the values stored before this project had profiles into profile ontwikkel')
    expect(run.io.out()).toContain('host=db-ontw.local')
    expect(existsSync(join(h.store, 'projects', ID, 'default.vault'))).toBe(false)
    expect(existsSync(join(h.store, 'projects', ID, 'ontwikkel.vault'))).toBe(true)
  })

  it('profiles add writes the implicit default profile out too', async () => {
    const h = project({ defaultProfile: undefined, profiles: undefined })
    await h.human(['set', 'DATABASE_URL'], { stdin: DB_O + '\n' })
    const add = await h.agent(['profiles', 'add', 'Acceptatie', '--extends', 'default'])
    expect(add.code).toBe(0)
    expect(JSON.parse(readFileSync(join(h.dir, 'arca.json'), 'utf8')).profiles).toEqual({ default: {}, acceptatie: { extends: 'default' } })
    const r = await h.human(['reveal', 'DATABASE_URL', '--profile', 'acceptatie'])
    expect(r.io.out().trim()).toBe(DB_O)
  })

  it('a stale `arca use` falls back to the default with a warning', async () => {
    const h = project()
    await seed(h)
    await h.agent(['use', 'test'])
    const cfg = JSON.parse(readFileSync(join(h.dir, 'arca.json'), 'utf8'))
    delete cfg.profiles.test
    writeJson(join(h.dir, 'arca.json'), cfg)
    const r = await h.human(['run', '--', 'node', 'print.js'])
    expect(r.code).toBe(0)
    expect(r.io.err()).toContain('the active profile "test" (set with `arca use`) isn\'t in arca.json any more. Using ontwikkel')
  })

  it('a profile missing a required value is reported with its own setup command', async () => {
    const h = project({ profiles: { ontwikkel: {}, los: {} } })
    await h.human(['set', 'DATABASE_URL'], { stdin: DB_O + '\n' })
    await h.human(['set', 'STRIPE_SECRET_KEY'], { stdin: STRIPE + '\n' })
    const r = await h.human(['run', '--profile', 'los', '--', 'node', 'print.js'])
    expect(r.code).toBe(1)
    expect(r.io.err()).toContain('not set for acme-web (profile los)')
    expect(r.io.err()).toContain('npx arca setup --profile los')
  })
})

describe('init with .env.<name> files', () => {
  it('turns .env.acceptatie into a profile that stores only what differs', async () => {
    const h = harness(tempDir())
    writeJson(join(h.dir, 'package.json'), { name: 'acme', scripts: { dev: 'next dev' }, devDependencies: { next: '^16.0.0' } })
    writeFileSync(join(h.dir, '.env.local'), `DATABASE_URL=${DB_O}\nSTRIPE_SECRET_KEY=${STRIPE}\nAPP_TITLE=Hello\n`)
    writeFileSync(join(h.dir, '.env.acceptatie'), `DATABASE_URL=${DB_A}\nSTRIPE_SECRET_KEY=${STRIPE}\nAPP_TITLE=Hello acc\n`)
    writeFileSync(join(h.dir, '.env.production'), 'APP_TITLE=Prod\n')
    const { code, io } = await h.human(['init'], {
      answers: { text: ['acme'], multiselect: [['DATABASE_URL', 'STRIPE_SECRET_KEY'], ['dev']], confirm: [true, true] },
    })
    expect(code).toBe(0)
    expect(io.err()).toContain('Profile acceptatie (extends default): 1 → arca, config stays in .env.acceptatie')
    expect(io.err()).toContain('Left alone: .env.production (framework mode files')
    expect(io.err()).toContain('npx arca import .env.acceptatie --profile acceptatie --delete')
    const cfg = JSON.parse(readFileSync(join(h.dir, 'arca.json'), 'utf8'))
    expect(cfg.profiles).toEqual({ default: {}, acceptatie: { extends: 'default', envFiles: ['.env.acceptatie'] } })
    expect((await h.human(['reveal', 'DATABASE_URL', '-p', 'acceptatie'])).io.out().trim()).toBe(DB_A)
    const list = await h.agent(['list'])
    expect(list.io.out()).toMatch(/STRIPE_SECRET_KEY\s+✔ set\s+↳ default/)
    expect(io.all()).not.toContain('acc-pass-222')

    const del = await h.human(['import', '.env.acceptatie', '--profile', 'acceptatie', '--delete'])
    expect(del.code).toBe(0)
    expect(readFileSync(join(h.dir, '.env.acceptatie'), 'utf8')).toBe('APP_TITLE=Hello acc\n')
  })
})
