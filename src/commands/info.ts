import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { DEFAULT_PROFILE, isSensitive } from '../config.js'
import { isTemplateFile, loadEnvFiles } from '../envfiles.js'
import { ArcaError } from '../errors.js'
import { chooseBackend, loadMasterKey } from '../keychain.js'
import { scanEnvFiles, type Finding } from '../leakguard.js'
import { humanGate } from '../policy.js'
import { MIN_NEEDLE_LENGTH } from '../redact.js'
import { gitRemote, type ResolvedVar, type Session } from '../session.js'
import type { AgentRunPolicy, VaultData } from '../store.js'
import { pad, type Paint, type Style } from '../style.js'
import { plural, shortDate } from '../util.js'
import { KNOWN_TOOLS, firstCommand } from './init.js'

// Commands agents may use: they print names, never values.

interface Row {
  name: string
  status: 'arca' | 'env-file' | 'env-file-sensitive' | 'missing' | 'unset'
  source?: string
  /** For values from arca: the profile that stores it (differs from the row's profile when inherited). */
  profile?: string
  inherited?: boolean
  sensitive: boolean
  required: boolean
  declared: boolean
  updatedAt?: string
  description?: string
}

function rows(s: Session, values: Map<string, ResolvedVar>, profile = s.profile): Row[] {
  const project = s.requireProject()
  const decls = project.config.vars
  const files = s.envFilesFor(profile).filter((f) => !isTemplateFile(f.name))
  // Files arca loads become process env, which beats the files a framework loads itself.
  // Among arca's own envFiles, later ones win.
  const loaded = s.envFiles(profile).map((f) => resolve(project.root, f))
  const ranked = [...files].sort((a, b) => loaded.indexOf(b.path) - loaded.indexOf(a.path))
  const inFile = (name: string) => ranked.find((f) => f.entries.some((e) => e.key === name && e.value !== ''))
  const names = [...new Set([...Object.keys(decls), ...values.keys()])]
  return names.map((name) => {
    const d = decls[name]
    const stored = values.get(name)
    const sensitive = isSensitive(d)
    const file = inFile(name)
    const base = { name, sensitive, required: Boolean(d?.required), declared: Boolean(d), description: d?.description }
    if (stored) return { ...base, status: 'arca', profile: stored.profile, inherited: stored.profile !== profile, updatedAt: stored.updatedAt }
    if (file) return { ...base, status: sensitive ? 'env-file-sensitive' : 'env-file', source: relative(project.root, file.path) || file.name }
    return { ...base, status: d?.required ? 'missing' : 'unset' }
  })
}

function statusText(r: Row, p: Paint): string {
  switch (r.status) {
    case 'arca':
      return r.inherited ? p('green', `✔ arca ↳ ${r.profile}`) : p('green', '✔ arca')
    case 'env-file':
      return p('cyan', `✔ ${r.source}`)
    case 'env-file-sensitive':
      return p('yellow', `⚠ ${r.source} (should be in arca)`)
    case 'missing':
      return p('red', '✖ missing (required)')
    case 'unset':
      return p('dim', '– not set')
  }
}

export async function listCommand(s: Session): Promise<number> {
  const project = s.requireProject()
  s.warnConfig()
  const values = await s.resolve()
  const list = rows(s, values)
  if (s.json) {
    s.print(JSON.stringify(list.map(({ description, inherited, ...r }) => ({ ...r, description: description ?? null })), null, 2))
    return 0
  }
  const p = s.out
  if (list.length === 0) {
    s.print(`No variables declared or stored for ${s.forWhom()} yet. Declare them in arca.json, then run \`npx arca setup${s.profileFlag()}\`.`)
    return 0
  }
  // Several profiles and none picked explicitly: one column per profile.
  if (s.multiProfile && s.profileSource !== 'flag') return listMatrix(s)
  const w = Math.max(4, ...list.map((r) => r.name.length)) + 2
  const sw = Math.max(...list.map((r) => statusText(r, (_, t) => t).length)) + 2
  s.print(p('bold', `${pad('NAME', w)}${pad('STATUS', sw)}${pad('KIND', 9)}UPDATED`))
  for (const r of list) {
    const kind = r.sensitive ? 'secret' : 'config'
    const extra = r.declared ? '' : p('dim', '  (undeclared)')
    s.print(`${pad(r.name, w)}${pad(statusText(r, p), sw)}${pad(kind, 9)}${shortDate(r.updatedAt)}${extra}`)
  }
  return 0
}

/**
 * The `arca list` matrix:
 *                  ontwikkel ●    acceptatie         test
 *   DATABASE_URL   ✔ set          ✔ set              ↳ ontwikkel
 */
