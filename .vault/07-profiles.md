# 07: Profiles

> Requested 2026-10-21, revised 2026-10-22. A project can have several **sets of local variables**, for example `ontwikkel` and `acceptatie`: the same variables with slightly different values. You switch between them freely ("now use set b to test this feature"). **All profiles are equal.** None is locked, protected or treated as more sensitive than another.
> "Profile" replaces the earlier term "environment", which collided with environment variables, `NODE_ENV` and framework modes. secretspec and fnox use the same term.

## What a profile is

A **profile** is a named set of values for one project's variables. Every profile:

- **shares the project's declarations** (`vars` in `arca.json`), so every set has the same variable names,
- has **its own values**, stored in arca,
- can **extend** another profile, so it only stores the values that differ,
- can list **its own config file** (`.env.acceptatie`) for non-sensitive values that differ.

Profiles follow the same rules as everything else in arca. Agents can use any profile through package scripts, output is always masked, and only a human can change values. There's no per-profile protection or confirmation.

**Profiles are not framework modes.** A profile decides *which values arca injects*. It doesn't set `NODE_ENV`, and it doesn't turn `next dev` into `next build`. `npm run dev` with `acceptatie` active runs your local dev server with the acceptatie values.

## Declaring profiles in `arca.json`

```jsonc
{
  "id": "arc_7k2m9q4x8w1z3p5n",
  "name": "acme-web",
  "defaultProfile": "ontwikkel",
  "profiles": {
    "ontwikkel": {},
    "acceptatie": { "extends": "ontwikkel", "envFiles": [".env.acceptatie"] }, // stores only what differs
    "test": { "extends": "ontwikkel" }
  },
  "vars": {                                     // one declaration list for every profile
    "DATABASE_URL": { "required": true },
    "API_KEY": { "required": true },
    "AUTH_SECRET": { "required": true },
    "API_BASE_URL": {}
  }
}
```

**Resolution rules** for profile `P`:

| What | How it resolves |
|---|---|
| Values | `P`'s own values first, then each profile up its `extends` chain. `arca list` shows inherited values as `↳ ontwikkel`. |
| Config files | Top-level `envFiles`, then the chain's, then `P.envFiles`. Later files win, and all of them rank below secrets ([03 §8](03-architecture.md#8-coexisting-with-env-files-and-the-leak-guard)). |
| Declarations | Shared. The top-level `vars` apply to every profile. `arca check --profile P` reports any required var that `P` (with its chain) has no value for. |

`extends` cycles are a config error.

**`extends` or a full copy?**

- **`extends`**: the profile stores only the values that differ. Change a shared value once and every set that extends it picks it up.
- **Full copy**: leave out `extends` and seed the profile with `arca profiles copy ontwikkel acceptatie`, then change the few values that differ. Every value is explicit, so a forgotten override can't silently fall back to another set's value.

Both are fine. `arca init` suggests `extends` when two `.env` files share most of their values.

## Switching profiles

**`arca use <profile>` switches the active profile** for the project on this machine. From then on, every `arca run` for the project uses that set.

```console
$ npx arca use acceptatie
✔ acme-web now uses profile acceptatie for every arca run on this machine
  Back to ontwikkel:  arca use --reset
$ npm run dev
arca ▸ profile acceptatie (via arca use) · 3 secrets · output masked
…
$ npx arca use --reset
✔ acme-web is back on ontwikkel
```

- **What follows it:** every `arca run` for the project, including your terminals, IDE tasks, git hooks, and the package scripts agents run. You don't need a copy of each script per profile.
- **Precedence:** `--profile <name>` (or `-p`) > `ARCA_PROFILE` > active profile (`arca use`) > `defaultProfile`. A script that names a profile (`"test": "arca run --profile test -- vitest"`) always keeps it. `ARCA_PROFILE` overrides the active profile for one terminal.
- **Scope:** per project and per user on this machine, so every clone and git worktree of the project switches together. It's stored outside the repo (`projects/<id>/state.json`), so it's never committed and teammates aren't affected.
- `arca use` with no argument shows the active profile and where it came from. `arca use --reset` returns to `defaultProfile`.
- **Banner:** whenever the profile isn't the default, every run starts with one line on stderr naming the profile and where the choice came from (`via arca use`, `via ARCA_PROFILE`, `via --profile`). It looks the same for every profile. It's information, not a warning. Agents read output, so they know which set is active too.
- **Agents can switch too.** You can tell an agent "use acceptatie to test this feature", and it runs `arca use acceptatie`. The AGENTS.md snippet asks agents not to switch on their own, because the switch also changes what your terminals use.
- The child process gets `ARCA_PROFILE=<name>`, so app code *may* branch on it. Most apps shouldn't need to.
- Profile names are **case-insensitive** and stored lowercase (`arca use ACCEPTATIE` is `acceptatie`), because vault file names live on case-insensitive file systems on Windows and macOS. Two names that differ only in case are a config error.

## Pinning a profile in a script

