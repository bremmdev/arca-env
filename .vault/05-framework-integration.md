# 05: Framework and tool integration

The general rule: **if a tool reads `process.env`, `arca run` works with no changes.** Frameworks load `.env` files *in addition to* the process environment, and the documented precedence is that already-set process env wins.

That's what makes **mixed mode** (confirmed: secrets in arca, config in `.env`) work with zero glue. The framework keeps loading your config-only `.env` files with its own mode logic, and arca's injected secrets win over any same-named entry. Effective precedence: **arca vault > shell env > `.env` files** ([03 §8](03-architecture.md#8-coexisting-with-env-files-and-the-leak-guard)).

For tools that *don't* load `.env` files themselves (plain `node`, `tsx` scripts, some CLIs), either list the files in `arca.json` `envFiles`, so arca loads them below secrets and the shell env, or use the tool's own flag (`node --env-file=.env`).

**Profiles** ([07](07-profiles.md)) work the same way in every framework. With `acceptatie` active (`arca use acceptatie`), every wrapped tool gets the acceptatie secrets, plus `.env.acceptatie` config if that profile lists it in `envFiles`, as process env, so both win over the framework's own `.env` files. Name profile config files with names frameworks don't treat as modes (`.env.acceptatie`, not `.env.development` or `.env.test`), so they're never loaded twice.

Status legend: ✅ works by design · ⚠️ works, with a pitfall · 🔬 needs a spike to confirm · ❌ needs a workaround

## Frameworks

| Framework | How it reads env | With `arca run` | Notes |
|---|---|---|---|
| **Next.js** | `@next/env` loads `.env*`. The lookup order starts at `process.env`. `NEXT_PUBLIC_*` is inlined at **build** time. | ✅ | Wrap `dev` *and* `build`. `NEXT_PUBLIC_*` values can simply stay in `.env`. Don't put secrets in `next.config` `env:`, because that inlines them. Don't add `.env.development` to `envFiles` (it would override `.env.production` during `next build`). Child workers inherit env. Next.js 16 prints browser console warnings and errors in the terminal by default (`logging.browserToTerminal: 'warn'`), with or without arca. Set it to `'error'` or `false` if a project's browser console is noisy (issue log U6). |
| **Vite** (core) | Loads `.env*` for `import.meta.env`. Env present when Vite starts has the highest priority. Only `VITE_*` reaches the client. | ✅ | Server code uses `process.env`. ✅ Verified 2026-11-03 (Vite 8.3.5, layer 5 framework checks): a `VITE_*` var that exists only in `process.env`, injected by arca from a profile's `envFiles`, reaches `import.meta.env` in the browser bundle and wins over the same var in `.env.local`. |
| **TanStack Start** | Vite-based. Server functions read `process.env`, client reads `import.meta.env.VITE_*`. | ✅ | Same Vite spike applies |
| **Astro** | `astro:env` schema (`context: server, access: secret`) reads the server environment first, then `.env` files. `import.meta.env` isn't available in `astro.config` for `.env` values. | ✅ / ⚠️ | Recommend `astro:env` secrets, which are never inlined into the bundle. 🔬 Check whether private `import.meta.env.X` values are inlined in builds (Astro has a `staticImportMetaEnv` experimental flag, so behaviour varies by version). |
| **Nuxt** | `nuxi dev` loads `.env`. `runtimeConfig` is overridden at runtime by `NUXT_*` env. | ✅ | Prefer `NUXT_`-prefixed runtime config for secrets |
| **SvelteKit** | `$env/static/private` is inlined at build. `$env/dynamic/private` is read at runtime. | ✅ / ⚠️ | Static private values end up in the server build output, so `arca scan .svelte-kit build` will catch them (Phase 2). Recommend `dynamic/private` for secrets. |
| **React Router v7 / Remix** | `process.env` in loaders/actions | ✅ | |
| **Express, Fastify, Hono, NestJS, Koa** | `process.env`, often `dotenv.config()` | ✅ | `dotenv` doesn't override existing vars and is a no-op without a file. Can be removed later. |
| **Bun runtime** | Auto-loads `.env*` | ✅ | Injected env is visible as usual. arca itself runs on Node. |
| **Deno** | `Deno.env` (with `--allow-env`) | ✅ | |
| **Expo / React Native** | `EXPO_PUBLIC_*` inlined by Metro from `process.env` | ✅ (likely) | Mobile out of scope for MVP, but nothing should break |
| **Cloudflare Workers** (`wrangler dev`, plus Astro/TanStack/Nuxt with CF adapters) | Local bindings come from `.dev.vars` / `.env`, **not** from `process.env` by default | 🔬 ❌ | Biggest known gap. 🔬 Check whether current Wrangler can include the process env in local bindings. If not, Phase 3 `arca run --mount .dev.vars` (ephemeral named pipe, Doppler-style) is the workaround. |

## Tools around the app

| Tool | Notes |
|---|---|
| **Prisma CLI** | Reads `DATABASE_URL` from env ✅. Newer `prisma.config.ts` setups often add `import 'dotenv/config'`, which is harmless. Wrap the `db:*` scripts. |
| **Drizzle Kit** | ✅ `drizzle.config.ts` reads `process.env` |
| **Vitest / Jest** | ✅ when run via a script. IDE test explorers bypass scripts, so use `import '@bremmdev/arca-env/register'` in the config (Phase 2). |
| **Playwright** | ✅ `webServer.command` inherits env from the Playwright process. Wrap `playwright test`. |
| **tsx / nodemon / node --watch** | ✅ Restarts inherit the env of the long-lived parent. These don't load `.env` themselves, so for config values use `envFiles` or `node --env-file`. |
| **Turborepo** | ⚠️ **Strict env mode** (the default in Turbo 2) only passes through declared vars. Either declare them in `turbo.json` (`env` / `globalEnv` / `passThroughEnv`) or wrap each workspace's own `dev` script instead of the root `turbo dev`. If both are wrapped and share one `arca.json`, the inner `arca run` reuses the outer one when the profile is the same, and switches cleanly when a workspace script pins another profile ([03 §7](03-architecture.md#7-runner-arca-run)). *Phase 2:* `arca init` detects `turbo.json` and offers to add `globalPassThroughEnv` with the names from `arca.json`. |
| **Nx** | ✅ wrap target commands, or the root `arca run -- nx run-many` |
| **pnpm / yarn / bun scripts** | ✅ Verified 2026-11-05 with pnpm 12, yarn 1.22, yarn 4.18 (Plug'n'Play) and bun 1.3 in the smoke test. Yarn 2+ sets no `npm_lifecycle_script`, so arca reads the script from `package.json` (P13). |
| **Docker Compose** | ⚠️ `arca run -- docker compose up` works for `${VAR}` interpolation and for `environment: [KEY]` passthrough entries. Mixed mode fits nicely here: keep `env_file: .env` for config, and add secrets as `environment: [STRIPE_SECRET_KEY, …]` passthrough entries filled from arca. |
| **VS Code debugger** | `launch.json`: `"runtimeExecutable": "npx", "runtimeArgs": ["arca", "run", "--", "node"]`, or `"runtimeArgs": ["--import", "@bremmdev/arca-env/register"]` (Phase 2). The `console: integratedTerminal` setting gives a TTY. |
| **JetBrains run configs** | Same two approaches. Doppler's forum shows this is a recurring pain point, so document it well. |
| **Storybook** | ✅ Vite/webpack based, wrap `storybook dev` |
| **GitHub Actions / Vercel / Netlify builds** | ✅ passthrough with required-name validation |

## Recommended script layout

`arca init` wraps scripts as `arca run -- <script>` and leaves `start` alone (offering `start:local`). Pinning a profile, like `test` and `e2e` below, is done by hand.

```json
{
  "scripts": {
    "dev": "arca run -- next dev",
    "build": "arca run -- next build",
    "start": "next start",
    "test": "arca run --profile test -- vitest",
    "e2e": "arca run --profile test -- playwright test",
    "db:migrate": "arca run -- prisma migrate dev",
    "db:studio": "arca run -- prisma studio"
  }
}
```

Scripts without `--profile` follow the active profile, so `arca use acceptatie` switches `dev`, `build`, `db:migrate` and `db:studio` at once. There's no need for `dev:acc`-style copies.

## Spike checklist for framework compatibility (part of Phase 0)

Run each against a fresh starter on **Windows (PowerShell + cmd)**, **macOS** and **Linux/WSL**, in both masked transports (pipe mode, and PTY mode once it exists):

1. `next dev` / `next build`: public var in the client bundle, server var at runtime, HMR, Ctrl+C cleanup with no orphaned processes.
2. `vite` / TanStack Start / Astro dev + build: `VITE_*` exposure without a file, SSR `process.env`, Vite keyboard shortcuts with piped stdout.
3. `nuxi dev`, `svelte-kit dev`, `react-router dev`.
4. `prisma migrate dev` interactive prompt in pipe mode. Clack/inquirer-style prompts check `isTTY` and may degrade. Since output is always masked there's no inherit fallback, so every tool that breaks here is a reason to ship PTY mode sooner. ✅ Prisma 7.10 on Windows, 2026-11-06: the name prompt works (it checks stdin, not stdout). Vite's shortcuts (item 2) work too. See S2 in [06](06-roadmap.md).
5. `wrangler dev` binding behaviour.
6. Turbo strict mode with and without `passThroughEnv`.
7. Colour fidelity with `FORCE_COLOR` forwarding across all of the above.
8. Mixed mode in every framework: config from `.env`, secrets from arca, and one key present in both. Confirm arca wins in dev *and* build, and that mode-specific files (`.env.production`) still apply to config during builds.
