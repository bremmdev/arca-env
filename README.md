# arca

**Keep secrets out of `.env` files, and out of reach of AI agents.**

arca moves the secrets in your `.env` / `.env.local` into an encrypted store outside the project, and hands them to your app only when it runs. Your app still reads `process.env.DATABASE_URL`, so Next.js, Vite, Astro, TanStack Start, Nuxt, SvelteKit, Prisma and plain Node keep working. Non-sensitive config (`PORT`, `NEXT_PUBLIC_*`, feature flags) can stay in `.env`.

- **No secret files in the repo.** Values live in an AES-256-GCM store in your user data folder. The key sits in your OS keychain, so there's no password to type.
- **Masked output, always.** Anything your app prints goes through arca, which replaces secrets with `[arca:DATABASE_URL]`, including the encoded forms and the password inside a connection string. Inside your app's Node processes, a console guard (preloaded through `NODE_OPTIONS`) masks `console.*` arguments too, so dev tools that forward server logs to the browser (such as TanStack Devtools) only see `[arca:NAME]`.
- **Agents can run your app, not read your secrets.** AI agents can use secrets only through your `package.json` scripts. Only a person at a terminal can reveal or change values.

> The goal is **much safer than `.env` files**, not unbreakable. Anything running as your user can, with deliberate effort, reach what you can reach. arca closes the easy, accidental and "helpful agent" paths.

## Quick start

