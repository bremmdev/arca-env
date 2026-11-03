// Framework checks (layer 5): the packed package inside real Next.js and TanStack Start dev
// servers, read by a real browser. Covers the routes around arca's stdout masking: React's
// server log replay and Next's dev log file (issues U3, U4), and TanStack Devtools' console
// piping to the browser (U2).
//
// Slow (framework installs, a browser), so it runs in its own daily workflow, not on every push.
// Run with `npm run build && npm run frameworks`, or `npm run frameworks -- next` for one.
// Needs Google Chrome (driven through playwright-core, so no browser download). Without it, set
// ARCA_FRAMEWORKS_CHANNEL= (empty) and run `npx playwright-core install chromium` first.
// ARCA_FRAMEWORKS_KEEP=1 keeps the temp folder.

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = join(import.meta.dirname, '..')
const fixtures = join(import.meta.dirname, 'frameworks')
const SECRETS = {
  DATABASE_URL: 'postgres://app:fw-s3cret-9z8y7x@db.internal:5432/acme',
  STRIPE_SECRET_KEY: 'sk_test_fwsecret_4d3c2b1a0z',
}
const PASSPHRASE = 'frameworks-passphrase-123'
const PLAYWRIGHT = 'playwright-core@1.64.1'
// Not `localhost`: it resolves to ::1 first on some Linux hosts and 127.0.0.1 on others.
const HOST = '127.0.0.1'

// The long form of the temp path: GitHub's Windows runners have TEMP=C:\Users\RUNNER~1\…, and
// under an 8.3 short path Vite + TanStack Start serve 404 for /@vite/client, arca or not (P12).
const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'arca-frameworks-'))
const store = join(root, 'store')
let failed = 0

async function step(name, fn) {
  try {
    await fn()
    console.log(`✔ ${name}`)
  } catch (e) {
    failed++
    console.log(`✖ ${name}\n  ${e.message.replaceAll('\n', '\n  ')}`)
  }
}

function check(cond, message, output) {
  if (!cond) throw new Error(output === undefined ? message : `${message}\n--- output ---\n${output.slice(-4000)}`)
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

// npm via its JS entry point, so no shell is needed for npm.cmd on Windows.
const npmCli = process.env.npm_execpath
function npm(args, cwd, env = process.env) {
  const r = npmCli && npmCli.endsWith('.js')
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, env, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd, env, encoding: 'utf8', shell: true })
  if (r.error) throw r.error
  return { code: r.status, out: r.stdout + r.stderr }
}

function packTarball() {
  const r = npm(['pack', '--json', '--pack-destination', root], repo)
  check(r.code === 0, 'npm pack failed. Run `npm run build` first.', r.out)
  const json = r.out.match(/^\[[\s\S]*?^\]$/m)
  check(json, 'no JSON in the npm pack output', r.out)
  return join(root, JSON.parse(json[0])[0].filename)
}

function installBrowserDriver() {
  const dir = join(root, 'browser')
  mkdirSync(dir)
  writeFileSync(join(dir, 'package.json'), '{ "private": true }\n')
  const r = npm(['install', '--no-audit', '--no-fund', PLAYWRIGHT], dir)
  check(r.code === 0, 'installing playwright-core failed', r.out)
  return createRequire(join(dir, 'package.json'))('playwright-core')
}

/** A developer's terminal: no agent markers, no npm/arca vars from whoever started this script. */
function cleanEnv(api, extra = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^(npm_|arca_)/i.test(k)) env[k] = v
  for (let a = api.detectAgent(env); a.detected; a = api.detectAgent(env)) delete env[a.via]
  return { ...env, ARCA_HOME: store, ARCA_KEYCHAIN: 'passphrase', ARCA_PASSPHRASE: PASSPHRASE, NEXT_TELEMETRY_DISABLED: '1', ...extra }
}

