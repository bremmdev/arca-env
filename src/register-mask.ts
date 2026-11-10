import { MessagePort, isMainThread } from 'node:worker_threads'
import { installConsoleGuard, maskContextFiles } from './guard.js'
import { Redactor, needlesFor, type Secret } from './redact.js'

// The register loader's masking, apart from loading, so the CommonJS entry (register-cjs.ts)
// stays small. All of it is synchronous.

/** Set by a register that decided not to load, so the Node processes it starts stay quiet. */
export const OFF = 'ARCA_REGISTER'

/**
 * Set in test runner workers only, never in the process that loads the config: Vitest, Jest,
 * Playwright. Workers report failures and logs to the runner over IPC, and IDE extensions
 * show that data (Test Results, failure peeks, Problems) without it ever passing stdout.
 */
export const TEST_WORKER_VARS = ['VITEST_WORKER_ID', 'VITEST_POOL_ID', 'JEST_WORKER_ID', 'TEST_WORKER_INDEX']

export const isTestWorker = (env: NodeJS.ProcessEnv): boolean => TEST_WORKER_VARS.some((v) => env[v])

/** The values a parent put in the env, by the names in ARCA_MASK (what the console guard reads too). */
export function secretsFromEnv(env: NodeJS.ProcessEnv): Secret[] {
  return (env.ARCA_MASK ?? '')
    .split(',')
    .filter(Boolean)
    .map((name) => ({ name, value: env[name] ?? '' }))
}

const MASKED = Symbol.for('arca.register.masked')

// Loose on purpose: Node's write() is overloaded, and every overload must fit.
type Write = (chunk: any, ...rest: any[]) => boolean
interface Writable {
  write: Write
}

/** Masks every write to `stream`. Each write is masked whole. */
export function maskWrites(stream: Writable, redactor: Redactor): boolean {
  if (redactor.size === 0 || Object.hasOwn(stream, MASKED)) return false
  const original = stream.write
  stream.write = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    if (typeof chunk === 'string') {
      const encoding = rest[0]
      if (typeof encoding !== 'string' || /^utf-?8$/i.test(encoding)) chunk = redactor.redact(chunk)
    } else if (chunk instanceof Uint8Array) {
      const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8')
      const masked = redactor.redact(text)
      if (masked !== text) {
        chunk = masked
        if (typeof rest[0] === 'string') rest[0] = 'utf8'
      }
    }
    return original.call(this, chunk, ...rest)
  } as Write
  Object.defineProperty(stream, MASKED, { value: true })
  return true
}

/** Objects copied as they are: binary data, transferables, and values without strings inside. */
function keepAsIs(v: object): boolean {
  return ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof MessagePort || v instanceof Date || v instanceof RegExp || typeof v === 'function'
}

function hasNeedle(v: unknown, redactor: Redactor, seen: Set<object>): boolean {
  if (typeof v === 'string') return redactor.redact(v) !== v
  if (v === null || typeof v !== 'object' || seen.has(v) || keepAsIs(v)) return false
  seen.add(v)
  if (v instanceof Map) return [...v].some(([k, x]) => hasNeedle(k, redactor, seen) || hasNeedle(x, redactor, seen))
  if (v instanceof Set) return [...v].some((x) => hasNeedle(x, redactor, seen))
  // Errors keep message and stack as own non-enumerable properties.
  return Object.getOwnPropertyNames(v).some((k) => hasNeedle((v as Record<string, unknown>)[k], redactor, seen))
}

/**
 * A copy of an IPC message with every string masked, or the message itself when it holds no
 * secret. Objects are copied the way IPC serializes them anyway: own properties, no prototype
 * (except errors, arrays, maps and sets). Binary data and transferables are passed as they are.
 */
export function maskDeep<T>(value: T, redactor: Redactor): T {
  if (!hasNeedle(value, redactor, new Set())) return value
  const seen = new Map<object, unknown>()
  const copy = (v: unknown): unknown => {
    if (typeof v === 'string') return redactor.redact(v)
    if (v === null || typeof v !== 'object' || keepAsIs(v)) return v
    if (seen.has(v)) return seen.get(v)
    if (Array.isArray(v)) {
      const out: unknown[] = []
      seen.set(v, out)
      for (const x of v) out.push(copy(x))
      return out
    }
    if (v instanceof Map) {
      const out = new Map()
      seen.set(v, out)
      for (const [k, x] of v) out.set(copy(k), copy(x))
      return out
    }
    if (v instanceof Set) {
      const out = new Set()
      seen.set(v, out)
      for (const x of v) out.add(copy(x))
      return out
    }
    const isError = v instanceof Error
    const out: Record<string, unknown> = isError ? Object.create(Object.getPrototypeOf(v)) : {}
    seen.set(v, out)
    for (const k of isError ? Object.getOwnPropertyNames(v) : Object.keys(v)) {
      const x = copy((v as Record<string, unknown>)[k])
      if (isError) Object.defineProperty(out, k, { value: x, writable: true, configurable: true, enumerable: Object.prototype.propertyIsEnumerable.call(v, k) })
      else out[k] = x
    }
    return out
  }
  return copy(value) as T
}

