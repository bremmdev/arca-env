// Smoke test of the packed package, the way users install it: `npm pack`, install the
// tarball into a tiny project (with a space in its path), then run arca through npm
// scripts and npm exec. Catches what the unit tests can't: the `files` list, the bin
// shim (.cmd on Windows), the console guard preloaded from node_modules, the native
// keyring binding installing, and the package exports.
//
// Run with `npm run build && npm run smoke`. `npm run smoke -- --pnpm` installs and runs it
// with pnpm instead (symlinked node_modules, pnpm's own shims). Set ARCA_SMOKE_KEEP=1 to
// keep the temp folder.

import spawn from 'cross-spawn'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = join(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const SECRET = 'smoke-secret-value-7f3k9q2x'
const PASSPHRASE = 'smoke-passphrase-123'

const root = mkdtempSync(join(tmpdir(), 'arca-smoke-'))
const project = join(root, 'arca smoke project')
let failed = 0

function step(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`✔ ${name}`),
      (e) => {
        failed++
        console.log(`✖ ${name}\n  ${e.message.replaceAll('\n', '\n  ')}`)
      },
    )
}

function check(cond, message, output) {
  if (!cond) throw new Error(output === undefined ? message : `${message}\n--- output ---\n${output}`)
}

// npm via its JS entry point, so no shell is needed for npm.cmd on Windows.
// `npm run smoke` sets npm_execpath; fall back to the shell otherwise.
const npmCli = process.env.npm_execpath
function npm(args, env, cwd = project) {
  const r = npmCli && npmCli.endsWith('.js')
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, env, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd, env, encoding: 'utf8', shell: true })
  if (r.error) throw r.error
  return { code: r.status, stdout: r.stdout, out: r.stdout + r.stderr }
}

// The package manager under test, for installing the tarball and running arca.
const pm = process.argv.includes('--pnpm') ? 'pnpm' : 'npm'
function tool(args, env) {
  if (pm === 'npm') return npm(args, env)
  // cross-spawn finds pnpm.cmd on Windows without a shell.
  const r = spawn.sync('pnpm', args, { cwd: project, env, encoding: 'utf8' })
  if (r.error) throw r.error
  return { code: r.status, stdout: r.stdout, out: r.stdout + r.stderr }
}
const exec = (args, env) => tool(pm === 'npm' ? ['exec', '--', ...args] : ['exec', ...args], env)

/** process.env without the npm_* and arca_* vars of whoever started this script. */
function ownEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(npm_|arca_)/i.test(k)) continue
    env[k] = v
  }
  return env
}

/** A developer's terminal: no agent markers, no npm/arca vars from whoever started this script. */
async function cleanEnv(extra = {}) {
  const { detectAgent } = await arcaApi()
  const env = ownEnv()
  for (let a = detectAgent(env); a.detected; a = detectAgent(env)) delete env[a.via]
  return { ...env, NO_COLOR: '1', ARCA_HOME: join(root, 'store'), ARCA_KEYCHAIN: 'passphrase', ARCA_PASSPHRASE: PASSPHRASE, ...extra }
}

let api
async function arcaApi() {
  // Resolved from the temp project, so this goes through the package's `exports`.
  api ??= await import(pathToFileURL(createRequire(join(project, 'package.json')).resolve('@bremmdev/arca-env')).href)
  return api
}

const APP = `// Replaces console.log the way dev tools do (TanStack Devtools' console piping),
// to check that the console guard runs before any wrapper sees the arguments.
const { writeFileSync } = require('node:fs')
const captured = []
const original = console.log
console.log = (...args) => { captured.push(args.join(' ')); original(...args) }
console.log('console:', process.env.API_KEY)
process.stdout.write('stdout: ' + process.env.API_KEY + '\\n')
console.error('stderr:', process.env.API_KEY)
console.log('secret-ok=' + (process.env.API_KEY === ${JSON.stringify(SECRET)}))
writeFileSync('captured.txt', captured.join('\\n'))
`