Requires Node 24 or newer, on Windows or Linux ([supported platforms](#supported-platforms)).

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

A teammate who clones the repo runs `npm run dev`, gets told which variables are missing, and runs `npx arca setup`. Step by step: [moving an existing project](#moving-an-existing-project-to-arca).

## Moving an existing project to arca

The usual starting point: a `.env.local` (or `.env`) that mixes secrets (`DATABASE_URL`, `STRIPE_SECRET_KEY`) with config (`PORT`, `NEXT_PUBLIC_*`), and scripts like `"dev": "next dev"`.

1. **Install and run `init`** in the project folder:

   ```console
   npm i -D @bremmdev/arca-env
   npx arca init
   ```

   It asks for the project name, then which variables are secrets. The ones that look like secrets are preselected; public names such as `NEXT_PUBLIC_*` aren't. Secrets move into arca, everything else stays in your `.env` files as config, and both are declared in `arca.json` (names only). Each `.env.<name>` file, such as `.env.acceptatie`, is offered as a [profile](#profiles). Then it asks which scripts to wrap with `arca run`. `start` stays unwrapped for production, and you're offered a `start:local` that runs the production build with your secrets. Finally it offers a short "Secrets (arca)" section for `AGENTS.md`. The secret values are copied into arca, and your `.env` files aren't changed. The first copy creates the master key: in your OS keychain, or [behind a passphrase](#where-things-are-kept) on WSL and headless Linux.

2. **Check it works:** `npm run dev` starts with an `arca ▸ … output masked` line and your app behaves as before. `npx arca list` shows where each variable now comes from, and `npx arca doctor` checks the whole setup. Until the next step, the leak guard warns that the secrets are still in your `.env` files. That's expected.

3. **Remove the plaintext copies:**

   ```console
   npx arca import --delete
   ```

   This removes only the entries that were imported. Config lines and comments stay, and a file is deleted only if nothing else was in it.

4. **Commit** `arca.json`, `package.json` and `AGENTS.md`. None of them holds a value. Keep your `.env` files out of git as before.

5. **Teammates** pull, run `npm install` and `npm run dev`. arca names the missing variables, and `npx arca setup` asks for each one. For variables with `"generate"` in `arca.json`, it offers a random value instead.

CI and deploys need no changes: without a store, `arca run` passes the platform's variables through ([CI and deploys](#ci-and-deploys)).

To go back, `npx arca export --output .env.local` writes every value to a file again (a person at a terminal only), and you remove `arca run -- ` from your scripts.

### Several environments in one `.env.local`

A common setup is one `.env.local` with a block per environment, all but one commented out, and switching by moving the comments. Commented-out lines are still plain text that an agent can read, so they have to leave the file too. Each block becomes a [profile](#profiles):

1. **Split the file.** Keep the block you normally run (say ontwikkel) in `.env.local`, uncommented. Put each other block, uncommented, in its own `.env.<profile>` file: `.env.acceptatie`, `.env.productie`. Delete the commented blocks from `.env.local`.

   Don't use `.env.test`, `.env.development` or `.env.production`: Next.js and Vite load those themselves depending on the mode (`.env.test` under Vitest or Jest), so `init` leaves them alone. Pick another name, such as `.env.testomgeving`. The file name becomes the profile name.

2. **Run `npx arca init`.** For each file it asks "Create profile acceptatie from .env.acceptatie?". A profile that shares most secrets with `.env.local` `extends` the default set and stores only the values that differ, so a shared `STRIPE_SECRET_KEY` is stored once. Config lines stay in each file, and only that profile loads them.

3. **Remove the plaintext copies** with the commands `init` prints at the end:

   ```console
   npx arca import --delete
   npx arca import .env.acceptatie --profile acceptatie --delete
   npx arca import .env.productie --profile productie --delete
   ```

4. **Switch** with `npx arca use acceptatie` and back with `npx arca use --reset`, or for one terminal `ARCA_PROFILE=productie npm run dev`.

`init` calls the `.env.local` set `default`. You never type the default profile's name, so that works fine. To name it `ontwikkel` instead, rename it before importing, because stored values belong to a profile name:

1. `npx arca init --no-import`
2. In `arca.json`, rename `default` to `ontwikkel` under `profiles` and in every `extends`, and add `"defaultProfile": "ontwikkel"`.
3. Run the import commands of step 3, default set first.

Teammates do the same with their own `.env.local`, or pull the commit and run `npx arca setup` for the default set and `npx arca setup -p acceptatie` for each other profile they use. arca doesn't sync values between machines.

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
| `arca init [--yes] [--new-id] [--no-import]` | Set up a project (`--no-import`: write `arca.json` and scripts, store no values yet) | ✅ without the import |
| `arca use [profile]` / `arca use --reset` | Show or switch the active profile | ✅ (only when you ask) |
| `arca profiles` / `profiles add <name> [--extends p]` / `profiles diff <a> <b>` | List, add and compare profiles. Names only. | ✅ |
| `arca profiles copy <from> <to> [--only A,B]` / `profiles rm <name>` | Copy values between profiles / remove a profile and its values | ❌ person only |
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

## Profiles

A profile is a set of values for the project's variables. Say you have `ontwikkel` and `acceptatie`: the same variables, a few different values. All profiles are equal. You switch between them freely.

```json
{
  "defaultProfile": "ontwikkel",
  "profiles": {
    "ontwikkel": {},
    "acceptatie": { "extends": "ontwikkel", "envFiles": [".env.acceptatie"] }
  }
}
```

- `extends` inherits every value the profile doesn't store itself, so `acceptatie` only stores what differs. Without it, seed a full copy with `npx arca profiles copy ontwikkel acceptatie`.
- `envFiles` lists non-sensitive config that arca loads for that profile. Use names frameworks don't load themselves (`.env.acceptatie`, not `.env.production`).
- Every value command takes `--profile` / `-p`: `npx arca set DATABASE_URL -p acceptatie`, `npx arca setup -p acceptatie`, `npx arca import .env.acceptatie -p acceptatie`.

```console
$ npx arca use acceptatie
✔ acme-web now uses profile acceptatie for every arca run on this machine
$ npm run dev
arca ▸ profile acceptatie (via arca use) · 3 secrets · output masked
$ npx arca use --reset
```

`arca use` applies to every `arca run` of the project on this machine: your terminals, IDE tasks, git hooks and the scripts agents run. It's stored outside the repo, so teammates aren't affected. Which profile wins: `--profile` (a script can pin one: `"test": "arca run --profile test -- vitest"`), then `ARCA_PROFILE` for one terminal, then `arca use`, then `defaultProfile`. A run on any profile other than the default starts with the `arca ▸ profile …` line, and the app gets `ARCA_PROFILE=<name>`.

A profile only decides which values arca injects. It doesn't set `NODE_ENV` or change `next dev` into `next build`.

Output is masked with the values of **every** profile, so an `acceptatie` connection string that shows up during an `ontwikkel` run still prints as `[arca:DATABASE_URL@acceptatie]`. `npx arca list` shows one column per profile, and `npx arca profiles diff ontwikkel acceptatie` shows which values a profile sets itself and which it inherits.

`arca init` offers each `.env.<name>` file as a profile. A project that had values before it declared profiles keeps them: they move to the default profile on the first run.

## Secrets in arca, config in `.env`

Who wins when a name is in more than one place: **arca, then your shell, then `.env` files**. When arca overrides a different value from your shell, it says so (by name, never by value). `--no-override` flips that for one run.

The **leak guard** checks your `.env*` files on every run. It warns when one contains a value stored in arca, a variable declared as a secret, or something that looks like a secret (`sk_live_…`, a URL with a password, a long random string). `arca doctor` shows details and the fix. `arca check --strict` makes it fail, for CI or a pre-commit hook.

## How agents are recognised

Agent tools set environment variables in the commands they run: `AI_AGENT` (a shared convention), `CLAUDECODE`, `CURSOR_AGENT`, `CODEX_SANDBOX`, `GEMINI_CLI`, `OPENCODE` and others. You can add your own markers in the store's `config.json` (`"agentMarkers": ["MY_AGENT"]`), or set `ARCA_AGENT=1` in an agent's config.

For a detected agent, `arca run` checks that it was started by a `package.json` script whose text matches the file, and that the command is the one in the script. Callers with no marker and no terminal (IDE tasks, git hooks) can run anything, masked. Showing or changing values needs a real terminal and no agent marker. If a marker leaks into your own terminal, arca asks you to type a short code instead.

## CI and deploys

There's no store in CI, on Vercel or in Docker, so `arca run` just runs the command with the platform's variables, after checking that the required ones exist. `start` scripts stay unwrapped, so production images don't need arca.

## Supported platforms

| Platform | Status |
|---|---|
| Windows 10 and 11 | Supported. Tested in CI on every push |
| Linux, including WSL | Supported. Tested in CI on every push, including against a real GNOME Keyring |
| macOS | Not supported yet. arca may work, but it isn't tested there. `arca init` and `arca doctor` show a warning |

CI tests Windows x64, Linux x64 and arm64, and Alpine (musl), with npm and pnpm. Node 24 or newer.

## Where things are kept

| What | Where |
|---|---|
| Encrypted vaults | `%LOCALAPPDATA%\arca` (Windows), `~/.local/share/arca` or `$XDG_DATA_HOME/arca` (Linux). Override with `ARCA_HOME`. |
| Master key | Windows Credential Manager, or the Secret Service on Linux (GNOME Keyring, KWallet). Where there's no persistent keychain (WSL, headless Linux, or a Secret Service that doesn't respond), arca uses a passphrase instead (`ARCA_KEYCHAIN=passphrase` forces it). You type it once: on Linux the unlocked key is then remembered in the kernel keyring for 12 hours, until a reboot at the latest. `ARCA_PASSPHRASE_CACHE=<hours>` changes that, `0` turns it off. `npx arca doctor` shows until when it's remembered. |

If the keychain entry is lost, the vaults can't be decrypted. For local development secrets that's usually fine, because they can be fetched again from their dashboards.

## Limits

arca can't stop deliberate workarounds: an agent that hides its markers, edits `package.json` to add a script that prints secrets (that shows in your git diff), or reads the keychain directly. It also can't stop malware running as you, or your own app reading `process.env`. Other output your app sends to the browser (an error overlay or page that shows a value) or writes to files isn't masked.

## Status

Usable today on Windows and Linux: everything above, including profiles and the passphrase cache. Checked daily against real Next.js and TanStack Start dev servers in a browser. Planned: a PTY mode for fully interactive tools, an in-process loader for IDE test runners, and `arca scan`.

## License

[MIT](LICENSE). Free to use, copy, modify and distribute, for any purpose.
