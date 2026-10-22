# arca (keeping secrets out of reach of AI agents)

Almost every JavaScript project keeps its passwords and API keys in a `.env` file. That used to be fine. Now AI coding agents work inside your project: they open files, run commands and read the output, so whatever is in `.env.local` ends up in their context. **arca** moves those secrets into an encrypted store outside the project, and hands them to your app only at the moment it runs. Your app still reads `process.env.DATABASE_URL`, so your framework and your code don't change.

The goal is **much safer than `.env` files**, not unbreakable. When safety and ease of use pull in different directions, ease of use wins, as long as secrets still stay out of agents' hands under normal circumstances.

| Term | Meaning |
| --- | --- |
| Secret | A value that must not leak: an API key, a database password, a token |
| Config | A value that isn't sensitive: a port, a public key, a feature flag. It can stay in `.env` |
| Store | The encrypted place on your machine where arca keeps secrets, outside every project |
| `arca.json` | A small file in the repo that lists which variables a project needs, by name only |
| Profile | A named set of values for the same variables, like `ontwikkel` or `acceptatie`. You switch between them with `arca use` |
| Masking | Replacing a secret in command output with a placeholder like `[arca:DATABASE_URL]` |
| Human gate | The check that a real person at a terminal is asking, not an agent |

Package: `@bremmdev/arca-env`. Command: `arca`.

---

## Contents