/** Stores the secrets through the installed package's API, like a person piping them in. */
async function storeSecrets(api, app) {
  for (const [name, value] of Object.entries(SECRETS)) {
    let out = ''
    const write = (s) => void (out += s)
    const noPrompt = async (m) => {
      throw new Error(`unexpected prompt: ${m}`)
    }
    const code = await api.main(['set', name], {
      env: cleanEnv(api),
      cwd: app,
      platform: process.platform,
      stdout: { write, isTTY: true },
      stderr: { write, isTTY: true },
      stdinIsTTY: false,
      readStdin: async () => `${value}\n`,
      prompts: { password: noPrompt, text: noPrompt, confirm: noPrompt, multiselect: noPrompt },
      childStdin: 'ignore',
      handleSignals: false,
    })
    check(code === 0, `arca set ${name} failed`, out)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/** `npm run dev -- <args>`, with its output collected. */
function startDev(app, args, env) {
  const cmd = npmCli && npmCli.endsWith('.js') ? [process.execPath, npmCli] : ['npm']
  const child = spawn(cmd[0], [...cmd.slice(1), 'run', 'dev', '--', ...args], {
    cwd: app,
    env,
    // Its own process group on Linux, so the whole tree can be stopped at once.
    detached: process.platform !== 'win32',
    shell: cmd[0] === 'npm' && process.platform === 'win32',
  })
  const dev = { child, out: '', exited: false }
  child.stdout.on('data', (c) => (dev.out += c))
  child.stderr.on('data', (c) => (dev.out += c))
  child.on('exit', () => (dev.exited = true))
  return dev
}

async function stopDev(dev) {
  if (dev.exited) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(dev.child.pid)])
  else {
    try {
      process.kill(-dev.child.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  await waitFor(() => dev.exited, 15_000, 'the dev server to stop').catch(() => {
    if (process.platform !== 'win32') process.kill(-dev.child.pid, 'SIGKILL')
  })
}

function leaked(text) {
  return Object.entries(SECRETS)
    .filter(([, v]) => text.includes(v))
    .map(([k]) => k)
}

const FRAMEWORKS = {
  next: {
    devArgs: (port) => ['--port', String(port), '--hostname', HOST],
    // React replays server component logs in the browser with a "Server" badge, whose styling
    // arguments end up between the logged ones.
    browserLog: { what: 'the replayed server log', test: (l) => l.includes('page sees DATABASE_URL =') && l.includes('Server') && l.includes('[arca:DATABASE_URL]') },
    extra: async (app, dev) => {
      // Next 16.4 copies server console calls into a log file meant for agents and MCP tools.
      const file = join(app, '.next', 'dev', 'logs', 'next-development.log')
      await step('next: .next/dev/logs/next-development.log gets the masked value', async () => {
        await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').includes('[arca:DATABASE_URL]'), 20_000, 'the masked value in the log file').catch((e) => {
          throw new Error(`${e.message}\n${existsSync(file) ? readFileSync(file, 'utf8').slice(-2000) : 'no log file'}`)
        })
        const text = readFileSync(file, 'utf8')
        check(leaked(text).length === 0, `the log file holds the raw ${leaked(text).join(', ')}`, text)
      })
      return dev
    },
  },
  'tanstack-start': {
    devArgs: (port) => ['--port', String(port), '--strictPort', '--host', HOST],
    // TanStack Devtools pipes server console calls to the browser as "[Server] LOG …".
    browserLog: { what: 'a piped server log', test: (l) => l.includes('Connection:') && l.includes('[arca:DATABASE_URL]') },
    extra: async (_app, dev) => dev,
  },
}

async function runFramework(name, spec, tarball, browser) {
  const app = join(root, name)
  cpSync(join(fixtures, name), app, { recursive: true })

  await step(`${name}: install the framework and the arca tarball`, () => {
    const r = npm(['install', '--save-dev', '--no-audit', '--no-fund', tarball], app)
    check(r.code === 0, 'npm install failed', r.out)
  })
  const api = await import(pathToFileURL(createRequire(join(app, 'package.json')).resolve('@bremmdev/arca-env')).href)
  await storeSecrets(api, app)

  const port = await freePort()
  const url = `http://${HOST}:${port}`
  const dev = startDev(app, spec.devArgs(port), cleanEnv(api))
  const consoleLogs = []
  try {
    await step(`${name}: \`npm run dev\` starts through arca run`, async () => {
      await waitFor(async () => {
        if (dev.exited) throw new Error(`the dev server exited\n${dev.out}`)
        return fetch(url, { signal: AbortSignal.timeout(10_000) }).then(() => true, () => false)
      }, 120_000, `the dev server at ${url}`)
    })

    const page = await browser.newPage()
    page.on('console', (m) => consoleLogs.push(m.text()))
    page.on('response', (r) => r.status() >= 400 && consoleLogs.push(`(HTTP ${r.status()} ${r.url()})`))
    await step(`${name}: the page renders with the secret injected`, async () => {
      await page.goto(url, { timeout: 120_000 })
      const text = await page.locator('#injected').textContent({ timeout: 60_000 })
      check(text.includes(`has ${SECRETS.STRIPE_SECRET_KEY.length} characters`), `expected the secret's length on the page, got "${text}"`)
    })
    // Give client-side dev tools a moment to connect before the server logs again.
    await new Promise((r) => setTimeout(r, 2000))
    await page.evaluate(() => fetch('/api/leak').then((r) => r.status))

    await step(`${name}: server logs in the terminal are masked`, async () => {
      await waitFor(() => dev.out.includes('Connection: [arca:DATABASE_URL]') && dev.out.includes('Using Stripe key [arca:STRIPE_SECRET_KEY]'), 30_000, 'the masked lines in the terminal').catch((e) => {
        throw new Error(`${e.message}\n${dev.out.slice(-3000)}`)
      })
    })
    await step(`${name}: server logs in the browser console are masked`, async () => {
      await waitFor(() => consoleLogs.some(spec.browserLog.test), 30_000, `${spec.browserLog.what}, masked, in the browser console`).catch((e) => {
        throw new Error(`${e.message}\n--- browser console ---\n${consoleLogs.join('\n').slice(-3000)}\n--- dev server ---\n${dev.out.slice(-2000)}`)
      })
    })
    await spec.extra(app, dev)
    await page.close()
  } finally {
    await stopDev(dev)
  }

  await step(`${name}: no raw secret in the terminal or the browser console`, () => {
    check(leaked(dev.out).length === 0, `the terminal shows the raw ${leaked(dev.out).join(', ')}`, dev.out)
    const browserText = consoleLogs.join('\n')
    check(leaked(browserText).length === 0, `the browser console shows the raw ${leaked(browserText).join(', ')}`, browserText)
  })
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))
for (const name of only) if (!FRAMEWORKS[name]) throw new Error(`unknown framework "${name}". Known: ${Object.keys(FRAMEWORKS).join(', ')}`)

let browser
try {
  const tarball = packTarball()
  const { chromium } = installBrowserDriver()
  browser = await chromium.launch({ channel: process.env.ARCA_FRAMEWORKS_CHANNEL ?? 'chrome', headless: true })
  for (const [name, spec] of Object.entries(FRAMEWORKS)) {
    if (only.length && !only.includes(name)) continue
    await runFramework(name, spec, tarball, browser)
  }
} catch (e) {
  failed++
  console.log(`✖ ${e.message}`)
} finally {
  await browser?.close()
  if (process.env.ARCA_FRAMEWORKS_KEEP) console.log(`kept ${root}`)
  else rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}

if (failed) {
  console.log(`\n${failed} framework check(s) failed`)
  process.exit(1)
}
console.log('\nframework checks passed')
