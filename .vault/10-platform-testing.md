# 10: Platform testing plan (Windows and Linux)

> Written 2026-11-02. Scope for the MVP: **Windows and Linux are supported, macOS is not** (the code paths stay, but nothing is tested or promised there). Status: plan, nothing built yet.

## Where we are today

| Area | Windows | Linux | Notes |
|---|---|---|---|
| Unit and CLI tests (`npm test`) | Run by hand on your machine | Run on `ubuntu-latest`, **but only inside `publish.yml` when the version changed** | Ordinary pushes and PRs ran no tests at all (fixed by layer 1) |
| OS keychain (`@napi-rs/keyring`) | Used by hand | **Never run** | Every test uses passphrase mode (`test/helpers.ts:16`) |
| `chooseBackend` on Linux (WSL / no D-Bus → passphrase) | n/a | **Never run** | Reads `/proc/version` and `DBUS_SESSION_BUS_ADDRESS` |
| Real child processes | Yes: `arca run -- node print.js` in `cli.test.ts` | Same, in CI | Always `node` with `main()` called in-process. Never the built `dist/cli.mjs`, never a `.cmd` shim, never `npm run` |
| Signals (Ctrl+C, SIGTERM, exit codes 130/143) | Never | Never | `handleSignals: false` in the fake IO |
| Console guard preload (`NODE_OPTIONS=--import=file:///…`) | Unit test for a `Program Files` path | Unit test | Not run from an installed package path |
| Installed package (`npm pack` → `npm i` → `npx arca`) | By hand, in `examples/` | Never | Checks the `files` field, the bin shebang, `dist/guard.mjs` resolution and the native binding |
| File permissions (`0o700` dir, `0o600` files) | n/a (per-user `%LOCALAPPDATA%`) | **Not asserted** | `atomicWrite` calls `chmodSync` |
| musl (Alpine), arm64 | n/a | Never | Prebuilt bindings exist for both |

## Gaps that worry me most

1. **No tests on normal pushes** (fixed 2026-11-02 by layer 1). A broken commit only showed up when you bumped the version, and then the failing run blocked the publish.
2. **The Linux keychain path has never run.** Two specific doubts:
   - `writeOsKey` reads the key back to catch "keyutils accepts writes that don't persist". A read-back **in the same process** will succeed with keyutils too, so that check probably doesn't do what its comment says. Needs a real test: write, then read from a *new process* after the keyring daemon restarts.
   - D-Bus present but no Secret Service daemon (minimal desktops, tiling WMs, some containers): we choose `os` and then fail. The error tells the user to set `ARCA_KEYCHAIN=passphrase`. Check the message is actually what they see, and consider falling back automatically on the *first* key creation.
3. **Windows `.cmd` shims.** `next`, `vite` and `npm` are `.cmd` files in `node_modules/.bin`. `cross-spawn` handles them, but no test proves it, including arguments with spaces, quotes, `&` and `%`.
4. **Signals.** Ctrl+C has to stop the dev server once, not leave an orphan, and give a sensible exit code. That's different on each OS and isn't tested anywhere.

## The plan

Four layers, cheapest first, plus framework coverage as a todo (layer 5). Each layer runs on both OSes.

### Layer 1: CI on every push and PR (`.github/workflows/publish.yml`) ✅ built 2026-11-02

One workflow, two jobs. The filename stays `publish.yml` because npm trusted publishing (OIDC) is registered for that filename; renaming it means updating the trusted publisher on npmjs.com first.

```
on: [push, pull_request]
test:     matrix os [ubuntu-latest, windows-latest] × node [24, current]
          npm ci → typecheck → test → build → smoke (layer 3)
publish:  needs: test, only on push to main
          version already on npm? skip : build → npm publish
```

- **A version bump is the release gate.** Every push and PR runs the tests; a push to main whose `package.json` version isn't on npm yet also publishes, but only if every test job passed. Failing tests with a bump: nothing is published; fix and push again, no second bump needed.
- `id-token: write` (publish rights) is granted to the publish job only, so test code never runs with it.
- `fail-fast: false`: one platform failing doesn't hide the other's result.
- Superseded runs on branches are cancelled; runs on main never are, so a publish isn't cut off. The publish job has its own `publish` concurrency group, so two quick pushes can't publish at once.
- A push to a branch with an open PR runs the tests twice (once for `push`, once for `pull_request`). Accepted for now.
- Extra Linux jobs, each small:
  - **`ubuntu-24.04-arm`**: arm64 binding (`linux-arm64-gnu`).
  - **Alpine container** (`node:24-alpine`): musl binding, BusyBox userland. Passphrase mode only.
  - **Secret Service job**: `ubuntu-latest` with `gnome-keyring` + `dbus-x11` installed, tests run under `dbus-run-session` with an unlocked keyring (`echo pw | gnome-keyring-daemon --unlock --components=secrets`). This is where the real-keychain tests (layer 2) run on Linux.
