import { inspect } from 'node:util'
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

type Fn = ((...args: unknown[]) => unknown) & { [WRAPPED]?: true }

export function installConsoleGuard(secrets: Secret[], host: { console: Console } = globalThis): boolean {
  const needles = secrets.flatMap(needlesFor)
  if (needles.length === 0) return false
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
    const wrapped: Fn = function (this: unknown, ...args: unknown[]) {
      return original.apply(this, args.map(maskArg))
    }
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
  return true
}

/** Entry point when preloaded: the names come from ARCA_MASK, the values from this process's env. */
export function installFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const names = (env.ARCA_MASK ?? '').split(',').filter(Boolean)
  return installConsoleGuard(names.map((name) => ({ name, value: env[name] ?? '' })))
}
