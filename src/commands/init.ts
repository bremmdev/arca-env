import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CONFIG_FILE, declareVars, invalidProfileName, isSensitive, newConfig, newProjectId, normalizeProfile, parseProject, updateConfigFile, type VarDecl } from '../config.js'
import { tokenize } from '../context.js'
import { DEV_FILES, isTemplateFile, readEnvFile, type EnvFile } from '../envfiles.js'
import { ArcaError } from '../errors.js'
import { chooseBackend } from '../keychain.js'
import { isPublicName, secretReason } from '../leakguard.js'
import { agentsSnippet } from '../messages.js'
import { humanGate } from '../policy.js'
import { Session } from '../session.js'
import { plural } from '../util.js'
import { storeValue } from './values.js'

export const KNOWN_TOOLS = new Set([
  'next', 'vite', 'astro', 'nuxt', 'nuxi', 'react-router', 'remix', 'svelte-kit', 'vinxi', 'tsx', 'node',
  'vitest', 'jest', 'playwright', 'prisma', 'drizzle-kit', 'wrangler', 'turbo', 'nodemon', 'ts-node', 'tsup',
  'tanstack', 'storybook', 'start-storybook', 'netlify', 'vercel', 'nest', 'expo', 'react-scripts', 'webpack',
])

/** The tool a script runs first (`next dev` → next, `npx prisma migrate` → prisma). Null for compound scripts. */
export function firstCommand(script: string): string | null {
  if (/&&|\|\||[;|<>]/.test(script)) return null
  const tokens = tokenize(script)
  let i = 0
  if (tokens[i] === 'npx' || tokens[i] === 'bunx' || tokens[i] === 'dotenv') i++
  if ((tokens[i] === 'pnpm' || tokens[i] === 'yarn') && tokens[i + 1] === 'exec') i += 2
  const t = tokens[i]
  if (!t || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t === 'cross-env') return null
  return basename(t)
}

