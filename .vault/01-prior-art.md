# 01: Prior art

What exists, how each tool works, and what arca should borrow or avoid. Facts were checked against docs or READMEs where possible. Items marked *(unverified)* still need a spike.

## Summary matrix

| Tool | Where values live | How they reach the app | Output masking | Agent-aware | Committed project file |
|---|---|---|---|---|---|
| **1Password CLI** (`op run`) | 1Password vaults (cloud + desktop app) | `op run -- cmd` resolves `op://` references in env/`.env` | **Yes, on by default** (`--no-masking`) | No, but biometric auth per terminal session | `.env` with `op://` references |
| **Doppler** (`doppler run`) | Doppler cloud | `doppler run -- cmd`; `--mount .env` named pipe | No | No | `doppler.yaml` (optional) |
| **Infisical** (`infisical run`) | Infisical cloud/self-hosted | `infisical run -- cmd` | No | No | `.infisical.json` with workspace ID |
| **dotenvx** | Encrypted values inside committed `.env`; private key in `.env.keys` | `dotenvx run -- cmd` | No | Markets itself for AI editors | Encrypted `.env` |
| **secretspec** (Cachix) | Provider: OS keyring (recommended), 1Password, dotenv, pass… | `secretspec run -- cmd`, SDKs | No | No | `secretspec.toml` (names/schema) |
| **Varlock** (dmno) | Values in `.env` files or plugins (1Password…) | `varlock run -- cmd`, framework integrations | **Yes**: `@redactLogs`, `@preventLeaks` for HTTP responses | Schema is safe for agents to read | `.env.schema` |
| **fnox** (jdx) | Encrypted inline in `fnox.toml` (age/KMS) or remote refs | `fnox exec -- cmd`, shell hook on `cd` | No | No | `fnox.toml` |
| **psst** | Local SQLite, AES-256-GCM, key in OS keychain | `psst run cmd`, `psst NAME -- cmd` | **Yes**: `[REDACTED]` | **Pitched for agents**, but `psst get` prints values to anyone | `.psst/` vault in project |
| **Teller** | Many providers | `teller run` | **Yes**: redact mode, `teller scan` | No | `.teller.yml` |
| **envchain** | OS keychain items per namespace | `envchain ns cmd` | No | No | None |
| **aws-vault** | OS keychain (many backends) | `aws-vault exec profile -- cmd` or local metadata server | No | No | None |
| **SOPS / age** | Encrypted files in repo, KMS/age keys | `sops exec-env` | No | No | Encrypted file |
| **direnv** | Whatever `.envrc` sources | Exports into the *shell* | No | No | `.envrc` |

## Tool notes

### 1Password CLI: the gold standard for UX and safety

- `op run -- <cmd>` scans the env and `.env` files for **secret references** (`op://vault/item/field`), resolves them, and runs the command as a subprocess. The `.env` file with references is safe to commit.
- **Output masking is on by default.** The CLI sits between the subprocess's stdout/stderr and its own, and conceals any secret it sees. Turn it off with `--no-masking` or `OP_RUN_NO_MASKING`. The known downside: the child no longer sees a TTY, so colours switch off. 1Password's answer is "force colour in the subprocess". **Borrow:** masking, `FORCE_COLOR` forwarding. **Differ:** arca masks *always*, with no `--no-masking` equivalent.
- **Biometric authorization is per terminal session.** Each new window or tab needs approval. A session lasts 10 minutes of inactivity with a 12-hour hard cap. On macOS/Linux it carries into sub-shells. On Windows, sub-shells need separate approval. Locking the app revokes everything. **Borrow for Phase 3:** session-scoped approvals with idle TTL and a hard cap.
- Recommends service accounts scoped to specific vaults to limit what a process can read. Least privilege matters even locally.

### Doppler

- `doppler setup` binds a *directory* to a project/config, and `doppler run -- cmd` injects.
- **`--mount .env`** creates a **named pipe**, not a file, so secrets are fetched on read and never hit disk. `--mount-max-reads 1` destroys it after one read. This helps tools that insist on reading a file (PHP config caching, `docker compose env_file`). Caveats: some libraries reject non-regular files, and iCloud-synced directories fail. **Borrow for Phase 3:** `arca run --mount .env` for file-only tools. Windows named pipes work differently, so this needs a spike.
- Doppler's community threads show the pain of IDE run configurations (JetBrains/Rider) not going through the wrapper. arca needs an answer for that: `@bremmdev/arca-env/register`.

### Infisical

- `.infisical.json` (committed) stores the workspace ID. `infisical run -- cmd`. Includes secret scanning (gitleaks-based).
- **Borrow:** a committed, non-secret project ID file, so identity doesn't depend on the directory path.

### dotenvx

