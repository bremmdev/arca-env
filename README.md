# arca

**Keep secrets out of `.env` files, and out of reach of AI agents.**

arca moves the secrets in your `.env` / `.env.local` into an encrypted store outside the project, and hands them to your app only when it runs. Your app still reads `process.env.DATABASE_URL`, so Next.js, Vite, Astro, TanStack Start, Nuxt, SvelteKit, Prisma and plain Node keep working. Non-sensitive config (`PORT`, `NEXT_PUBLIC_*`, feature flags) can stay in `.env`.

- **No secret files in the repo.** Values live in an AES-256-GCM store in your user data folder. The key sits in your OS keychain, so there's no password to type.
- **Masked output, always.** Anything your app prints goes through arca, which replaces secrets with `[arca:DATABASE_URL]`, including the encoded forms and the password inside a connection string. Inside your app's Node processes, a console guard (preloaded through `NODE_OPTIONS`) masks `console.*` arguments too, so dev tools that forward server logs to the browser (such as TanStack Devtools) only see `[arca:NAME]`.
- **Agents can run your app, not read your secrets.** AI agents can use secrets only through your `package.json` scripts. Only a person at a terminal can reveal or change values.

> The goal is **much safer than `.env` files**, not unbreakable. Anything running as your user can, with deliberate effort, reach what you can reach. arca closes the easy, accidental and "helpful agent" paths.

## Quick start

```console
npm i -D @bremmdev/arca-env
npx arca init
npm run dev
```

`arca init` creates `arca.json` (variable names only, committed), sorts the variables in your `.env` files into secrets and config, imports the secrets, and wraps your scripts:

```json
{
  "scripts": {
    "dev": "arca run -- next dev",
    "build": "arca run -- next build"
  }
}
```

Your `.env` files are left untouched. Once you've checked everything works, remove the plaintext copies with:

```console
npx arca import --delete     # removes only the imported entries; config lines stay
```

A teammate who clones the repo runs `npm run dev`, gets told which variables are missing, and runs `npx arca setup`.

## Commands

arca is installed per project, so in a terminal you run it as `npx arca <command>`. A bare `arca` gives "command not found", because `node_modules/.bin` isn't on your PATH. Inside `package.json` scripts, plain `arca run -- …` works, because npm adds that folder for scripts. For a bare `arca` everywhere, also install it globally: `npm i -g @bremmdev/arca-env`.

| Command | What it does | AI agents |
|---|---|---|
| `arca run [--only A,B] -- <cmd>` | Run with secrets injected, output masked | ✅ only through `package.json` scripts |
| `arca list` | Every variable and where it comes from (arca, `.env`, missing). Names only. | ✅ |
| `arca check [--strict]` | Exit 1 when required variables are missing. `--strict` also fails on secrets in `.env` files. | ✅ |
| `arca doctor` | Keychain, project, scripts and leak-guard diagnosis | ✅ |
| `arca set NAME [--generate]` | Store a value: hidden prompt, `… \| arca set NAME`, or a random value | ❌ person only |
| `arca setup [--all]` | Prompt for every missing required variable | ❌ person only |
| `arca unset NAME` / `arca restore NAME` | Remove a value / undo the last change | ❌ person only |
| `arca reveal NAME` / `arca export` | Show one value / print all (`--format dotenv\|json\|shell`, `--output file`) | ❌ person only |
| `arca import [files] [--only A,B] [--delete]` | Move secrets from `.env` files into arca | ❌ person only |
| `arca init [--yes] [--new-id]` | Set up a project | ✅ without the import |
| `arca policy set agent-run deny` | Stop agents from getting secrets at all in this project | ❌ person only |
| `arca projects [rm <id>]` | Projects with secrets on this machine | list ✅ |

## `arca.json`

```json
{
  "$schema": "./node_modules/@bremmdev/arca-env/schema.json",
  "id": "arc_7k2m9q4x8w1z3p5n",
  "name": "acme-web",
  "vars": {
    "DATABASE_URL": { "required": true, "description": "Local Postgres", "example": "postgres://postgres:postgres@localhost:5432/acme" },
    "STRIPE_SECRET_KEY": { "required": true, "docs": "https://dashboard.stripe.com/test/apikeys" },
    "AUTH_SECRET": { "required": true, "generate": { "bytes": 32 } },
    "NEXT_PUBLIC_POSTHOG_KEY": { "sensitive": false }
  }
}
```

- `sensitive` defaults to `true`: the value comes from arca and is masked. `false` marks config that lives in `.env`.
- The `id` ties clones and git worktrees of the repo to the same secrets.
- `envFiles` (opt-in) lists `.env` files that arca loads itself, for tools that don't (plain `node`, `tsx`). Leave it empty for frameworks that load their own.
- `leakGuard.ignore` silences the leak guard for specific names.

## Secrets in arca, config in `.env`

Who wins when a name is in more than one place: **arca, then your shell, then `.env` files**. When arca overrides a different value from your shell, it says so (by name, never by value). `--no-override` flips that for one run.

The **leak guard** checks your `.env*` files on every run. It warns when one contains a value stored in arca, a variable declared as a secret, or something that looks like a secret (`sk_live_…`, a URL with a password, a long random string). `arca doctor` shows details and the fix. `arca check --strict` makes it fail, for CI or a pre-commit hook.

## How agents are recognised

Agent tools set environment variables in the commands they run: `AI_AGENT` (a shared convention), `CLAUDECODE`, `CURSOR_AGENT`, `CODEX_SANDBOX`, `GEMINI_CLI`, `OPENCODE` and others. You can add your own markers in the store's `config.json` (`"agentMarkers": ["MY_AGENT"]`), or set `ARCA_AGENT=1` in an agent's config.

For a detected agent, `arca run` checks that it was started by a `package.json` script whose text matches the file, and that the command is the one in the script. Callers with no marker and no terminal (IDE tasks, git hooks) can run anything, masked. Showing or changing values needs a real terminal and no agent marker. If a marker leaks into your own terminal, arca asks you to type a short code instead.

## CI and deploys

There's no store in CI, on Vercel or in Docker, so `arca run` just runs the command with the platform's variables, after checking that the required ones exist. `start` scripts stay unwrapped, so production images don't need arca.

## Where things are kept

| What | Where |
|---|---|
| Encrypted vaults | `%LOCALAPPDATA%\arca` (Windows), `~/Library/Application Support/arca` (macOS), `~/.local/share/arca` (Linux). Override with `ARCA_HOME`. |
| Master key | Windows Credential Manager, macOS Keychain or Linux Secret Service. Where there's no persistent keychain (WSL, headless Linux), arca uses a passphrase (`ARCA_KEYCHAIN=passphrase`). |

If the keychain entry is lost, the vaults can't be decrypted. For local development secrets that's usually fine, because they can be fetched again from their dashboards.

## Limits

arca can't stop deliberate workarounds: an agent that hides its markers, edits `package.json` to add a script that prints secrets (that shows in your git diff), or reads the keychain directly. It also can't stop malware running as you, or your own app reading `process.env`. Other output your app sends to the browser (an error overlay or page that shows a value) or writes to files isn't masked.

## Status

Version 0.1: one set of values per project. Profiles (several sets per project, switched with `arca use`), a PTY mode for fully interactive tools, an in-process loader for IDE test runners, and `arca scan` are planned.