try {
  let tarball
  await step('npm pack', () => {
    const r = npm(['pack', '--json', '--pack-destination', root], process.env, repo)
    check(r.code === 0, 'npm pack failed', r.out)
    // Newer npm versions print `npm notice` lines too, so cut the JSON array out of stdout.
    // It's pretty-printed: the top-level array opens and closes at the start of a line.
    const json = r.stdout.match(/^\[[\s\S]*?^\]$/m)
    check(json, 'no JSON in the npm pack output', r.out)
    const [info] = JSON.parse(json[0])
    const files = info.files.map((f) => f.path)
    for (const f of ['dist/cli.mjs', 'dist/index.mjs', 'dist/guard.mjs', 'schema.json']) {
      check(files.includes(f), `${f} is missing from the package. Run \`npm run build\` first.`)
    }
    tarball = join(root, info.filename)
  })
  if (!tarball) throw new Error('no tarball, stopping')

  await step(`${pm}: install the tarball into a project with a space in its path`, () => {
    mkdirSync(project)
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: 'arca-smoke', private: true, scripts: { dev: 'arca run -- node app.js' } }, null, 2),
    )
    writeFileSync(join(project, 'arca.json'), JSON.stringify({ id: 'arc_smoketest', name: 'arca-smoke', vars: { API_KEY: { required: true } } }, null, 2))
    writeFileSync(join(project, 'app.js'), APP)
    const args = pm === 'npm' ? ['install', '--save-dev', '--no-audit', '--no-fund', tarball] : ['add', '--save-dev', tarball]
    // pnpm reads npm_config_* as its own config, so it doesn't get the ones `npm run smoke` set.
    const r = tool(args, pm === 'npm' ? process.env : ownEnv())
    check(r.code === 0, `${pm} install failed`, r.out)
  })

  await step(`\`${pm} exec arca --version\` reports the package version`, async () => {
    const r = exec(['arca', '--version'], await cleanEnv())
    check(r.code === 0 && r.stdout.trim() === version, `expected ${version}`, r.out)
  })

  await step('store a secret through the programmatic API (passphrase store)', async () => {
    const { main } = await arcaApi()
    let out = ''
    const write = (s) => void (out += s)
    const noPrompt = async (m) => {
      throw new Error(`unexpected prompt: ${m}`)
    }
    const code = await main(['set', 'API_KEY'], {
      env: await cleanEnv(),
      cwd: project,
      platform: process.platform,
      // A person at a terminal, piping the value in: `… | arca set API_KEY`.
      stdout: { write, isTTY: true },
      stderr: { write, isTTY: true },
      stdinIsTTY: false,
      readStdin: async () => `${SECRET}\n`,
      prompts: { password: noPrompt, text: noPrompt, confirm: noPrompt, multiselect: noPrompt },
      childStdin: 'ignore',
      handleSignals: false,
    })
    check(code === 0, 'arca set failed', out)
    check(!out.includes(SECRET), 'arca set printed the secret', out)
  })

  await step(`\`${pm} run dev\` injects the secret and masks it everywhere`, async () => {
    const r = tool(['run', 'dev'], await cleanEnv())
    check(r.code === 0, `${pm} run dev failed`, r.out)
    check(r.out.includes('secret-ok=true'), 'the secret was not injected', r.out)
    for (const line of ['console: [arca:API_KEY]', 'stdout: [arca:API_KEY]', 'stderr: [arca:API_KEY]']) {
      check(r.out.includes(line), `expected "${line}"`, r.out)
    }
    check(!r.out.includes(SECRET), 'the secret appeared in the output', r.out)
  })

  await step('the console guard masks before a console.log wrapper sees the value', () => {
    const captured = readFileSync(join(project, 'captured.txt'), 'utf8')
    check(captured.includes('console: [arca:API_KEY]'), 'the wrapper did not see the masked value', captured)
    check(!captured.includes(SECRET), 'the wrapper saw the raw secret', captured)
  })

  await step('an AI agent may run the package script, masked', async () => {
    const r = tool(['run', 'dev'], await cleanEnv({ CLAUDECODE: '1' }))
    check(r.code === 0 && r.out.includes('secret-ok=true'), 'the agent could not run the script', r.out)
    check(!r.out.includes(SECRET), 'the secret appeared in the output', r.out)
  })

  await step(`an AI agent is refused an ad-hoc \`${pm} exec arca run\``, async () => {
    const r = exec(['arca', 'run', '--', 'node', 'app.js'], await cleanEnv({ CLAUDECODE: '1' }))
    check(r.code !== 0, 'the ad-hoc run was allowed', r.out)
    check(r.out.includes('AI agents can only use secrets through package.json scripts'), 'expected the agent refusal', r.out)
    check(!r.out.includes(SECRET), 'the secret appeared in the output', r.out)
  })

  await step(`\`${pm} exec arca doctor\` finds the passphrase store, names only`, async () => {
    const r = exec(['arca', 'doctor'], await cleanEnv())
    check(r.out.includes('passphrase'), 'expected the passphrase key storage', r.out)
    check(!r.out.includes(SECRET), 'the secret appeared in the output', r.out)
  })

  await step('CI without a store: passes through and checks required variables', async () => {
    const env = await cleanEnv({ CI: 'true', ARCA_HOME: join(root, 'empty-store') })
    const missing = tool(['run', 'dev'], env)
    check(missing.code !== 0 && missing.out.includes('API_KEY'), 'expected a missing API_KEY error', missing.out)
    const given = tool(['run', 'dev'], { ...env, API_KEY: SECRET })
    check(given.code === 0 && given.out.includes('secret-ok=true'), 'the platform value was not passed through', given.out)
  })
} catch (e) {
  failed++
  console.log(`✖ ${e.message}`)
} finally {
  if (process.env.ARCA_SMOKE_KEEP) console.log(`kept ${root}`)
  else rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}

if (failed) {
  console.log(`\n${failed} smoke step(s) failed`)
  process.exit(1)
}
console.log(`\nsmoke test passed (${pm})`)
