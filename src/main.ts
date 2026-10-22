import { parseArgs, type ParseArgsConfig } from 'node:util'
import { RUN_OPTIONS_WITH_VALUE } from './context.js'
import { ArcaError, EXIT_USAGE } from './errors.js'
import type { IO } from './io.js'
import { runCommand } from './runner.js'
import { Session } from './session.js'
import { suggest } from './util.js'
import { checkCommand, doctorCommand, listCommand, policyCommand, projectsCommand, statusCommand } from './commands/info.js'
import { initCommand } from './commands/init.js'
import { exportCommand, importCommand, restoreCommand, revealCommand, setCommand, setupCommand, unsetCommand } from './commands/values.js'

export const VERSION = '0.1.0'

const HELP = `arca: keep secrets out of .env files and out of reach of AI agents

Usage: npx arca <command> [options]    (inside package.json scripts, plain "arca" works)

Everyday
  run [opts] -- <cmd>     Run a command with the project's secrets injected, output masked
                          --only A,B      inject only these
                          --passthrough   run without the store, checking required vars (like CI)
                          --no-override   let values inherited from the shell win over arca
  list, ls                Variables and where each one comes from (names only, never values)
  check [--strict]        Exit 1 if required variables are missing (--strict: also on leak-guard findings)
  doctor                  Diagnose keychain, project, scripts and .env files

Values (only a person at a terminal)
  set NAME [--generate]   Store a value (hidden prompt, or piped: … | arca set NAME)
  setup [--all]           Set every missing required variable, one prompt each
  unset NAME              Remove a value          restore NAME   Undo the last change
  reveal NAME             Print a value           export         Print all values (--format dotenv|json|shell, --output file)
  import [files] [--only A,B] [--include-public] [--delete]
                          Move secrets from .env files into arca. Files are untouched unless --delete.

Project
  init [--yes] [--new-id] Set up arca: arca.json, import secrets, wrap scripts, AGENTS.md
  policy [set agent-run scripts|deny]
  projects [rm <id>]      Projects with secrets on this machine

Global options: --project-dir <path>, --json, --quiet, --help, --version
Docs: https://www.npmjs.com/package/@bremmdev/arca-env`

type Values = Record<string, string | boolean | string[] | undefined>

