// VS Code check of the register loader (layer 6): the packed package in real VS Code, driven
// through its own test explorer and debugger, with the Vitest, Jest and Playwright extensions.
// Covers what only an IDE shows: test messages and failure peeks the extensions get over IPC,
// a WebSocket or a results file (I12), worker threads (I13), Playwright's error-context.md
// (I14), Debug Console locations (I15), and the integrated terminal.
//
// Needs a desktop session, so it isn't in CI. Run it before a release that touches the loader,
// the console guard or masking: `npm run build && npm run vscode`, or `npm run vscode -- jest debug`
// for some scenarios. Uses the VS Code at ARCA_VSCODE_EXE, else the installed one, else downloads
// stable. Never touches your own VS Code settings or extensions: it runs with its own
// --user-data-dir and --extensions-dir. Options:
//   --latest      the newest extension versions instead of the pinned ones
//   --passphrase  a passphrase store instead of the OS keychain (the default on headless Linux)
// The secret goes in a store of its own. With the keychain, that's an `arca` entry in Windows
// Credential Manager or the Secret Service, deleted again at the end. Screenshots (Windows only)
// capture the test window and nothing else. The reports and screenshots are kept; set
// ARCA_VSCODE_KEEP=1 to keep the workspaces too. On Linux without a display: `xvfb-run -a npm run vscode`.

import spawn from 'cross-spawn'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = join(import.meta.dirname, '..')
const fixtures = join(import.meta.dirname, 'vscode')
const SECRET = 'vscode-secret-9x7k2m4q'
const MASKED = '[arca:API_KEY]'
const HASH = createHash('sha256').update(SECRET).digest('hex')
const PASSPHRASE = 'vscode-passphrase-123'
const TEST_ELECTRON = '@vscode/test-electron@3.1.0'
/** The versions checked on 2026-11-10. `--latest` installs the newest instead. */
const EXTENSIONS = { 'vitest.explorer': '1.52.2', 'orta.vscode-jest': '6.4.4', 'ms-playwright.playwright': '1.1.19' }

const args = process.argv.slice(2)
const latest = args.includes('--latest')
const windows = process.platform === 'win32'
if (process.platform !== 'win32' && process.platform !== 'linux') fail('Windows and Linux only')
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) fail('no display: run it as `xvfb-run -a npm run vscode`')
const passphrase = args.includes('--passphrase') || (process.platform === 'linux' && !process.env.DBUS_SESSION_BUS_ADDRESS)
if (!existsSync(join(repo, 'dist', 'register.cjs'))) fail('no build: run `npm run build` first')

// Each test logs the secret, writes it to stdout, fails on it and throws with it. Its file never
// contains it: it checks a hash, and writes evidence (no value) that the secret arrived.
const evidence = (dir) =>
  `function evidence(name) { require('node:fs').writeFileSync(require('node:path').join(${dir}, 'evidence-' + name + '.json'), JSON.stringify({ ok: sha(process.env.API_KEY) === HASH, masked: Object.hasOwn(process.stdout, Symbol.for('arca.register.masked')) })) }`
const testFile = (runner, { header = '', dir = "__dirname, '..'" } = {}) => `${header}
const RUNNER = '${runner}'
const HASH = '${HASH}'
const sha = (s) => require('node:crypto').createHash('sha256').update(String(s)).digest('hex')
${evidence(dir)}
test('secret reaches the test', () => {
  evidence(RUNNER)
  console.log('console in test:', process.env.API_KEY)
  process.stdout.write('stdout in test: ' + process.env.API_KEY + '\\n')
  expect(sha(process.env.API_KEY)).toBe(HASH)
})
test('fails with the value', () => {
  expect(process.env.API_KEY).toBe('wrong')
})
test('throws with the value', () => {
  throw new Error('bad key ' + process.env.API_KEY)
})
`
const vitestConfig = (extra = '') =>
  `import '@bremmdev/arca-env/register'\nimport { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { include: ['tests/**/*.test.ts']${extra} } })\n`
