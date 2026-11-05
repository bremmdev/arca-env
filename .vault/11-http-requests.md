# 11: `arca request`, sending HTTP requests with arca secrets

> Researched 2026-11-03. Chosen direction: a built-in `arca request` command. Earlier drafts also compared an httpyac plugin, Bruno, Hurl, plain curl config files and Postman Vault. Those were dropped in favour of this option, because it adds no dependencies and arca keeps full control over where secrets go.
> Status: **design, not built.** Open decisions are in [§13](#13-open-decisions).

## 1. The problem

arca takes secrets out of `.env` files for the app. But developers also call APIs by hand: to try an endpoint, debug an integration, or reproduce a bug. Those requests need the same secrets (API keys, OAuth client IDs and secrets, subscription keys, basic-auth passwords). The two most common tools keep them outside arca:

- **Postman** (and similar GUI clients) keeps secrets as environment or collection variables. "Initial" values sync to the Postman cloud and are shared with the workspace. Current values live in the app. It's a second copy of every secret, outside arca, and often outside the developer's control.
- **The REST Client VS Code extension** (and the JetBrains HTTP Client, which uses a similar format) runs `.http` files from the repo. Those files usually read secrets through `{{$dotenv NAME}}` from a `.env` next to the file. That's the plaintext file arca exists to remove. REST Client's other option, `{{$processEnv NAME}}`, only works if VS Code itself is started with the secrets in its environment, which hands them to every extension and every terminal, agents included. REST Client has no plugin API, so arca can't hook into it.

So even in a project fully moved to arca, the same secrets often sit in a Postman workspace or a `.env` that exists only for `.http` files. An AI agent working in the repo can read those `.env` files, and can read `.http` files that people have pasted values into.

## 2. Requirements

1. Send full HTTP requests: method, URL, query, headers, body.
2. Requests can reference `.env` config, arca secrets, or both in the same request.
3. Good DX: one command, and a keyboard shortcut (later a button) in VS Code.
4. Requests are written as templates that are easy to read, write and commit.

## 3. The idea in one paragraph

`arca request` reads requests from `.http` files, a subset of the REST Client format, so existing files keep working. It fills in `{{NAME}}` from the arca vault (active profile), the shell and the project's `.env` files, using the same precedence as `arca run`. It then sends the request with Node's built-in `node:http` / `node:https` and prints the response through arca's `Redactor`. Node 24 is already required, so **no new dependencies**.

Because arca itself reads the file, resolves the values and sends the request, a request file is **data, not code**. It can't run scripts, write files or pass extra flags. The only thing it can do is send an HTTP request. That makes one new guarantee enforceable: a secret can be **bound to the hosts it may be sent to**.

```console
$ npx arca request api/orders.http -n listOrders
POST https://auth.example.com/oauth/token → 200 OK (212 ms)
GET  https://api.example.com/v1/orders?top=10 → 200 OK (88 ms)
{
  "items": [ { "id": 1041, "customerId": "c-77" } ]
}
```

## 4. Request files

### 4.1 Example: an API key plus an OAuth client-credentials token

A typical setup: an API that wants an API key header and a bearer token from an OAuth provider (Auth0, Okta, Keycloak, Entra ID, Cognito and others all support the client-credentials grant).

```http
# api/orders.http, committed. No values in it.

### Token
# @name token
POST {{OAUTH_TOKEN_URL}}
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id={{OAUTH_CLIENT_ID}}
&client_secret={{OAUTH_CLIENT_SECRET:url}}
&audience=https://api.example.com

### List orders
# @name listOrders
GET {{API_BASE_URL}}/v1/orders
    ?top=10
    &status=open
X-Api-Key: {{API_KEY}}
Authorization: Bearer {{token.response.body.$.access_token}}

### Create order
# @name createOrder
POST {{API_BASE_URL}}/v1/orders
X-Api-Key: {{API_KEY}}
Authorization: Bearer {{token.response.body.$.access_token}}
Content-Type: application/json

{
  "customerId": "{{listOrders.response.body.$.items[0].customerId}}",
  "qty": 1,
  "requestId": "{{$guid}}"
}
```

Where the values come from in this example:

| Name | Kind | Where it lives |
|---|---|---|
| `OAUTH_CLIENT_SECRET`, `API_KEY` | secret | arca vault (`arca set`), per profile |
| `OAUTH_CLIENT_ID` | config, or secret if you prefer | `.env` / `.env.local`, or arca |
| `OAUTH_TOKEN_URL`, `API_BASE_URL` | endpoints that receive credentials | **arca** is recommended ([02 L17](02-threat-model.md)): only a person can change where the key gets sent |
| `token.response…`, `listOrders.response…` | derived from an earlier response | runtime only, always masked ([§7](#7-masking)) |

Other common shapes work the same way: a single API key in a header or query string, `Authorization: Basic …`, a long-lived personal access token, or a subscription-key header.

### 4.2 Format (the supported subset)

The goal is that **existing REST Client files work unchanged**, as long as they use the common features. What's not supported fails with a clear message, never silently.

| Feature | Syntax | v1 |
|---|---|---|
| Request separator | a line starting with `###` (text after it is a title) | ✅ |
| Request name | `# @name token` or `// @name token` | ✅ |
| Comments | lines starting with `#` or `//` | ✅ |
| File variables | `@base = https://…` before the first request or between requests. Values may use `{{…}}`. | ✅ |
| Request line | `METHOD URL [HTTP/1.1]`. A line with only a URL means `GET`. | ✅ |
| Multi-line query | following lines starting with `?` or `&` | ✅ |
| Headers | `Name: value` lines until the first blank line | ✅ |
| Body | everything after the blank line, until the next `###` | ✅ |
| Form body over several lines | lines starting with `&` are joined (REST Client behaviour) | ✅ |
| Body from a file | `< ./body.json` (sent as is), `<@ ./body.json` (variables substituted) | ✅ |
| Basic auth shorthand | `Authorization: Basic user:pass` or `Basic user pass` is base64-encoded automatically | ✅ |
| Request variables | `{{name.response.body.$.json.path}}`, `{{name.response.headers.Header-Name}}`, `{{name.request.body.$…}}` | ✅ (JSONPath subset: `$.a.b[0].c`) |
| System variables | `{{$guid}}`, `{{$timestamp}}`, `{{$datetime iso8601}}` / `rfc1123`, `{{$randomInt min max}}` | ✅ |
| REST Client env lookups | `{{$dotenv NAME}}`, `{{$processEnv NAME}}` | ✅ as aliases for `{{NAME}}` (see [§5](#5-variables-and-precedence)) |
| Encoding filters (arca addition) | `{{NAME:url}}`, `{{NAME:json}}`, `{{NAME:b64}}` | ✅ |
| REST Client's Azure AD helpers | `{{$aadToken}}`, `{{$aadV2Token}}` | ❌ Use an explicit token request (§4.1) |
| REST Client environments | `rest-client.environmentVariables` in VS Code settings | ❌ Use arca profiles and `.env` files |
| Prompts | `# @prompt` | ❌ v1 |
| Multipart / file upload | `multipart/form-data` with `<` parts | ❌ v1 (most likely first addition) |
| GraphQL | `X-REQUEST-TYPE: GraphQL` | ❌ v1 (a JSON body with a `query` field works today) |
| Pasted curl commands | `curl …` inside a `.http` file | ❌ v1. Later: `arca request --from-curl` converts a "Copy as cURL" command into `.http` |
| Scripts | none | ❌ **On purpose.** Files stay data. |

The parser is a pure function, `parseHttpFile(text) → Request[]`. Each request keeps its start and end line, so `--line` can find it and errors can point at the right line.

## 5. Variables and precedence

Each `{{…}}` resolves in this order, highest first:

1. **Request variables**: `{{name.response…}}` / `{{name.request…}}`, from a request run earlier in the same invocation ([§6.3](#63-dependencies-between-requests)).
2. **System variables**: `{{$guid}}` and the rest.
3. **File variables**: `@name = …`. A file variable may **not** use a name declared in `arca.json`. That's an error, so a file can't silently shadow a secret, and nobody is confused about which value was sent.
4. **arca vault**: the active profile, with its `extends` chain.
5. **Inherited shell environment.**
6. **`envFiles` loaded by arca**: top-level, then the profile's own.
7. **The framework's dev files**: `.env`, `.env.development`, `.env.local`, `.env.development.local` (`DEV_FILES`), in the project root and the nearest package root.

Positions 4–7 are exactly the `arca run` precedence. When the vault overrides a different value from the shell, the same names-only notice appears.

Rules:

- **Unknown names are an error**, never an empty string. The message names the variable and the line, and suggests close matches (`suggest()`), e.g. `api/orders.http:14: {{API_KYE}} isn't set. Did you mean API_KEY?`. A required secret that's missing gets the usual hint to run `npx arca setup`.
- `{{$dotenv NAME}}` and `{{$processEnv NAME}}` resolve exactly like `{{NAME}}`. REST Client's `$dotenv` only reads a `.env` next to the `.http` file. arca uses the project's files instead, which is what people expect after migrating.
- Values are substituted as text. Use `:url` in query strings and form bodies, and `:json` inside JSON strings. Secrets with `&`, `+`, `"` or `\` otherwise break the request. This mistake is easy to make, so `arca request` warns when a value containing such characters is substituted into a form body or JSON string without a filter (names only).
- Postman-style lowercase names (`{{client_secret}}`) work too. arca's name rule (`^[A-Za-z_][A-Za-z0-9_]*$`) allows lowercase, so a migrated collection can keep its variable names if they're declared in `arca.json` with those names.

## 6. The command

### 6.1 Usage

```text
arca request <file> [options]        (alias: arca req)

  -n, --name <name>     run the request with this @name (and the requests it depends on)
  -l, --line <n>        run the request at line n (for editor integration)
  -a, --all             run every request in the file, in order
  -p, --profile <name>  use this profile's values
  -i, --include         print response headers
  -v, --verbose         print the request (masked) and the response headers
      --raw             don't pretty-print the body
      --json            print one JSON object per request (masked), for scripts and agents
      --fail            exit 1 when a response is 400 or higher
      --timeout <ms>    per request, default 30000
      --insecure        don't verify TLS certificates (human only; refused for agents)
      --dry-run         resolve and print the request (masked), don't send
```

- **No selector:** if the file has one request, it runs. With several requests in a terminal, a picker (`@clack/prompts`, already a dependency) lists them by name or title. Without a terminal, it's an error that lists the names.
- **`--dry-run`** is the safe way to check a template. It runs the full resolution and host check without sending anything.

### 6.2 Output

- **stdout:** the response body. JSON is pretty-printed when stdout is a terminal. Binary bodies print as `[binary 12.3 kB image/png]` on a terminal, and are written as is when piped. So `npx arca request api/orders.http -n listOrders | jq '.items'` works.
- **stderr:** one status line per request (`METHOD URL → 200 OK (88 ms)`), plus headers with `-i` / `-v`, the profile banner on non-default profiles, and notices.
- **Everything is masked**, stdout and stderr, every caller, no off switch. This is the same rule as `arca run` (D6). Masking details are in [§7](#7-masking).
- Bodies over 1 MB are cut off on a terminal, with a note about how to pipe the full body.
- **Exit codes:**

  | Code | Meaning |
  |---|---|
  | 0 | Every response was received |
  | 1 | Network or TLS error, timeout, or a status of 400 or higher with `--fail` |
  | 2 | Usage error: unknown variable, parse error, unknown name or line |
  | 3 | A request was refused by host binding or the agent policy |

### 6.3 Dependencies between requests

- If request B uses `{{A.response…}}` and A hasn't run yet in this invocation, A runs first, recursively. Cycles are an error.
- `-n listOrders` therefore sends the token request first.
- Responses live in memory for one invocation. Nothing about responses is written to disk.
- **Token caching across invocations isn't in v1.** Each send fetches a fresh token, typically 100–300 ms extra. Caching would mean storing a derived secret. If it's wanted later, it goes into the encrypted store, keyed by profile, and expires with `expires_in`.

### 6.4 Sending: `node:https`, not `fetch`

Both are built into Node. `node:http` / `node:https` give the control this feature needs:

- **Redirects are never followed automatically.** `fetch` follows them and forwards custom headers such as `X-Api-Key` to the new host. It only strips `Authorization` and `Cookie` on a cross-origin redirect. That would let an allowed host redirect the key somewhere else. arca follows up to 5 redirects itself, runs the host check again for every hop, and drops headers carrying secrets on a cross-origin hop. A redirect to a host that isn't allowed stops with the masked `Location`.
- **TLS options:**
  - `ca`, so company networks with TLS inspection work. Node's `tls.getCACertificates('system')` reads the Windows certificate store and the Linux system store. Checked on 2026-11-03: it found 149 certificates on a Windows 11 machine.
  - Client certificates (`pfx` / `cert` + `key`), for APIs that require mutual TLS, from paths in a `# @cert` directive. That's a later addition.
  - `rejectUnauthorized: false` for `--insecure`, for local servers with self-signed certificates.
- **Exact headers:** the request has exactly the headers in the file, plus `Host`, `Content-Length` and `User-Agent: arca/<version>`.
- **Decompression** with `node:zlib`: gzip, deflate, br and zstd. zstd works on Node 26; check it on Node 24.
- **Proxies:** Node has built-in proxy support from the environment (`NODE_USE_ENV_PROXY=1` / `--use-env-proxy`, which reads `HTTPS_PROXY` / `NO_PROXY`). Check which Node 24 minor added it for `node:https` (spike R1). If it isn't enough, arca sets up the CONNECT tunnel itself, in about 40 lines.

## 7. Masking

Every printed byte goes through a `Redactor`, built once per invocation from:

1. **Vault secrets of every profile.** This is `s.allSecrets()` with `needlesFor()`, the same needles `arca run` uses: raw, URL-encoded, JSON-escaped, base64, base64url and URL credentials. A secret from another profile prints as `[arca:NAME@staging]`.
2. **Derived values.** Any value from a response that the file references (`{{token.response.body.$.access_token}}`) becomes a needle named after the reference, e.g. `[arca:token.access_token]`. arca knows these exactly from the file, so no guessing is involved.
3. **Well-known secret fields**, for the response that *contains* the token: it's printed before anything references it. JSON fields named `access_token`, `refresh_token`, `id_token`, `client_secret`, `password`, `api_key` or `*_secret` are masked in every response. So are values of the `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie` headers, and JWT-shaped strings (`eyJ….eyJ….…`).

Request echoes (`-v`, `--dry-run`, `--json`) are masked in the same way. The URL, headers and body show `[arca:API_KEY]` instead of the value.

The response is buffered before printing, so no new streaming machinery is needed. `Redactor.redact()` already masks a complete string, and `Redactor` doesn't need a new API, because it's built after the needles are known. Streaming responses (SSE, large downloads) are out of scope for v1.

**What masking can't catch** (the same limits as `arca run`, L3): values transformed by the server (split, hashed, re-encoded in an unusual way), and secrets in a response that arca doesn't know about, such as a newly created API key in a body field with an unusual name.

## 8. Host binding

### 8.1 Config

```json
"vars": {
  "API_KEY": {
    "required": true,
    "http": { "hosts": ["api.example.com", "api.staging.example.com"] }
  },
  "OAUTH_CLIENT_SECRET": {
    "required": true,
    "http": { "hosts": ["auth.example.com"] }
  },
  "API_BASE_URL": { "required": true, "description": "API endpoint, in arca so only a person can change it" }
}
```

- Entries are exact host names, or `*.example.com` for subdomains only (not the apex domain).
- **HTTPS only**, unless the entry spells out a scheme and port, e.g. `"http://localhost:3000"` for a local server. Ports must match when given.
- `hosts` is a list for every profile together. Per-profile lists aren't worth the complexity: a dev key reaching the staging host just fails there. If it's ever needed, a later version can allow `{ "staging": [...] }`.
- Validated in `parseDecl()`: a non-empty array of strings, valid host names, at most one `*.` at the start. Added to `schema.json`.

### 8.2 The check

1. Resolve the whole request, keeping a list of every **vault secret** substituted anywhere in it: URL, headers, body or file body. Derived values count as well (see below).
2. Parse the final URL with WHATWG `URL`, and normalize the host (lowercase, punycode, no trailing dot).
3. For each substituted secret that has `http.hosts`: the host must match, or the request is refused before anything is sent (exit 3):

   ```text
   arca: api/orders.http:9: API_KEY may only be sent to api.example.com, api.staging.example.com,
     not to api.test.example.com. If that host is right, add it to vars.API_KEY.http.hosts in arca.json.
   ```

4. Every redirect hop is checked again ([§6.4](#64-sending-nodehttps-not-fetch)).
5. **Derived values** (a token from an earlier response) may only be sent to the **known hosts**: the union of every `http.hosts` in `arca.json`. That stops "fetch a token with the bound secret, then send the token somewhere else". The rule applies only when at least one variable declares hosts, so projects that don't use binding aren't affected.

### 8.3 Secrets without `hosts`

- **People:** allowed to any host. `arca doctor` lists secrets that are used in `.http` files but have no `hosts`, and suggests the hosts they were actually sent to.
- **Agents:** refused. See [§9](#9-agents) and [§13](#13-open-decisions).

## 9. Agents

Today's rule (D5): agents only get secrets through verified `package.json` scripts, because an ad-hoc command is arbitrary code. `arca request` is different: the file can only describe one HTTP request, and arca decides where that request may go. Proposed rule:

| Caller | `arca request` |
|---|---|
| Person at a terminal | Everything. Masked. |
| No agent marker, no TTY (VS Code task, git hook, CI) | Everything. Masked. Same as `arca run`. |
| **Agent** | Allowed, masked, **only if every secret in the request has `http.hosts` and the host matches**, and derived values only go to known hosts. A secret without `hosts` is refused, with a message telling the agent to ask the user to add hosts to `arca.json`. `--insecure` is refused. |
| Agent, with policy `agent-run deny` | Refused, same as `arca run`. |

Why this is safe enough for the bar in [02](02-threat-model.md):

- An agent (or a prompt-injected file) can't send a bound secret anywhere new without editing `arca.json`, which shows in the git diff. That's the same class as L5's "edit `package.json`".
- Everything it reads back is masked, including tokens.
- It can still use the API with the secret: that's the point. Use least-privilege keys where it matters (L18).
- An agent that strips its markers is deliberate circumvention, as everywhere else in arca.

The AGENTS.md snippet written by `arca init` gets one line: "To call the project's APIs, use `npx arca request <file> -n <name>`. Ask the user to add a host to `arca.json` if a request is refused."

## 10. DX in VS Code

### 10.1 Keyboard shortcut with a task (no extension)

```jsonc
// .vscode/tasks.json (committed; `arca init` can offer to write it)
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "arca: send request at cursor",
      "type": "shell",
      "command": "npx arca request \"${file}\" --line ${lineNumber}",
      "presentation": { "reveal": "always", "panel": "dedicated", "clear": true },
      "problemMatcher": []
    },
    {
      "label": "arca: send all requests in file",
      "type": "shell",
      "command": "npx arca request \"${file}\" --all",
      "presentation": { "reveal": "always", "panel": "dedicated", "clear": true },
      "problemMatcher": []
    }
  ]
}
```

```jsonc
// keybindings.json (user-level: VS Code has no workspace keybindings)
{
  "key": "ctrl+alt+r",
  "command": "workbench.action.tasks.runTask",
  "args": "arca: send request at cursor",
  "when": "editorLangId == http || resourceExtname == .http"
}
```

- `${lineNumber}` is the cursor line, and `--line` picks the request block around it.
- A VS Code task has no agent marker and no TTY, which is the "IDE task" class: allowed, masked.
- In passphrase mode (WSL, headless Linux), the first task after the cache expires has no TTY to ask on. arca says so and tells you to run `npx arca doctor` (or any command) once in a terminal. The 12 h kernel-keyring cache then covers the task. Check this in spike R3.
- Other editors work the same way with their own task runners. JetBrains IDEs, for example, can use a "Shell Script" run configuration with `$FilePath$` and `$LineNumber$` macros.

### 10.2 Syntax highlighting

VS Code has no built-in `.http` grammar. Two options:

- Keep REST Client installed for highlighting, and turn off its own Send CodeLens, so nobody sends an unresolved request through it. Check the exact setting name (`rest-client.enableSendRequestCodeLens`) before documenting it.
- Use any other extension that provides the `http` language.

### 10.3 Later: a small arca VS Code extension

A clickable "▶ Send (arca)" CodeLens above each `###` block. It runs the same `npx arca request <file> --line <n>` in a dedicated terminal. That's about 50–100 lines, with no secrets handled in the extension itself. It's published to the Marketplace or shared as a `.vsix`. Only build it after the CLI has settled.

## 11. Migration

### 11.1 From REST Client

1. Move the secrets the `.http` files read into arca: `npx arca import` for the `.env` they came from, or `npx arca set NAME`.
2. Keep the files. `{{$dotenv X}}` and `{{$processEnv X}}` keep working, and you can switch to plain `{{X}}` whenever you like.
3. Replace REST Client environments (VS Code settings) with arca profiles and `.env` files. Replace `{{$aadToken}}` / `{{$aadV2Token}}`, if used, with a token request.
4. Add `http.hosts` to the secrets the files send.
5. Run `npx arca request <file> --all --dry-run` to check every template resolves, without sending anything.

### 11.2 From Postman

1. Export the collection (v2.1 JSON) and convert it to `.http`. Third-party converters exist (`httpyac-import`, `postman-to-http`), or later arca's own `arca request --from-postman`. Check the output by hand.
2. Postman variables keep their names (`{{client_secret}}`) if they're declared in `arca.json` under the same name.
3. Postman environments, exported as JSON (`values[].key/value/type`), can be imported later with a human-gated `arca import --from-postman env.json`. Until then, use `arca set`.
4. **What doesn't carry over:** pre-request and test scripts (`pm.*`), the collection runner, the GUI response viewer and history. That's the real cost for Postman users ([§14](#14-risks-and-shortcomings)).
5. Afterwards, clear the values from the Postman environments, and check that nothing was ever stored as a shared "initial value" in the Postman cloud. If it was, rotate it.

### 11.3 From nothing (new projects)

`arca init` sees no `.http` files, so it offers nothing. The README's "Testing APIs" section shows the example file from §4.1 and the VS Code task. A new project starts with request files in the repo and secrets in arca from day one.

## 12. Implementation plan

### 12.1 Code

| File | What |
|---|---|
| `src/http/parse.ts` | `.http` parser: blocks, names, file variables, request line, multi-line query, headers, body, file bodies. Lines kept for `--line` and errors. Pure. |
| `src/http/vars.ts` | `{{…}}` resolution (§5): precedence, filters, system variables, JSONPath subset, a record of which secrets each request used. Pure, given a lookup. |
| `src/http/hosts.ts` | Host-pattern parsing, normalization and matching, the known-hosts set. Pure. |
| `src/http/send.ts` | `node:https` send: manual redirects with a host check per hop, timeout, TLS (`ca` with system certs), decompression, proxy. |
| `src/http/print.ts` | Status lines, headers, pretty JSON, binary handling, `--json`, all through `Redactor`. Derived and well-known-field needles. |
| `src/commands/request.ts` | The command: session, profile, agent policy, picking requests, resolving dependencies, the banner, exit codes. |
| `src/config.ts`, `schema.json` | `VarDecl.http.hosts`: parse, validate, describe |
| `src/policy.ts` | `decideRequest(ctx, policy, usedSecrets, host)` next to `decideRun()` |
| `src/main.ts` | `request` / `req` dispatch, plus the HELP text |
| `src/commands/info.ts` | `doctor`: secrets used in `.http` files without `hosts`, and literal secret values in `.http` files. `list`: an "http hosts" column, or a note. |
| `src/leakguard.ts` | Also scan `*.http` / `*.rest` files in the project for stored secret values (exact matches only), so a pasted key gets caught like one in `.env` |
| `src/commands/init.ts` | Detect `*.http` / `*.rest` files, offer `.vscode/tasks.json`, add the AGENTS.md line |

Rough size: 600–900 lines of source plus tests. Most of it is the parser, variables and printing, which are pure and easy to test.

### 12.2 Tests

- **Parser:** every row of the §4.2 table, CRLF files, odd spacing, `###` inside bodies, errors with line numbers. Plus fixtures from real-world REST Client files (spike R4).
- **Variables:** precedence (one test per level), the file-variable-shadows-secret error, unknown-name suggestions, filters, JSONPath, dependency order and cycles.
- **Host binding:** exact and wildcard matches, apex vs subdomain, port and scheme, punycode, a redirect to a disallowed host, derived values to unknown hosts.
- **Send:** a local `node:http` server for methods, bodies, redirects (same-origin and cross-origin header dropping), compressed responses, timeouts, binary bodies. Plus a local HTTPS server with a self-signed cert for `--insecure` and `ca`.
- **Masking:** vault values, other profiles' values, encodings, derived tokens, well-known fields, `-v` / `--dry-run` / `--json` echoes.
- **Policy:** the §9 table, one test per row, using the existing agent-marker helpers.
- **CLI:** exit codes, the picker in non-TTY mode, `--line` selection.
- Windows and Linux in the existing CI matrix. The smoke test (`scripts/smoke.mjs`) gains one request against a local server.

### 12.3 Docs

- README: a "Testing APIs" section with the example file, the command, the VS Code task and host binding.
- Commands table: `arca request` with "✅ agents: only host-bound secrets".
- [02 Threat model](02-threat-model.md): new channels (§14 lists them).
- [04 CLI and DX](04-cli-and-dx.md): the command, the AGENTS.md line.
- [06 Roadmap](06-roadmap.md): a phase entry and the decisions from §13 once made.

## 13. Open decisions

| # | Question | Recommendation |
|---|---|---|
| Q1 | Can agents run `arca request` directly? That's a new way for agents to get secrets, next to D5's "only verified package scripts". | **Yes, with host-bound secrets only** (§9). Requiring a package script adds nothing: `npm run api -- evil.http` passes the script check anyway, and host binding is what actually protects the key. |
| Q2 | Secrets without `hosts`: allowed anywhere for people? | **Yes.** DX first, `doctor` nudges toward adding hosts. Agents are refused (follows from Q1). |
| Q3 | Command name | `arca request`, alias `arca req`. `arca http` reads like a server, and `arca send` is too vague. |
| Q4 | Cache OAuth tokens between runs? | **Not in v1.** Revisit if the extra time per send annoys people. If so, encrypted in the store, with expiry. |
| Q5 | Always mask derived tokens, even for a person who wants to copy one? | **Yes, always masked**, consistent with D6. A person who needs a raw token runs the token request in another tool. A human-gated `--reveal-derived` could come later. |
| Q6 | Scope of v1 | §4.2 as marked. Next in line: multipart, then `--from-curl`, then `--from-postman`, then the VS Code extension. |

## 14. Risks and shortcomings

| # | Risk / shortcoming | Severity | Mitigation |
|---|---|---|---|
| R1 | **Company networks.** Many developers work behind a proxy, TLS inspection, or both. If `HTTPS_PROXY` or a company root CA isn't handled, every request fails on those machines. | **High** (blocks adoption) | System CA store by default (`tls.getCACertificates('system')`). Proxy from the environment (`NODE_USE_ENV_PROXY`, or arca's own CONNECT tunnel). Test behind a real proxy with TLS inspection before release (spike R1). |
| R2 | **arca owns an HTTP client.** It's a parser, variables, redirects, TLS, decompression and printing to maintain, with feature requests to follow: multipart, cookies, GraphQL, OAuth helpers, prompts, response history. | Medium | A strict, written v1 scope (§4.2). Every addition must keep files as data. Anything script-like is a "no", and the answer for advanced flows is a TypeScript script under `arca run`. |
| R3 | **REST Client compatibility gaps.** Files using REST Client environments, `$aadToken`, prompts, multipart or GraphQL mode don't run as they are. | Medium | Clear errors naming the feature and the replacement. Run the parser over a sample of real-world `.http` files before building (spike R4). |
| R4 | **Postman users lose the GUI**, collection runner, scripts and history. People may keep using Postman, and with it the second copy of the secrets. | Medium (people, not tech) | Good conversion docs, and later `--from-postman`. The CLI output and `--json` are good enough for most API poking. The VS Code extension narrows the gap later. Clearing the Postman environments is part of the migration steps. |
| R5 | **Masking is incomplete for unknown secrets** in responses (a newly issued key in an oddly named field, a value transformed by the server). | Medium | Derived references and well-known fields (§7) cover the common cases, including OAuth. Documented as the same limit as L3. |
| R6 | **Wrong encoding** (`&` or `+` in a secret inside a form body) leads to confusing 401s, and people will blame arca. | Low–medium | The warning for unfiltered values (§5), plus `--dry-run` to see the masked request. |
| R7 | **Host binding friction:** a new environment or a renamed host means a refused request until `arca.json` is updated. | Low | The error prints the exact host and where to add it. Wildcards like `*.example.com` are allowed, but `doctor` notes when one is broad (e.g. a shared cloud domain where anyone can get a subdomain). |
| R8 | **New threat-model channels:** (a) a request file sending a secret to an attacker's host. (b) A redirect to another host. (c) Derived tokens leaking through output, or to other hosts. (d) Secrets pasted literally into `.http` files. | Medium | (a) host binding. (b) manual redirects with a check per hop. (c) derived masking plus the known-hosts rule. (d) the leak guard scans `.http` files. Add each as a row in [02](02-threat-model.md). |
| R9 | **The send itself is the risk.** An allowed request to an allowed host can still change real data (`DELETE /orders/…`) when an agent runs it. | Medium | Out of arca's scope, like an agent running `npm run db:reset`. Use least-privilege keys for agent-accessible profiles (L18). A later `# @confirm` directive could ask a person before sending. |
| R10 | **Passphrase mode in VS Code tasks** (WSL, headless Linux). A task has no TTY, so it can't ask for the passphrase once the cache expires. | Low | A clear message, and the 12 h cache. Fixed properly by the planned VS Code extension (it can prompt) or the Phase 3 session agent. |
| R11 | **Only terminal output.** There's no response viewer, history or side-by-side compare like Postman or REST Client. | Low | `--json` plus `jq`, piping to a file, and later the extension, which could open the masked response in a read-only editor tab. |

## 15. Spikes (before or during the build)

| # | Question | How to check |
|---|---|---|
| R1 | Does `node:https` with `NODE_USE_ENV_PROXY` and the system CA store work behind a proxy with TLS inspection, on Node 24 and on Windows? From which Node 24 minor? | A throwaway script behind a real company proxy, or a local mitmproxy setup with its CA in the system store |
| R2 | End to end against a real API: OAuth client credentials (for example Auth0, Keycloak or Entra ID), an API key header, a redirect case, and gzip and br responses | A spike branch of `arca request` |
| R3 | VS Code task: `${lineNumber}` is 1-based, the dedicated panel is reused, colours work (`FORCE_COLOR` from the task terminal), and the passphrase-mode message on WSL | Manual check on Windows and WSL Remote |
| R4 | How much of typical real-world `.http` files the v1 subset parses | Run the parser over a sample from public GitHub repos and early users, and list unsupported features |
| R5 | The exact REST Client setting for turning off its Send CodeLens | Check REST Client's `package.json` contributions |
