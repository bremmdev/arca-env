# 06: Roadmap and decisions

## Decisions (confirmed 2026-10-21)

| # | Decision | Consequence in the design |
|---|---|---|
| D1 | **Package name `@bremmdev/arca-env`**, binary `arca`, **one package** | `npm i -D @bremmdev/arca-env`, `npx arca …`, subpath export `/schema.json` (`@bremmdev/arca-env/register` follows in Phase 2). `$schema` points into `node_modules/@bremmdev/arca-env/`. |
| D2 | **Agents may only run package scripts** | Agents get secrets only via a verified `package.json` script. The policy can be tightened (`approved`, `deny`) but never loosened. There's no `allow` mode. ([03 §6](03-architecture.md#6-policy-engine)) |
| D3 | **Always mask output** | Every `arca run` and `register` load is redacted, for humans too, with no off-switch. That makes PTY mode important for interactive tools, so it moves from Phase 3 to Phase 2. ([03 §7](03-architecture.md#7-runner-arca-run), [§9](03-architecture.md#9-redaction-engine)) |
| D4 | **Only a human can change values** | `set` (new, overwrite, `--generate`), `unset`, `import`, `restore`, `setup` and policy changes are all human-gated. Agent-run `arca init` scaffolds config but skips the import. ([04](04-cli-and-dx.md#commands)) |
| D5 | **Vault wins over inherited shell env, with a notice** | Merge order `envFiles < process.env < vault`. One stderr line per run, names only, when a vault value overrides a *different* inherited value. `--no-override` flips vault vs shell for one run. ([03 §7](03-architecture.md#7-runner-arca-run)) |
| D6 | **`arca set NAME value` warns, doesn't refuse** | The positional value is accepted with a shell-history warning. The masked prompt and stdin stay the recommended paths. |
| D7 | **Import never deletes unless `--delete`** | `arca import` / `arca init` leave `.env` files untouched by default. `--delete` removes *only the imported entries*, keeps comments and config lines, and deletes a file only if it ends up empty. The leak guard reminds you about plaintext copies until they're gone. |
| D8 | **Undetected non-interactive callers: allow, masked** | IDE tasks, git hooks and agents without markers may run ad-hoc commands. Output stays masked, and Phase 2 process-tree detection narrows the gap. |
| D9 | **arca and `.env` coexist: secrets in arca, non-sensitive config in `.env`** | `arca.json` holds names only, never values (no `default` field). The framework keeps loading `.env` as usual. Opt-in `envFiles` covers tools that don't load files themselves. A **leak guard** flags stored secrets, declared-sensitive keys and secret-looking values in `.env*` files. `init` sorts variables into secrets vs config. ([03 §8](03-architecture.md#8-coexisting-with-env-files-and-the-leak-guard)) |
| D10 | **Profiles: multiple local sets of the same variables, easy to switch between** (revised 2026-10-22). Example: `ontwikkel` and `acceptatie`, with slightly different values. **All profiles are equal**: none is locked or more sensitive than another. | Replaces "environments" (`--profile`, `ARCA_PROFILE`, `defaultProfile`). Declarations are shared. Each profile has its own values, an optional `extends` (store only what differs) and optional `envFiles`. **`arca use <profile>`** switches the active profile for every `arca run` in the project (per machine, shared by worktrees). Explicit `--profile` and `ARCA_PROFILE` still win. Profiles follow the normal rules: agents via scripts, always masked, human-only writes. One vault file per profile. ([07](07-profiles.md)) |
| D11 | **Windows and Linux only for the MVP** (2026-11-02). macOS is not supported, not blocked. | CI, tests and docs cover Windows and Linux (including WSL). On macOS, `arca init` and `arca doctor` print a warning and carry on. No `"os"` field in `package.json`, because that would fail `npm install` for every macOS teammate in a mixed team. The darwin code paths (store location, keychain name) stay. Plan and results: [10](10-platform-testing.md). |

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
| S6 | ✅ 2026-11-07. Vite: are `VITE_*` vars that exist only in `process.env` exposed to `import.meta.env`? (✅ yes, verified 2026-11-03 in the layer 5 framework checks, see [10](10-platform-testing.md).) Astro inlining behaviour. Wrangler process env. | Framework claims in [05](05-framework-integration.md) |
| S7 | Windows Hello `UserConsentVerifier` from Node (PowerShell WinRT shim vs a tiny prebuilt helper) and macOS `LAContext` helper: latency and packaging | Phase 2 human gate. Matters more now that every write needs it (D4). |
| S8 | `node-pty` as an optional dependency: are prebuilt binaries available for win-x64/arm64, darwin-x64/arm64, linux-x64/arm64 and current Node versions without a compiler? ConPTY behaviour on Windows, resize forwarding, Ctrl+C, and masking of PTY output. | PTY mode (D3) without making installs fragile |

## Implementation status

Checked against the code on 2026-11-05. **0.4.1 is published on npm** and is the MVP: Phase 1 plus profiles, Windows and Linux only (D11), Node 24 or newer. 0.4.0 (2026-11-03) completed the Phase 1 scope below: the passphrase cache (O1), the typo-prompt default (P10), the locked-keyring tip (P8), `init --no-import`, the README migration section, and your real-terminal check of `init`, `import --delete`, `setup` and the profile confirmations (O4, O11). 0.4.1 explains why the passphrase cache is unavailable on WSL. **On `main`, unreleased:** script verification under yarn 2+ (P13), package-manager-aware hints (P14) and the test temp-folder cleanup (O8). Bump to 0.4.2 to ship P13 and P14.

Version 0.1 (2026-10-22) implemented Phase 1 **without profiles**, as asked: first validate replacing or supplementing a `.env` with one set of values. Internally everything used a single set (`projects/<id>/default.vault`), so profiles could be added later without migrating the store.

- **Done:** `arca.json` + JSON Schema, store (atomic writes, lock, `.bak`, registry, ID collision warning), crypto, OS keychain + passphrase mode, context detection, script verification, policy (`scripts`/`deny`), human gate with challenge, runner (env merge with override notice, passthrough + validation, nesting, signals, exit codes, always-on masking in pipe mode with `FORCE_COLOR`/`COLUMNS`), redactor with variants, `.env` coexistence + leak guard, and every Phase 1 command (`init`, `setup`, `set`, `unset`, `restore`, `list`, `check`, `run`, `reveal`, `export`, `import`, `doctor`, `policy`, `projects`).
- **Profiles (D10), added 2026-10-22:** everything in [07](07-profiles.md): `profiles`/`defaultProfile` in `arca.json` with `extends` and per-profile `envFiles`, `--profile`/`-p` on every value command, `ARCA_PROFILE`, `arca use [profile] [--reset]` with `state.json`, the `arca ▸ profile …` banner, `arca profiles` list/add/diff/copy/rm, `check --all-profiles`, the `list` matrix, masking with every profile's values, `init` turning `.env.<name>` files into profiles, and automatic migration of `default.vault`. Implementation calls are listed at the end of 07. Checked in the Next.js example and a new TanStack Start example (`examples/tanstack-start`), both on `ontwikkel`/`default` and `acceptatie`, in the dev server, the browser console and Next's agent log file.
- **Console guard** (pulled forward from Phase 2's `register`, see the TanStack finding below): `dist/guard.mjs`, preloaded through `NODE_OPTIONS`.
- **Passphrase cache** (2026-11-03): on Linux, a typed passphrase is remembered in the kernel keyring for 12 h (`ARCA_PASSPHRASE_CACHE`). See [03](03-architecture.md).
- **Not yet:** per-framework doc pages (the README's migration section covers the common case); everything in Phase 2 (`scan`/`hook`, `register`, PTY mode, `reveal --copy`, `approved` policy, `backup`, `init --undo`, Turbo `globalPassThroughEnv`). Agent-tool deny rules from `init` are built for Claude Code and Codex (2026-11-06); Cursor, Gemini CLI and OpenCode are left out until their project files add to the user's rules instead of replacing them ([04](04-cli-and-dx.md)).
- **Tests** (2026-11-07): 194 in the suite (unit, in-process end-to-end with real child processes, and platform tests that run only on Windows or only on Linux: real keychains, `.cmd` shims, signals, file modes, the passphrase cache); 140 on 2026-11-05, 132 on 2026-11-03, 84 on 2026-11-01, 49 at version 0.1. CI runs them on Windows, Linux x64 and arm64, and Alpine, plus a packed-package smoke test with npm, pnpm, yarn 1, yarn 4 (Plug'n'Play) and bun. A daily workflow runs 32 browser checks against real Next.js and TanStack Start dev servers on two profiles. Details in [10](10-platform-testing.md). An earlier end-to-end run on a real Next.js 16.4 app went from mixed `.env.local` → `init` → `import --delete` → `npm run dev` / `npm run build` as Claude Code. Server-side secrets reached the app, `.env.local` config still loaded through Next.js, and the dev server log showed `[arca:…]`. Every agent attack path was refused, and CI passthrough worked with and without platform vars.

**Spike findings so far:**

- **S1 (Windows):** `@napi-rs/keyring` with Windows Credential Manager persists, and reads take about 2 ms. `arca run` adds about 100 ms on this machine, mostly one extra Node startup (plain `node -e 0` takes 145 ms).
- **S3 (Claude Code):** sets `AI_AGENT=claude-code_<version>_agent`, `CLAUDECODE=1` and `CLAUDE_CODE_ENTRYPOINT`.
- **S3 (other agents, from their source, 2026-11-06):** what each tool sets on the commands its agent runs, read from the open-source repos and the published bundles (versions as of that day). Each one is now a unit test.
  - **Codex CLI** (openai/codex): `CODEX_THREAD_ID` on every command, set *after* the user's `shell_environment_policy` filters, so `include_only` can't drop it. `CODEX_CI=1` on its unified exec. `CODEX_SANDBOX=seatbelt` **only on macOS**, so it was never a marker on Windows or Linux. Also `CODEX_SESSION_ID` and `CODEX_TOOL_CALL_ID`.
  - **Gemini CLI** (google-gemini/gemini-cli): `GEMINI_CLI=1`, added after its env sanitising, for agent commands, `!` shell mode and stdio MCP servers.
  - **OpenCode** (sst/opencode): `AI_AGENT=opencode` (unless already set), `OPENCODE=1`, `AGENT=1` and `OPENCODE_SESSION_ID` in its shell tool. The desktop app sets `OPENCODE_CLIENT=desktop` on its whole process, so that one is **not** a marker (Vercel's `@vercel/detect-agent` 1.2.7 uses it).
  - **VS Code Copilot agent** (microsoft/vscode, `toolTerminalCreator.ts`): `AI_AGENT=github_copilot_vscode_agent` and `COPILOT_AGENT=1`, only in the hidden terminals the agent runs commands in (`hideFromUser`). A person's terminal doesn't get them.
  - **Copilot CLI** (closed source, the binary's JS isn't searchable): its changelog says `COPILOT_CLI=1` for subprocesses (0.0.421, 2026-03-03) and `COPILOT_AGENT_SESSION_ID` in shell commands (1.0.29). **Run by you (2026-11-09, Copilot CLI 1.0.107, Windows, Node 24, launched from a VS Code terminal):** a command the agent ran had `COPILOT_CLI=1` and `COPILOT_AGENT_SESSION_ID`, plus other `COPILOT_*` vars (version, path, loader PID). No `COPILOT_AGENT` or `AI_AGENT`. arca detects it as github-copilot-cli via `COPILOT_CLI` ✅. Stdin, stdout and stderr weren't TTYs. `TERM_PROGRAM=vscode` came from the VS Code terminal Copilot was started in. `SHELL` pointed to Git Bash although the command ran in PowerShell.
  - **Cursor agent** (closed source, the `agent-cli-package` bundle of 2026-11-05): `CURSOR_AGENT=1`, plus `CURSOR_CONVERSATION_ID` and `CURSOR_REQUEST_ID`, on every command its terminal executor runs. Cursor's **IDE** agent, checked by you on Windows (2026-11-06): `CURSOR_AGENT=1`, `CURSOR_EXTENSION_HOST_ROLE=agent-exec`, `CURSOR_CONVERSATION_ID`, `CURSOR_REQUEST_ID`, `AGENT_TRANSCRIPTS` and `__CURSOR_SANDBOX_ENV_RESTORE`, with no `TERM_PROGRAM`. Its commands run in a hidden process launched from Cursor's extension host, not in a terminal you can type in, so the marker never reaches a person's terminal. `CURSOR_TRACE_ID` is **not** a marker: Vercel's detector reads it as Cursor, but it may sit in a person's terminal too. A person's Cursor terminal on Windows (checked by you, 2026-11-06) had no `CURSOR_*` var at all, only `TERM_PROGRAM=vscode`, `TERM_PROGRAM_VERSION`, `VSCODE_GIT_ASKPASS_*`, `VSCODE_GIT_IPC_*` and `VSCODE_INJECTION`: nothing arca counts as an agent.
  - **Augment** (`@augmentcode/auggie` 0.37): `AUGMENT_AGENT=1`. **Goose** (block/goose): `GOOSE_TERMINAL=1` and `AGENT=goose`. **Cline** (cline/cline): `CLINE_ACTIVE=true` on the VS Code terminals it creates. Those terminals stay visible, so a person typing in one is treated as the agent.
  - **Changed in arca:** added `CODEX_CI`, `COPILOT_AGENT` and `COPILOT_CLI`. `AI_AGENT` names now keep every word: `github_copilot_vscode_agent` → `github-copilot-vscode` (it was `github`). `AGENT` is left out: it's generic, and OpenCode and Goose already have their own markers.
  - **People's terminals, checked by you (Windows):** VS Code (Git Bash) has `TERM_PROGRAM=vscode`, `TERM_PROGRAM_VERSION`, `VSCODE_GIT_*`, `VSCODE_PYTHON_AUTOACTIVATE_GUARD` and `COPILOT_DEBUG_NONCE`. T3 Code (PowerShell) has only `CLAUDE_AGENT_SDK_VERSION` of the probe's patterns, inherited from the app's Claude Agent SDK, so that var must never become a marker, nor any `CLAUDE*` prefix. Cursor's is above. None is detected as an agent ✅.
  - **Claude Code's VS Code extension (checked by you):** `CLAUDE_CODE_ENTRYPOINT` and other `CLAUDE_CODE_*` vars, from an extension-host process like Cursor's agent (`VSCODE_PID`, `VSCODE_CWD`, no `TERM_PROGRAM`). Detected as claude-code.
  - **Still to check by running it:** whether Copilot CLI's `!` shell mode (a person typing a command) also sets `COPILOT_CLI`. If it does, those commands count as the agent and hit the human gate's challenge.
- **S3 (Claude Code inside T3 Code, 2026-11-01):** the same three markers (`CLAUDE_CODE_ENTRYPOINT=sdk-ts`), so arca detects it as claude-code. T3 also sets `T3CODE_CLI_PATH`. Don't use that as a marker until it's confirmed that T3's terminals for humans don't set it. (2026-11-06: T3's own terminal does inherit `CLAUDE_AGENT_SDK_VERSION` from the app. The probe didn't look for `T3CODE_*`.)
- **S4 (npm 11):** `npm_lifecycle_script` is the script text without the extra `-- args`, so `npm run dev -- --port 4000` verifies. `npx`/`npm exec` set `npm_lifecycle_event=npx` with the ad-hoc command as the script, which arca treats as ad-hoc. **pnpm 12** (2026-11-03, smoke test): `pnpm run dev` verifies as a script and `pnpm exec arca run` counts as ad-hoc. **yarn 1.22, yarn 4.18 and bun 1.3** (2026-11-05, smoke test on Windows): yarn 1 and bun set both vars like npm. **Yarn 4 sets only `npm_lifecycle_event`**, so `yarn dev` counted as ad-hoc and agents were refused (P13, fixed). The ad-hoc forms (`yarn arca`, `yarn exec arca`, `bunx`/`bun x arca`, `bun run <bin>`) all count as ad-hoc. Turbo-spawned tasks still need checking.
- **S6 (Vite 8.3):** `VITE_*` vars that exist only in `process.env` do reach `import.meta.env` in the browser bundle, and win over `.env.local` (layer 5 framework checks, 2026-11-03).
- **S6 (Astro and Wrangler, 2026-11-07, Windows, Node 26):** throwaway projects run through `npm run …` from a person's environment, with secrets in a passphrase store, then the page and the build output checked for the raw values.
  - **Astro 7.4.7** (`@astrojs/node` 11.1, SSR): `astro dev` gives a secret that's only in `process.env` to `astro:env/server`, `import.meta.env.X` and `process.env.X`, with nothing cached on disk. **`astro build` inlines private `import.meta.env.X` into `dist/server/chunks` as a plain string**, while `astro:env` secrets and `process.env.X` stay runtime reads. So: recommend `astro:env` secrets. The `staticImportMetaEnv` flag no longer exists.
  - **Wrangler 4.158:** by default `wrangler dev` binds none of arca's vars. With `"secrets": { "required": [...] }` in `wrangler.jsonc` it binds exactly those names from `process.env`, and arca's value wins over `.env`. A `.dev.vars` file switches the env lookup off. `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` binds the whole environment (106 bindings). Ctrl+C on `npm run dev` stops everything, `workerd.exe` included, and the bindings table shows the value as `(hidden)`. The "biggest known gap" is a one-line config, so `--mount .dev.vars` drops out of the reasons for Phase 3.
  - **Astro on `@astrojs/cloudflare` 14.4** (`@cloudflare/vite-plugin` 1.67): the same `secrets` rule for `cloudflare:workers` `env` in `astro dev`. **A wrapped `astro build` writes the declared secrets to `dist/server/.dev.vars` in plain text** (for preview). Unwrapped, the build writes nothing (Wrangler warns the secrets are missing), and `arca run -- astro preview` still gets them. That's an argument for `init` not to wrap `build` in Cloudflare projects (follow-up, below).
  - **Built (2026-11-07):** `arca init` offers to add the secrets from `arca.json` to `secrets.required` in the Wrangler config (JSONC edited in place, comments kept; TOML gets a `[secrets]` table), and leaves `build` unwrapped in projects that use Cloudflare's Vite plugin ([04](04-cli-and-dx.md)). Checked end to end on the Astro project: after `init`, `astro dev` binds both secrets from arca, the unwrapped build writes nothing secret, and `arca run -- astro preview` gets them at runtime.
  - **Still open:** `arca scan` (Phase 2) should look in `dist/server` for Astro and Cloudflare builds.
- **Next.js 16.4** appends its own block to `AGENTS.md` during `next dev`. arca's section stays intact.
- **TanStack Devtools leaked to the browser** (reported by the user 2026-10-22). Its `consolePiping` (on by default in dev) replaces `console.*` in the server entry and POSTs the raw arguments to the Vite server, which shows them in the browser console. That bypasses stdout masking, and agents with browser tools read that console. **Fix:** an in-process console guard preloaded by `arca run` through `NODE_OPTIONS=--import` (`dist/guard.mjs`, about 6 kB), verified against TanStack's real injected code. This pulls part of the planned `register` stream patching forward from Phase 2.
- **Checked by you (2026-11-03):** Ctrl+C on `npm run dev` in PowerShell, cmd.exe and Git Bash stops everything, with nothing left running (the "Terminate batch job" prompt is Volta's, P9). Next's colours come through the masking pipe (seen in PowerShell and cmd.exe). Still to check: Vite's keyboard shortcuts and other interactive tools through the pipe (S2), done below.
- **S2 (2026-11-06, Windows, Node 26):** driven through `npm run …` in a real pseudo-terminal (ConPTY via node-pty) with keystrokes, compared against the same tool run without arca. Each tool decides whether keys and prompts work from `stdin.isTTY`, and arca leaves stdin on the terminal, so they all work:
  - **Vite 8.3 dev:** `h`, `u`, `r` (restart) and `q` work, colours come through, Ctrl+C stops everything (port freed, no `node.exe` left). The secret a plugin logs is masked.
  - **`vite build`** with the console guard: builds normally, the plugin's log shows `[arca:API_KEY]`. That finishes O5.
  - **vitest 5.1 watch:** watch mode starts, `h`, `a` (rerun), `p` (filename filter, typed key by key with live matches) and `q` work, the same as without arca.
  - **`prisma migrate dev` (Prisma 7.10):** the migration name prompt shows, takes the answer, and the migration is created and applied. Prisma prints the datasource URL, so a `DATABASE_URL` stored in arca shows as `[arca:DATABASE_URL]` there.
  - **What degrades (cosmetic only):** anything keyed to `stdout.isTTY`. Vite doesn't clear the screen on start or restart, and its `c` (clear console) shortcut does nothing. `vite build` prints its progress steps as lines instead of rewriting one. vitest's reporter drops the live summary while tests run (results and the final summary still print).
  - **Not checked:** Prisma 8 (npm's `latest` tag is 8.0.0-rc.30): it removed `migrate dev` (now `contract emit` / `migration plan --name` / `db migrate`) and its config API changed, so a Prisma 7 project doesn't load. Recheck when 8 is stable. `astro dev` (Vite underneath, no shortcuts of its own).
  - **What it means for PTY mode:** nothing tested is broken in pipe mode, only screen clearing and live progress are missing. PTY mode is a polish item, not a blocker, and can drop down Phase 2's priorities.
- **S8, a first look (2026-11-06):** node-pty 1.1.0 installed in seconds on Windows x64 with Node 26, no compiler. It ships prebuilt binaries for win32-x64/arm64 and darwin-x64/arm64 only, **none for Linux**, so Linux installs would compile it (or PTY mode stays off there). Killing a pty whose process already exited throws `AttachConsole failed` from a helper process on Windows; PTY mode would have to guard against that.

## Phase 1: MVP ("get the secrets out of your .env today")

Scope:

- [x] `arca.json` loader + JSON Schema (shipped in the package), walk-up resolution
- [x] **Profiles (D10):** resolution of `extends` and per-profile `envFiles`; selection (`--profile` > `ARCA_PROFILE` > `arca use` > `defaultProfile`); `arca use [profile] [--reset]` with `state.json`; banner with the selection source; `arca profiles` list/add/diff/copy/rm
- [x] Store (paths, one vault file per profile, `policy.vault`, atomic writes, lock, one-deep backup), registry, ID collision warning
- [x] Crypto envelope (HKDF + AES-256-GCM), keychain adapter, passphrase mode with the keyutils cache (O1, 2026-11-03)
- [x] Context detection: agent markers (vendored list + `AI_AGENT` + `ARCA_AGENT` + user markers), TTY, verified script, CI, nesting
- [x] Policy engine implementing D2 and D4 ([03 §6](03-architecture.md#6-policy-engine)), human gate (TTY + no agent + challenge)
- [x] Runner: cross-spawn, env merge `envFiles < shell < vault` with override notice (D5), passthrough + validation, signals, exit codes, **pipe mode with always-on masking** (D3), `FORCE_COLOR`/`COLUMNS` forwarding, console guard
- [x] Redactor with variants and URL-password needles, `[arca:NAME]`
- [x] `.env` coexistence (D9): dotenv parsing, opt-in `envFiles`, **leak guard** (exact match, declared-sensitive, heuristics, git-tracked escalation, `leakGuard.ignore`)
- [x] Commands: `init` (framework detect, secrets-vs-config sorting, import for humans, wrap scripts, AGENTS.md), `setup`, `set` (masked/stdin/`--generate`, positional with warning), `unset`, `list`, `check [--strict]`, `run`, `reveal`, `export`, `import [--only] [--delete]` (entry-level removal, D7), `restore`, `doctor`
- [x] Agent-oriented refusal messages for reveal, ad-hoc run, and writes
- [x] Tests: unit ✅, integration with real `node` children through the redactor ✅, CI matrix on every push (windows-latest and ubuntu-latest × Node 24 and 26, plus real keychains, a packed-package smoke test and signals) ✅ 2026-11-02; arm64, Alpine, pnpm and daily framework checks ✅ 2026-11-03; yarn 1, yarn 4 and bun ✅ 2026-11-05; see [10](10-platform-testing.md). macOS isn't supported (D11)
- [x] Docs: README with the honest threat model and a "Moving an existing project to arca" section (2026-11-03). One page per framework in [05](05-framework-integration.md) is moved to after the MVP.
- [x] Publish `@bremmdev/arca-env` with `bin: { "arca": … }` and `exports` for `.` and `./schema.json` (0.4.1 on npm). `./register` follows with the loader in Phase 2.

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
6. *(Moved to Phase 2, needs `arca scan`.)* `arca scan` finds a pasted secret in a staged file, and the pre-commit hook blocks the commit. Until then, `arca check --strict` covers `.env*` files.
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
- `arca backup` / restore bundles, and the `doctor` hint about backups
- ~~Passphrase-mode keyutils cache (O1)~~ done in Phase 1 (2026-11-03)
- `arca init --undo`, and agent deny rules for Cursor CLI, Gemini CLI and OpenCode once their project files merge safely (Claude Code and Codex are built, 2026-11-06)
- ~~CI on arm64 and Alpine (musl)~~ done in Phase 1 (2026-11-03). macOS if it becomes supported (D11)
- One doc page per framework in [05](05-framework-integration.md) (moved from Phase 1)
- Clear docs for VS Code / JetBrains / Cursor setups

## Phase 3: bigger bets (only if there's demand)

- **Session agent / daemon** (ssh-agent / 1Password style): holds the unlocked key, `prompt` policy (OS approval before an agent's script receives secrets, cached per terminal session with idle TTL and a hard cap), and passphrase mode on every OS
- **Crypto-gated master key:** Windows Hello `KeyCredentialManager` (TPM), macOS Secure Enclave / keychain with a user-presence ACL. This finally closes direct keychain reads (L8).
- **Providers:** pull from or reference 1Password (`op://`), Doppler, Infisical, Bitwarden, Vercel (`arca pull vercel`, so no `.env.local` ever touches disk). Human-gated, since pulling writes values (D4).
- **Team sharing:** age-encrypted bundles to teammates' public keys (`arca share --to alice`)
- **`--mount <file>`:** an ephemeral named pipe for file-only tools (`env_file`, PHP config caches), Doppler-style, with `--mount-max-reads`. Not needed for Wrangler: declaring `secrets` in its config makes it read `process.env` (S6, 2026-11-07).
- **HTTP response leak detection** in `register` (Varlock `@preventLeaks` idea) and dev error-page redaction
- **IPC env delivery** so values never sit in the child's initial env block (L9 on Linux/macOS)
- Local web UI / VS Code extension for viewing names and setting values

## Still open

Nothing blocking. All product decisions are recorded as D1–D11 above. Open as of 2026-11-05:

- **Release 0.4.2** with the yarn 2+ fix (P13) and package-manager-aware hints (P14): push the bump, CI publishes.
- **`arca request` ([11](11-http-requests.md)):** decide Q1–Q6, then spikes R1 (company proxy and TLS inspection) and R4 (real-world `.http` files) before building.
- **Spikes not finished:** S2 for Prisma 8 once it's stable (Vite, vitest, Prisma 7, Next done 2026-11-06), S3 for the Copilot CLI's `!` shell mode (its agent commands run 2026-11-09, the rest read from source or run 2026-11-06), S4 for Turbo-spawned tasks (npm, pnpm, yarn 1 and 4, bun done), S5, and S7–S8 for Phase 2. Details per item in [08](08-issue-log.md#open-problems-and-things-not-verified-yet).
- **Overhead budget:** [03 §7](03-architecture.md#7-runner-arca-run) sets under 80 ms. S1 measured about 100 ms on Windows, mostly the extra Node startup. Adjust the budget, or make startup faster?
- **Policy file deletion:** a deleted `policy.vault` falls back to `scripts`, so a `deny` can be loosened by tampering with the store. Documented in [02](02-threat-model.md#prompt-injection-walkthrough). Leave it as accepted circumvention, or detect it?
- **Azure Key Vault ([09](09-azure-key-vault-references.md)):** resolve `@Microsoft.KeyVault(...)` references at run time, or `arca pull --from azure` into the store, or neither. Not on the Phase 3 provider list yet.
## Risks

| Risk | Mitigation |
|---|---|
| macOS keychain prompts after every Node upgrade annoy users | Document it. Phase 3 signed helper binary with a stable code signature owns the keychain item. |
| Always-on masking (D3) breaks some interactive CLIs in pipe mode | `FORCE_COLOR`/`COLUMNS` forwarding. S2 (2026-11-06) found only cosmetic losses in Vite, vitest and Prisma 7: no screen clearing, no live progress. PTY mode in Phase 2. There's deliberately no unmasked escape hatch. |
| `node-pty` install failures (no prebuild → compiler needed) | Optional dependency. arca falls back to pipe mode silently, and `arca doctor` reports it. |
| Human gate friction on every write (D4) | One masked prompt per `set`, and `arca setup` batches every missing value into one session. Phase 2 biometric prompt replaces the TTY challenge. |
| Agent markers change or new agents appear | Vendored list updated per release, user-configurable markers, `ARCA_AGENT=1` documented for agent configs |
| Users think it's a hard security boundary | Threat model up front in the README. Never use the word "unbreakable". |
| WSL users lose secrets on reboot | Never store the sole master key in keyutils. Passphrase mode is automatic there. |
| Losing the keychain loses everything | `arca backup`, the `doctor` warning, and messaging that local dev secrets should be re-obtainable |
| Mixed mode (D9) lets secrets drift back into `.env` | The leak guard runs on every `run`, `check`, `doctor` and `scan`. Exact matches have zero false positives. `check --strict` and the pre-commit hook block. |
| Leak-guard heuristics are noisy (false positives on hashes, IDs, public keys) | Heuristics only apply to *undeclared* keys. Declaring `sensitive: false` or using `leakGuard.ignore` silences them. The entropy threshold gets tuned in S5. |
| Agent edits a config URL in `.env` that receives credentials (L17) | Guidance to declare such endpoints sensitive, plus a `doctor` hint when a URL in `.env` shares a prefix with a stored secret |
