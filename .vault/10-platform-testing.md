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
| musl (Alpine), arm64 | n/a | ✅ CI jobs since 2026-11-03 | Prebuilt bindings exist for both |

## Gaps that worry me most

1. **No tests on normal pushes** (fixed 2026-11-02 by layer 1). A broken commit only showed up when you bumped the version, and then the failing run blocked the publish.
2. **The Linux keychain path has never run** (fixed 2026-11-02, P3 in [08](08-issue-log.md)). Two specific doubts, both confirmed in Docker:
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
test:            matrix os [ubuntu-latest, windows-latest] × node [24, 26], plus ubuntu-24.04-arm × 24
                 npm ci → typecheck → test → build → smoke (layer 3) → smoke with pnpm
alpine:          docker run node:24-alpine: npm ci → typecheck → test → build → smoke
keychain-linux:  real Secret Service (gnome-keyring under dbus-run-session)
publish:         needs: test, alpine, keychain-linux, only on push to main
          version already on npm? skip : build → npm publish
```

- **A version bump is the release gate.** Every push and PR runs the tests; a push to main whose `package.json` version isn't on npm yet also publishes, but only if every test job passed. Failing tests with a bump: nothing is published; fix and push again, no second bump needed.
- `id-token: write` (publish rights) is granted to the publish job only, so test code never runs with it.
- `fail-fast: false`: one platform failing doesn't hide the other's result.
- Superseded runs on branches are cancelled; runs on main never are, so a publish isn't cut off. The publish job has its own `publish` concurrency group, so two quick pushes can't publish at once.
- A push to a branch with an open PR runs the tests twice (once for `push`, once for `pull_request`). Accepted for now.
- Extra Linux jobs, each small:
  - ✅ **`ubuntu-24.04-arm`**: arm64 binding (`linux-arm64-gnu`). A matrix `include` on Node 24: the whole test job, smoke tests included.
  - ✅ **`alpine`** (`node:24-alpine`): musl binding, BusyBox userland, passphrase mode only. Typecheck, tests, build and the npm smoke test inside a plain `docker run` (no JavaScript action has to run in Alpine). Publish needs it too. Passed locally in Docker first (112 tests).
  - ✅ **`keychain-linux`**: `ubuntu-latest` with `dbus` + `gnome-keyring`, tests run under `dbus-run-session` with an unlocked keyring (`echo pw | gnome-keyring-daemon --unlock --components=secrets`). Runs `keychain.test.ts` against the real Secret Service and `backend.test.ts` (auto-detection). Publish needs it too.
- ✅ Windows: the real-keychain tests run in the `windows-latest` test jobs (`ARCA_TEST_OS_KEYCHAIN=1` on the Test step).
- Skip `windows-11-arm` for now; add it if someone asks.

### Layer 2: new tests in the suite

| Test file | What it covers | Runs where |
|---|---|---|
| ✅ `test/keychain.test.ts` | Real OS keychain: first `set` picks the OS keychain by itself and creates no passphrase file, each temp `ARCA_HOME` gets its own entry (never your real `master-key/v1`), `doctor` names the keychain, a deleted entry gives "no master key found" and is never silently replaced. Gated by `ARCA_TEST_OS_KEYCHAIN=1`, deletes its entries afterwards. (The "read back from a new process" idea was dropped: pinning to the Secret Service removes the in-memory fallback it was meant to catch.) | Windows CI, `keychain-linux`, your machine on demand |
| ✅ `test/backend.test.ts` | `chooseBackend`: Windows → os, Linux + D-Bus → os, no D-Bus → passphrase, WSL (`WSL_DISTRO_NAME`) → passphrase, `ARCA_KEYCHAIN` and the store's recorded backend override. On real Linux: with a D-Bus address that can't connect, the first key falls back to a passphrase with a note. | Everywhere; the fallback on Linux, not WSL |
| ✅ `test/spawn.test.ts` | A local tool package installed by **real npm** (`--offline`), so `node_modules/.bin` holds npm's own shim: `.cmd` through cmd.exe on Windows, a symlink on Linux. Project path with a space. 21 awkward arguments arrive unchanged (spaces, quotes, `& | < > ^ ! ( ) ; , * ?`, `%PATH%`, backslashes, unicode, an empty string). Secret masked, exit codes passed through, missing command → 127. Masking holds when the secret arrives one byte per chunk, when a multi-byte value is split across chunks, and inside a 1 MB line with no newline. | Both OSes (passed on both, 2026-11-02) |
| ✅ `test/signals.test.ts` | Builds the CLI with the tsdown API into `node_modules/.cache` (≈ 150 ms, `dist/` untouched) and runs it as a real process, masked, with stdin a pipe. Linux, for SIGTERM, SIGHUP and SIGINT: a child that handles the signal gets it, arca exits with the child's code and its last output still comes through masked; a child that doesn't is stopped and arca exits 128 + signal (143, 129, 130); no child is left behind. Windows: killing **only** arca ends the child too (libuv puts children in a kill-on-close job object), and `taskkill /T /F` ends both. Ctrl+C in a real terminal stays manual (M1, M6). | Both OSes, different assertions (passed on both, 2026-11-02) |
| ✅ `test/files.test.ts` | Store location: `%LOCALAPPDATA%` not roaming, the home-folder fallback, `XDG_DATA_HOME`, `ARCA_HOME`. Linux: after `set` ×2, `restore`, `profiles add`, `use` and `policy set`, the store folder is `0700` and every file under it is private; `export --output` makes new **and existing** files `0600` (P6). Windows: a file held open without delete sharing (like antivirus) for 300 ms is still written; held for 5 s, the write fails cleanly (P5). | Per OS with `it.runIf` (passed on both, 2026-11-02) |

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

✅ `npm run smoke -- --pnpm` (2026-11-03) runs every step with pnpm instead: `pnpm add` of the tarball, `pnpm run dev`, `pnpm exec arca`. The package then sits behind a symlink (a junction on Windows) in `node_modules/.pnpm/@bremmdev+arca-env@file+…`, so the console guard is preloaded from a path with `+` and `@` in it. Runs in every test job after the npm smoke test, with pnpm 12 (pinned major). Passed on Windows and Linux before it went into CI. yarn isn't covered.

### Layer 5: framework coverage (`scripts/frameworks.mjs`, `.github/workflows/frameworks.yml`) ✅ built 2026-11-03

The smoke test has no framework on purpose: framework installs are slow and a broken framework release shouldn't fail an arca push. So framework behaviour has **its own workflow**, `frameworks.yml`: daily (04:23 UTC), on every push to main that changes `package.json` (so every version bump), and by hand (`workflow_dispatch`). It never blocks a push or a publish. Windows and Ubuntu, Node 24.

- **Fixtures** in `scripts/frameworks/next` and `scripts/frameworks/tanstack-start`: trimmed copies of the `examples/` apps, at exactly the versions you run (Next 16.4.2, React 19.3.1; TanStack Start 1.169.3, Vite 8.3.5, devtools-vite 0.8.5). Plain JS for Next and no TypeScript package, so the installs stay small. They live under `scripts/`, outside the tsconfig and vitest scope. No lockfiles: the direct versions are pinned, the daily run picks up drift below them, which is what it's for.
- **The script** packs the package, copies each fixture to a temp folder, installs the tarball, stores two secrets in a throwaway passphrase store, runs `npm run dev -- --port <free>` and opens the page in headless Chrome (`playwright-core` with the installed Google Chrome, no browser download).
- **Checks per framework:** the page shows the secret's length (injected), the page and `/api/leak` log the secrets and the terminal shows `[arca:…]`; the browser console gets the masked value (Next: React's "Server" log replay, U3; TanStack: devtools console piping, U2); Next's `.next/dev/logs/next-development.log` holds the masked value (U4); no raw value anywhere in the terminal, the browser console or the log file.
- **The checks can fail:** a control run with `dist/guard.mjs` emptied failed 5 checks, each naming the raw value in the browser console or the log file, while terminal masking (a separate layer) still held.
- Everything binds to `127.0.0.1`, not `localhost`. In a Debian container `localhost` resolved to `::1` first, and neither the readiness probe nor TanStack's server-to-browser pipe got through (P11).
- Locally: `npm run build && npm run frameworks` (or `-- next` for one). Without Google Chrome, `ARCA_FRAMEWORKS_CHANNEL=` plus `npx playwright-core install chromium`. Passed on Windows and in a `node:24` container before it went into CI.

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
| M1 | Windows Terminal + PowerShell | `npm run dev` in a real Next.js example; Ctrl+C stops it **once**, no "Terminate batch job (Y/N)?" loop, no orphan `node.exe` in Task Manager. (Killing arca and process-tree kills are automated now; only the console Ctrl+C is left.) ✅ 2026-11-03: stops once, nothing left running. The "Terminate batch job" prompt does appear, but it comes from Volta's `npm.exe` shim and shows up without arca too (P9) |
| M2 | cmd.exe and Git Bash | `npx arca`, `npx arca set` (masked prompt works), `npm run dev`. cmd.exe ✅ 2026-11-03: status shows "interactive terminal", `set` shows dots, `npm run dev` masked; Ctrl+C leaves nothing running and port 3123 free (the batch prompt is Volta's, P9). Git Bash ✅ 2026-11-03: same results; the arrow-key Yes/No prompt works. Found P10 (typo question defaulted to Yes) |
| M3 | Windows, VS Code integrated terminal + Claude Code | Agent runs `npm run dev` (allowed, masked), `npx arca reveal` (refused). ✅ 2026-11-03: the agent started `npm run dev` in the background (acceptatie, 4 secrets, output masked); asked for `DATABASE_URL`, it first declined on its own (after reading arca's source); told to run `npx arca reveal DATABASE_URL`, arca refused with exit 1 ("secret values cannot be shown to AI agents (detected: claude-code via AI_AGENT)") and printed no part of the value |
| M4 | WSL, fresh store | ✅ 2026-11-02, driven through a real PTY: a fresh store on WSL picks passphrase mode by itself; the first `npx arca set` hides the value, then asks for the passphrase twice; `npm run dev` asks once and runs masked; `ARCA_PASSPHRASE` skips it; a wrong passphrase stops with "arca: wrong passphrase."; nothing is ever echoed |
| M5 | gnome-keyring, `ARCA_KEYCHAIN=os` | ✅ 2026-11-02, in Docker (WSL would need sudo for the packages): the key written in one D-Bus session is read back by a **new** session and a new keyring daemon, from `login.keyring` on disk, with the kernel keyring blocked. A locked keyring fails at once with an unlock hint (P8) |
| M6 | WSL | ✅ 2026-11-02, real PTY Ctrl+C on `npm run dev`: SIGINT reaches the whole foreground group (npm, sh, arca, node); a child that handles it gets it **exactly once** (arca doesn't forward it again), its last output still appears, and nothing is left running, with or without a handler |

Record anything found in [08](08-issue-log.md), as usual.

## Making "macOS not supported" explicit

- README: a "Supported platforms" line: Windows 10/11 and Linux (glibc and musl, x64 and arm64), Node ≥ 24. macOS: not supported yet, may work.
- `arca doctor` on macOS: one warning line saying it's untested. No hard block.
- **Don't** add `"os": ["win32", "linux"]` to `package.json`. That makes `npm i` fail outright for every macOS teammate in a mixed team, which breaks installs for the whole repo.
- Leave the darwin code paths in place (`paths.ts`, `info.ts`, `init.ts`). They're three lines, and removing them gains nothing.

## Order of work

1. ✅ CI with the Windows + Linux matrix running the existing tests, publish gated on it (2026-11-02).
2. ✅ Smoke test (layer 3) added to CI (2026-11-02).
3. ✅ `backend.test.ts` + `keychain.test.ts` + the `keychain-linux` CI job (2026-11-02). The read-back doubt was real: see P3 in [08](08-issue-log.md).
4. ✅ `spawn.test.ts` and `files.test.ts` (2026-11-02). Found and fixed P5 (Windows rename retry too short) and P6 (`export --output` kept an existing file world-readable).
5. ✅ `signals.test.ts` (2026-11-02). No bugs found; one surprise recorded (P7).
6. ✅ First pass of the manual checklist (2026-11-02). WSL already had Node 24.15 (nvm); the suite and the smoke test pass there (110 tests). M4–M6 were driven through a real pseudo-terminal (a small Python `pty` driver), M5 in Docker. One fix: the locked-keyring message (P8). M1–M3 done 2026-11-03 (P9: the batch prompt is Volta's; P10 fixed). The whole checklist has had a first pass.
7. ✅ README/doctor wording for macOS (2026-11-02): a "Supported platforms" section in the README; `arca init` and `arca doctor` warn on macOS without failing (tested); D11 in [06](06-roadmap.md).
8. ✅ arm64 and Alpine jobs, pnpm smoke test (2026-11-03). No bugs found.
9. ✅ Layer 5, framework coverage (2026-11-03): Next.js and TanStack Start in a daily workflow. No arca bugs found.
9. Todo: framework coverage job (layer 5), daily and on version bumps.