- Encrypts values inside `.env` with a public key (committed). The private key lives in `.env.keys` or `DOTENV_PRIVATE_KEY`. `dotenvx run -- cmd` decrypts at runtime.
- Explicitly marketed for AI editors and agents.
- **Weakness:** `.env.keys` is a plaintext file in the project directory, so an agent can read it as easily as `.env`. Any agent can also run `dotenvx run -- printenv` or `dotenvx get`. And a leaked private key decrypts every committed version forever.
- **Borrow:** the `run` ergonomics and "process env wins" precedence. **Avoid:** keeping the key in the project directory.

### secretspec (Cachix): closest to arca's data model

- `secretspec.toml` (committed) declares *what* secrets an app needs. Values live in a provider, and the system **keyring is the recommended default**. `secretspec check` validates. `secretspec run -- cmd` injects. Has profiles and SDKs.
- Release notes mention a macOS papercut: keychain items are tied to the binary's code signature, so a new build may prompt once. Expect the same with Node upgrades.
- **Borrow:** schema/value separation, `check`, profiles, keyring-first. **Differ:** arca stores one master key in the keyring plus an encrypted vault file, not one keyring item per secret.

### Varlock (dmno-dev): leak prevention ideas

- `.env.schema` with decorators: `@required`, `@sensitive`, `@type`, `@defaultSensitive`. The schema is designed to be safe for agents: names, types and descriptions, never values.
- **Runtime leak prevention:** `@redactLogs` redacts sensitive values from `console.log`, and `@preventLeaks` scans *outgoing HTTP responses* for secrets and fails the response. `varlock scan` plus git hooks catch leaks before commit.
- **Borrow:** `sensitive: false` for public values like `NEXT_PUBLIC_*`, `scan` + pre-commit hook, describing schema as agent-safe. **Consider for later:** HTTP response leak detection via `@bremmdev/arca-env/register`.

### fnox (jdx)

- `fnox.toml` holds encrypted inline values (age, KMS) or remote references. Profiles. Config discovery walks up parent directories, plus `fnox.local.toml` overrides. `fnox exec -- cmd` and an optional shell hook on `cd`. `if_missing = error|warn|ignore`.
- **Borrow:** walk-up config discovery, `if_missing` semantics. **Avoid:** the shell hook. Exporting into the shell puts values into the agent's shell too, if the agent's shell runs the hook.

### psst: the agent-native attempt

- "AI-native secrets manager. Agents use secrets without seeing them." Bun + TypeScript. Local SQLite vault encrypted with AES-256-GCM, key in the OS keychain (macOS Keychain, libsecret, Windows Credential Manager). `PSST_PASSWORD` for headless setups. Optional AWS backend.
- `psst run cmd` injects everything. `psst NAME -- cmd` injects only named secrets. Tags. Output redacted to `[REDACTED]`.
- **Gap:** `psst get NAME` prints the value with no restriction. Its FAQ says: *"It'll print the value. That's a feature for human debugging. If you're worried, don't give your agent shell access."* It does no agent detection, and the default vault is `.psst/` *inside the project*.
- **This is the gap arca fills:** the same storage model plus context-aware policy (agents can't reveal, export or change values, and can't run ad-hoc commands with secrets), a store outside the repo, and named redaction (`[arca:NAME]`) so agents can still debug.

### Teller

- Multi-provider `teller run`. `teller show` displays only the first 2 characters. Has a redaction mode for process output and logs, and `teller scan` for vault-kept secrets in code (works as a CI linter). Per-entry severity.
- **Borrow:** exact-value scanning (zero false positives, because we know the values), per-entry opt-out of redaction.

### envchain / aws-vault

- envchain stores env vars in OS keychain namespaces and runs `envchain ns cmd`. The original has no per-access passphrase flag. Ports discuss using macOS `SecKeychainPromptSelector` / access control for "require passphrase every access", which is the OS mechanism behind a stronger gate.
- aws-vault: keychain backends (keychain, wincred, secret-service, kwallet, pass, file). Besides `exec`, it can run a **local metadata server** so creds never become env vars. That's too invasive for web frameworks, which expect `process.env`.
- **Borrow:** the namespace-per-project mental model, plus a backend list with a file fallback.

### SOPS / age, git-crypt

- Encrypted files committed to the repo, decrypted with KMS or age keys. Great for teams and GitOps, heavy for local dev, and the decryption key is still on the machine. **Borrow later:** age public-key recipients for *team sharing* (Phase 3).

### direnv

- Exports variables into the interactive shell on `cd`. The agent problem: agents that spawn a login or interactive shell, or run in an integrated terminal with direnv hooks, inherit everything. **Avoid** shell-level export entirely.

### Platform CLIs: Vercel, Netlify, Railway

- `vercel env pull` writes every value, secrets included, into a plaintext `.env.local`, which is exactly what arca wants to avoid. **Opportunity:** `arca pull vercel` imports straight into the vault without leaving a plaintext file behind (Phase 3).

### Node itself

- `node --env-file=.env` and `process.loadEnvFile()` are file-based. `util.parseEnv()` (Node ≥ 20.12) can parse dotenv content for `arca import` with no dependency.

## Agent-specific context