async function listMatrix(s: Session): Promise<number> {
  const p = s.out
  const profiles = s.profiles
  const tables = new Map<string, Map<string, Row>>()
  for (const profile of profiles) tables.set(profile, new Map(rows(s, await s.resolve(profile), profile).map((r) => [r.name, r])))
  const names = [...new Set([...tables.values()].flatMap((t) => [...t.keys()]))]
  const cell = (r: Row | undefined): [string, Style] => {
    if (!r) return ['–', 'dim']
    if (r.status === 'arca') return r.inherited ? [`↳ ${r.profile}`, 'green'] : ['✔ set', 'green']
    if (r.status === 'env-file') return [r.source!, 'cyan']
    if (r.status === 'env-file-sensitive') return [`⚠ ${r.source}`, 'yellow']
    if (r.status === 'missing') return ['✖ missing', 'red']
    return ['–', 'dim']
  }
  const heads = profiles.map((x) => (x === s.profile ? `${x} ●` : x))
  const w = Math.max(4, ...names.map((n) => n.length)) + 2
  const widths = profiles.map((x, i) => Math.max(heads[i]!.length, ...names.map((n) => cell(tables.get(x)!.get(n))[0].length)) + 3)
  s.print(p('bold', (pad('', w) + heads.map((h, i) => pad(h, widths[i]!)).join('')).trimEnd()))
  for (const name of names) {
    const cells = profiles.map((x, i) => {
      const [text, color] = cell(tables.get(x)!.get(name))
      return pad(p(color, text), widths[i]!)
    })
    const declared = [...tables.values()].some((t) => t.get(name)?.declared)
    s.print(`${pad(name, w)}${cells.join('')}${declared ? '' : p('dim', '(undeclared)')}`.trimEnd())
  }
  s.print(p('dim', `\n● active profile: ${s.profile}${activeWhy(s)}. Switch with \`npx arca use <profile>\`.`))
  return 0
}

/** " (via arca use)", " (the default)", or nothing when the profile is literally called "default". */
export function activeWhy(s: Session): string {
  if (s.profileSource !== 'default') return ` (via ${sourceLabel(s)})`
  return s.profile === DEFAULT_PROFILE ? '' : ' (the default)'
}

export function sourceLabel(s: Session): string {
  return s.profileSource === 'flag' ? '--profile' : s.profileSource === 'env' ? 'ARCA_PROFILE' : s.profileSource === 'use' ? 'arca use' : 'default'
}

// ── check ────────────────────────────────────────────────────────────────

interface CheckResult {
  profile: string
  required: number
  missing: string[]
  misplaced: string[]
  undeclared: string[]
}

async function checkProfile(s: Session, profile: string): Promise<CheckResult> {
  const project = s.requireProject()
  const values = await s.resolve(profile)
  const files = s.envFilesFor(profile).filter((f) => !isTemplateFile(f.name))
  const envFileValues = loadEnvFiles(project.root, s.envFiles(profile))
  const present = (name: string) =>
    values.has(name) ||
    Boolean(s.io.env[name]) ||
    Boolean(envFileValues[name]) ||
    files.some((f) => f.entries.some((e) => e.key === name && e.value !== ''))
  const required = Object.entries(project.config.vars).filter(([, d]) => d.required)
  return {
    profile,
    required: required.length,
    missing: required.filter(([n]) => !present(n)).map(([n]) => n),
    misplaced: required.filter(([n, d]) => isSensitive(d) && !values.has(n) && !s.io.env[n] && present(n)).map(([n]) => n),
    undeclared: [...values.keys()].filter((n) => !(n in project.config.vars)),
  }
}