- Windows: the real-keychain tests run on `windows-latest` directly (runners have Credential Manager).
- Skip `windows-11-arm` for now; add it if someone asks.

### Layer 2: new tests in the suite

| Test file | What it covers | Runs where |
|---|---|---|
| `test/keychain.test.ts` | Real OS keychain: create key on first `set`, read it back **from a new process**, `deleteOsKey`, the "vaults exist but key missing" error, a custom `ARCA_HOME` gets its own account (`keychainAccount` hash) so tests never touch your real key. Gated by `ARCA_TEST_OS_KEYCHAIN=1`, always cleans up. | Windows CI, Linux Secret Service job, your machine on demand |
| `test/backend.test.ts` | `chooseBackend` with injected `/proc/version` and env: WSL → passphrase, no D-Bus → passphrase, D-Bus → os, config and `ARCA_KEYCHAIN` override both. Needs `readSafe` made injectable (via `IO`), a small change. | Everywhere (pure) |
| `test/spawn.test.ts` | Child processes the way real projects run them: a `.cmd`/shell shim in a fake `node_modules/.bin`, args with spaces/quotes/`&`/`%`/unicode, paths with spaces, exit codes passed through, `command not found` → 127, masking when output arrives in tiny chunks or as one huge line. | Both OSes |
| `test/signals.test.ts` | Spawn the **built CLI** as a real process running a child that sleeps. Linux: SIGTERM/SIGINT/SIGHUP reach the child, exit code 143/130, no orphan left. Windows: kill the tree with `taskkill /T` and check no orphan; Ctrl+C can't be simulated reliably in CI, so it goes on the manual checklist. | Both OSes, different assertions |
| additions to `units.test.ts` | Linux: store dir is `0o700`, vault and key files `0o600` after every write path (`set`, `import`, `restore`, `.bak`). Windows: store lands in `%LOCALAPPDATA%`, not roaming. XDG_DATA_HOME honoured. The `atomicWrite` EPERM retry with a file held open (Windows only). | Per OS with `it.runIf` |

Rule for platform-specific tests: use `it.runIf(process.platform === 'linux')` etc., never silently skip. A test that can't run on an OS should say so in its name.

### Layer 3: packed-package smoke test (`scripts/smoke.mjs`) ✅ built 2026-11-02

`npm run build && npm run smoke`. Runs in CI after `build`, on every OS/Node job. It tests what users actually install, not the source. The project is deliberately tiny (no framework): one `package.json` with `"dev": "arca run -- node app.js"`, an `arca.json` declaring `API_KEY`, and `app.js`. Steps:

1. `npm pack`, and check `dist/cli.mjs`, `dist/index.mjs`, `dist/guard.mjs` and `schema.json` are in it.
2. Install the tarball into a temp project whose path has a space in it.
3. `npx arca --version` matches `package.json` (bin shim, `.cmd` on Windows).
4. Store `API_KEY` in a throwaway passphrase store (`ARCA_HOME`, `ARCA_PASSPHRASE`), never the real store or keychain. This goes through the installed package's programmatic `main()` with a terminal-like IO, because the CLI's human gate rightly refuses `set` without a real terminal. It also checks the package's `exports`.
5. `npm run dev`: the secret is injected (`secret-ok=true`) and `console.log`, `process.stdout.write` and `console.error` all show `[arca:API_KEY]`, never the value.
6. `app.js` replaces `console.log` with a wrapper that saves its arguments to a file (like TanStack's console piping). The file must hold the masked value, which proves the console guard was preloaded from inside `node_modules`.
7. With `CLAUDECODE=1`: `npm run dev` is allowed and masked; `npx arca run -- node app.js` is refused.
8. `npx arca doctor` names the passphrase key storage and never the value.
9. CI without a store (`CI=true`, empty `ARCA_HOME`): `npm run dev` fails naming `API_KEY`, and passes through when the platform provides it.

The script strips agent markers and `npm_*`/`ARCA_*` vars it inherited, so it gives the same result when run from Claude Code. `ARCA_SMOKE_KEEP=1` keeps the temp folder for inspection.

Optional later: repeat steps 2–7 with `pnpm` (symlinked `node_modules`, different shims). Worth it before 1.0, not for the MVP.

### Layer 5 (todo): framework coverage

The smoke test has no framework on purpose: framework installs are slow and a broken framework release shouldn't fail an arca push. Framework-specific behaviour is still worth covering in CI, as a **separate job that runs daily (`schedule`) and on version bumps**, never blocking a normal push:

- Next.js: `next dev` through `arca run`; server `console.log` masked in the terminal, in `.next/dev/logs/next-development.log` and in React's browser log replay (issues U3, U4 in [08](08-issue-log.md)).
- TanStack Start or Vite: devtools console piping to the browser is masked (U2).
- Both OSes. The browser checks need headless Chrome (Playwright), which is the slow part.

The `examples/` folders on your machine are the starting point, but they're gitignored, so the job needs small committed fixtures or scaffolds them with `create-next-app` / `create-vite` at a pinned version.

### Layer 4: local and manual testing on your machine

**WSL (Ubuntu 24.04)** — yes, it's useful, for three things CI can't easily give you:

- **Interactive passphrase prompts in a real terminal.** WSL is the main real-world passphrase user, and `@clack/prompts` in a real TTY isn't covered by any automated test.
- **A real Secret Service with a real desktop session.** WSLg is running on your machine and WSL already has a systemd D-Bus session (`DBUS_SESSION_BUS_ADDRESS` is set). Install `gnome-keyring` and `libsecret-tools`, run with `ARCA_KEYCHAIN=os`, and check the key survives `wsl --shutdown`. That tests persistence across a full restart, which CI can't do.
- **Running the suite on Linux before pushing.**

Setup notes:
- Install Node 24 in WSL (`fnm` or `nvm`). It isn't installed yet.
- Clone the repo **inside the WSL filesystem** (`~/arca`), not `/mnt/c/...`. On `/mnt/c` the permission tests give wrong results (DrvFs fakes modes) and everything is slower.
- Don't share `node_modules` between Windows and WSL: the keyring binding is per OS.

**Docker Desktop** (installed, not running): useful for quickly trying Alpine and a "headless server, no D-Bus" Linux without setting up CI. Optional; the CI jobs cover the same ground.

**Manual checklist before each release** (keep it short, ~15 min):

| # | Where | Check |
|---|---|---|
| M1 | Windows Terminal + PowerShell | `npm run dev` in a real Next.js example; Ctrl+C stops it **once**, no "Terminate batch job (Y/N)?" loop, no orphan `node.exe` in Task Manager |
| M2 | cmd.exe and Git Bash | `npx arca`, `npx arca set` (masked prompt works), `npm run dev` |
| M3 | Windows, VS Code integrated terminal + Claude Code | Agent runs `npm run dev` (allowed, masked), `npx arca reveal` (refused) |
| M4 | WSL, fresh store | First `npx arca set` asks for a passphrase twice; later commands ask once; `ARCA_PASSPHRASE` skips it |
| M5 | WSL with gnome-keyring, `ARCA_KEYCHAIN=os` | Key survives `wsl --shutdown` |
| M6 | WSL | Ctrl+C on `npm run dev`; `kill -TERM` the arca process from another shell |

Record anything found in [08](08-issue-log.md), as usual.

## Making "macOS not supported" explicit

- README: a "Supported platforms" line: Windows 10/11 and Linux (glibc and musl, x64 and arm64), Node ≥ 24. macOS: not supported yet, may work.
- `arca doctor` on macOS: one warning line saying it's untested. No hard block.
- **Don't** add `"os": ["win32", "linux"]` to `package.json`. That makes `npm i` fail outright for every macOS teammate in a mixed team, which breaks installs for the whole repo.
- Leave the darwin code paths in place (`paths.ts`, `info.ts`, `init.ts`). They're three lines, and removing them gains nothing.

## Order of work

1. ✅ CI with the Windows + Linux matrix running the existing tests, publish gated on it (2026-11-02).
2. ✅ Smoke test (layer 3) added to CI (2026-11-02).
3. `backend.test.ts` + `keychain.test.ts` + the Secret Service CI job. Fix the read-back check in `writeOsKey` depending on what the test shows.
4. `spawn.test.ts` and the permission tests.
5. `signals.test.ts`.
6. WSL setup and the first pass of the manual checklist.
7. README/doctor wording for macOS.
8. Later: arm64 and Alpine jobs, pnpm smoke test.
9. Todo: framework coverage job (layer 5), daily and on version bumps.
