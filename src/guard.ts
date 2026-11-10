import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import vm from 'node:vm'
import { Redactor, needlesFor, type Secret } from './redact.js'

// In-process console guard, preloaded into every Node process `arca run` starts
// (NODE_OPTIONS=--import). Masking stdout isn't enough: some dev tools capture console
// *arguments* and send them to the browser, so they never pass through arca's output pipe:
//   - React Server Components replay server logs in the browser. React wraps console
//     methods with Object.defineProperty, and only when they are plain data properties.
//   - TanStack Devtools' console piping assigns console.log = wrapper and POSTs the arguments.
// The guard must mask before those wrappers see the arguments, without hiding the methods
// from them (an accessor would make React skip its replay). So the global console becomes
// a Proxy: methods stay ordinary data properties, and every function installed later,
// by assignment or by defineProperty, is wrapped so masking runs first.

const METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table', 'dirxml', 'group', 'groupCollapsed', 'assert'])
const WRAPPED = Symbol.for('arca.console-guard')
/** Set on the host once a guard is installed: the preloaded guard and the register loader can both run in one process. */
const INSTALLED = Symbol.for('arca.console-guard.installed')

type Fn = ((...args: unknown[]) => unknown) & { [WRAPPED]?: true }
type MakeWrapper = (original: Fn, mask: (arg: unknown) => unknown) => Fn

/**
 * The wrapper's code is compiled under a `node:` script URL. Debuggers (VS Code's js-debug)
 * treat those like Node's own internals: a log's location in the Debug Console is the caller's
 * line instead of arca's, and stepping into console.log skips the wrapper.
 */
const makeWrapper: MakeWrapper = (() => {
  const body = 'return function (...args) { return original.apply(this, args.map(mask)) }'
  try {
    return vm.compileFunction(body, ['original', 'mask'], { filename: 'node:arca/console-guard' }) as MakeWrapper
  } catch {
    return (original, mask) =>
      function (this: unknown, ...args: unknown[]) {
        return original.apply(this, args.map(mask))
      }
  }
})()

export function installConsoleGuard(secrets: Secret[], host: { console: Console } = globalThis): boolean {
  const needles = secrets.flatMap(needlesFor)
  if (needles.length === 0 || Object.hasOwn(host, INSTALLED)) return false
  const redactor = new Redactor(needles)

  const maskArg = (arg: unknown): unknown => {
    if (typeof arg === 'string') return redactor.redact(arg)
    if (arg === null || (typeof arg !== 'object' && typeof arg !== 'function')) return arg
    let text: string
    try {
      text = inspect(arg, { depth: 6, breakLength: Infinity })
    } catch {
      return arg
    }
    // Objects without a secret pass through untouched (so tools still get real objects).
    const masked = redactor.redact(text)
    return masked === text ? arg : masked
  }

  const wrap = (fn: unknown): unknown => {
    if (typeof fn !== 'function' || (fn as Fn)[WRAPPED]) return fn
    const original = fn as Fn
    const wrapped = makeWrapper(original, maskArg)
    Object.defineProperty(wrapped, 'name', { value: original.name })
    wrapped[WRAPPED] = true
    return wrapped
  }

  const target = host.console
  for (const method of METHODS) {
    const d = Object.getOwnPropertyDescriptor(target, method)
    if (d && 'value' in d && (d.writable || d.configurable)) {
      Object.defineProperty(target, method, { ...d, value: wrap(d.value) })
    }
  }

  const guarded: Console = new Proxy(target, {
    set(t, prop, value, receiver): boolean {
      return Reflect.set(t, prop, typeof prop === 'string' && METHODS.has(prop) ? wrap(value) : value, receiver === guarded ? t : receiver)
    },
    defineProperty(t, prop, descriptor) {
      if (typeof prop === 'string' && METHODS.has(prop) && 'value' in descriptor) {
        descriptor = { ...descriptor, value: wrap(descriptor.value) }
      }
      return Reflect.defineProperty(t, prop, descriptor)
    },
  })
  const d = Object.getOwnPropertyDescriptor(host, 'console')
  Object.defineProperty(host, 'console', {
    value: guarded,
    writable: d?.writable ?? true,
    enumerable: d?.enumerable ?? false,
    configurable: true,
  })
  Object.defineProperty(host, INSTALLED, { value: true })
  return true
}

/**
 * Files test runners write from raw test errors for AI agents to read: Playwright's
 * error-context.md ("Context for AI" in its VS Code extension, and in test-results/ on disk).
 */
const AGENT_CONTEXT_FILE = /(?:^|[\\/])error-context\.md$/
const FILES_MASKED = Symbol.for('arca.context-files-masked')

type WriteFn = (file: unknown, data: unknown, ...rest: unknown[]) => unknown

/** Masks what this process writes to those files. Other files are written unchanged. */
export function maskContextFiles(redactor: Redactor, fsm: typeof fs = fs): boolean {
  if (redactor.size === 0 || Object.hasOwn(fsm, FILES_MASKED)) return false
  const isContextFile = (file: unknown): boolean => {
    if (typeof file !== 'string' && !(file instanceof URL)) return false
    return AGENT_CONTEXT_FILE.test(file instanceof URL ? fileURLToPath(file) : file)
  }
  const mask = (data: unknown): unknown => {
    if (typeof data === 'string') return redactor.redact(data)
    if (data instanceof Uint8Array) return redactor.redact(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'))
    return data
  }
  const wrap = (holder: object, key: string): void => {
    const h = holder as Record<string, unknown>
    const original = h[key] as WriteFn
    h[key] = function (this: unknown, file: unknown, data: unknown, ...rest: unknown[]) {
      return original.call(this, file, isContextFile(file) ? mask(data) : data, ...rest)
    }
  }
  wrap(fsm, 'writeFileSync')
  wrap(fsm, 'writeFile')
  wrap(fsm.promises, 'writeFile')
  Object.defineProperty(fsm, FILES_MASKED, { value: true })
  return true
}

/** Entry point when preloaded: the names come from ARCA_MASK, the values from this process's env. */
export function installFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const names = (env.ARCA_MASK ?? '').split(',').filter(Boolean)
  const secrets = names.map((name) => ({ name, value: env[name] ?? '' }))
  maskContextFiles(new Redactor(secrets.flatMap(needlesFor)))
  return installConsoleGuard(secrets)
}