const IPC_MASKED = Symbol.for('arca.register.ipc-masked')

/**
 * In a test worker, masks what it sends to the runner: process.send (child processes) and, in
 * a worker thread, MessagePort.postMessage. Checked per message, because runners set their
 * worker variables after a preload has run. Other processes send unchanged.
 */
export function maskWorkerMessages(redactor: Redactor, env: NodeJS.ProcessEnv = process.env, proc: NodeJS.Process = process): void {
  if (redactor.size === 0) return
  if (typeof proc.send === 'function' && !Object.hasOwn(proc, IPC_MASKED)) {
    const send = proc.send
    proc.send = function (this: unknown, message: unknown, ...rest: unknown[]) {
      return (send as (...a: unknown[]) => boolean).call(this, isTestWorker(env) ? maskDeep(message, redactor) : message, ...rest)
    } as NodeJS.Process['send']
    Object.defineProperty(proc, IPC_MASKED, { value: true })
  }
  // Each worker thread has its own MessagePort class, so this only changes what this thread sends.
  const proto = MessagePort.prototype as unknown as Record<PropertyKey, unknown>
  if (!isMainThread && !Object.hasOwn(proto, IPC_MASKED)) {
    const post = proto.postMessage as (...a: unknown[]) => void
    proto.postMessage = function (this: unknown, message: unknown, ...rest: unknown[]) {
      return post.call(this, isTestWorker(env) ? maskDeep(message, redactor) : message, ...rest)
    }
    Object.defineProperty(proto, IPC_MASKED, { value: true })
  }
}

/**
 * Jest's main process: with one test file Jest runs it in-band, so failures are formatted
 * here and written to the --json --outputFile the VS Code extension reads (its Problems
 * entries). Tests run in Jest's sandbox, which has its own JSON, so test code isn't affected.
 */
export function isJestMain(argv: string[] = process.argv): boolean {
  const script = (argv[1] ?? '').replaceAll('\\', '/')
  return /\/(jest|jest-cli)\/bin\/jest(\.js)?$/.test(script) || /\/\.bin\/jest(\.cmd|\.js)?$/.test(script)
}

export function maskJsonStringify(redactor: Redactor, json: JSON = JSON): void {
  const holder = json as unknown as Record<PropertyKey, unknown>
  if (redactor.size === 0 || Object.hasOwn(holder, MASKED)) return
  const stringify = json.stringify
  holder.stringify = function (this: unknown, ...args: Parameters<JSON['stringify']>) {
    const out = stringify.apply(this, args)
    return typeof out === 'string' ? redactor.redact(out) : out
  }
  Object.defineProperty(holder, MASKED, { value: true })
}

interface Host {
  process: { stdout: Writable; stderr: Writable }
  console: Console
}

/** Masks this process's stdout, stderr, console arguments, and what a test worker sends to its runner. */
export function maskProcess(secrets: Secret[], host: Host = { process, console: globalThis.console }): void {
  const needles = secrets.flatMap(needlesFor)
  if (needles.length === 0) return
  const redactor = new Redactor(needles)
  maskWrites(host.process.stdout, redactor)
  maskWrites(host.process.stderr, redactor)
  installConsoleGuard(secrets, host)
  if (host.process === process) {
    maskContextFiles(redactor)
    maskWorkerMessages(redactor)
    if (isJestMain()) maskJsonStringify(redactor)
  }
}

/**
 * Node processes started from here load the register again, to mask their own output. With
 * --require, not --import: only --require preloads run in worker threads too. The path is quoted
 * with forward slashes, the form NODE_OPTIONS parses on every platform.
 */
export function addToNodeOptions(env: NodeJS.ProcessEnv, registerCjs: string): void {
  const file = registerCjs.replaceAll('\\', '/').replaceAll('"', '\\"')
  const flag = `--require="${file}"`
  const current = env.NODE_OPTIONS ?? ''
  if (!current.includes(flag)) env.NODE_OPTIONS = current ? `${current} ${flag}` : flag
}
