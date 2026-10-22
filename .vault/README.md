# arca: research and plan

> Status: **planning** (no code yet). Written 2026-10-21.
> Package: **`@bremmdev/arca-env`** (npm). Binary: **`arca`**.
> `.vault/` is the human research folder for this repo. The arca tool itself must never read from or write to `.vault/`.

## The one-paragraph pitch

arca moves the **secrets** out of `.env` / `.env.local` files in JavaScript projects. Secret values live in an encrypted, per-user store outside the repo, unlocked by a key held in the OS keychain. Non-sensitive config (`PORT`, `NEXT_PUBLIC_*`, feature flags) can stay in ordinary `.env` files, where frameworks already load it. The repo also gets a committed `arca.json` that lists variable *names* (a typed replacement for `.env.example`). Commands get their secrets through a process wrapper (`arca run -- next dev`), so Next.js, Vite, Astro, TanStack Start, Nuxt, SvelteKit, Prisma and the rest keep reading `process.env` as before. Profiles give each project several sets of values for the same variables (say `ontwikkel` and `acceptatie`), and `arca use acceptatie` switches every command to another set. AI agents can still run the app through package scripts, but secret **values** stay out of their context: they're not in any file, all output is masked, and the commands that reveal or change values only work for a human.

## Documents

| # | Doc | What it covers |
|---|-----|----------------|
| 0 | [Explainer](00-explainer.md) | **Start here.** A broad, non-technical overview of what arca is and how it works |
| 1 | [Prior art](01-prior-art.md) | Survey of 1Password CLI, Doppler, Infisical, dotenvx, secretspec, Varlock, fnox, psst, Teller, envchain, aws-vault, SOPS, direnv, and what to borrow from each |
| 2 | [Threat model](02-threat-model.md) | Who we defend against, every way a secret leaks, what we deliberately don't defend |
| 3 | [Architecture](03-architecture.md) | Store, crypto, keychain, project identity, runner, `.env` coexistence, redaction, context detection, policy engine |
| 4 | [CLI and DX](04-cli-and-dx.md) | Commands, `arca.json` format, onboarding flows, agent-facing messages, AGENTS.md snippet |
| 5 | [Framework integration](05-framework-integration.md) | Per-framework and per-tool notes and pitfalls (Next, Vite family, Astro, Turborepo, Prisma, Docker, IDEs…) |
| 6 | [Roadmap and decisions](06-roadmap.md) | Every confirmed decision, spikes to run first, MVP scope, later phases |
| 7 | [Profiles](07-profiles.md) | Several local sets of values per project, switching with `arca use`, `extends`, per-profile config files |
| 8 | [Issue log](08-issue-log.md) | Every error, bug and problem found so far: cause, fix and status. Append new ones here |

## The core insight

You can't stop a process running as your OS user from reading what your OS user can read. Every tool in this space (1Password, Doppler, psst, the AWS agent guidance) concedes that point. So arca's goal is narrower and reachable:

> **A secret value should never end up in an agent's context window, in a file in the repo, or in captured output by accident or by "helpful" agent behaviour.**

Secrets leak to agents through a small number of channels. arca closes each one by default:

| Channel | Today with `.env` | With arca |
|---|---|---|
| Agent reads a file in the repo | `.env.local` is right there (and some tools reportedly auto-load it) | `.env` files hold only non-sensitive config. A **leak guard** warns whenever a stored secret, or something that looks like one, appears in a `.env*` file. |
| Agent runs `printenv` / `echo $X` in its shell | Clean, unless direnv or a shell profile exported the values | Secrets only exist inside `arca run` child processes |
| Agent reads dev server or test output | Secrets in error messages and logs show up verbatim | Output of every `arca run` is masked to `[arca:DATABASE_URL]`, always |
| Agent runs `arca reveal` / `arca export` | n/a | Refused when an agent is detected or there's no interactive TTY |
| Agent runs `arca run -- printenv` (ad-hoc command) | n/a | Refused for agents; they can only use declared package scripts |
| Agent runs `arca set` / `unset` / `import` | n/a | Refused: only a human can change values |
| Agent reads the store on disk | n/a | AES-256-GCM ciphertext; the key is in the OS keychain |

Bypassing any of these takes deliberate effort, like stripping env markers, editing `package.json` to add a dump script, or calling the keychain API directly. That is outside the "much safer than .env files" bar you set. [Threat model](02-threat-model.md) lists those residual risks honestly.