const vitestTest = (runner) => testFile(runner, { header: "import { test, expect } from 'vitest'", dir: 'process.cwd()' })
const jestConfig = "require('@bremmdev/arca-env/register')\nmodule.exports = { testMatch: ['**/tests/**/*.test.js'] }\n"

const APP = `const HASH = '${HASH}'
const sha = (s) => require('node:crypto').createHash('sha256').update(String(s)).digest('hex')
${evidence('__dirname')}
evidence(process.env.SCENARIO_NAME)
console.log('console:', process.env.API_KEY)
process.stdout.write('stdout: ' + process.env.API_KEY + '\\n')
console.error('stderr:', { key: process.env.API_KEY })
require('node:child_process').spawnSync(process.execPath, ['child.js'], { stdio: 'inherit', cwd: __dirname })
`
const CHILD = "console.log('child: ' + process.env.API_KEY)\n"
const launch = (name, extra = {}) => ({
  name,
  type: 'node',
  request: 'launch',
  program: '${workspaceFolder}/app.js',
  runtimeArgs: ['--import', '@bremmdev/arca-env/register'],
  env: { SCENARIO_NAME: name },
  ...extra,
})

/** `evidence`: how many evidence files must say the secret arrived. */
const SCENARIOS = {
  vitest: { deps: ['vitest'], evidence: 1, files: { 'vitest.config.ts': vitestConfig(), 'tests/secret.test.ts': vitestTest('vitest') } },
  'vitest-threads': {
    deps: ['vitest'],
    evidence: 1,
    files: { 'vitest.config.ts': vitestConfig(", pool: 'threads'"), 'tests/secret.test.ts': vitestTest('vitest-threads') },
  },
  // One file: Jest runs it in its main process (in-band).
  jest: { deps: ['jest'], evidence: 1, files: { 'jest.config.js': jestConfig, 'tests/secret.test.js': testFile('jest') } },
  // Two files: Jest starts workers.
  'jest-workers': {
    deps: ['jest'],
    evidence: 2,
    files: { 'jest.config.js': jestConfig, 'tests/secret.test.js': testFile('jest-workers'), 'tests/second.test.js': testFile('jest-workers-b') },
  },
  playwright: {
    deps: ['@playwright/test'],
    evidence: 1,
    files: {
      'playwright.config.ts': "import '@bremmdev/arca-env/register'\nimport { defineConfig } from '@playwright/test'\nexport default defineConfig({ testDir: './tests' })\n",
      'tests/secret.spec.ts': testFile('playwright', { header: "import { test, expect } from '@playwright/test'" }),
    },
  },
  // The debugger, with output in the Debug Console and in the integrated terminal. The child
  // process gets the loader through NODE_OPTIONS.
  debug: {
    deps: [],
    evidence: 2,
    files: {
      'app.js': APP,
      'child.js': CHILD,
      '.vscode/launch.json': JSON.stringify({ version: '0.2.0', configurations: [launch('debug-console'), launch('debug-terminal', { console: 'integratedTerminal' })] }, null, 2),
    },
  },
}
const chosen = args.filter((a) => !a.startsWith('--'))
for (const name of chosen) if (!SCENARIOS[name]) fail(`unknown scenario ${name}: ${Object.keys(SCENARIOS).join(', ')}`)
const scenarios = chosen.length ? chosen : Object.keys(SCENARIOS)

function fail(message) {
  console.error(`vscode check: ${message}`)
  process.exit(1)
}

// The long form of the temp path (see frameworks.mjs, P12). No space in it: VS Code's IPC
// socket path has a length limit, and paths with spaces are the smoke test's job.
const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'arca-vscode-'))
const out = join(root, 'out')
const store = join(root, 'store')
mkdirSync(out)
let failed = 0

