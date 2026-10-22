import { describe, expect, it } from 'vitest'
import { installConsoleGuard } from '../src/guard.js'
import { addConsoleGuard } from '../src/runner.js'

const SECRET = { name: 'ADMIN_PASSWORD', value: 'Latindash1!' }

function fakeHost() {
  const printed: unknown[][] = []
  const host = {
    console: { log: (...a: unknown[]) => printed.push(a), error: (...a: unknown[]) => printed.push(a) } as unknown as Console,
  }
  return { host, printed }
}

/** React's patchConsole from react-server-dom-webpack (Next.js 16.4), which replays server logs in the browser. */
function reactPatchConsole(consoleInst: Console, methodName: 'log' | 'error', replay: unknown[][]): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(consoleInst, methodName)
  if (descriptor && (descriptor.configurable || descriptor.writable) && typeof descriptor.value === 'function') {
    const originalMethod = descriptor.value as (...a: unknown[]) => unknown
    const wrapperMethod = function (this: unknown, ...args: unknown[]) {
      replay.push(args) // serialized into the RSC payload and logged in the browser
      return originalMethod.apply(this, args)
    }
    Object.defineProperty(consoleInst, methodName, { value: wrapperMethod })
    return true
  }
  return false
}

describe('console guard', () => {
  it('keeps React Server Components log replay working, with masked values (Next.js)', () => {
    const { host, printed } = fakeHost()
    installConsoleGuard([SECRET], host)
    const replay: unknown[][] = []
    expect(reactPatchConsole(host.console, 'log', replay)).toBe(true) // React still patches
    host.console.log('admin password:', SECRET.value)
    expect(replay).toEqual([['admin password:', '[arca:ADMIN_PASSWORD]']]) // reaches the browser, masked
    expect(printed).toEqual([['admin password:', '[arca:ADMIN_PASSWORD]']])
  })

  it('masks arguments before a later console wrapper forwards them (TanStack Devtools pattern)', () => {
    const { host, printed } = fakeHost()
    installConsoleGuard([SECRET], host)

    // What @tanstack/devtools' console piping does in the server entry:
    const original = host.console.log.bind(host.console)
    const piped: string[] = []
    host.console.log = (...args: unknown[]) => {
      piped.push(JSON.stringify(args)) // sent to the browser over HTTP
      original(...args)
    }

    host.console.log('LOG', SECRET.value, { user: 'admin', password: SECRET.value }, 42)
    expect(piped.join()).not.toContain(SECRET.value)
    expect(piped[0]).toContain('[arca:ADMIN_PASSWORD]')
    expect(JSON.stringify(printed)).not.toContain(SECRET.value)
    expect(printed[0]![3]).toBe(42)
  })

  it('handles React and TanStack together, in either order', () => {
    const { host, printed } = fakeHost()
    installConsoleGuard([SECRET], host)
    const replay: unknown[][] = []
    const piped: unknown[][] = []
    reactPatchConsole(host.console, 'log', replay)
    const original = host.console.log.bind(host.console)
    host.console.log = (...args: unknown[]) => (piped.push(args), original(...args))
    host.console.log(SECRET.value)
    expect([replay, piped, printed].map((x) => x[0]![0])).toEqual(['[arca:ADMIN_PASSWORD]', '[arca:ADMIN_PASSWORD]', '[arca:ADMIN_PASSWORD]'])
  })

  it('leaves arguments without secrets untouched (objects stay objects)', () => {
    const { host, printed } = fakeHost()
    installConsoleGuard([SECRET], host)
    const obj = { a: 1 }
    host.console.log('hello', obj)
    expect(printed[0]![1]).toBe(obj)
  })

  it('masks errors whose message contains a secret', () => {
    const { host, printed } = fakeHost()
    installConsoleGuard([SECRET], host)
    host.console.error(new Error(`login failed for ${SECRET.value}`))
    expect(String(printed[0]![0])).toContain('[arca:ADMIN_PASSWORD]')
    expect(String(printed[0]![0])).not.toContain(SECRET.value)
  })

  it('does nothing without secrets', () => {
    const { host } = fakeHost()
    const c = host.console
    expect(installConsoleGuard([], host)).toBe(false)
    expect(host.console).toBe(c)
  })

  it('is preloaded through NODE_OPTIONS with names only', () => {
    const env: NodeJS.ProcessEnv = { NODE_OPTIONS: '--max-old-space-size=4096', ADMIN_PASSWORD: SECRET.value }
    addConsoleGuard(env, ['ADMIN_PASSWORD'], 'C:\\Program Files\\arca\\dist\\guard.mjs')
    expect(env.ARCA_MASK).toBe('ADMIN_PASSWORD')
    expect(env.NODE_OPTIONS).toMatch(/^--max-old-space-size=4096 --import=file:\/\/\/.*Program%20Files.*guard\.mjs$/)
    addConsoleGuard(env, ['ADMIN_PASSWORD'], 'C:\\Program Files\\arca\\dist\\guard.mjs')
    expect(env.NODE_OPTIONS!.match(/--import/g)).toHaveLength(1)
  })
})