export async function checkCommand(s: Session, opts: { strict?: boolean; allProfiles?: boolean }): Promise<number> {
  const project = s.requireProject()
  s.warnConfig()
  const results: CheckResult[] = []
  for (const profile of opts.allProfiles ? s.profiles : [s.profile]) results.push(await checkProfile(s, profile))
  const findings = scanEnvFiles(project, s.envFilesForGuard(), await s.allSecrets())
  const missingAny = results.some((r) => r.missing.length > 0)

  if (s.json) {
    const ok = !missingAny && (!opts.strict || findings.length === 0)
    if (opts.allProfiles) {
      const profiles = Object.fromEntries(results.map(({ profile, required, ...r }) => [profile, { ok: r.missing.length === 0, ...r }]))
      s.print(JSON.stringify({ ok, profiles, leakGuard: findings }, null, 2))
    } else {
      const r = results[0]!
      s.print(JSON.stringify({ ok, profile: r.profile, missing: r.missing, inEnvFiles: r.misplaced, undeclared: r.undeclared, leakGuard: findings }, null, 2))
    }
  } else {
    const p = s.out
    for (const r of results) {
      const who = s.forWhom(r.profile)
      if (r.missing.length === 0) s.print(`${p('green', '✔')} All ${plural(r.required, 'required variable')} set for ${who}`)
      else {
        s.print(`${p('red', '✖')} ${plural(r.missing.length, 'required variable')} missing for ${who}: ${r.missing.join(', ')}`)
        s.print(`  Run \`npx arca setup${s.profileFlag(r.profile)}\` to set them. (AI agents: ask the user to run it.)`)
      }
      for (const n of r.misplaced) s.print(`${p('yellow', '⚠')} ${n} is a secret but comes from a .env file. Move it: npx arca import --only ${n} --delete${s.profileFlag(r.profile)}`)
      if (r.undeclared.length) s.print(p('dim', `  stored but not declared in arca.json: ${r.undeclared.join(', ')}`))
    }
    if (findings.length) {
      s.print(`${p('yellow', '⚠')} Leak guard: ${plural(findings.length, 'possible secret')} in .env files (run \`npx arca doctor\` for details)`)
    }
  }
  if (missingAny) return 1
  if (opts.strict && findings.length) return 1
  return 0
}

// ── doctor ───────────────────────────────────────────────────────────────