Most scripts should follow the active profile. Pin one only for a task that always needs the same set:

```jsonc
{
  "scripts": {
    "dev": "arca run -- next dev",                    // follows the active profile
    "db:migrate": "arca run -- prisma migrate dev",   // follows the active profile
    "test": "arca run --profile test -- vitest"       // always test
  }
}
```

## Masking across profiles

The redactor's needles include the values of **all** profiles of the project, not just the active one. If an acceptatie connection string turns up in an ontwikkel run (copied into a fixture, or printed by a tool), it's still masked. When the match comes from a profile other than the active one, the replacement names it: `[arca:DATABASE_URL@acceptatie]`. The leak guard's exact-match check also covers every profile.

## CI

In CI there's no vault, so `arca run` **passes through** and validates the declared required vars against the platform's env. The profile there only decides which `envFiles` arca loads, if any.

## Storage

- One vault file **per profile**: `projects/<id>/<profile>.vault`. That keeps each write small.
- AAD `arca-vault:v1:<projectId>:<profile>`, and the per-profile key is `HKDF(masterKey, salt = projectId, info = "arca/vault/v1/<profile>")`, so a vault file can't be swapped onto another profile by renaming it.
- The active profile lives in `projects/<id>/state.json` (`{ "activeProfile": "acceptatie", "setAt": "…" }`). It's plaintext because it isn't secret.

## Commands

All value commands take `--profile` / `-p`: `run`, `set`, `unset`, `reveal`, `export`, `import`, `restore`, `setup`, `check`, `list`.

| Command | Purpose | Agent? |
|---|---|---|
| `arca use [profile] [--reset]` | Show or switch the active profile for this project on this machine | ✅ |
| `arca profiles` | List profiles: active, extends, number of values set, missing required | ✅ |
| `arca profiles add <name> [--extends p]` | Add a profile to `arca.json` | ✅ |
| `arca profiles diff <a> <b>` | **Names only:** which values each profile sets itself and which it inherits. Useful for "what does acceptatie override?" | ✅ |
| `arca profiles copy <from> <to> [--only A,B]` | Copy values, e.g. seed `acceptatie` from `ontwikkel` and then change a few | 🔒 |
| `arca profiles rm <name>` | Remove a profile and its values | 🔒 |
| `arca setup --profile acceptatie` | Walk through missing required vars for that profile | 🔒 |
| `arca check --all-profiles` | Completeness of every profile (names only) | ✅ |

🔒 is the usual rule that only a human changes values (D4). It applies the same way to every profile.

`arca list` becomes a matrix:

```
                 ontwikkel ●    acceptatie         test
DATABASE_URL     ✔ set          ✔ set              ✔ set
API_KEY          ✔ set          ✔ set              ↳ ontwikkel
AUTH_SECRET      ✔ set          ↳ ontwikkel        ↳ ontwikkel
API_BASE_URL     ✔ set          ✔ set              ↳ ontwikkel
FEATURE_X        .env           .env.acceptatie    .env
```

`●` marks the active profile.

## Importing per profile

- `arca import .env.acceptatie --profile acceptatie` sorts secrets from config as usual. Config lines stay in the file, and with `--delete` only the imported entries are removed.
- `arca init` proposes a mapping from file names to profiles and asks before creating each one:
  - `.env` + `.env.local` → the default profile
  - `.env.<name>` → a profile called `<name>`
  - If two files share most of their values, it suggests `extends` and imports only the values that differ.
- ⚠️ `.env.development`, `.env.production` and `.env.test` are also **framework mode files**: Next.js and Vite load them themselves based on mode. The config left in them keeps working that way. For *profile-specific* config that arca loads, use names frameworks don't recognise, like `.env.acceptatie`. Then config never gets loaded twice under two different rules.

## AGENTS.md

The AGENTS.md snippet gains one line: *"The active profile (set of values) is shown in the `arca ▸ profile …` banner. Don't switch it with `arca use` unless the user asks."*

## Design calls in this doc (flag any you disagree with)

1. **Renamed "environments" to "profiles"** everywhere (`--profile`, `ARCA_PROFILE`, `defaultProfile`, `profiles` in `arca.json`).
2. **All profiles are equal** (revised 2026-10-22). There are no protected profiles, no per-profile confirmations and no per-profile agent rules.
3. **`arca use` sets an active profile** (revised 2026-10-22). It's per project and machine, and worktrees share it. Explicit `--profile` and `ARCA_PROFILE` still win. A banner names the profile on every non-default run.
4. **Agents may run `arca use`.** The AGENTS.md line asks them to do it only when you ask.
5. **Declarations are shared by every profile.** There are no per-profile `vars` or `exclude` lists, because profiles are sets of the same variables. This is simpler, and it can be added later if a real need shows up.
6. **Masking covers values from all profiles**, not just the active one.
7. **One vault file per profile.**
8. **Profile names are case-insensitive**, because vault files live on case-insensitive file systems.
