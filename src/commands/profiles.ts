import { addProfileToConfig, invalidProfileName, isSensitive, normalizeProfile, profileChildren, removeProfileFromConfig } from '../config.js'
import { ArcaError, EXIT_USAGE } from '../errors.js'
import { humanGate } from '../policy.js'
import type { ResolvedVar, Session } from '../session.js'
import { pad, type Style } from '../style.js'
import { plural } from '../util.js'
import { activeWhy, sourceLabel } from './info.js'
import { storeValue } from './values.js'

// Profiles are equal, switchable sets of the same variables. Switching and adding profiles
// only touch names, so agents may do it. Copying or removing values needs a human (D4).

// ── use ──────────────────────────────────────────────────────────────────

export async function useCommand(s: Session, opts: { profile?: string; reset?: boolean }): Promise<number> {
  const project = s.requireProject()
  const { id, name, defaultProfile } = project.config
  const p = s.err

  if (opts.reset || (opts.profile !== undefined && normalizeProfile(opts.profile) === defaultProfile)) {
    s.store.writeState(id, {})
    s.note(`${p('green', '✔')} ${name} is back on ${defaultProfile}`)
    envOverrideNote(s)
    return 0
  }

  if (opts.profile === undefined) {
    if (s.json) {
      s.print(JSON.stringify({ profile: s.profile, source: s.profileSource, defaultProfile, profiles: s.profiles }, null, 2))
      return 0
    }
    s.warnConfig()
    s.print(`${s.profile}${s.out('dim', activeWhy(s))}`)
    if (!s.multiProfile) s.note(p('dim', `${name} has one profile. Add another with \`npx arca profiles add <name>\`.`))
    else s.note(p('dim', `Profiles: ${s.profiles.join(', ')}. Switch with \`npx arca use <profile>\`.`))
    return 0
  }

  const profile = s.checkProfile(project, opts.profile, 'arca use')
  s.store.writeState(id, { activeProfile: profile, setAt: new Date().toISOString() })
  s.note(`${p('green', '✔')} ${name} now uses profile ${profile} for every arca run on this machine`)
  s.note(`  Back to ${defaultProfile}:  npx arca use --reset`)
  const missing = await missingFor(s, profile)
  if (missing.length) s.note(p('yellow', `⚠ ${profile} has no value for ${missing.join(', ')}. Run \`npx arca setup --profile ${profile}\`.`))
  envOverrideNote(s)
  return 0
}

function envOverrideNote(s: Session): void {
  if (s.profileSource === 'env') s.note(s.err('yellow', `⚠ ARCA_PROFILE=${s.io.env.ARCA_PROFILE} is set in this terminal and wins over \`arca use\` here.`))
}

/** Required secrets the profile has no value for (names only). */
async function missingFor(s: Session, profile: string): Promise<string[]> {
  const values = s.hasVault(profile) ? await s.resolve(profile) : new Map<string, ResolvedVar>()
  return Object.entries(s.requireProject().config.vars)
    .filter(([n, d]) => d.required && isSensitive(d) && !values.has(n))
    .map(([n]) => n)
}

// ── profiles ─────────────────────────────────────────────────────────────

export interface ProfilesOptions {
  extends?: string
  only?: string[]
  yes?: boolean
}

export async function profilesCommand(s: Session, args: string[], opts: ProfilesOptions): Promise<number> {
  const [action = 'list', ...rest] = args
  switch (action) {
    case 'list':
    case 'ls':
      return listProfiles(s)
    case 'add':
      return addProfile(s, rest[0], opts)
    case 'diff':
      return diffProfiles(s, rest[0], rest[1])
    case 'copy':
    case 'cp':
      return copyProfile(s, rest[0], rest[1], opts)
    case 'rm':
    case 'remove':
      return removeProfile(s, rest[0], opts)
  }
  throw new ArcaError(
    'arca: usage: npx arca profiles [list]  |  add <name> [--extends p]  |  diff <a> <b>  |  copy <from> <to> [--only A,B]  |  rm <name>',
    EXIT_USAGE,
  )
}

