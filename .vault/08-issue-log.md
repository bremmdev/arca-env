# 08: Issue log

Every error, bug and problem found so far, with its cause and what was done about it. Add new entries at the bottom of the right section, with the date. Status: ✅ fixed · ⚠️ mitigated, residual risk · ⏳ open · ℹ️ not a bug (recorded because it was surprising).

## Found by you while using arca

| # | Date | Problem | Cause | Fix | Status |
|---|---|---|---|---|---|
| U1 | 2026-10-22 | `arca init` in a TanStack repo after a local install gave `bash: arca: command not found` | Local installs put the binary in `node_modules/.bin`, which isn't on your shell's PATH. Only package scripts get it on PATH. arca's own messages made it worse: several told people to run a bare `arca set NAME` or `arca list`. That included the agent refusal messages and the AGENTS.md section, so agents following them would fail too. | Every "run this" hint now says `npx arca …`. The help header says `Usage: npx arca <command>` and notes that plain `arca` works inside scripts. The README explains local vs global installs. | ✅ |
| U2 | 2026-10-22 | In a TanStack Start app, `console.log(process.env.ADMIN_PASSWORD)` was masked in the terminal but showed the real value in the **browser** console (`[Server] LOG … Latindash1!`) | TanStack Devtools' `consolePiping` (on by default in dev) injects code into the server entry that replaces `console.*`. That code POSTs the raw arguments to the Vite dev server, which pushes them to the browser. That route never passes through arca's stdout masking. Agents with browser tools (Playwright MCP, Chrome DevTools MCP) read that console. | `arca run` preloads a console guard into every Node child (`NODE_OPTIONS=--import=…/dist/guard.mjs`, names only in `ARCA_MASK`). It masks `console.*` arguments before any wrapper sees them, and an accessor keeps it outermost when tools replace `console.log` later. Verified against TanStack's real injected code: the forwarded payload now holds `[arca:ADMIN_PASSWORD]`. | ⚠️ Fixed for console forwarding, not yet confirmed in your full app. Still not covered: error overlays, rendered pages, and loggers that don't use `console` (threat model L11). |
| U3 | 2026-10-22 | In Next.js, **no** server `console` logs reached the browser any more when run with arca (normally React shows them with a "Server" badge) | Caused by the U2 fix. The guard turned `console.log` into a getter/setter. React (`patchConsole` in react-server-dom) and Next.js (`console-file`, `console-dim`, `console-exit`) only patch console methods whose descriptor has `value: function`, so they silently skipped patching. That disabled React's log replay and Next's dev log file. Going back to a plain property would have been worse: React would wrap outside the guard and send raw values to the browser. | The global `console` became a Proxy over the real one. Methods stay plain data properties, so React's and Next's checks pass. The Proxy's `defineProperty` trap (React/Next) and `set` trap (TanStack) wrap whatever gets installed, so masking still runs first. Verified in headless Chrome against a real Next.js 16.4 dev server: with arca the browser shows `Server  db is [arca:DATABASE_URL]`, without arca the raw connection string. Tests copy React's `patchConsole` logic. | ✅ Restart your dev server to load the new guard |
| U4 | 2026-10-22 | (found while fixing U3) Next.js 16.4 copies every server `console` call into **`.next/dev/logs/next-development.log`**, a file meant for agents and MCP tools | Next's `console-file` extension wraps console methods and writes the formatted arguments to that file, which bypasses stdout masking. Before U3 was fixed, the guard accidentally disabled the file logger. | Covered by the U3 fix: Next's wrapper is wrapped by the guard, so the file gets masked values. Verified: with arca the file holds `[arca:DATABASE_URL]`, without it the raw password. | ✅ |
| U5 | 2026-10-22 | In a TanStack Start project, `arca init` seemed not to wrap all scripts (`generate-routes`, `format`, `lint`, `check`, `start`) | Intended behaviour, but unexplained. `init` only wraps tools that use env vars (`tsr` and `biome` don't). `check` chains `npm run check:*` scripts that are wrapped themselves. `start` stays unwrapped on purpose for production. Silence made it look like a bug, and a local run of the production build had no way to get secrets. | `init` now lists every unwrapped script with the reason, and offers to add `"start:local": "arca run -- <start>"`. Tested with the project's real script list. | ✅ |

## Found during implementation

| # | Date | Problem | Cause | Fix | Status |
|---|---|---|---|---|---|
| I1 | 2026-10-22 | `.env` parser disagreed with Node/dotenv on `HASH=abc#def` (gave `abc#def`, they give `abc`) | I only treated ` #` (space then hash) as a comment. dotenv, which Next.js and Vite use, ends an unquoted value at the first `#`. arca would have imported or compared a different value than the framework sees. | Unquoted values now end at the first `#`. A test compares the parser with `node:util` `parseEnv`. | ✅ |
| I2 | 2026-10-22 | Build warning: tsdown `external` is deprecated | tsdown 0.22 renamed the option | `deps: { neverBundle: [...] }` | ✅ |
| I3 | 2026-10-22 | Typecheck failed after the `npx` change (TS1005 in `main.ts`) | The new help header contained backticks inside the help text's template literal | Reworded without backticks | ✅ |
| I4 | 2026-10-22 | One end-to-end test failed (`len=27`) | Test bug: the fake Stripe key is 26 characters | Corrected the expectation | ✅ |
| I5 | 2026-10-22 | (profiles) Two existing tests failed after profiles landed | They asserted the old "profiles are not available yet" warning and refusal | Updated to the new behaviour: `--profile acc` now says the profile isn't declared and how to add it | ✅ |
| I6 | 2026-10-22 | (profiles) A new test expected `NODE_ENV` to be unset in the child | vitest sets `NODE_ENV=test` in its own process, and arca passes it through | The test now checks that `NODE_ENV` is unchanged, which is the real claim (profiles don't set it) | ℹ️ |

## Found during validation (real Next.js app, real keychain, real npm)

| # | Date | Problem | Cause | Fix | Status |
|---|---|---|---|---|---|
| V1 | 2026-10-22 | An agent's `npx arca run -- node -e …` was refused (correct), but the message said *"the "npx" script in package.json doesn't match"* | `npx` / `npm exec` set `npm_lifecycle_event=npx` and put the ad-hoc command in `npm_lifecycle_script`. arca took that for a package script that failed verification. | A lifecycle event with no matching script in `package.json` now counts as ad-hoc, so the plain ad-hoc refusal appears. Covered by a test. | ✅ |
| V2 | 2026-10-22 | A colour escape code wrapped an empty line in `arca init` output | A coloured string started with `\n` | The newline moved outside the colour | ✅ |
| V3 | 2026-10-22 | Next.js 16.4 adds its own block to `AGENTS.md` during `next dev` | Next.js now generates agent rules itself | Nothing to fix: arca's "Secrets (arca)" section stays intact next to it | ℹ️ |
| V4 | 2026-10-22 | Checking the rendered page with `grep` found no values | React puts `<!-- -->` between text nodes, so `stripe-ok=true` became `stripe-ok=<!-- -->true` | Validation script only. The page was correct. | ℹ️ |
| V5 | 2026-10-22 | A validation script failed with `ERR_UNSUPPORTED_ESM_URL_SCHEME … protocol 'c:'` | On Windows, an ESM import of an absolute path needs a `file:///` URL | Validation script only. The console guard already uses `pathToFileURL`, which also encodes spaces. A unit test covers a path with `Program Files`. | ℹ️ |
| V6 | 2026-10-22 | A hand-written test `arca.json` was rejected: *"id must be an arca project ID"* | IDs use base32 (`a–z`, `2–7`), and the test ID contained `0` | Correct behaviour, and the message says what to do. Worth knowing for anyone who writes an ID by hand. | ℹ️ |
| V7 | 2026-10-22 | (profiles, Next.js example) `arca list` said `APP_TITLE` came from `.env.local` for `acceptatie`, but the app showed the `.env.acceptatie` value | The list took the last matching file in alphabetical order. At runtime, files arca loads (`envFiles`) become process env, which beats the framework's own `.env.local`. | `list` ranks the profile's `envFiles` first. Covered by a test. | ✅ |
| V8 | 2026-10-22 | `npx arca` status said `Secrets   2 storeds` | `plural(n, 'stored')` adds an "s" (older than profiles) | Prints `2 stored` | ✅ |
| V9 | 2026-10-22 | (TanStack Start example) One server `console.error` echoed 64 times between the dev server and the browser console | Vite 8 forwards browser console errors to the terminal, and TanStack Devtools pipes terminal logs back to the browser. **Same result without arca** (compared on the same app). Every echo was masked. | Not arca's. The example's `/api/db` route logs with `console.log` and says why. | ℹ️ |
| V10 | 2026-10-22 | Port 3000 was taken by another app on your machine during validation | Something else was running there | The TanStack example uses port 3124 (Next.js uses 3123) | ℹ️ |
| V11 | 2026-10-22 | A validation helper read a different file than Git Bash had just written | Git Bash's `/tmp` is `%LOCALAPPDATA%\Temp`, Node resolves `/tmp` to `C:\tmp` | Validation scripts only: use Windows paths (`cygpath -w`) | ℹ️ |

## Found while designing (in these docs)

| # | Date | Problem | Fix | Status |
|---|---|---|---|---|
| D1 | 2026-10-21 | The profiles design made every non-default profile **protected** (agents refused, y/N per run, no sticky profile), framed around production vs development. You wanted equal, switchable local sets. | Redesigned (D10, revised 2026-10-22): all profiles equal, `arca use` to switch, no protection tiers. Saved as a feedback memory so it doesn't come back. | ✅ |
| D2 | 2026-10-21 | The explainer claimed Cursor, Codex and Gemini use the `AI_AGENT` convention | Corrected: each has its own markers, and `AI_AGENT` is a shared convention any tool can adopt | ✅ |
| D3 | 2026-10-21 | Threat-model rows L16 to L19 ended up out of order. There was a wrong cross-reference (§6 instead of §7), and stale terms remained after renames (`--env`, `ARCA_ENV`, "environment", `default` field, `--keep`). | Reordered, corrected, and swept with grep after each change | ✅ |

## Open problems and things not verified yet

| # | Problem | Status |
|---|---|---|
| O1 | Passphrase mode (WSL, headless Linux) asks for the passphrase on **every** run unless `ARCA_PASSPHRASE` is set. The planned keyutils cache isn't built. | ⏳ |
| O2 | Ctrl+C on `npm run dev` in a real terminal: does any `node.exe` stay behind? Only a killed process tree was tested. | ⏳ needs you |
| O3 | Colours, Vite shortcuts and interactive prompts through the masking pipe (spike S2) | ⏳ needs you |
| O4 | The human prompts (`init`, `set`, `setup`) in a real terminal. Validation simulated them. | ⏳ needs you |
| O5 | The console guard in a full TanStack Start app (does `--import` in `NODE_OPTIONS` disturb the dev server?) | ✅ dev server checked 2026-10-22 in `examples/tanstack-start` (TanStack Start 1.169, Vite 8, Devtools on): starts normally, browser console gets `[arca:NAME]`. `vite build` not checked yet. |
| O6 | Lifecycle variables under pnpm, yarn and bun (spike S4), and markers of agents other than Claude Code (spike S3) | ⏳ |
| O7 | `package.json` says `MIT`, but there's no `LICENSE` file, and the license wasn't your explicit choice | ⏳ |
| O8 | The tests leave temporary folders in the OS temp directory | ⏳ minor |
| O9 | `npx arca --version` prints `0.1.0` (hard-coded in `main.ts`), while `package.json` says `0.1.2` | ⏳ minor, older than profiles |
| O10 | `publish.yml` publishes on **every push to `main`**. Profiles is a new feature, so bump the version (to 0.2.0?) before pushing, or the publish will fail on the existing 0.1.2 | ⏳ needs you |
| O11 | The profile prompts in `arca init`, and `profiles copy` / `profiles rm` confirmations, in a real terminal. Validation simulated them. | ⏳ needs you |