- **Agent detection convention.** Vercel's `@vercel/detect-agent` promotes a universal **`AI_AGENT`** env var (e.g. `AI_AGENT=claude-code`, `devin@1`) and also detects Cursor, Claude Code, Devin, Gemini CLI, Codex, Antigravity, GitHub Copilot, Replit and v0 by their own variables. Claude Code sets `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT`, per the Rust `is-ai-agent` crate. A Python port keeps the rules in an `agents.json`. **Plan:** depend on or vendor this rule list, and let users add markers. *(unverified: exact variable names per agent, re-check in Spike S3.)*
- **AWS's guidance for agents** uses runtime-resolved references instead of letting agents call `get-secret-value`, and explicitly calls it **"a best-effort defense, not a security boundary."** arca should use the same honest framing.
- **Agents and `.env` files.** Knostic reported (Dec 2025, vendor blog, single observation) that Claude Code appeared to load project `.env*` files into its own runtime, and that `Read(.env*)` deny rules only apply after first access. A Claude Code GitHub issue reports deny rules not blocking `.env.local` reads, and other write-ups note that deny rules only cover the Read tool while `cat`/`grep` still work. *Whatever the exact current behaviour, the robust fix is to not have the file.* That is arca's premise.

## Lessons distilled

1. **Wrapper injection is the industry standard**, and every framework already works with it. Don't invent a new integration surface.
2. **Masking stdout/stderr is proven** (1Password, psst, Teller). The known cost is losing TTY detection. Soften it with `FORCE_COLOR`/`COLUMNS` forwarding, and remove it with a PTY mode later.
3. **Separate schema from values.** A committed file of names, descriptions and "where to get it" links replaces `.env.example` and is safe for agents to read (secretspec, Varlock, Infisical).
4. **Keychain-backed key plus an encrypted file** is the pragmatic local store (psst). Don't put the key next to the ciphertext (dotenvx's `.env.keys` problem).
5. **Nobody gates reveal or writes by caller context.** Agent detection plus TTY plus declared-script checks is cheap and novel, and it's where arca adds value.
6. **Session-scoped human approval** (1Password) is the right model for a stronger tier. It needs a daemon or OS integration, so it comes later.
7. **Be honest:** same-user processes can read the keychain and process memory. Market arca as "keeps secrets out of agent context and out of the repo", not "unbreakable".

## Sources

- 1Password CLI `op run` reference: https://developer.1password.com/docs/cli/reference/commands/run
- 1Password masking discussion (forum): https://www.1password.community/discussions/developers/68-op-run-no-color-output/138369
- 1Password CLI 2.30.3 release notes (`OP_RUN_NO_MASKING`): https://releases.1password.com/developers/cli/2.30.3/
- 1Password app integration security (session model): https://developer.1password.com/docs/cli/app-integration-security
- 1Password secret references: https://developer.1password.com/docs/cli/secret-references
- Doppler secrets access guide (`--mount`): https://docs.doppler.com/docs/accessing-secrets
- Doppler mount forum thread: https://community.doppler.com/t/mount-doesnt-seem-to-do-anything-am-i-misunderstanding-how-it-works/1231
- Doppler + JetBrains Rider thread: https://community.doppler.com/t/doppler-and-jetbrains-rider-or-any-other-dev-env/674
- dotenvx: https://dotenvx.com/docs/quickstart/encryption/
- secretspec: https://github.com/cachix/secretspec, v0.21.0 notes: https://newreleases.io/project/github/cachix/secretspec/release/v0.21.0
- Varlock: https://varlock.dev/, https://github.com/dmno-dev/varlock
- fnox: https://fnox.jdx.dev/, https://fnox.jdx.dev/reference/configuration.html
- psst: https://github.com/Michaelliv/psst, pi-psst: https://cdn.jsdelivr.net/npm/@miclivs/pi-psst@0.2.0/README.md
- Teller: https://github.com/pathcl/teller (mirror), Thoughtworks Radar: https://www.thoughtworks.com/en-ca/radar/tools/teller
- envchain: https://github.com:443/sorah/envchain, envvault README: https://raw.githubusercontent.com/Yortw/winix/main/src/envvault/README.md
- Apple `SecKeychainPromptSelector`: https://developer.apple.com/documentation/security/seckeychainpromptselector.md
- `@napi-rs/keyring`: https://github.com/Brooooooklyn/keyring-node
- `@vercel/detect-agent`: https://cdn.jsdelivr.net/npm/@vercel/detect-agent@1.2.3/README.md, `is-ai-agent`: https://docs.rs/crate/is-ai-agent/0.4.0
- AWS Secrets Manager, secrets with AI agents: https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets-ai-agents.md
- Knostic on Claude Code and `.env`: https://knostic.ai/blog/claude-loads-secrets-without-permission
- Claude Code issue #24846: https://github.com/anthropics/claude-code/issues/24846
- Vite env and modes: https://vitejs.dev/guide/env-and-mode
- Next.js environment variables: https://nextjs.org/docs/app/guides/environment-variables
- Astro environment variables: https://docs.astro.build/en/guides/environment-variables/
