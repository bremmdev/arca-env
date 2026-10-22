# 06: Roadmap and decisions

## Decisions (confirmed 2026-10-21)

| # | Decision | Consequence in the design |
|---|---|---|
| D1 | **Package name `@bremmdev/arca-env`**, binary `arca`, **one package** | `npm i -D @bremmdev/arca-env`, `npx arca …`, subpath exports `@bremmdev/arca-env/register` and `/schema.json`. `$schema` points into `node_modules/@bremmdev/arca-env/`. |
| D2 | **Agents may only run package scripts** | Agents get secrets only via a verified `package.json` script. The policy can be tightened (`approved`, `deny`) but never loosened. There's no `allow` mode. ([03 §6](03-architecture.md#6-policy-engine)) |
| D3 | **Always mask output** | Every `arca run` and `register` load is redacted, for humans too, with no off-switch. That makes PTY mode important for interactive tools, so it moves from Phase 3 to Phase 2. ([03 §7](03-architecture.md#7-runner-arca-run), [§9](03-architecture.md#9-redaction-engine)) |
| D4 | **Only a human can change values** | `set` (new, overwrite, `--generate`), `unset`, `import`, `restore`, `setup` and policy changes are all human-gated. Agent-run `arca init` scaffolds config but skips the import. ([04](04-cli-and-dx.md#commands)) |
| D5 | **Vault wins over inherited shell env, with a notice** | Merge order `envFiles < process.env < vault`. One stderr line per run, names only, when a vault value overrides a *different* inherited value. `--no-override` flips vault vs shell for one run. ([03 §7](03-architecture.md#7-runner-arca-run)) |
| D6 | **`arca set NAME value` warns, doesn't refuse** | The positional value is accepted with a shell-history warning. The masked prompt and stdin stay the recommended paths. |
| D7 | **Import never deletes unless `--delete`** | `arca import` / `arca init` leave `.env` files untouched by default. `--delete` removes *only the imported entries*, keeps comments and config lines, and deletes a file only if it ends up empty. The leak guard reminds you about plaintext copies until they're gone. |
| D8 | **Undetected non-interactive callers: allow, masked** | IDE tasks, git hooks and agents without markers may run ad-hoc commands. Output stays masked, and Phase 2 process-tree detection narrows the gap. |
| D9 | **arca and `.env` coexist: secrets in arca, non-sensitive config in `.env`** | `arca.json` holds names only, never values (no `default` field). The framework keeps loading `.env` as usual. Opt-in `envFiles` covers tools that don't load files themselves. A **leak guard** flags stored secrets, declared-sensitive keys and secret-looking values in `.env*` files. `init` sorts variables into secrets vs config. ([03 §8](03-architecture.md#8-coexisting-with-env-files-and-the-leak-guard)) |
| D10 | **Profiles: multiple local sets of the same variables, easy to switch between** (revised 2026-10-22). Example: `ontwikkel` and `acceptatie`, with slightly different values. **All profiles are equal**: none is locked or more sensitive than another. | Replaces "environments" (`--profile`, `ARCA_PROFILE`, `defaultProfile`). Declarations are shared. Each profile has its own values, an optional `extends` (store only what differs) and optional `envFiles`. **`arca use <profile>`** switches the active profile for every `arca run` in the project (per machine, shared by worktrees). Explicit `--profile` and `ARCA_PROFILE` still win. Profiles follow the normal rules: agents via scripts, always masked, human-only writes. One vault file per profile. ([07](07-profiles.md)) |

**Calls I made while applying D7 and D9** (flag any you disagree with):

- `--delete` strips only the imported entries rather than deleting whole files, because in mixed mode the same file still holds config you want to keep.
- arca does **not** load `.env` files itself by default (`envFiles: []`). Frameworks already do it with their own mode logic, and loading them twice risks dev values leaking into production builds (see the pitfall in [03 §8](03-architecture.md#8-coexisting-with-env-files-and-the-leak-guard)).
- The leak guard **warns but never blocks** `arca run` (DX first). `arca check --strict` and `arca scan --staged` are the blocking variants for CI and pre-commit.
- Endpoints that receive credentials (API base URLs) are *recommended* to be declared sensitive, so they live in arca and only a human can change them ([02 L17](02-threat-model.md#leak-channels-and-mitigations)). This is guidance plus a `doctor` hint, not enforcement.

**Calls I made while designing D10** (details and rationale in [07](07-profiles.md#design-calls-in-this-doc-flag-any-you-disagree-with)):

- Renamed "environments" to "profiles" everywhere.
- No protected profiles, per-profile confirmations or per-profile agent rules (revised 2026-10-22).
- `arca use` sets an active profile per project and machine (revised 2026-10-22, was "no sticky profile"). A banner names the profile and where it came from on every non-default run.
- Agents may run `arca use`. The AGENTS.md snippet asks them to switch only when the user asks.
- Declarations are shared by all profiles. There are no per-profile `vars` or `exclude` lists.
- Profile names are case-insensitive (`ACCEPTATIE` = `acceptatie`).
- Masking covers values from all profiles, not only the active one.
- One vault file per profile.

## Phase 0: spikes (answer before writing the real code)

Each spike is a throwaway script. The output is a short note added to this folder.

| # | Question | Why it matters |
|---|---|---|
| S1 | `@napi-rs/keyring` on Windows 11, macOS (Node from nodejs.org, Homebrew, fnm/nvm) and Linux (GNOME, headless, WSL2, devcontainer): does it persist? Are there prompts? Do they come back after a Node upgrade? How long is the sync read? | The whole "invisible unlock" DX depends on it |
| S2 | Pipe-mode fidelity: `next dev`, `vite`, `astro dev`, `prisma migrate dev`, `vitest` (watch UI) with stdout/stderr piped through the redactor and stdin inherited. Check colours (`FORCE_COLOR`), Vite shortcuts, interactive prompts, Ctrl+C on Windows (no orphaned `node.exe`), exit codes. **List every tool that degrades.** | Masking is always on (D3), so pipe mode is the default experience until PTY mode ships |
| S3 | Agent markers: actually run `env` from inside Claude Code, Codex CLI, Cursor agent, Copilot agent mode, Gemini CLI, OpenCode and T3 Code. Record which vars are set, and which IDEs set markers in *human* terminals too (false positives). | Accuracy of D2 and D4 |
| S4 | `npm_lifecycle_event` / `npm_lifecycle_script` under npm, pnpm, yarn (classic and berry), bun, including nested `npm run` inside scripts and Turbo-spawned tasks | Script verification for D2 |
| S5 | Redactor: throughput (shouldn't matter, under 1 ms/MB), correctness on split chunks, multi-byte text and `\r` progress bars | Correctness of the core promise |
| S6 | Vite: are `VITE_*` vars that exist only in `process.env` exposed to `import.meta.env`? Astro inlining behaviour. Wrangler process env. | Framework claims in [05](05-framework-integration.md) |
| S7 | Windows Hello `UserConsentVerifier` from Node (PowerShell WinRT shim vs a tiny prebuilt helper) and macOS `LAContext` helper: latency and packaging | Phase 2 human gate. Matters more now that every write needs it (D4). |
| S8 | `node-pty` as an optional dependency: are prebuilt binaries available for win-x64/arm64, darwin-x64/arm64, linux-x64/arm64 and current Node versions without a compiler? ConPTY behaviour on Windows, resize forwarding, Ctrl+C, and masking of PTY output. | PTY mode (D3) without making installs fragile |

## Implementation status (2026-10-22)

Version 0.1 implements Phase 1 **without profiles**, as asked: first validate replacing or supplementing a `.env` with one set of values. Internally everything uses a single set (`projects/<id>/default.vault`), and `--profile` explains that profiles aren't available yet. So profiles can be added later without migrating the store.

- **Done:** `arca.json` + JSON Schema, store (atomic writes, lock, `.bak`, registry, ID collision warning), crypto, OS keychain + passphrase mode, context detection, script verification, policy (`scripts`/`deny`), human gate with challenge, runner (env merge with override notice, passthrough + validation, nesting, signals, exit codes, always-on masking in pipe mode with `FORCE_COLOR`/`COLUMNS`), redactor with variants, `.env` coexistence + leak guard, and every Phase 1 command (`init`, `setup`, `set`, `unset`, `restore`, `list`, `check`, `run`, `reveal`, `export`, `import`, `doctor`, `policy`, `projects`).
- **Profiles (D10), added 2026-10-22:** everything in [07](07-profiles.md): `profiles`/`defaultProfile` in `arca.json` with `extends` and per-profile `envFiles`, `--profile`/`-p` on every value command, `ARCA_PROFILE`, `arca use [profile] [--reset]` with `state.json`, the `arca ▸ profile …` banner, `arca profiles` list/add/diff/copy/rm, `check --all-profiles`, the `list` matrix, masking with every profile's values, `init` turning `.env.<name>` files into profiles, and automatic migration of `default.vault`. Implementation calls are listed at the end of 07. Checked in the Next.js example and a new TanStack Start example (`examples/tanstack-start`), both on `ontwikkel`/`default` and `acceptatie`, in the dev server, the browser console and Next's agent log file. 80 tests.
- **Not yet:** the keyutils cache for passphrase mode (it prompts every run unless `ARCA_PASSPHRASE` is set); everything in Phase 2 (`scan`/`hook`, `register`, PTY mode, `reveal --copy`, `approved` policy).
- **Tests:** 49 (unit plus in-process end-to-end with real child processes). An end-to-end run on a real Next.js 16.4 app went from mixed `.env.local` → `init` → `import --delete` → `npm run dev` / `npm run build` as Claude Code. Server-side secrets reached the app, `.env.local` config still loaded through Next.js, and the dev server log showed `[arca:…]`. Every agent attack path was refused, and CI passthrough worked with and without platform vars.

**Spike findings so far:**

- **S1 (Windows):** `@napi-rs/keyring` with Windows Credential Manager persists, and reads take about 2 ms. `arca run` adds about 100 ms on this machine, mostly one extra Node startup (plain `node -e 0` takes 145 ms).
- **S3 (Claude Code):** sets `AI_AGENT=claude-code_<version>_agent`, `CLAUDECODE=1` and `CLAUDE_CODE_ENTRYPOINT`. Other agents still need checking.
- **S4 (npm 11):** `npm_lifecycle_script` is the script text without the extra `-- args`, so `npm run dev -- --port 4000` verifies. `npx`/`npm exec` set `npm_lifecycle_event=npx` with the ad-hoc command as the script, which arca treats as ad-hoc. pnpm, yarn and bun still need checking.
- **Next.js 16.4** appends its own block to `AGENTS.md` during `next dev`. arca's section stays intact.
- **TanStack Devtools leaked to the browser** (reported by the user 2026-10-22). Its `consolePiping` (on by default in dev) replaces `console.*` in the server entry and POSTs the raw arguments to the Vite server, which shows them in the browser console. That bypasses stdout masking, and agents with browser tools read that console. **Fix:** an in-process console guard preloaded by `arca run` through `NODE_OPTIONS=--import` (`dist/guard.mjs`, about 6 kB), verified against TanStack's real injected code. This pulls part of the planned `register` stream patching forward from Phase 2.
- **Still for a human to verify:** Ctrl+C in a real terminal (no orphaned `node.exe`), and colours and Next's interactive output through the masking pipe.

## Phase 1: MVP ("get the secrets out of your .env today")

Scope:

- [ ] `arca.json` loader + JSON Schema (shipped in the package), walk-up resolution
- [x] **Profiles (D10):** resolution of `extends` and per-profile `envFiles`; selection (`--profile` > `ARCA_PROFILE` > `arca use` > `defaultProfile`); `arca use [profile] [--reset]` with `state.json`; banner with the selection source; `arca profiles` list/add/diff/copy/rm
- [ ] Store (paths, one vault file per profile, `policy.vault`, atomic writes, lock, one-deep backup), registry, ID collision warning
- [ ] Crypto envelope (HKDF + AES-256-GCM), keychain adapter, passphrase mode with the keyutils cache
- [ ] Context detection: agent markers (vendored list + `AI_AGENT` + `ARCA_AGENT` + user markers), TTY, verified script, CI, nesting
- [ ] Policy engine implementing D2 and D4 ([03 §6](03-architecture.md#6-policy-engine)), human gate (TTY + no agent + challenge)
- [ ] Runner: cross-spawn, env merge `envFiles < shell < vault` with override notice (D5), passthrough + validation, signals, exit codes, **pipe mode with always-on masking** (D3), `FORCE_COLOR`/`COLUMNS` forwarding
- [ ] Redactor with variants and URL-password needles, `[arca:NAME]`
- [ ] `.env` coexistence (D9): dotenv parsing, opt-in `envFiles`, **leak guard** (exact match, declared-sensitive, heuristics, git-tracked escalation, `leakGuard.ignore`)
- [ ] Commands: `init` (framework detect, secrets-vs-config sorting, import for humans, wrap scripts, AGENTS.md), `setup`, `set` (masked/stdin/`--generate`, positional with warning), `unset`, `list`, `check [--strict]`, `run`, `reveal`, `export`, `import [--only] [--delete]` (entry-level removal, D7), `restore`, `doctor`
- [ ] Agent-oriented refusal messages for reveal, ad-hoc run, and writes
- [ ] Tests: unit (crypto, redactor, policy matrix as a table test), integration (spawn real `node` children through the redactor), CI matrix (windows-latest, macos-latest, ubuntu-latest)
- [ ] Docs: README with the honest threat model, a migration guide, one framework page per row in [05](05-framework-integration.md)
- [ ] Publish `@bremmdev/arca-env` with `bin: { "arca": … }` and `exports` for `.`, `./register`, `./schema.json`

**MVP acceptance scenarios** (scripted, run in CI where possible):

1. Next.js app with `.env.local` holding secrets *and* config:
   - After `arca init`, the secrets are in arca and the files are unchanged, so the leak guard reports the plaintext copies.
   - After `arca import --delete`, only the config lines remain and the leak guard is clean.
   - `npm run dev` serves a page that uses a server secret (from arca) and a `NEXT_PUBLIC_` var (from `.env.local`).
2. In a shell with `CLAUDECODE=1`, no TTY:
   - `printenv` shows no secrets.
   - `arca reveal X` exits non-zero with guidance.
   - `npx arca run -- printenv` is refused.
   - `arca set X`, `arca unset X` and `arca import .env` are all refused with "ask the user" guidance.
   - `npm run dev` works, and a route that `console.log`s the secret shows `[arca:X]` in output.
3. Human in a terminal:
   - `arca reveal X` prints the value, and `arca set X` works.
   - `npm run dev` output is **still masked**, keeps its colours (`FORCE_COLOR`), and Ctrl+C stops it with no orphaned processes.
4. `CI=true` with no vault: `npm run build` passes through, and fails listing names when a required var is missing.
5. A git worktree of the same repo sees the same secrets with no extra setup.
6. `arca scan` finds a pasted secret in a staged file, and the pre-commit hook blocks the commit.
7. A key exists in arca, in the shell env *and* in `.env` with three different values: the app sees the arca value, and arca prints the override notice (names only).
8. Profiles:
   - After `arca use acceptatie`, `npm run dev` from a human terminal, an IDE task and an agent (`CLAUDECODE=1`) all get acceptatie values (falling back to `ontwikkel` through `extends`) plus `.env.acceptatie` config, with the banner and no prompt. The same happens in a second git worktree.
   - `npm test` (pinned with `--profile test`) stays on test. `ARCA_PROFILE=ontwikkel npm run dev` overrides the active profile for that one run. `arca use --reset` goes back to the default.
   - An agent can run `arca use acceptatie`, but `arca set NAME --profile acceptatie` is refused like any other write.
   - An acceptatie value printed during an ontwikkel run shows as `[arca:NAME@acceptatie]`.

## Phase 2: hardening and polish

- **PTY mode** (`node-pty` optional dependency): genuine TTY behaviour for interactive tools while masking. Chosen automatically when the parent is a TTY. Moved up from Phase 3 because of D3.
- **OS-native human gate:** Windows Hello, Touch ID, Linux polkit/zenity fallback. Every write needs the human gate (D4), so this makes it both stronger and quicker.
- `@bremmdev/arca-env/register` in-process loader (IDE test explorers, debuggers) with stream patching for masking
- `arca scan` + `arca hook install`, plus a build-output scan recipe
- Process-tree agent detection (only when a decision depends on it), which narrows the "undetected agent" gap in the policy matrix
- `approved` agent policy with `arca policy allow …`
- `arca reveal --copy` with clipboard auto-clear
- Turbo `globalPassThroughEnv` integration in `init`
- `arca backup` / restore bundles
- Clear docs for VS Code / JetBrains / Cursor setups

## Phase 3: bigger bets (only if there's demand)

- **Session agent / daemon** (ssh-agent / 1Password style): holds the unlocked key, `prompt` policy (OS approval before an agent's script receives secrets, cached per terminal session with idle TTL and a hard cap), and passphrase mode on every OS
- **Crypto-gated master key:** Windows Hello `KeyCredentialManager` (TPM), macOS Secure Enclave / keychain with a user-presence ACL. This finally closes direct keychain reads (L8).
- **Providers:** pull from or reference 1Password (`op://`), Doppler, Infisical, Bitwarden, Vercel (`arca pull vercel`, so no `.env.local` ever touches disk). Human-gated, since pulling writes values (D4).
- **Team sharing:** age-encrypted bundles to teammates' public keys (`arca share --to alice`)
- **`--mount <file>`:** an ephemeral named pipe for file-only tools (`.dev.vars`, `env_file`), Doppler-style, with `--mount-max-reads`
- **HTTP response leak detection** in `register` (Varlock `@preventLeaks` idea) and dev error-page redaction
- **IPC env delivery** so values never sit in the child's initial env block (L9 on Linux/macOS)
- Local web UI / VS Code extension for viewing names and setting values

## Still open

Nothing blocking. All product decisions are recorded as D1–D10 above. Spikes S1–S8 are the next step.

## Risks

| Risk | Mitigation |
|---|---|
| macOS keychain prompts after every Node upgrade annoy users | Document it. Phase 3 signed helper binary with a stable code signature owns the keychain item. |
| Always-on masking (D3) breaks some interactive CLIs in pipe mode | `FORCE_COLOR`/`COLUMNS` forwarding, S2 lists the affected tools, PTY mode in Phase 2. There's deliberately no unmasked escape hatch. |
| `node-pty` install failures (no prebuild → compiler needed) | Optional dependency. arca falls back to pipe mode silently, and `arca doctor` reports it. |
| Human gate friction on every write (D4) | One masked prompt per `set`, and `arca setup` batches every missing value into one session. Phase 2 biometric prompt replaces the TTY challenge. |
| Agent markers change or new agents appear | Vendored list updated per release, user-configurable markers, `ARCA_AGENT=1` documented for agent configs |
| Users think it's a hard security boundary | Threat model up front in the README. Never use the word "unbreakable". |
| WSL users lose secrets on reboot | Never store the sole master key in keyutils. Passphrase mode is automatic there. |
| Losing the keychain loses everything | `arca backup`, the `doctor` warning, and messaging that local dev secrets should be re-obtainable |
| Mixed mode (D9) lets secrets drift back into `.env` | The leak guard runs on every `run`, `check`, `doctor` and `scan`. Exact matches have zero false positives. `check --strict` and the pre-commit hook block. |
| Leak-guard heuristics are noisy (false positives on hashes, IDs, public keys) | Heuristics only apply to *undeclared* keys. Declaring `sensitive: false` or using `leakGuard.ignore` silences them. The entropy threshold gets tuned in S5. |
| Agent edits a config URL in `.env` that receives credentials (L17) | Guidance to declare such endpoints sensitive, plus a `doctor` hint when a URL in `.env` shares a prefix with a stored secret |