interface Pkg {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const FRAMEWORKS: [string, string][] = [
  ['next', 'Next.js'],
  ['@tanstack/react-start', 'TanStack Start'],
  ['@tanstack/solid-start', 'TanStack Start'],
  ['astro', 'Astro'],
  ['nuxt', 'Nuxt'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['@remix-run/dev', 'Remix'],
  ['@react-router/dev', 'React Router'],
  ['vite', 'Vite'],
]

function detectFramework(pkg: Pkg): string | null {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const [dep, label] of FRAMEWORKS) {
    if (deps[dep]) return `${label} ${deps[dep]!.replace(/^[\^~]/, '')}`
  }
  return null
}

export interface InitOptions {
  yes?: boolean
  newId?: boolean
  import?: boolean
}

export async function initCommand(s: Session, opts: InitOptions): Promise<number> {
  const { io } = s
  const root = io.cwd
  const configFile = join(root, CONFIG_FILE)
  const pkgFile = join(root, 'package.json')
  const pkg: Pkg | null = existsSync(pkgFile) ? (JSON.parse(readFileSync(pkgFile, 'utf8')) as Pkg) : null
  // Without a terminal (agents, scripts) init uses the defaults instead of asking.
  const interactive = s.ctx.interactiveOutput && s.ctx.stdinIsTTY && !opts.yes
  const ok = (t: string) => s.note(`${s.err('green', '✔')} ${t}`)
  const step = (t: string) => s.note(`${s.err('cyan', '◇')} ${t}`)
  const ask = async (q: string, initial = true) => {
    if (!interactive) return initial
    const r = await io.prompts.confirm(q, initial)
    if (r === null) throw new ArcaError('arca: cancelled.')
    return r
  }

  // 1. arca.json
  let created = false
  if (existsSync(configFile)) {
    if (opts.newId) {
      const id = newProjectId()
      updateConfigFile(configFile, (raw) => {
        raw.id = id
      })
      ok(`New project ID ${id}. This project no longer shares secrets with the old ID.`)
      return 0
    }
    const existing = parseProject(readFileSync(configFile, 'utf8'), configFile)
    step(`arca.json already exists (${existing.config.name}, ${existing.config.id}). Checking the rest of the setup.`)
  } else {
    let name = pkg?.name?.replace(/^@[^/]+\//, '') ?? basename(root)
    if (interactive) {
      const answer = await io.prompts.text('Project name', { initial: name })
      if (answer === null) throw new ArcaError('arca: cancelled.')
      name = answer.trim() || name
    }
    writeFileSync(configFile, JSON.stringify(newConfig(name), null, 2) + '\n')
    created = true
  }

  const framework = pkg ? detectFramework(pkg) : null
  if (framework) step(`Detected ${framework}`)

  // 2. .env files: sort secrets from config.
  const devFiles = DEV_FILES.map((f) => readEnvFile(join(root, f), f)).filter((f) => f !== null)
  const otherFiles = safeReaddir(root).filter((n) => /^\.env\./.test(n) && !DEV_FILES.includes(n) && !isTemplateFile(n))
  const merged = new Map<string, string>()
  for (const f of devFiles) for (const e of f.entries) merged.set(e.key, e.value)
  let secretKeys: string[] = []
  const config = parseProject(readFileSync(configFile, 'utf8'), configFile).config
  if (merged.size === 0) {
    step('No .env files with values found. Secrets go in arca (`npx arca set NAME`), non-sensitive config can stay in .env.')
  } else {
    step(`Found ${devFiles.map((f) => `${f.name} (${plural(f.entries.length, 'var')})`).join(', ')}`)
    const keys = [...merged.keys()]
    const suggested = keys.filter((k) => {
      const d = config.vars[k]
      if (d) return d.sensitive !== false
      return Boolean(secretReason(k, merged.get(k)!))
    })
    if (interactive) {
      const picked = await io.prompts.multiselect(
        'Which of these are secrets? Secrets move to arca, the rest stays in .env as config.',
        keys.map((k) => ({ value: k, label: k, hint: isPublicName(k) ? 'public' : secretReason(k, merged.get(k)!) ?? undefined })),
        suggested,
      )
      if (picked === null) throw new ArcaError('arca: cancelled.')
      secretKeys = picked
    } else secretKeys = suggested
    const stays = keys.filter((k) => !secretKeys.includes(k))
    s.note(`    → arca    ${secretKeys.join(', ') || '(none)'}`)
    s.note(`    stays     ${stays.join(', ') || '(none)'}`)
    const decls: Record<string, VarDecl> = {}
    for (const k of secretKeys) decls[k] = { required: true }
    for (const k of stays) decls[k] = { sensitive: false }
    declareVars(configFile, decls)
  }
  // 2b. `.env.<name>` files hold other sets of values: offer each as a profile.
  const plans = await planProfiles(s, configFile, otherFiles, merged, secretKeys, ask)
  const modeFiles = otherFiles.filter((n) => MODE_FILE.test(n))
  const leftAlone = otherFiles.filter((n) => !modeFiles.includes(n) && !plans.some((p) => p.file.name === n))
  if (modeFiles.length) step(`Left alone: ${modeFiles.join(', ')} (framework mode files, your framework loads them itself)`)
  if (leftAlone.length) step(`Left alone: ${leftAlone.join(', ')}`)
  ok(`${created ? 'Created' : 'Updated'} arca.json${created ? ` (id ${parseProject(readFileSync(configFile, 'utf8'), configFile).config.id})` : ''}`)

  // 3. Import the secret values (humans only).
  const session = new Session(io) // reload with the new arca.json
  let imported = 0
  const profileImports = plans.filter((p) => p.store.size > 0)
  if ((secretKeys.length || profileImports.length) && opts.import !== false) {
    try {
      await humanGate(io, session.ctx, { kind: 'write', command: 'npx arca import' })
      const hadKey = session.store.readGlobalConfig().keychain !== undefined
      if (secretKeys.length) {
        const vault = await session.readVault()
        for (const k of secretKeys) {
          const v = merged.get(k)!
          if (v === '') continue
          const source = [...devFiles].reverse().find((f) => f.entries.some((e) => e.key === k))?.name ?? '.env'
          storeValue(vault, k, v, `import:${source}`)
          imported++
        }
        await session.writeVault(vault)
      }
      for (const plan of profileImports) {
        const ps = new Session(io, { profile: plan.name })
        const vault = await ps.readVault()
        for (const [k, v] of plan.store) storeValue(vault, k, v, `import:${plan.file.name}`)
        await ps.writeVault(vault)
        imported += plan.store.size
      }
      if (!hadKey) ok(`Master key created in ${chooseBackend(session.store, io) === 'os' ? keychainLabel(io.platform) : 'a passphrase-protected file'}`)
      const per = profileImports.length ? ` (${[`${session.defaultProfile}: ${secretKeys.length}`, ...profileImports.map((p) => `${p.name}: ${p.store.size}`)].join(', ')})` : ''
      ok(`Imported ${plural(imported, 'secret')} into arca${per}`)
      ok('Your .env files were not changed')
    } catch (e) {
      if (!(e instanceof ArcaError)) throw e
      s.note(`${s.err('yellow', '✋')} Moving secret values into arca needs a human. Ask the user to run:  npx arca import`)
      for (const p of profileImports) s.note(`   and:  npx arca import ${p.file.name} --profile ${p.name}`)
      s.note('   (the .env files stay untouched)')
    }
  }

  // 4. Wrap package.json scripts.
  if (pkg?.scripts) {
    const candidates = Object.entries(pkg.scripts).filter(([k, v]) => k !== 'start' && !/\barca\s+run\b/.test(v) && KNOWN_TOOLS.has(firstCommand(v) ?? ''))
    let toWrap = candidates.map(([k]) => k)
    if (candidates.length && interactive) {
      const picked = await io.prompts.multiselect(
        'Wrap these package.json scripts with `arca run`, so they get secrets?',
        candidates.map(([k, v]) => ({ value: k, label: k, hint: v })),
        toWrap,
      )
      if (picked === null) throw new ArcaError('arca: cancelled.')
      toWrap = picked
    }
    if (toWrap.length) {
      wrapScripts(pkgFile, toWrap)
      ok(`Wrapped scripts: ${toWrap.join(', ')}`)
      for (const k of toWrap) s.note(s.err('dim', `    ${k}: "${pkg.scripts[k]}"  →  "arca run -- ${pkg.scripts[k]}"`))
    }
    const wrappedAlready = Object.keys(pkg.scripts).filter((k) => /\barca\s+run\b/.test(pkg.scripts![k]!))
    if (wrappedAlready.length && !toWrap.length) step(`Already wrapped: ${wrappedAlready.join(', ')}`)

    // Explain every script that stays unwrapped, so nothing looks forgotten.
    const wrappedNow = new Set([...wrappedAlready, ...toWrap])
    const skipped = Object.entries(pkg.scripts).filter(([k]) => !wrappedNow.has(k))
    if (skipped.length) {
      step('Not wrapped:')
      for (const [k, v] of skipped) s.note(s.err('dim', `    ${k}: ${skipReason(k, v, pkg.scripts, wrappedNow)}`))
    }

    // `start` stays unwrapped for production; offer a local variant that gets the secrets.
    const start = pkg.scripts.start
    if (start && !/\barca\s+run\b/.test(start) && !pkg.scripts['start:local'] && KNOWN_TOOLS.has(firstCommand(start) ?? '')) {
      if (await ask('Add "start:local" to run the production build locally with your secrets?', true)) {
        addScript(pkgFile, 'start:local', `arca run -- ${start}`)
        ok(`Added "start:local": "arca run -- ${start}"`)
      }
    }
  } else if (!pkg) {
    step('No package.json here. Wrap your commands yourself: arca run -- <command>')
  }

  // 5. AGENTS.md / CLAUDE.md
  const docs = ['AGENTS.md', 'CLAUDE.md'].filter((f) => existsSync(join(root, f)))
  const marker = '## Secrets (arca)'
  const missingSnippet = docs.filter((f) => !readFileSync(join(root, f), 'utf8').includes(marker))
  if (docs.length === 0) {
    if (await ask('Create AGENTS.md with a short "Secrets (arca)" section for AI agents?', true)) {
      writeFileSync(join(root, 'AGENTS.md'), `# Agent instructions\n\n${agentsSnippet()}`)
      ok('Created AGENTS.md with the "Secrets (arca)" section')
    }
  } else if (missingSnippet.length) {
    if (await ask(`Add a "Secrets (arca)" section to ${missingSnippet.join(' and ')}?`, true)) {
      for (const f of missingSnippet) {
        const text = readFileSync(join(root, f), 'utf8')
        appendFileSync(join(root, f), `${text.endsWith('\n') ? '' : '\n'}\n${agentsSnippet()}`)
      }
      ok(`Added the "Secrets (arca)" section to ${missingSnippet.join(' and ')}`)
    }
  }
  // Sections written by an older arca version get the current text.
  const outdated = docs.filter((f) => {
    const section = findSection(readFileSync(join(root, f), 'utf8'), marker)
    return section !== null && section.text.trim() !== agentsSnippet().trim()
  })
  if (outdated.length && (await ask(`Update the "Secrets (arca)" section in ${outdated.join(' and ')} to the current text?`, true))) {
    for (const f of outdated) {
      const text = readFileSync(join(root, f), 'utf8')
      const section = findSection(text, marker)!
      const trailing = /\s*$/.exec(section.text)?.[0] ?? '\n'
      writeFileSync(join(root, f), text.slice(0, section.start) + agentsSnippet().trimEnd() + trailing + text.slice(section.end))
    }
    ok(`Updated the "Secrets (arca)" section in ${outdated.join(' and ')}`)
  }

  // 6. Next steps
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
  if (pkg && !deps['@bremmdev/arca-env']) s.note(`\nInstall arca in this project:  npm i -D @bremmdev/arca-env`)
  if (imported) {
    const withSecrets = plans.filter((p) => p.secrets.size > 0)
    const files = [...(secretKeys.length ? devFiles.map((f) => f.name) : []), ...withSecrets.map((p) => p.file.name)]
    s.note('\n' + s.err('yellow', `⚠ The ${plural(imported, 'secret')} still have plaintext copies in ${files.join(', ')}.`))
    s.note('  Remove just those entries (config lines stay):')
    if (secretKeys.length) s.note('    npx arca import --delete')
    for (const p of withSecrets) s.note(`    npx arca import ${p.file.name} --profile ${p.name} --delete`)
  } else if (!secretKeys.length) {
    s.note('\nNext: npx arca set DATABASE_URL   or   npx arca setup')
  }
  if (plans.length) s.note(`\nSwitch profiles with  npx arca use ${plans[0]!.name}  (and back with  npx arca use --reset)`)
  return 0
}

/** Files Next.js and Vite load by themselves, depending on the mode. Not profiles. */
const MODE_FILE = /^\.env\.(development|production|test)(\.local)?$/

interface ProfilePlan {
  name: string
  file: EnvFile
  extends?: string
  /** Every secret in the file. */
  secrets: Map<string, string>
  /** The secrets to store in the profile (with `extends`, only the ones that differ). */
  store: Map<string, string>
  config: string[]
}

/**
 * `.env.acceptatie` → profile `acceptatie`. Secrets go into the profile's vault and config lines
 * stay in the file, which the profile lists in `envFiles`. When the file shares most secrets with
 * the default set (or leaves some out), the profile extends the default and stores only what differs.
 */
async function planProfiles(
  s: Session,
  configFile: string,
  candidates: string[],
  defaults: Map<string, string>,
  defaultSecrets: string[],
  ask: (q: string, initial?: boolean) => Promise<boolean>,
): Promise<ProfilePlan[]> {
  const config = parseProject(readFileSync(configFile, 'utf8'), configFile).config
  const plans: ProfilePlan[] = []
  for (const fileName of candidates) {
    const m = /^\.env\.([A-Za-z0-9_-]+)$/.exec(fileName)
    if (!m || MODE_FILE.test(fileName)) continue
    const name = normalizeProfile(m[1]!)
    if (invalidProfileName(name) || name in config.profiles) continue
    const file = readEnvFile(join(s.io.cwd, fileName), fileName)
    if (!file || file.entries.length === 0) continue

    const secrets = new Map<string, string>()
    const configKeys: string[] = []
    for (const e of file.entries) {
      if (e.value === '') continue
      const d = config.vars[e.key]
      const secret = d ? isSensitive(d) : defaultSecrets.includes(e.key) || Boolean(secretReason(e.key, e.value))
      if (secret) secrets.set(e.key, e.value)
      else configKeys.push(e.key)
    }
    const same = [...secrets].filter(([k, v]) => defaultSecrets.includes(k) && defaults.get(k) === v).length
    const leavesOut = defaultSecrets.some((k) => !secrets.has(k))
    const extend = defaultSecrets.length > 0 && (leavesOut || same * 2 >= secrets.size)
    const store = new Map([...secrets].filter(([k, v]) => !extend || !defaultSecrets.includes(k) || defaults.get(k) !== v))
    const how = extend
      ? `extends ${config.defaultProfile}, ${plural(store.size, 'secret')} of its own`
      : `${plural(secrets.size, 'secret')}`
    if (!(await ask(`Create profile ${name} from ${fileName} (${how}${configKeys.length ? `, ${plural(configKeys.length, 'config line')} ${configKeys.length === 1 ? 'stays' : 'stay'} in the file` : ''})?`, true))) continue
    plans.push({ name, file, extends: extend ? config.defaultProfile : undefined, secrets, store, config: configKeys })
  }
  if (plans.length === 0) return plans

  updateConfigFile(configFile, (raw) => {
    const existing = raw.profiles && typeof raw.profiles === 'object' && Object.keys(raw.profiles).length > 0
    const profiles = (existing ? raw.profiles : { [config.defaultProfile]: {} }) as Record<string, unknown>
    for (const p of plans) {
      const decl: Record<string, unknown> = {}
      if (p.extends) decl.extends = p.extends
      if (p.config.length) decl.envFiles = [p.file.name]
      profiles[p.name] = decl
    }
    raw.profiles = profiles
  })
  const decls: Record<string, VarDecl> = {}
  for (const p of plans) {
    for (const k of p.secrets.keys()) decls[k] ??= {}
    for (const k of p.config) decls[k] ??= { sensitive: false }
  }
  declareVars(configFile, decls)
  for (const p of plans) {
    s.note(`${s.err('green', '✔')} Profile ${p.name}${p.extends ? ` (extends ${p.extends})` : ''}: ${p.store.size ? `${p.store.size} → arca` : 'no secrets of its own'}${p.config.length ? `, config stays in ${p.file.name}` : ''}`)
  }
  return plans
}

/** The arca section of an AGENTS.md: from its heading to the next heading or HTML comment block. */
export function findSection(text: string, marker: string): { start: number; end: number; text: string } | null {
  const start = text.indexOf(marker)
  if (start === -1) return null
  const rest = text.slice(start + marker.length)
  const next = rest.search(/\n(?=#{1,2} |<!--)/)
  const end = next === -1 ? text.length : start + marker.length + next + 1
  return { start, end, text: text.slice(start, end) }
}

/** Why `init` leaves a script unwrapped, in words a user can act on. */
export function skipReason(name: string, script: string, scripts: Record<string, string>, wrapped: Set<string>): string {
  if (name === 'start') {
    return 'production start, left alone on purpose (the host provides the env, and arca may not be installed there)'
  }
  if (/&&|\|\||;/.test(script)) {
    const parts = script.split(/&&|\|\||;/).map((p) => p.trim()).filter(Boolean)
    const fine = parts.every((part) => {
      const run = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/.exec(part)?.[1]
      if (run) return wrapped.has(run) || !(run in scripts) || !KNOWN_TOOLS.has(firstCommand(scripts[run]!) ?? '')
      const tool = firstCommand(part)
      return tool !== null && !KNOWN_TOOLS.has(tool)
    })
    if (fine) return 'chains other scripts and tools; the ones that need secrets are wrapped themselves'
    return 'compound command, wrap the part that needs secrets by hand'
  }
  const tool = firstCommand(script)
  if (tool === null) return 'sets env vars inline or uses cross-env, wrap by hand if it needs secrets'
  return `${tool} doesn't need secrets (wrap by hand if it does: arca run -- ${script})`
}

function addScript(pkgFile: string, name: string, script: string): void {
  const text = readFileSync(pkgFile, 'utf8')
  const indent = /\n(\s+)"/.exec(text)?.[1] ?? '  '
  const pkg = JSON.parse(text) as Pkg
  pkg.scripts = { ...pkg.scripts, [name]: script }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(pkgFile, JSON.stringify(pkg, null, indent).replace(/\n/g, eol) + eol)
}

function wrapScripts(pkgFile: string, names: string[]): void {
  const text = readFileSync(pkgFile, 'utf8')
  const indent = /\n(\s+)"/.exec(text)?.[1] ?? '  '
  const pkg = JSON.parse(text) as Pkg
  for (const n of names) {
    const v = pkg.scripts![n]!
    if (!/\barca\s+run\b/.test(v)) pkg.scripts![n] = `arca run -- ${v}`
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(pkgFile, JSON.stringify(pkg, null, indent).replace(/\n/g, eol) + eol)
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function keychainLabel(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Windows Credential Manager' : platform === 'darwin' ? 'the macOS Keychain' : 'the Secret Service keyring'
}