async function listProfiles(s: Session): Promise<number> {
  const project = s.requireProject()
  s.warnConfig()
  const list = []
  for (const profile of s.profiles) {
    const values = s.hasVault(profile) ? await s.resolve(profile) : new Map<string, ResolvedVar>()
    const own = [...values.values()].filter((v) => v.profile === profile).length
    list.push({
      name: profile,
      active: profile === s.profile,
      default: profile === project.config.defaultProfile,
      extends: project.config.profiles[profile]?.extends ?? null,
      envFiles: project.config.profiles[profile]?.envFiles ?? [],
      own,
      inherited: values.size - own,
      missing: await missingFor(s, profile),
    })
  }
  if (s.json) {
    s.print(JSON.stringify(list, null, 2))
    return 0
  }
  const p = s.out
  const w = Math.max(7, ...list.map((x) => x.name.length + 2)) + 2
  s.print(p('bold', `${pad('PROFILE', w)}${pad('EXTENDS', 14)}${pad('VALUES', 22)}MISSING`))
  for (const x of list) {
    const label = `${x.active ? '●' : ' '} ${x.name}`
    const values = `${x.own} set${x.inherited ? `, ${x.inherited} inherited` : ''}`
    const missing = x.missing.length ? p('red', x.missing.join(', ')) : p('dim', '–')
    const tags = [x.default ? 'default' : '', ...x.envFiles].filter(Boolean)
    s.print(`${pad(label, w)}${pad(x.extends ?? '–', 14)}${pad(values, 22)}${missing}${tags.length ? p('dim', `  (${tags.join(', ')})`) : ''}`)
  }
  s.print(p('dim', `\n● active (${sourceLabel(s)}). Switch: npx arca use <profile>   Add: npx arca profiles add <name> [--extends ${project.config.defaultProfile}]`))
  return 0
}

async function addProfile(s: Session, raw: string | undefined, opts: ProfilesOptions): Promise<number> {
  const project = s.requireProject()
  if (!raw) throw new ArcaError('arca: missing profile name. Usage: npx arca profiles add <name> [--extends <profile>]', EXIT_USAGE)
  const name = normalizeProfile(raw)
  const bad = invalidProfileName(name)
  if (bad) throw new ArcaError(`arca: ${bad}.`, EXIT_USAGE)
  if (name in project.config.profiles) throw new ArcaError(`arca: profile ${name} already exists in arca.json.`)
  const parent = opts.extends !== undefined ? s.checkProfile(project, opts.extends, '--extends') : undefined
  addProfileToConfig(project, name, { extends: parent })
  const p = s.err
  s.note(`${p('green', '✔')} Added profile ${name}${parent ? ` (extends ${parent}, so it only stores what differs)` : ''} to arca.json`)
  s.note('  Next, in your own terminal:')
  if (parent) s.note(`    npx arca set NAME --profile ${name}             override a value from ${parent}`)
  else {
    s.note(`    npx arca profiles copy ${project.config.defaultProfile} ${name}    start from ${project.config.defaultProfile}'s values, or`)
    s.note(`    npx arca setup --profile ${name}               enter each value`)
  }
  s.note(`    npx arca use ${name}                         switch to it`)
  return 0
}

/** Names only: which values each profile sets itself, and which it inherits. */
async function diffProfiles(s: Session, rawA: string | undefined, rawB: string | undefined): Promise<number> {
  const project = s.requireProject()
  if (!rawA || !rawB) throw new ArcaError('arca: usage: npx arca profiles diff <a> <b>', EXIT_USAGE)
  const a = s.checkProfile(project, rawA, 'profiles diff')
  const b = s.checkProfile(project, rawB, 'profiles diff')
  const va = s.hasVault(a) ? await s.resolve(a) : new Map<string, ResolvedVar>()
  const vb = s.hasVault(b) ? await s.resolve(b) : new Map<string, ResolvedVar>()
  const names = [...new Set([...Object.keys(project.config.vars).filter((n) => isSensitive(project.config.vars[n])), ...va.keys(), ...vb.keys()])]
  const describe = (values: Map<string, ResolvedVar>, profile: string, name: string): { text: string; color: Style; kind: string } => {
    const v = values.get(name)
    if (!v) return { text: '– not set', color: 'dim', kind: 'missing' }
    if (v.profile === profile) return { text: '✔ own value', color: 'green', kind: 'own' }
    return { text: `↳ ${v.profile}`, color: 'cyan', kind: `inherits:${v.profile}` }
  }
  const rowsOut = names.map((name) => ({ name, a: describe(va, a, name), b: describe(vb, b, name) }))
  if (s.json) {
    s.print(JSON.stringify(rowsOut.map((r) => ({ name: r.name, [a]: r.a.kind, [b]: r.b.kind })), null, 2))
    return 0
  }
  const p = s.out
  const w = Math.max(4, ...names.map((n) => n.length)) + 2
  const cw = Math.max(a.length, ...rowsOut.map((r) => r.a.text.length)) + 3
  s.print(p('bold', `${pad('', w)}${pad(a, cw)}${b}`))
  for (const r of rowsOut) s.print(`${pad(r.name, w)}${pad(p(r.a.color, r.a.text), cw)}${p(r.b.color, r.b.text)}`)
  const ownB = rowsOut.filter((r) => r.b.kind === 'own').map((r) => r.name)
  s.print(p('dim', `\n${b} sets ${ownB.length ? ownB.join(', ') : 'nothing'} itself. Names only: values are never compared or shown.`))
  return 0
}