1. [The problem](#1-the-problem)
2. [How a secret travels](#2-how-a-secret-travels)
3. [What stays in your project](#3-what-stays-in-your-project)
4. [Who can do what](#4-who-can-do-what)
5. [Masking](#5-masking)
6. [Secrets in arca, config in `.env`](#6-secrets-in-arca-config-in-env)
7. [Profiles](#7-profiles)
8. [Getting started](#8-getting-started)
9. [Where the secrets are kept](#9-where-the-secrets-are-kept)
10. [What it protects against, and what it can't](#10-what-it-protects-against-and-what-it-cant)
11. [How it compares](#11-how-it-compares)
12. [Status and next steps](#12-status-and-next-steps)
13. [Read more](#13-read-more)

---

## 1. The problem

A secret in a `.env` file reaches an agent in more ways than you'd expect:

- **Agents read files.** `.env.local` is just a file in the project. Agents search, open and index files. Some tools have been reported to load `.env` files automatically.
- **Agents read output.** An agent starts your dev server to check its work. The database is down, and the error message prints the full connection string, password included.
- **Agents run commands.** `printenv`, `cat .env.local`, or a quick debug script that logs `process.env`. Usually with good intentions, sometimes because a malicious README or web page told it to (prompt injection).
- **Files leak in other ways too.** A `.env` file gets committed by mistake, synced to a cloud backup, copied into a Docker image or pasted into a chat.

Agent tools have "deny" rules for reading `.env` files. They help, but reports show they don't cover every path, for example reading the file through a shell command instead of the read tool. **The robust fix is not having the secret in the file.**

---

## 2. How a secret travels

```
you store a secret once          arca set STRIPE_SECRET_KEY
  → arca encrypts it into the store, outside the project
    → you start the app as usual       npm run dev   (the script is "arca run -- next dev")
      → arca decrypts the secrets and starts the app with them in its environment
        → the app reads process.env, exactly as before
          → everything the app prints passes through arca, which masks the secrets
```

1. **You store a secret** with `arca set NAME`. You type the value into a hidden prompt, so it's not in your shell history either.
2. **arca encrypts it** into a file in your user data folder. The key to that file sits in your operating system's keychain, so you never type a master password.
3. **You start the app** the way you always do: `npm run dev`. The only change is that the script now starts with `arca run --`.
4. **arca starts your app** with the secrets added to its environment. Next.js, Vite, Astro, TanStack Start, Nuxt, SvelteKit, Prisma and plain Node all read `process.env`, so they just work.
5. **arca watches the output.** Anything the app prints goes through arca first, and any secret in it is replaced by `[arca:NAME]`.

**The key point: a secret only exists in two places.** It's in the encrypted store, and in the memory of the app you started. It's not in the repo, not in your shell, and not in anything that gets printed.

---

## 3. What stays in your project

Three small things, all safe to commit:

**`arca.json`** lists the variables the project needs, with descriptions and links, but never values. It replaces `.env.example`. It also holds the project's ID, so every clone and git worktree of the repo finds the same secrets.

```json
{
  "id": "arc_7k2m9q4x8w1z3p5n",
  "name": "acme-web",
  "vars": {
    "DATABASE_URL": { "required": true, "description": "Local Postgres connection string" },
    "STRIPE_SECRET_KEY": { "required": true, "docs": "https://dashboard.stripe.com/test/apikeys" },
    "NEXT_PUBLIC_POSTHOG_KEY": { "sensitive": false }
  }
}
```

**`package.json` scripts** that start with `arca run --`:

```json
{
  "scripts": {
    "dev": "arca run -- next dev",
    "test": "arca run --profile test -- vitest",
    "db:migrate": "arca run -- prisma migrate dev"
  }
}
```

**`.env` files with config only**, if you want them (see [section 6](#6-secrets-in-arca-config-in-env)).

---

## 4. Who can do what

arca checks **who is asking** before it does anything with a secret:

| Action | You, in your terminal | An AI agent |
| --- | --- | --- |
| Run the app or tests through a package script (`npm run dev`) | ✅ | ✅ output masked |
| Run any other command with secrets (`arca run -- printenv`) | ✅ | ❌ |
| See a value (`arca reveal NAME`) | ✅ | ❌ |
| Add, change or remove a value | ✅ | ❌ it's told to ask you |
| See which variables exist (`arca list`, `arca check`) | ✅ | ✅ names only |
| Switch to another profile (`arca use acceptatie`) | ✅ | ✅ when you ask it to |

How arca tells you and an agent apart:

- **Agents announce themselves.** Agent tools set environment variables in the commands they run, such as `CLAUDECODE` for Claude Code. Cursor, Codex, Gemini and others have their own, and there's a shared `AI_AGENT` convention any tool can use.
- **People have a real terminal.** Agents usually run commands without an interactive terminal. Revealing or changing a value needs one.
- **Scripts are checked.** arca verifies that a command really came from a script in `package.json`, and that the script matches the file.

When arca refuses, it says what to do instead. Agents follow instructions in error messages well, so the refusal doubles as onboarding:

```
arca: secret values cannot be shown to AI agents (detected: claude-code via CLAUDECODE).
You don't need the values. Secrets are injected automatically when you run package
scripts, for example `npm run dev`. Their output is masked as [arca:NAME].
  • See which variables exist:   arca list
  • A value is missing or wrong: ask the user to run `arca set NAME`
```

`arca init` can also add a short section to `AGENTS.md` / `CLAUDE.md` that explains these rules to agents up front.

---

## 5. Masking

Masking is **always on**, for agents and for you. There's no switch to turn it off.

```
Error: password authentication failed. Connection: postgres://app:[arca:DATABASE_URL#password]@localhost/acme
```

- The placeholder names the variable, so debugging still works ("the app logs `DATABASE_URL` on startup") without showing the value.
- arca also catches the common encoded forms of a value (URL-encoded, base64, JSON-escaped) and the password inside a connection string.
- Values from *other* profiles are masked too. An acceptatie value that shows up during an ontwikkel run appears as `[arca:DATABASE_URL@acceptatie]`.

One trade-off: because arca sits between the app and your terminal, some tools think they're not in a real terminal. Colours are kept, but a few interactive prompts or spinners may behave a bit differently. A later version runs the app in a pseudo-terminal, which removes that difference.

---

## 6. Secrets in arca, config in `.env`

You don't have to move everything. **Secrets go in arca, and non-sensitive config can stay in `.env`**, where your framework loads it as it always has.

- **Who wins when a name is in both:** arca, then your shell, then `.env` files. If arca overrides a different value, it tells you (by name, never by value).
- **The leak guard** keeps secrets from creeping back into `.env`. Every time you run something, arca checks your `.env` files and warns if one contains a value stored in arca, or something that looks like a secret (`sk_live_…`, a URL with a password, a long random string).
- **Importing never deletes on its own.** `arca import` copies secrets out of your `.env` files and leaves the files alone. Add `--delete` to remove just the lines that moved; your config lines stay.

---

## 7. Profiles

Often you want more than one set of values for the same variables: one for `ontwikkel`, one for `acceptatie`, one to try a feature against another API. A **profile** is such a set, and switching is one command:

```console
$ npx arca use acceptatie        # every npm run … now uses the acceptatie values
$ npm run dev
arca ▸ profile acceptatie (via arca use) · 4 secrets · output masked
$ npx arca use --reset           # back to the default set
```

- **Every command follows the switch**: your terminals, IDE tasks, and the scripts agents run. Your scripts stay as they are.
- **The variables are declared once** in `arca.json`. A profile can **extend** another, so it only stores the values that differ.
- **All profiles are equal.** None is locked or treated as more sensitive. The usual rules apply to each one: agents use scripts, output is masked, and only you change values.
- **The banner** shows which set is active whenever it isn't the default, so you don't forget you switched.
- Each profile can have its own config file (`.env.acceptatie`) for non-sensitive values that differ.

---

## 8. Getting started

**A new project**

```console
npm i -D @bremmdev/arca-env
npx arca init
npx arca set DATABASE_URL
npm run dev
```

**An existing project with `.env` files.** `arca init` reads your files, suggests which variables are secrets and which are config, moves the secrets into arca, and wraps your scripts. Your files aren't touched until you run `npx arca import --delete`.

**A teammate who clones the repo.** `npm run dev` tells them which variables are missing. `npx arca setup` then asks for each one, with its description and a link to where to get it.

**CI, Vercel, Docker.** Nothing to do. There's no arca store there, so `arca run` simply starts the command with the platform's own variables, and checks that the required ones exist.

---

## 9. Where the secrets are kept

- **Encrypted files, one per project and profile**, in your user data folder (`%LOCALAPPDATA%\arca` on Windows), never inside a project. They use AES-256-GCM, a standard authenticated cipher.
- **One random key in your OS keychain**: Windows Credential Manager, macOS Keychain or the Linux Secret Service. That's why there's no master password to type. On systems without a keychain, like WSL, arca asks for a passphrase instead, about once a day.
- **The store isn't a backup.** If the keychain is wiped, the secrets are gone. For local development that's usually fine, because the values can be fetched again from their dashboards, and there's a backup command for the rest.

---

## 10. What it protects against, and what it can't

It prevents:

- secrets sitting in files that agents read, index or commit,
- secrets showing up in logs, errors and test output,
- agents reading values, running one-off commands with secrets, or changing values,
- secrets drifting back into `.env` files unnoticed.

It **can't** stop:

- **deliberate workarounds.** An agent that hides its identity, edits `package.json` to add a script that prints secrets, or reads the keychain directly is no longer working "under normal circumstances". The edit to `package.json` does show up in your git diff.
- **malware running as you.** Anything that runs as your user can reach what you can reach. No local tool fixes that.
- **your own app.** Code in your app (and its dependencies) reads `process.env` by design.
- **the browser.** An error page that shows a connection string isn't terminal output, so it isn't masked.

In short, it's best-effort defence in depth, not a security boundary. That's the same honest framing AWS uses in its own guidance on secrets and AI agents.

---

## 11. How it compares

| Tool | How it works | What's missing for this goal |
| --- | --- | --- |
| **dotenvx** | Encrypts the values inside `.env` | The decryption key sits in `.env.keys`, right next to it, and anyone can run the decrypt command |
| **1Password CLI, Doppler, Infisical** | Fetch secrets from a cloud vault and inject them at runtime. 1Password also masks output | Need an account and a service. They don't treat agents differently from people |
| **psst** | Local encrypted vault, injects and masks, pitched at agents | `psst get` shows a value to whoever asks, agents included, and the vault lives inside the project |
| **secretspec, Varlock** | A committed list of variable names, values kept elsewhere. Varlock also masks logs | No rules for who may reveal or change values |
| **arca** | Local and free, no account, knows the difference between you and an agent, works alongside your `.env` config | |

---

## 12. Status and next steps

arca is in **planning**. No code exists yet.

1. **Spikes first**: short experiments to confirm the risky assumptions, like how the keychain behaves on each OS, which variables each agent sets, and how dev servers behave when their output is masked.
2. **First version**: the encrypted store, `arca run` with masking, agent detection, profiles, the leak guard, and the commands above.
3. **Later**: a fingerprint or Windows Hello prompt to confirm you're a person, the pseudo-terminal mode, support for IDE test runners and debuggers, and team sharing.

---

## 13. Read more

**Design documents in this folder**
- [Overview and key decisions](README.md)
- [Prior art](01-prior-art.md): the tools above in detail
- [Threat model](02-threat-model.md): every way a secret can leak, and the answer to each
- [Architecture](03-architecture.md): store, encryption, agent detection, masking
- [CLI and DX](04-cli-and-dx.md): all commands, onboarding flows, messages for agents
- [Framework integration](05-framework-integration.md): Next.js, Vite, Astro, Prisma, Turborepo and more
- [Roadmap and decisions](06-roadmap.md): every decision so far, and the plan
- [Profiles](07-profiles.md): the full profile design

**Outside sources**
- [1Password CLI, `op run`](https://developer.1password.com/docs/cli/reference/commands/run) (output masking)
- [psst](https://github.com/Michaelliv/psst) (the closest existing tool)
- [AWS, secrets and AI agents](https://docs.aws.amazon.com/secretsmanager/latest/userguide/retrieving-secrets-ai-agents.md) ("best-effort defense, not a security boundary")
- [Knostic, Claude Code and `.env` files](https://knostic.ai/blog/claude-loads-secrets-without-permission)
- [`@vercel/detect-agent`](https://cdn.jsdelivr.net/npm/@vercel/detect-agent@1.2.3/README.md) (the `AI_AGENT` convention)