function run(command, cmdArgs, cwd, env = process.env) {
  const r = spawn.sync(command, cmdArgs, { cwd, env, encoding: 'utf8' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${command} ${cmdArgs.join(' ')} failed (${r.status})\n${r.stdout}${r.stderr}`)
  return r.stdout
}
const npmInstall = (cwd, pkgs) => run('npm', ['install', '--save-dev', '--no-audit', '--no-fund', ...pkgs], cwd)

/** A person's environment: no agent markers, nothing from npm, arca or the VS Code this may run in. */
function personEnv(detectAgent) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(npm_|arca_|vscode_|electron_run_as_node$|term_program)/i.test(k)) continue
    env[k] = v
  }
  for (let a = detectAgent(env); a.detected; a = detectAgent(env)) delete env[a.via]
  env.ARCA_HOME = store
  if (passphrase) Object.assign(env, { ARCA_KEYCHAIN: 'passphrase', ARCA_PASSPHRASE: PASSPHRASE })
  return env
}

function findVSCode() {
  if (process.env.ARCA_VSCODE_EXE) return process.env.ARCA_VSCODE_EXE
  const candidates = windows
    ? [join(process.env.ProgramFiles ?? 'C:/Program Files', 'Microsoft VS Code', 'Code.exe'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe')]
    : ['/usr/share/code/code', '/snap/code/current/usr/share/code/code', '/opt/visual-studio-code/code']
  return candidates.find((c) => existsSync(c))
}

/** Every file in a workspace except node_modules, for a raw value left on disk. */
function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : filesIn(p)
    return statSync(p).size < 5_000_000 ? [p] : []
  })
}

const count = (text, needle) => text.split(needle).length - 1

function evaluate(name, ws) {
  const problems = []
  const file = join(out, `${name}.json`)
  if (!existsSync(file)) return [`no report (VS Code didn't run the driver, see ${name}.log)`]
  const raw = readFileSync(file, 'utf8')
  const report = JSON.parse(raw)
  for (const line of report.log) if (line.includes('error:')) problems.push(line.split('\n')[0])
  if (raw.includes(SECRET)) problems.push(`the raw value is in what VS Code showed (${count(raw, SECRET)}x, see ${name}.json)`)

  const evidence = readdirSync(ws).filter((f) => /^evidence-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(ws, f), 'utf8')))
  const got = evidence.filter((e) => e.ok).length
  if (got !== SCENARIOS[name].evidence) problems.push(`the secret reached ${got} of ${SCENARIOS[name].evidence} test processes`)
  const leftOnDisk = filesIn(ws).filter((f) => readFileSync(f, 'utf8').includes(SECRET))
  if (leftOnDisk.length) problems.push(`the raw value is in ${leftOnDisk.map((f) => f.slice(ws.length + 1)).join(', ')}`)

  if (name === 'debug') {
    for (const config of ['debug-console', 'debug-terminal']) {
      const lines = report.debugOutput.filter((o) => o.config === config && (o.category === 'stdout' || o.category === 'stderr') && o.source)
      const own = lines.filter((o) => o.output.includes(MASKED))
      if (!report.log.some((l) => l.includes(`start ${config}`))) problems.push(`${config} didn't start`)
      if (own.length < 3) problems.push(`${config}: expected masked output from app.js and child.js in the Debug Console, got ${own.length} lines`)
      // I15: a log's location must be the caller's line, not arca's console wrapper.
      const wrong = lines.filter((o) => !/^(app|child)\.js$/.test(basename(o.source.replaceAll('\\', '/'))))
      if (wrong.length) problems.push(`${config}: Debug Console locations point at ${[...new Set(wrong.map((o) => o.source))].join(', ')}`)
    }
    if (report.terminalData === null) console.log('  (integrated terminal text not captured by this VS Code: check debug-debug-terminal.png)')
    else if (!report.terminalData.includes(`child: ${MASKED}`)) problems.push('the integrated terminal shows no masked output from the child process')
  } else {
    // The failures were reported, masked: in test messages, or in the Problems panel (Jest).
    const failures = report.tests.filter((t) => t.states.some((s) => s.state === 4 || s.state === 6)).length + report.diagnostics.length
    if (failures === 0) problems.push('no failures reported: the failing tests should show up')
    if (count(raw, MASKED) < 2) problems.push(`expected the two failures to show ${MASKED}, it appears ${count(raw, MASKED)}x`)
  }
  return problems
}

let api
try {
  console.log(`working in ${root}`)
  const pack = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', root], repo))
  const tgz = join(root, pack[0].filename)

  const harness = join(root, 'harness')
  mkdirSync(harness)
  writeFileSync(join(harness, 'package.json'), '{ "name": "harness", "private": true }\n')
  npmInstall(harness, [TEST_ELECTRON])
  const electron = await import(pathToFileURL(createRequire(join(harness, 'package.json')).resolve('@vscode/test-electron')).href)
  const exe = findVSCode() ?? (await electron.downloadAndUnzipVSCode({ version: 'stable', cachePath: join(tmpdir(), 'arca-vscode-cache') }))
  const cli = electron.resolveCliPathFromVSCodeExecutablePath(exe)
  const cliEnv = { ...process.env }
  for (const k of Object.keys(cliEnv)) if (/^(vscode_|electron_run_as_node$)/i.test(k)) delete cliEnv[k]
  const extDir = join(root, 'ext')
  const userDir = join(root, 'ud')
  const vscodeCli = (a) => run(cli, ['--extensions-dir', extDir, '--user-data-dir', userDir, ...a], root, cliEnv)
  const ids = Object.entries(EXTENSIONS).map(([id, v]) => (latest ? id : `${id}@${v}`))
  vscodeCli([...ids.flatMap((id) => ['--install-extension', id])])
  const versions = vscodeCli(['--list-extensions', '--show-versions']).trim().split(/\r?\n/)
  console.log(`VS Code ${vscodeCli(['--version']).split(/\r?\n/)[0]}, ${versions.join(', ')}`)
  mkdirSync(join(userDir, 'User'), { recursive: true })
  writeFileSync(
    join(userDir, 'User', 'settings.json'),
    JSON.stringify(
      {
        'security.workspace.trust.enabled': false,
        'telemetry.telemetryLevel': 'off',
        'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false,
        'update.mode': 'none',
        'workbench.startupEditor': 'none',
        'window.restoreWindows': 'none',
        'jest.runMode': 'on-demand',
        'chat.disableAIFeatures': true,
      },
      null,
      2,
    ),
  )

  const workspaces = {}
  for (const name of scenarios) {
    const ws = join(root, `ws-${name}`)
    workspaces[name] = ws
    mkdirSync(join(ws, 'tests'), { recursive: true })
    // CommonJS projects, the kind create-next-app makes (the loader's CJS entry, I13).
    writeFileSync(join(ws, 'package.json'), `{ "name": "ws-${name}", "private": true }\n`)
    writeFileSync(join(ws, 'arca.json'), JSON.stringify({ id: 'arc_vscodecheckqq', name: 'vscode-check', vars: { API_KEY: { required: true } } }, null, 2))
    for (const [file, content] of Object.entries(SCENARIOS[name].files)) {
      mkdirSync(join(ws, file, '..'), { recursive: true })
      writeFileSync(join(ws, file), content)
    }
    npmInstall(ws, [tgz, ...SCENARIOS[name].deps])
  }
  console.log(`installed ${scenarios.length} workspace(s)`)

  // Stores the secret the way `arca set` does at a terminal. With the repo's build (the same one
  // that was packed): loading the workspace's copy would load its native keyring module, and
  // Windows locks that file until this process exits, so the workspace couldn't be deleted.
  api = await import(pathToFileURL(join(repo, 'dist', 'index.mjs')).href)
  const env = personEnv(api.detectAgent)
  let said = ''
  const write = (s) => void (said += s)
  const noPrompt = async (m) => {
    throw new Error(`unexpected prompt: ${m}`)
  }
  const code = await api.main(['set', 'API_KEY'], {
    env,
    cwd: workspaces[scenarios[0]],
    platform: process.platform,
    stdout: { write, isTTY: true },
    stderr: { write, isTTY: true },
    stdinIsTTY: false,
    readStdin: async () => `${SECRET}\n`,
    prompts: { password: noPrompt, text: noPrompt, confirm: noPrompt, multiselect: noPrompt },
    childStdin: 'ignore',
    handleSignals: false,
  })
  if (code !== 0) throw new Error(`arca set failed (${code}):\n${said}`)
  console.log(`secret stored (${passphrase ? 'passphrase' : 'OS keychain'})\n`)

  // VS Code starts with this process's env: make it a person's.
  for (const k of Object.keys(process.env)) delete process.env[k]
  Object.assign(process.env, env)
  for (const name of scenarios) {
    const ws = workspaces[name]
    const started = Date.now()
    // VS Code's own logging goes to <scenario>.log.
    const logLines = []
    const sink = { write: (d) => void logLines.push(String(d)) }
    const log = console.log
    console.log = (...a) => sink.write(`${a.join(' ')}
`) // test-electron's "Exit code: 0"
    try {
      await electron.runTests({
        stdout: sink,
        stderr: sink,
        vscodeExecutablePath: exe,
        extensionDevelopmentPath: join(fixtures, 'driver'),
        extensionTestsPath: join(fixtures, 'driver', 'suite.js'),
        extensionTestsEnv: { ARCA_SCENARIO: name, ARCA_OUT: out, ARCA_SHOT: windows ? join(fixtures, 'shot.ps1') : '' },
        launchArgs: [
          ws,
          '--extensions-dir',
          extDir,
          '--user-data-dir',
          userDir,
          '--enable-proposed-api=arca.arca-vscode-driver',
          '--disable-workspace-trust',
          '--skip-welcome',
          '--skip-release-notes',
          '--disable-gpu',
        ],
      })
    } catch (e) {
      logLines.push(`runTests: ${e.message}\n`)
    } finally {
      console.log = log
      writeFileSync(join(out, `${name}.log`), logLines.join(''))
    }
    const problems = evaluate(name, ws)
    const took = `${Math.round((Date.now() - started) / 1000)}s`
    if (problems.length) {
      failed++
      console.log(`✖ ${name} (${took})\n  ${problems.join('\n  ')}`)
    } else console.log(`✔ ${name} (${took})`)
  }
} catch (e) {
  failed++
  console.log(`✖ ${e.message}`)
} finally {
  if (!passphrase && api) forgetKey()
  if (process.env.ARCA_VSCODE_KEEP) console.log(`\nkept ${root}`)
  else {
    // On Windows, antivirus may still be reading freshly installed binaries (esbuild, rollup).
    for (const e of readdirSync(root)) {
      if (e === 'out') continue
      try {
        rmSync(join(root, e), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
      } catch (err) {
        console.log(`couldn't delete ${join(root, e)}: ${err.code}`)
      }
    }
    console.log(`\nreports and screenshots: ${out}`)
  }
}

/** Deletes the test store's master key from the OS keychain (the account keychain.ts gives a custom ARCA_HOME). */
function forgetKey() {
  const account = `master-key/v1/${createHash('sha256').update(store).digest('hex').slice(0, 12)}`
  try {
    const { Entry } = createRequire(join(repo, 'package.json'))('@napi-rs/keyring')
    const key = new Entry('arca', account, process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined)
    if (key.getPassword() === null) console.log(`(no keychain entry arca/${account} to delete)`)
    else key.deletePassword()
  } catch (e) {
    console.log(`couldn't delete the keychain entry arca/${account}: ${e.message}`)
  }
}

if (failed) {
  console.log(`${failed} VS Code check(s) failed`)
  process.exit(1)
}
console.log('VS Code check passed')
