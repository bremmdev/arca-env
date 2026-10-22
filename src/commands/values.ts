import { existsSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { VAR_NAME, declareVars, isSensitive, type VarDecl } from '../config.js'
import { generateSecret } from '../crypto.js'
import { DEV_FILES, readEnvFile, removeEntries, type EnvFile } from '../envfiles.js'
import { ArcaError } from '../errors.js'
import { secretReason } from '../leakguard.js'
import { humanGate } from '../policy.js'
import { MIN_NEEDLE_LENGTH } from '../redact.js'
import type { Session } from '../session.js'
import type { VaultData } from '../store.js'
import { plural, suggest } from '../util.js'

const now = () => new Date().toISOString()

export function storeValue(vault: VaultData, name: string, value: string, source: string): void {
  const old = vault.vars[name]
  vault.vars[name] = {
    value,
    updatedAt: now(),
    source,
    previous: old ? { value: old.value, updatedAt: old.updatedAt } : (vault.removed[name] ?? null),
  }
  delete vault.removed[name]
}

function checkName(name: string | undefined, usage: string): string {
  if (!name) throw new ArcaError(`arca: missing variable name. Usage: ${usage}`, 2)
  if (!VAR_NAME.test(name)) throw new ArcaError(`arca: "${name}" is not a valid environment variable name.`, 2)
  return name
}

// ── set ──────────────────────────────────────────────────────────────────

export interface SetOptions {
  name?: string
  value?: string
  /** `--generate` (true) or `--generate=48` (bytes). */
  generate?: true | number
}

export async function setCommand(s: Session, opts: SetOptions): Promise<number> {
  const project = s.requireProject()
  let name = checkName(opts.name, 'npx arca set NAME')
  const fromStdin = opts.value === undefined && opts.generate === undefined && !s.io.stdinIsTTY
  await humanGate(s.io, s.ctx, { kind: 'write', command: `npx arca set ${name}${s.profileFlag()}`, allowPipedStdin: fromStdin })

  const declared = project.config.vars
  if (!(name in declared)) {
    const guess = suggest(name, Object.keys(declared))
    if (guess && s.io.stdinIsTTY) {
      const yes = await s.io.prompts.confirm(`${name} isn't declared in arca.json. Did you mean ${guess}?`, true)
      if (yes === null) throw new ArcaError('arca: cancelled.')
      if (yes) name = guess
    }
  }

  const decl = declared[name]
  let value: string
  if (opts.generate !== undefined) {
    const bytes = opts.generate === true ? (decl?.generate?.bytes ?? 32) : opts.generate
    value = generateSecret(bytes, decl?.generate?.encoding ?? 'base64url')
  } else if (opts.value !== undefined) {
    s.note(s.err('yellow', '⚠ value passed on the command line; it may be in your shell history. Next time use `npx arca set NAME` (hidden prompt).'))
    value = opts.value
  } else if (fromStdin) {
    value = (await s.io.readStdin()).replace(/\r?\n$/, '')
  } else {
    const entered = await s.io.prompts.password(`${name}${decl?.description ? ` (${decl.description})` : ''}`)
    if (entered === null) throw new ArcaError('arca: cancelled. Nothing was changed.')
    value = entered
  }
  if (value === '') throw new ArcaError('arca: empty value. Nothing was changed. (To remove a value, use `npx arca unset NAME`.)')

  const vault = await s.readVault()
  const existed = name in vault.vars
  storeValue(vault, name, value, opts.generate !== undefined ? 'generate' : fromStdin ? 'stdin' : 'set')
  await s.writeVault(vault)

  if (!(name in declared)) {
    let declare = false
    if (s.io.stdinIsTTY) declare = (await s.io.prompts.confirm(`Declare ${name} in arca.json, so teammates know it's needed?`, true)) === true
    if (declare) declareVars(project.file, { [name]: { required: true } })
    else s.note(s.err('dim', `arca: ${name} isn't declared in arca.json. It's still injected; declare it so \`npx arca check\` and teammates know about it.`))
  }
  if (isSensitive(decl) && value.length < MIN_NEEDLE_LENGTH) {
    s.note(s.err('yellow', `⚠ ${name} is shorter than ${MIN_NEEDLE_LENGTH} characters, so it can't be masked in output.`))
  }
  if (decl && !isSensitive(decl)) {
    s.note(s.err('dim', `arca: ${name} is declared as config (sensitive: false). It's stored in arca anyway and arca's value wins over .env.`))
  }
  const what = opts.generate !== undefined ? 'Generated' : existed ? 'Updated' : 'Set'
  const undo = existed ? ` (previous value kept, \`npx arca restore ${name}${s.profileFlag()}\` undoes this)` : ''
  s.note(`${s.err('green', '✔')} ${what} ${name} for ${s.forWhom()}${undo}`)
  return 0
}

/** Error for a name the profile only inherits, so it can't be changed or removed there. */
function inheritedError(s: Session, name: string, from: string, verb: string): ArcaError {
  return new ArcaError(
    `arca: ${name} isn't stored in profile ${s.profile} itself, it's inherited from ${from}.\n` +
      `  To ${verb} it for every profile that extends ${from}:  npx arca ${verb} ${name}${s.profileFlag(from)}`,
  )
}

// ── unset / restore ──────────────────────────────────────────────────────

export async function unsetCommand(s: Session, rawName: string | undefined): Promise<number> {
  s.requireProject()
  const name = checkName(rawName, 'npx arca unset NAME')
  await humanGate(s.io, s.ctx, { kind: 'write', command: `npx arca unset ${name}${s.profileFlag()}` })
  const vault = await s.readVault()
  const v = vault.vars[name]
  if (!v) {
    const inherited = (await s.resolve()).get(name)
    if (inherited) throw inheritedError(s, name, inherited.profile, 'unset')
    throw new ArcaError(`arca: ${name} is not stored in arca for ${s.forWhom()}.`)
  }
  vault.removed[name] = { value: v.value, updatedAt: v.updatedAt }
  delete vault.vars[name]
  await s.writeVault(vault)
  const fallback = (await s.resolve()).get(name)
  s.note(`${s.err('green', '✔')} Removed ${name}${s.multiProfile ? ` from profile ${s.profile}` : ''}. \`npx arca restore ${name}${s.profileFlag()}\` brings it back.`)
  if (fallback) s.note(s.err('dim', `  ${s.profile} now inherits ${name} from ${fallback.profile}.`))
  return 0
}

export async function restoreCommand(s: Session, rawName: string | undefined): Promise<number> {
  s.requireProject()
  const name = checkName(rawName, 'npx arca restore NAME')
  await humanGate(s.io, s.ctx, { kind: 'write', command: `npx arca restore ${name}${s.profileFlag()}` })
  const vault = await s.readVault()
  const current = vault.vars[name]
  if (current?.previous) {
    vault.vars[name] = {
      value: current.previous.value,
      updatedAt: now(),
      source: 'restore',
      previous: { value: current.value, updatedAt: current.updatedAt },
    }
  } else if (!current && vault.removed[name]) {
    storeValue(vault, name, vault.removed[name].value, 'restore')
  } else {
    const inherited = (await s.resolve()).get(name)
    if (!current && inherited) throw inheritedError(s, name, inherited.profile, 'restore')
    throw new ArcaError(`arca: there's no previous value of ${name} to restore${s.multiProfile ? ` in profile ${s.profile}` : ''}.`)
  }
  await s.writeVault(vault)
  s.note(`${s.err('green', '✔')} Restored the previous value of ${name}. Run it again to undo.`)
  return 0
}

// ── reveal / export ──────────────────────────────────────────────────────

export async function revealCommand(s: Session, rawName: string | undefined): Promise<number> {
  s.requireProject()
  const name = checkName(rawName, 'npx arca reveal NAME')
  await humanGate(s.io, s.ctx, { kind: 'reveal', command: `npx arca reveal ${name}${s.profileFlag()}` })
  const values = await s.resolve()
  const v = values.get(name)
  if (!v) {
    const guess = suggest(name, values.keys())
    throw new ArcaError(`arca: ${name} is not stored in arca for ${s.forWhom()}.${guess ? ` Did you mean ${guess}?` : ''}`)
  }
  s.print(v.value)
  return 0
}

export type ExportFormat = 'dotenv' | 'json' | 'shell'

export async function exportCommand(s: Session, opts: { format?: string; output?: string }): Promise<number> {
  const project = s.requireProject()
  const format = (opts.format ?? 'dotenv') as ExportFormat
  if (!['dotenv', 'json', 'shell'].includes(format)) throw new ArcaError('arca: --format must be dotenv, json or shell.', 2)
  await humanGate(s.io, s.ctx, { kind: 'reveal', command: `npx arca export${s.profileFlag()}` })
  const entries = [...(await s.resolve())].map(([k, v]) => [k, v.value] as const)
  let text: string
  if (format === 'json') text = JSON.stringify(Object.fromEntries(entries), null, 2)
  else if (format === 'shell') text = entries.map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'`).join('\n')
  else text = entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n')
  if (opts.output) {
    const file = resolve(s.io.cwd, opts.output)
    writeFileSync(file, text + '\n', { mode: 0o600 })
    s.note(`${s.err('green', '✔')} Wrote ${plural(entries.length, 'secret')} to ${opts.output}`)
    s.note(s.err('yellow', `⚠ That file holds plaintext secrets. Delete it when you're done. The leak guard will flag it while it sits in ${project.config.name}.`))
  } else {
    s.print(text)
  }
  return 0
}

// ── setup ────────────────────────────────────────────────────────────────

export async function setupCommand(s: Session, opts: { all?: boolean }): Promise<number> {
  const project = s.requireProject()
  await humanGate(s.io, s.ctx, { kind: 'write', command: `npx arca setup${s.profileFlag()}` })
  const vault = await s.readVault()
  const inherited = await s.resolve()
  const todo = Object.entries(project.config.vars).filter(
    ([name, d]) => isSensitive(d) && !inherited.has(name) && (opts.all || d.required),
  )
  if (todo.length === 0) {
    s.note(`${s.err('green', '✔')} All ${opts.all ? 'declared' : 'required'} secrets are set for ${s.forWhom()}.`)
    return 0
  }
  s.note(`arca: ${plural(todo.length, 'variable')} to set for ${s.forWhom()}. Leave a prompt empty to skip it.\n`)
  let set = 0
  for (const [name, d] of todo) {
    s.note(`${s.err('cyan', '◆')} ${s.err('bold', name)}${d.description ? `: ${d.description}` : ''}`)
    if (d.docs) s.note(`  get it at ${d.docs}`)
    if (d.example) s.note(s.err('dim', `  example: ${d.example}`))
    let value: string | null = null
    if (d.generate) {
      const gen = await s.io.prompts.confirm(`Generate a random value for ${name}?`, true)
      if (gen === null) break
      if (gen) value = generateSecret(d.generate.bytes ?? 32, d.generate.encoding ?? 'base64url')
    }
    if (value === null) {
      const entered = await s.io.prompts.password(name)
      if (entered === null) break
      value = entered === '' ? null : entered
    }
    if (value === null) {
      s.note(s.err('dim', `  skipped ${name}`))
      continue
    }
    storeValue(vault, name, value, 'setup')
    await s.writeVault(vault)
    set++
  }
  const left = todo.length - set
  if (left === 0) s.note(`\n${s.err('green', '✔')} All ${opts.all ? 'declared' : 'required'} variables set. Run \`npm run dev\`.`)
  else s.note(`\narca: set ${set}, ${left} still missing. Run \`npx arca setup${s.profileFlag()}\` again later.`)
  return left === 0 ? 0 : 1
}

// ── import ───────────────────────────────────────────────────────────────

export interface ImportOptions {
  files: string[]
  only?: string[]
  includePublic?: boolean
  delete?: boolean
  yes?: boolean
}

export interface ImportPlan {
  sources: EnvFile[]
  /** key -> value and the file it came from (highest precedence wins) */
  secrets: Map<string, { value: string; file: string }>
  skipped: { key: string; why: string }[]
}

/** Decides which entries of which files are secrets. Shared with `arca init`. */
export function planImport(s: Session, files: string[], opts: { only?: string[]; includePublic?: boolean } = {}): ImportPlan {
  const project = s.requireProject()
  const sources: EnvFile[] = []
  for (const f of files) {
    const file = readEnvFile(resolve(s.io.cwd, f), f) ?? readEnvFile(join(project.root, f), f)
    if (file) sources.push(file)
  }
  const merged = new Map<string, { value: string; file: string }>()
  for (const file of sources) for (const e of file.entries) merged.set(e.key, { value: e.value, file: file.name })
  const only = opts.only ? new Set(opts.only) : null
  const secrets = new Map<string, { value: string; file: string }>()
  const skipped: { key: string; why: string }[] = []
  for (const [key, v] of merged) {
    if (only && !only.has(key)) continue
    if (v.value === '') {
      skipped.push({ key, why: 'empty' })
      continue
    }
    const decl: VarDecl | undefined = project.config.vars[key]
    if (decl && !isSensitive(decl)) {
      skipped.push({ key, why: 'declared as config' })
      continue
    }
    if (decl || only || opts.includePublic || secretReason(key, v.value)) secrets.set(key, v)
    else skipped.push({ key, why: "doesn't look secret" })
  }
  return { sources, secrets, skipped }
}

export function defaultImportFiles(s: Session): string[] {
  const root = s.requireProject().root
  return DEV_FILES.filter((f) => existsSync(join(root, f)))
}

export async function importCommand(s: Session, opts: ImportOptions): Promise<number> {
  const project = s.requireProject()
  await humanGate(s.io, s.ctx, { kind: 'write', command: `npx arca import${s.profileFlag()}${opts.delete ? ' --delete' : ''}` })
  const files = opts.files.length ? opts.files : defaultImportFiles(s)
  if (files.length === 0) throw new ArcaError(`arca: no .env files found in ${project.root}. Name the file: npx arca import path/to/.env`)
  const plan = planImport(s, files, opts)
  if (plan.sources.length === 0) throw new ArcaError(`arca: none of these files exist: ${files.join(', ')}`)
  const vault = await s.readVault()
  const resolved = await s.resolve()

  const conflicts = [...plan.secrets].filter(([k, v]) => vault.vars[k] && vault.vars[k].value !== v.value).map(([k]) => k)
  let overwrite = Boolean(opts.yes)
  if (conflicts.length && !opts.yes) {
    const answer = await s.io.prompts.confirm(`${conflicts.join(', ')} already in arca with a different value. Overwrite?`, false)
    if (answer === null) throw new ArcaError('arca: cancelled. Nothing was changed.')
    overwrite = answer
  }
  const imported: string[] = []
  const inheritedSame: string[] = []
  let changed = false
  for (const [key, v] of plan.secrets) {
    if (vault.vars[key]?.value === v.value) {
      imported.push(key)
      continue
    }
    // Same value as the profile it extends: keep inheriting instead of storing a copy.
    const parent = resolved.get(key)
    if (!vault.vars[key] && parent && parent.profile !== s.profile && parent.value === v.value) {
      imported.push(key)
      inheritedSame.push(key)
      continue
    }
    if (vault.vars[key] && !overwrite) continue
    storeValue(vault, key, v.value, `import:${v.file}`)
    imported.push(key)
    changed = true
  }
  if (changed) await s.writeVault(vault)

  const undeclared = imported.filter((k) => !(k in project.config.vars))
  if (undeclared.length) declareVars(project.file, Object.fromEntries(undeclared.map((k) => [k, {}])))

  s.note(`${s.err('green', '✔')} Imported ${plural(imported.length, 'secret')} into arca${s.multiProfile ? ` (profile ${s.profile})` : ''}${imported.length ? `: ${imported.join(', ')}` : ''}`)
  if (inheritedSame.length) s.note(s.err('dim', `  same value as the profile it extends, so still inherited: ${inheritedSame.join(', ')}`))
  if (undeclared.length) s.note(`${s.err('green', '✔')} Declared ${undeclared.join(', ')} in arca.json`)
  const config = plan.skipped.filter((x) => x.why !== 'empty')
  if (config.length) s.note(s.err('dim', `  stays in .env: ${config.map((x) => x.key).join(', ')}${opts.includePublic ? '' : ' (use --include-public or --only to import these too)'}`))

  if (opts.delete && imported.length) {
    const keys = new Set(imported)
    for (const src of plan.sources) {
      const result = removeEntries(src.path, keys)
      const name = relative(project.root, src.path) || src.name
      if (result === 'edited') s.note(`${s.err('green', '✔')} Removed the imported entries from ${name} (other lines kept)`)
      if (result === 'deleted') s.note(`${s.err('green', '✔')} Deleted ${name} (nothing else was in it)`)
    }
  } else if (imported.length) {
    s.note(s.err('yellow', `⚠ Your .env files were not changed, so these secrets still have plaintext copies.`))
    s.note(`  Remove just those entries (config lines stay):   npx arca import --delete`)
  }
  return 0
}