async function copyProfile(s: Session, rawFrom: string | undefined, rawTo: string | undefined, opts: ProfilesOptions): Promise<number> {
  const project = s.requireProject()
  if (!rawFrom || !rawTo) throw new ArcaError('arca: usage: npx arca profiles copy <from> <to> [--only A,B]', EXIT_USAGE)
  const from = s.checkProfile(project, rawFrom, 'profiles copy')
  const to = s.checkProfile(project, rawTo, 'profiles copy')
  if (from === to) throw new ArcaError('arca: <from> and <to> are the same profile.', EXIT_USAGE)
  await humanGate(s.io, s.ctx, { kind: 'write', command: `npx arca profiles copy ${from} ${to}${opts.only ? ` --only ${opts.only.join(',')}` : ''}` })

  const source = await s.resolve(from)
  const only = opts.only ? new Set(opts.only) : null
  const picked = [...source].filter(([n]) => !only || only.has(n))
  if (only) {
    const unknown = [...only].filter((n) => !source.has(n))
    if (unknown.length) s.note(s.err('yellow', `arca: not stored in ${from}: ${unknown.join(', ')}`))
  }
  if (picked.length === 0) throw new ArcaError(`arca: ${from} has no values to copy.`)

  const target = await s.readVault(to)
  const conflicts = picked.filter(([n, v]) => target.vars[n] && target.vars[n].value !== v.value).map(([n]) => n)
  let overwrite = Boolean(opts.yes)
  if (conflicts.length && !opts.yes) {
    const answer = await s.io.prompts.confirm(`${to} already has its own ${conflicts.join(', ')}. Overwrite with ${from}'s?`, false)
    if (answer === null) throw new ArcaError('arca: cancelled. Nothing was changed.')
    overwrite = answer
  }
  const copied: string[] = []
  for (const [n, v] of picked) {
    if (target.vars[n]?.value === v.value) continue
    if (target.vars[n] && !overwrite) continue
    storeValue(target, n, v.value, `copy:${from}`)
    copied.push(n)
  }
  if (copied.length) await s.writeVault(target, to)
  const skipped = picked.length - copied.length
  s.note(`${s.err('green', '✔')} Copied ${plural(copied.length, 'value')} from ${from} to ${to}${copied.length ? `: ${copied.join(', ')}` : ''}`)
  if (skipped) s.note(s.err('dim', `  ${plural(skipped, 'value')} left as ${to} had ${skipped === 1 ? 'it' : 'them'}`))
  if (copied.length) s.note(`  Change the ones that differ:  npx arca set NAME --profile ${to}`)
  return 0
}

async function removeProfile(s: Session, raw: string | undefined, opts: ProfilesOptions): Promise<number> {
  const project = s.requireProject()
  if (!raw) throw new ArcaError('arca: usage: npx arca profiles rm <name>', EXIT_USAGE)
  const name = s.checkProfile(project, raw, 'profiles rm')
  const { id, defaultProfile } = project.config
  if (name === defaultProfile) throw new ArcaError(`arca: ${name} is the default profile. Set another "defaultProfile" in arca.json first.`)
  const children = profileChildren(project.config, name)
  if (children.length) throw new ArcaError(`arca: ${children.join(', ')} ${children.length === 1 ? 'extends' : 'extend'} ${name}. Change or remove ${children.length === 1 ? 'it' : 'them'} first.`)
  await humanGate(s.io, s.ctx, { kind: 'write', command: `npx arca profiles rm ${name}` })
  const stored = s.ownsVault(name) ? Object.keys((await s.readVault(name)).vars).length : 0
  if (!opts.yes) {
    const what = stored ? ` and its ${plural(stored, 'value')} on this machine` : ''
    const yes = await s.io.prompts.confirm(`Remove profile ${name} from arca.json${what}? This can't be undone.`, false)
    if (!yes) throw new ArcaError('arca: cancelled. Nothing was changed.')
  }
  removeProfileFromConfig(project.file, name)
  s.store.removeVault(id, name)
  if (s.store.readState(id).activeProfile === name) s.store.writeState(id, {})
  s.note(`${s.err('green', '✔')} Removed profile ${name}${stored ? ` and its ${plural(stored, 'value')}` : ''}`)
  s.note(s.err('dim', '  Teammates keep their own values for it until they remove it too.'))
  return 0
}
