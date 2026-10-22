// Everything arca needs from the outside world, in one object. Commands never touch
// `process` directly, so tests can run them in-process with a fake terminal.

export interface OutStream {
  write(chunk: string): void
  isTTY: boolean
  columns?: number
  rows?: number
  colorDepth?: number
}

export interface Prompts {
  /** Masked input. Returns null when the user cancels. */
  password(message: string): Promise<string | null>
  text(message: string, opts?: { placeholder?: string; initial?: string }): Promise<string | null>
  confirm(message: string, initial?: boolean): Promise<boolean | null>
  multiselect<T extends string>(
    message: string,
    options: { value: T; label: string; hint?: string }[],
    initial: T[],
  ): Promise<T[] | null>
}

export interface IO {
  env: NodeJS.ProcessEnv
  cwd: string
  platform: NodeJS.Platform
  stdout: OutStream
  stderr: OutStream
  stdinIsTTY: boolean
  /** Reads all of stdin (used for `… | arca set NAME`). */
  readStdin(): Promise<string>
  prompts: Prompts
  /** `inherit` for real terminals, `ignore` in tests. */
  childStdin: 'inherit' | 'ignore'
  /** Only the real CLI forwards signals to the child. */
  handleSignals: boolean
}

function stream(s: NodeJS.WriteStream): OutStream {
  return {
    write: (chunk) => {
      s.write(chunk)
    },
    get isTTY() {
      return Boolean(s.isTTY)
    },
    get columns() {
      return s.columns
    },
    get rows() {
      return s.rows
    },
    get colorDepth() {
      return s.isTTY && typeof s.getColorDepth === 'function' ? s.getColorDepth() : undefined
    },
  }
}

export function processIO(): IO {
  return {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    stdout: stream(process.stdout),
    stderr: stream(process.stderr),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    readStdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks).toString('utf8')
    },
    prompts: clackPrompts(),
    childStdin: 'inherit',
    handleSignals: true,
  }
}

function clackPrompts(): Prompts {
  // Prompts render on stderr so stdout stays clean for data.
  const load = () => import('@clack/prompts')
  const output = process.stderr
  return {
    async password(message) {
      const p = await load()
      const r = await p.password({ message, output })
      return p.isCancel(r) ? null : r
    },
    async text(message, opts = {}) {
      const p = await load()
      const r = await p.text({ message, output, placeholder: opts.placeholder, initialValue: opts.initial })
      return p.isCancel(r) ? null : r
    },
    async confirm(message, initial = true) {
      const p = await load()
      const r = await p.confirm({ message, output, initialValue: initial })
      return p.isCancel(r) ? null : r
    },
    async multiselect(message, options, initial) {
      const p = await load()
      const r = await p.multiselect({
        message,
        output,
        options: options as never,
        initialValues: initial,
        required: false,
      })
      return p.isCancel(r) ? null : (r as never)
    },
  }
}