## Key decisions

✅ = confirmed by you on 2026-10-21. The full list with consequences is in [06](06-roadmap.md#decisions-confirmed-2026-10-21).

1. **Wrapper injection (`arca run -- cmd`)** is the primary integration. It works with every framework, the way `op run`, `doppler run`, `dotenvx run` and `secretspec run` do. An in-process loader (`@bremmdev/arca-env/register`) comes second, for IDE runners.
2. **Envelope encryption.** One random 256-bit master key goes in the OS keychain (`@napi-rs/keyring`). Each project gets an AES-256-GCM vault file in the user data directory. Individual secrets are *not* stored as keychain items, because Windows caps credential blobs at about 2.5 KB and macOS prompts per item.
3. **No passphrase by default.** Unlocking is invisible, which keeps DX close to `.env`. The human gate only appears when someone tries to *reveal* or *change* values (a TTY check, plus an OS biometric prompt in Phase 2). Running the app never prompts.
4. **A committed `arca.json` holds a stable project ID** plus the variable schema (names only, never values). Git worktrees and clones share secrets automatically. This matters because agent tools create worktrees all the time.
5. ✅ **Agents may only run package scripts.** arca detects agents (via the `AI_AGENT` convention, `CLAUDECODE`, Cursor, Codex, Gemini and other markers) and checks that the command came from a declared `package.json` script whose text matches the file. Ad-hoc `arca run -- <cmd>` is refused for agents. A human can make this *stricter* (an approved list of scripts, or deny), never looser. Callers with no agent marker and no TTY (IDE tasks, git hooks) may run ad-hoc commands, masked.
6. ✅ **Output is always masked.** Every `arca run` pipes the child's stdout/stderr through the redactor, for humans too, with no off-switch. Colour and terminal width are forwarded (`FORCE_COLOR`, `COLUMNS`). A PTY mode (Phase 2) brings back full TTY behaviour for interactive tools without dropping the masking.
7. ✅ **Only a human can change values.** `set`, `unset`, `import`, `restore`, `--generate` and policy changes all pass the human gate. Agents get names-only read access (`list`, `check`, `doctor`) and are told to ask the user.
8. ✅ **arca and `.env` files coexist.** Secrets go in arca. Non-sensitive values may stay in `.env` files, which the framework loads as usual. Precedence is **arca vault > inherited shell env > `.env` files**, and there's a notice (names only) when the vault overrides a different value.
9. ✅ **Import never deletes unless asked.** `arca import` leaves your files untouched. With `--delete`, it removes only the imported entries from the file, and removes the file only if nothing is left.
10. **Graceful passthrough.** If there's no vault on the machine (CI, Vercel, Docker), `arca run` just executes the command and validates that required vars are present. Wrapped scripts never break deploys.
11. ✅ **Profiles** (revised 2026-10-22). A project can have several local sets of values for the same variables, e.g. `ontwikkel` and `acceptatie`. `arca use acceptatie` switches every `arca run` in the project to that set until you switch back. A profile can `extend` another, so it only stores the values that differ. **All profiles are equal**: none is locked or more sensitive than another, and the normal rules (scripts only for agents, always masked, only humans change values) apply to each. See [07](07-profiles.md).
12. ✅ **Published as one package, `@bremmdev/arca-env`, binary `arca`.** It uses subpath exports (`/register`, `/schema.json`). TypeScript on Node ≥ 22, minimal dependencies, installed as a devDependency. The only required native dependency is the keychain binding, which ships prebuilt binaries.

## Glossary

- **Project**: a codebase identified by `arca.json#id`. One project has many profiles.
- **Profile**: a named set of values for the project's variables (`ontwikkel`, `acceptatie`, `test`, …), with optional config files. All profiles are equal. Replaces the earlier term "environment".
- **Active profile**: the profile every `arca run` in the project uses, switched with `arca use <profile>`. Falls back to `defaultProfile`.
- **Vault**: the encrypted file holding one profile's values for one project and one user.
- **Store**: the directory of vaults plus global config, outside any repo.
- **Master key**: the 32 random bytes in the OS keychain that unlock every vault.
- **Context**: who is calling arca: human or agent, interactive or not, declared script or ad-hoc.
- **Human gate**: the check required before values may be shown or changed (TTY + no agent markers, later an OS biometric prompt).
- **Leak guard**: arca's check that no stored secret, or secret-looking value, sits in plaintext in the project's `.env*` files.