const GLOBAL_OPTIONS = {
  'project-dir': { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
} satisfies ParseArgsConfig['options']

function parse(args: string[], options: ParseArgsConfig['options'] = {}): { values: Values; positionals: string[] } {
  try {
    const r = parseArgs({ args, options: { ...GLOBAL_OPTIONS, ...options }, allowPositionals: true, strict: true })
    return { values: r.values as Values, positionals: r.positionals }
  } catch (e) {
    throw new ArcaError(`arca: ${(e as Error).message.replace(/\. To specify a positional.*$/s, '')}\nRun \`npx arca help\` for usage.`, EXIT_USAGE)
  }
}

const COMMANDS = ['run', 'list', 'ls', 'check', 'doctor', 'set', 'setup', 'unset', 'restore', 'reveal', 'export', 'import', 'init', 'policy', 'projects', 'help', 'version']

export async function main(argv: string[], io: IO): Promise<number> {
  try {
    return await dispatch(argv, io)
  } catch (e) {
    if (e instanceof ArcaError) {
      if (e.message) io.stderr.write(e.message + '\n')
      return e.code
    }
    io.stderr.write(`arca: unexpected error: ${(e as Error).stack ?? String(e)}\n`)
    return 1
  }
}

async function dispatch(argv: string[], io: IO): Promise<number> {
  const [command, ...rest] = argv
  if (command === '--version' || command === '-v' || command === 'version') {
    io.stdout.write(VERSION + '\n')
    return 0
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    io.stdout.write(HELP + '\n')
    return 0
  }
  if (command === undefined || (command.startsWith('-') && command !== '--')) {
    const { values } = parse(argv)
    return statusCommand(session(io, values), VERSION)
  }
  if (command === 'run' || command === '--') return run(command === '--' ? ['--', ...rest] : rest, io)
  if (!COMMANDS.includes(command)) {
    const guess = suggest(command, COMMANDS)
    throw new ArcaError(`arca: unknown command "${command}".${guess ? ` Did you mean \`npx arca ${guess}\`?` : ''} Run \`npx arca help\`.`, EXIT_USAGE)
  }

  switch (command) {
    case 'list':
    case 'ls': {
      const { values } = parse(rest, profileOption)
      return listCommand(session(io, values))
    }
    case 'check': {
      const { values } = parse(rest, { strict: { type: 'boolean' }, ...profileOption })
      return checkCommand(session(io, values), { strict: Boolean(values.strict) })
    }
    case 'doctor': {
      const { values } = parse(rest)
      return doctorCommand(session(io, values))
    }
    case 'set': {
      const normalized = rest.map((a) => (a === '--generate' || a === '-g' ? '--generate=default' : a))
      const { values, positionals } = parse(normalized, { generate: { type: 'string' }, ...profileOption })
      let generate: true | number | undefined
      if (typeof values.generate === 'string') {
        if (values.generate === 'default') generate = true
        else {
          generate = Number(values.generate)
          if (!Number.isInteger(generate) || generate < 8 || generate > 1024) throw new ArcaError('arca: --generate takes a number of bytes from 8 to 1024.', EXIT_USAGE)
        }
      }
      if (positionals.length > 2) throw new ArcaError('arca: too many arguments. Usage: npx arca set NAME [value]', EXIT_USAGE)
      return setCommand(session(io, values), { name: positionals[0], value: positionals[1], generate })
    }
    case 'setup': {
      const { values } = parse(rest, { all: { type: 'boolean' }, ...profileOption })
      return setupCommand(session(io, values), { all: Boolean(values.all) })
    }
    case 'unset':
    case 'restore':
    case 'reveal': {
      const { values, positionals } = parse(rest, { copy: { type: 'boolean' }, ...profileOption })
      if (values.copy) throw new ArcaError('arca: --copy is not available yet. Use `npx arca reveal NAME` in your terminal.', EXIT_USAGE)
      const s = session(io, values)
      if (command === 'unset') return unsetCommand(s, positionals[0])
      if (command === 'restore') return restoreCommand(s, positionals[0])
      return revealCommand(s, positionals[0])
    }
    case 'export': {
      const { values } = parse(rest, { format: { type: 'string' }, output: { type: 'string', short: 'o' }, ...profileOption })
      return exportCommand(session(io, values), { format: values.format as string | undefined, output: values.output as string | undefined })
    }
    case 'import': {
      const { values, positionals } = parse(rest, {
        only: { type: 'string' },
        'include-public': { type: 'boolean' },
        delete: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        ...profileOption,
      })
      return importCommand(session(io, values), {
        files: positionals,
        only: splitList(values.only),
        includePublic: Boolean(values['include-public']),
        delete: Boolean(values.delete),
        yes: Boolean(values.yes),
      })
    }
    case 'init': {
      const { values } = parse(rest, { yes: { type: 'boolean', short: 'y' }, 'new-id': { type: 'boolean' }, 'no-import': { type: 'boolean' } })
      return initCommand(session(io, values), { yes: Boolean(values.yes), newId: Boolean(values['new-id']), import: !values['no-import'] })
    }
    case 'policy': {
      const { values, positionals } = parse(rest)
      return policyCommand(session(io, values), positionals)
    }
    case 'projects': {
      const { values, positionals } = parse(rest)
      return projectsCommand(session(io, values), positionals)
    }
  }
  return EXIT_USAGE
}

// Profiles aren't implemented yet; accept the flag only to explain that.
const profileOption = { profile: { type: 'string', short: 'p' } } satisfies ParseArgsConfig['options']

function session(io: IO, values: Values): Session {
  if (values.help) {
    io.stdout.write(HELP + '\n')
    throw new ArcaError('', 0)
  }
  if (values.profile !== undefined) {
    throw new ArcaError('arca: profiles are not available in this version yet. Every command uses the project\'s single set of values.', EXIT_USAGE)
  }
  const s = new Session(io, { projectDir: values['project-dir'] as string | undefined })
  s.json = Boolean(values.json)
  s.quiet = Boolean(values.quiet)
  return s
}

function splitList(v: unknown): string[] | undefined {
  if (typeof v !== 'string') return undefined
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/** `arca run [opts] [--] <cmd…>`: arca's options end at `--` or at the first non-option. */
async function run(args: string[], io: IO): Promise<number> {
  const own: string[] = []
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') {
      i++
      break
    }
    if (!a.startsWith('-')) break
    own.push(a)
    if (RUN_OPTIONS_WITH_VALUE.has(a) && i + 1 < args.length) own.push(args[++i]!)
  }
  const command = args.slice(i)
  const { values } = parse(own, {
    only: { type: 'string' },
    passthrough: { type: 'boolean' },
    'no-override': { type: 'boolean' },
    ...profileOption,
  })
  const s = session(io, values)
  return runCommand(s, {
    command,
    only: splitList(values.only),
    passthrough: Boolean(values.passthrough),
    noOverride: Boolean(values['no-override']),
  })
}