export async function doctorCommand(s: Session): Promise<number> {
  const p = s.out
  const ok = (t: string) => s.print(`  ${p('green', '✔')} ${t}`)
  const warn = (t: string) => s.print(`  ${p('yellow', '⚠')} ${t}`)
  const bad = (t: string) => s.print(`  ${p('red', '✖')} ${t}`)
  const info = (t: string) => s.print(`  ${p('dim', '·')} ${t}`)
  let problems = 0

  s.print(p('bold', 'Context'))
  info(`Node ${process.version} on ${s.io.platform}`)
  const a = s.ctx.agent
  if (a.detected) info(`You look like an AI agent: ${a.name} via ${a.via}. Values can't be shown or changed from here.`)
  else info('No AI agent detected')
  info(s.ctx.interactiveOutput && s.ctx.stdinIsTTY ? 'Interactive terminal' : 'Not an interactive terminal')
  if (s.ctx.ci) info('CI detected: wrapped scripts pass through without a store')

  s.print(p('bold', '\nStore'))
  info(`Location: ${s.store.root}`)
  const backend = chooseBackend(s.store, s.io)
  info(`Key storage: ${backend === 'os' ? osKeychainName(s.io.platform) : 'passphrase (master.key.enc)'}`)
  let master: Buffer | null = null
  try {
    master = await loadMasterKey(s.store, s.io, { create: false })
    if (master) ok('Master key found')
    else if (s.store.hasAnyVault()) {
      bad('Master key missing, but vaults exist. They cannot be decrypted.')
      problems++
    } else info('No master key yet (created on the first `npx arca set`)')
  } catch (e) {
    bad((e as Error).message.replace(/^arca: /, ''))
    problems++
  }

  if (!s.project) {
    s.print(p('bold', '\nProject'))
    info('No arca.json here or in any parent folder. Run `npx arca init`.')
    return problems ? 1 : 0
  }
  const project = s.project
  s.print(p('bold', '\nProject'))
  info(`${project.config.name} (${project.config.id})`)
  info(`Config: ${project.file}`)
  for (const w of project.warnings) warn(w)
  const reg = s.store.readRegistry()[project.config.id]
  const remote = gitRemote(project.root)
  if (reg?.gitRemote && remote && reg.gitRemote !== remote) {
    warn(`The ID is also used by ${reg.roots[0]} (git remote ${reg.gitRemote}). If these are different projects: npx arca init --new-id`)
    problems++
  }

  s.print(p('bold', s.multiProfile ? '\nProfiles' : '\nVault'))
  if (s.multiProfile) info(`Active: ${s.profile} (${sourceLabel(s)})${s.staleActiveProfile ? `; \`arca use\` points at "${s.staleActiveProfile}", which no longer exists` : ''}`)
  const decls = project.config.vars
  let active: Map<string, ResolvedVar> | null = null
  for (const profile of s.profiles) {
    const label = s.multiProfile ? `${profile}: ` : ''
    if (!s.hasVault(profile)) {
      info(`${label}no secrets stored on this machine yet`)
      const missing = Object.entries(decls).filter(([, d]) => d.required && isSensitive(d)).map(([n]) => n)
      if (missing.length) warn(`${label}required secrets not stored: ${missing.join(', ')}. Run \`npx arca setup${s.profileFlag(profile)}\`.`)
      continue
    }
    if (!master) continue
    const values = await s.resolve(profile)
    if (profile === s.profile) active = values
    const own = [...values.values()].filter((v) => v.profile === profile).length
    const inherited = values.size - own
    ok(`${label}${plural(own, 'secret')} stored${inherited ? `, ${inherited} inherited` : ''}`)
    const short = [...values].filter(([n, v]) => v.profile === profile && isSensitive(decls[n]) && v.value.length < MIN_NEEDLE_LENGTH)
    for (const [n] of short) warn(`${label}${n} is shorter than ${MIN_NEEDLE_LENGTH} characters, so it isn't masked in output`)
    const missing = Object.entries(decls).filter(([n, d]) => d.required && isSensitive(d) && !values.has(n)).map(([n]) => n)
    if (missing.length) warn(`${label}required secrets not stored: ${missing.join(', ')}. Run \`npx arca setup${s.profileFlag(profile)}\`.`)
  }

  // package.json scripts
  const pkgFile = join(s.packageRoot() ?? project.root, 'package.json')
  if (existsSync(pkgFile)) {
    s.print(p('bold', '\nScripts'))
    const scripts = (JSON.parse(readFileSync(pkgFile, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {}
    const wrapped = Object.keys(scripts).filter((k) => /\barca\s+run\b/.test(scripts[k]!))
    const unwrapped = Object.entries(scripts)
      .filter(([k, v]) => k !== 'start' && !/\barca\s+run\b/.test(v) && KNOWN_TOOLS.has(firstCommand(v) ?? ''))
      .map(([k]) => k)
    if (wrapped.length) ok(`Wrapped with arca run: ${wrapped.join(', ')}`)
    else warn('No scripts use `arca run` yet, so nothing gets secrets. Run `npx arca init` to wrap them.')
    if (unwrapped.length) info(`Not wrapped (no secrets): ${unwrapped.join(', ')}`)
  }

  // envFiles pitfalls
  const allEnvFiles = [...project.config.envFiles, ...Object.values(project.config.profiles).flatMap((x) => x.envFiles)]
  const modeFiles = [...new Set(allEnvFiles)].filter((f) => /^\.env\.(development|production|test)(\.local)?$/.test(f))
  for (const f of modeFiles) {
    warn(`envFiles lists ${f}. arca injects it as process env, which beats the framework's own mode files (e.g. in \`next build\`). Prefer a name frameworks don't load.`)
  }

  // leak guard
  s.print(p('bold', '\nLeak guard (.env files)'))
  const files = s.envFilesForGuard()
  const findings = scanEnvFiles(project, files, master ? await s.allSecrets() : [])
  if (files.length === 0) info('No .env files')
  else if (findings.length === 0) ok(`${plural(files.length, 'file')} checked, no secrets found: ${files.map((f) => f.name).join(', ')}`)
  for (const f of findings) {
    const fn = f.tracked ? bad : warn
    fn(`${f.detail}${f.tracked ? ' (committed to git!)' : ''}`)
    s.print(`      ${p('dim', fixFor(f))}`)
    problems++
  }

  // credential-receiving URLs in .env
  const stored = active ?? new Map<string, ResolvedVar>()
  const secretPrefixes = new Set([...stored.keys()].map((n) => n.split('_')[0]))
  for (const file of files) {
    for (const e of file.entries) {
      if (!/^https?:\/\//i.test(e.value) || decls[e.key]?.sensitive === true) continue
      if (secretPrefixes.has(e.key.split('_')[0]) && !stored.has(e.key)) {
        info(`${e.key} in ${file.name} is a URL next to the secret ${e.key.split('_')[0]}_… If it receives that credential, keep it in arca so only you can change it.`)
      }
    }
  }

  if (master) {
    const policy = s.store.readPolicy(master, project.config.id)
    s.print(p('bold', '\nAgent policy'))
    info(policy.agentRun === 'scripts' ? 'Agents get secrets only through package.json scripts (default)' : 'Agents never get secrets (deny)')
  }

  s.print('')
  s.print(problems ? `${p('yellow', `${plural(problems, 'issue')} found.`)}` : p('green', 'No problems found.'))
  return problems ? 1 : 0
}

function fixFor(f: Finding): string {
  if (f.rule === 'stored') return `fix: delete the line from ${f.file}, or run: npx arca import ${f.file} --only ${f.key} --delete`
  if (f.rule === 'declared') return `fix: npx arca import ${f.file} --only ${f.key} --delete   (or declare it "sensitive": false if it's config)`
  return `fix: npx arca import ${f.file} --only ${f.key} --delete   (or, if it's not secret, declare it "sensitive": false or add it to leakGuard.ignore)`
}

function osKeychainName(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'Windows Credential Manager'
  if (platform === 'darwin') return 'macOS Keychain'
  return 'Secret Service (GNOME Keyring / KWallet)'
}

// ── status (no arguments) ────────────────────────────────────────────────

export async function statusCommand(s: Session, version: string): Promise<number> {
  const p = s.out
  s.print(`${p('bold', 'arca')} ${version}: secrets out of your .env files, masked in all output`)
  if (!s.project) {
    s.print('\nNo arca.json in this folder or any parent. Get started:  npx arca init')
    s.print('Commands:  npx arca help')
    return 0
  }
  s.warnConfig()
  const project = s.project
  const values = await s.resolve()
  const list = rows(s, values)
  const missing = list.filter((r) => r.status === 'missing').map((r) => r.name)
  s.print(`\nProject   ${project.config.name} (${project.config.id})`)
  if (s.multiProfile) s.print(`Profile   ${s.profile}${activeWhy(s)}  ${p('dim', `(profiles: ${s.profiles.join(', ')})`)}`)
  s.print(`Secrets   ${values.size} stored${missing.length ? p('red', `, missing: ${missing.join(', ')}`) : ''}`)
  const policy = await s.policy()
  s.print(`Agents    ${policy.agentRun === 'scripts' ? 'package scripts only, output masked' : 'denied'}`)
  s.print(`You       ${s.ctx.agent.detected ? `AI agent (${s.ctx.agent.name} via ${s.ctx.agent.via})` : s.ctx.interactiveOutput ? 'interactive terminal' : 'non-interactive'}`)
  s.print(`Store     ${s.store.root}`)
  s.print(`\n${missing.length ? `Next: npx arca setup${s.profileFlag()}` :'Run your app as usual, e.g. npm run dev'}    ·    npx arca help`)
  return 0
}

// ── policy ───────────────────────────────────────────────────────────────

export async function policyCommand(s: Session, args: string[]): Promise<number> {
  const project = s.requireProject()
  const [action = 'show', key, value] = args
  if (action === 'show') {
    const policy = await s.policy()
    s.print(`agent-run: ${policy.agentRun}`)
    s.print(s.out('dim', policy.agentRun === 'scripts' ? '  Agents get secrets only through verified package.json scripts (default).' : '  Agents never get secrets.'))
    return 0
  }
  if (action !== 'set' || key !== 'agent-run' || (value !== 'scripts' && value !== 'deny')) {
    throw new ArcaError('arca: usage: npx arca policy [show]  |  npx arca policy set agent-run <scripts|deny>', 2)
  }
  await humanGate(s.io, s.ctx, { kind: 'write', command: `npx arca policy set agent-run ${value}` })
  const master = await s.masterKey(true)
  s.store.writePolicy(master, project.config.id, { agentRun: value as AgentRunPolicy })
  s.note(`${s.err('green', '✔')} agent-run is now ${value} for ${project.config.name}`)
  return 0
}

// ── projects ─────────────────────────────────────────────────────────────

export async function projectsCommand(s: Session, args: string[]): Promise<number> {
  const [action, id] = args
  const reg = s.store.readRegistry()
  if (!action || action === 'list') {
    const ids = new Set([...Object.keys(reg), ...s.store.projectIds()])
    if (ids.size === 0) {
      s.print('No projects on this machine yet.')
      return 0
    }
    for (const pid of ids) {
      const e = reg[pid]
      s.print(`${pid}  ${e?.name ?? '(unknown)'}  ${s.out('dim', e?.roots.join(', ') ?? '')}`)
    }
    return 0
  }
  if (action !== 'rm' || !id) throw new ArcaError('arca: usage: npx arca projects [list]  |  npx arca projects rm <id>', 2)
  await humanGate(s.io, s.ctx, { kind: 'write', command: `npx arca projects rm ${id}` })
  if (!reg[id] && !s.store.projectIds().includes(id)) throw new ArcaError(`arca: no project ${id} on this machine.`)
  const yes = await s.io.prompts.confirm(`Delete all secrets of ${reg[id]?.name ?? id} on this machine? This can't be undone.`, false)
  if (!yes) throw new ArcaError('arca: cancelled.')
  s.store.removeProject(id)
  s.note(`${s.err('green', '✔')} Removed ${id}`)
  return 0
}
