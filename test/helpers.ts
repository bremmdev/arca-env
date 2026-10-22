import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_MARKERS } from '../src/context.js'
import { newMasterKey, wrapMasterKey } from '../src/crypto.js'
import type { IO, Prompts } from '../src/io.js'
import { main } from '../src/main.js'

export const PASSPHRASE = 'test-passphrase-123'

export function tempDir(prefix = 'arca-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A store in passphrase mode with cheap scrypt params, so tests don't touch the real keychain. */
export function tempStore(): string {
  const root = tempDir('arca-store-')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ keychain: 'passphrase' }))
  writeFileSync(join(root, 'master.key.enc'), JSON.stringify(wrapMasterKey(newMasterKey(), PASSPHRASE, { N: 1024, r: 8, p: 1 })))
  return root
}

/** process.env without agent markers, CI flags or npm lifecycle vars. */
export function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const drop = new Set([...AGENT_MARKERS.map((m) => m.env), 'CI', 'GITHUB_ACTIONS', 'VERCEL', 'ARCA_ACTIVE', 'FORCE_COLOR', 'NO_COLOR'])
  for (const [k, v] of Object.entries(process.env)) {
    if (drop.has(k) || k.startsWith('npm_') || k.startsWith('CLAUDE') || k.startsWith('CODEX')) continue
    env[k] = v
  }
  return { ...env, ...extra }
}

export interface Answers {
  password?: (string | null)[]
  confirm?: (boolean | null)[]
  text?: (string | null)[]
  multiselect?: (string[] | null)[]
}

export interface FakeIO extends IO {
  out(): string
  err(): string
  all(): string
}

export function fakeIO(opts: { cwd: string; env: NodeJS.ProcessEnv; tty?: boolean; stdin?: string; answers?: Answers }): FakeIO {
  let out = ''
  let err = ''
  let all = ''
  const tty = opts.tty ?? false
  const a = { password: [...(opts.answers?.password ?? [])], confirm: [...(opts.answers?.confirm ?? [])], text: [...(opts.answers?.text ?? [])], multiselect: [...(opts.answers?.multiselect ?? [])] }
  const next = <T>(list: T[], what: string, message: string): T => {
    if (list.length === 0) throw new Error(`unexpected ${what} prompt: ${message}`)
    return list.shift()!
  }
  const prompts: Prompts = {
    password: async (m) => next(a.password, 'password', m),
    text: async (m) => next(a.text, 'text', m),
    confirm: async (m) => next(a.confirm, 'confirm', m),
    multiselect: async (m) => next(a.multiselect, 'multiselect', m) as never,
  }
  return {
    env: opts.env,
    cwd: opts.cwd,
    platform: process.platform,
    stdout: { write: (s) => ((out += s), (all += s)), isTTY: tty, columns: 100 },
    stderr: { write: (s) => ((err += s), (all += s)), isTTY: tty },
    stdinIsTTY: tty && opts.stdin === undefined,
    readStdin: async () => opts.stdin ?? '',
    prompts,
    childStdin: 'ignore',
    handleSignals: false,
    out: () => out,
    err: () => err,
    all: () => all,
  }
}

export interface Harness {
  dir: string
  store: string
  /** Runs arca as a human at a terminal. */
  human(args: string[], o?: { answers?: Answers; stdin?: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number; io: FakeIO }>
  /** Runs arca as Claude Code would: agent marker, no terminal. */
  agent(args: string[], o?: { env?: NodeJS.ProcessEnv }): Promise<{ code: number; io: FakeIO }>
  /** No marker, no terminal: an IDE task or git hook. */
  task(args: string[], o?: { env?: NodeJS.ProcessEnv }): Promise<{ code: number; io: FakeIO }>
}

export function harness(dir = tempDir(), store = tempStore()): Harness {
  const base = () => cleanEnv({ ARCA_HOME: store, ARCA_PASSPHRASE: PASSPHRASE })
  const go = async (args: string[], io: FakeIO) => ({ code: await main(args, io), io })
  return {
    dir,
    store,
    human: (args, o = {}) => go(args, fakeIO({ cwd: dir, env: { ...base(), ...o.env }, tty: true, stdin: o.stdin, answers: o.answers })),
    agent: (args, o = {}) => go(args, fakeIO({ cwd: dir, env: { ...base(), CLAUDECODE: '1', ...o.env } })),
    task: (args, o = {}) => go(args, fakeIO({ cwd: dir, env: { ...base(), ...o.env } })),
  }
}

export function writeJson(file: string, data: unknown): void {
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}
