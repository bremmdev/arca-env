# 09: Azure Key Vault references for local development

> Researched 2026-11-01. Question: can a Node.js / Next.js app use Azure Key Vault references as environment variables on a developer's machine? How would a typical setup work, what are the pros and cons, and what changes when developers need a **PIM-elevated** role to read the vault?

## Short answer

**Not natively.** `@Microsoft.KeyVault(...)` references only work inside Azure hosting. App Service, Azure Functions and Logic Apps (Standard) resolve them with the app's managed identity before your process starts. Container Apps has its own variant (`keyvaultref:` secrets). Nothing resolves them on a laptop. If you put the reference in a local `.env`, `process.env.DATABASE_URL` is the literal string `@Microsoft.KeyVault(...)`.

- Microsoft's Key Vault reference docs don't mention local development at all.
- The sister feature, App Configuration references (`@Microsoft.AppConfiguration(...)`), is documented as **not resolved** by the local Functions host from `local.settings.json`. Community tools confirm Key Vault references behave the same way.
- Even in Azure, a failed resolution doesn't raise an error: "If a reference isn't resolved properly, the reference string is used instead."

**What Azure does support locally** is reading Key Vault **with your own developer identity** through the Azure SDK (`@azure/keyvault-secrets` + `@azure/identity`) after `az login`, `azd auth login`, `Connect-AzAccount` or a VS Code sign-in. So the pattern is possible, but **you build the bridge**: a small resolver that turns references into values before or during startup.

Three Azure features come close but don't fill the gap:

| Feature | Resolves locally? | Notes |
|---|---|---|
| App Service / Functions `@Microsoft.KeyVault(...)` | ❌ | Platform feature, uses the managed identity, values cached and refetched every 24 h |
| Container Apps `keyvaultref:` secrets | ❌ | Platform feature, uses the managed identity, refetched within 30 min |
| App Configuration Key Vault references + `@azure/app-configuration-provider` | ✅ | Resolved **client-side** by the JS provider via `keyVaultOptions.credential`. Needs an App Configuration store, and you read config through the provider, not `process.env` |
| azd `akvs://<sub>/<vault>/<secret>` in `.azure/<env>/.env` | ⚠️ partly | Resolved for Bicep parameters (`azd provision`) and hooks that map them via `secrets:`. **Not** for `npm run dev` |

## Typical setup

### 1. The references (safe to commit)

Use the App Service syntax locally too, so local config and deployed app settings look the same:

```dotenv
# .env  (committed: references aren't secrets)
DATABASE_URL=@Microsoft.KeyVault(VaultName=kv-acme-dev;SecretName=database-url)
STRIPE_SECRET_KEY=@Microsoft.KeyVault(SecretUri=https://kv-acme-dev.vault.azure.net/secrets/stripe-secret-key)
NEXT_PUBLIC_POSTHOG_KEY=phc_123        # plain config stays plain
```

Key Vault secret names allow only letters, digits and `-`, so `DATABASE_URL` has to map to something like `database-url`. Spelling the name out in each reference keeps that mapping visible.

### 2. Access

- The vault must use the **Azure RBAC** permission model. Legacy access policies "lack support for Privileged Identity Management (PIM)".
- Developers need **Key Vault Secrets User** on the vault (or on single secrets). **Key Vault Reader** isn't enough: it "cannot read sensitive values such as secret contents".
- If the vault has a firewall or private endpoint, developers also need network reach: VPN, Dev Box, or their IP on the allow list. Otherwise reads fail with `ForbiddenByFirewall`, whatever the role.

### 3. A resolver: three options

**A. Wrapper process (recommended).** It resolves references, then spawns the dev server with real values. It works for every framework, the way `op run` / `doppler run` / `arca run` do. Next.js doesn't overwrite variables already set in `process.env`, so the resolved values win over the literal references in `.env`.

```js
// scripts/kv-run.mjs — "dev": "node scripts/kv-run.mjs -- next dev"
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { SecretClient } from "@azure/keyvault-secrets";
import { AzureCliCredential } from "@azure/identity";

const credential = new AzureCliCredential();
const clients = new Map();

function parseRef(value) {
  const body = value?.match(/^@Microsoft\.KeyVault\((.+)\)$/)?.[1];
  if (!body) return null;
  if (body.startsWith("SecretUri=")) {
    const url = new URL(body.slice("SecretUri=".length));
    const [, , name, version] = url.pathname.split("/");
    return { vaultUrl: url.origin, name, version };
  }
  const kv = Object.fromEntries(body.split(";").map((part) => part.split("=")));
  return { vaultUrl: `https://${kv.VaultName}.vault.azure.net`, name: kv.SecretName, version: kv.SecretVersion };
}

const env = { ...(existsSync(".env") ? parseEnv(readFileSync(".env", "utf8")) : {}), ...process.env };

await Promise.all(Object.entries(env).map(async ([key, value]) => {
  const ref = parseRef(value);
  if (!ref) return;
  if (!clients.has(ref.vaultUrl)) clients.set(ref.vaultUrl, new SecretClient(ref.vaultUrl, credential));
  try {
    env[key] = (await clients.get(ref.vaultUrl).getSecret(ref.name, { version: ref.version })).value;
  } catch (err) {
    const hint = err.statusCode === 403 ? "access denied. Is your PIM role for this vault active?" : err.message;
    console.error(`${key}: ${hint}`);
    process.exit(1);
  }
}));

const [cmd, ...args] = process.argv.slice(process.argv.indexOf("--") + 1);
spawn(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" })
  .on("exit", (code) => process.exit(code ?? 1));
```

`AzureCliCredential` is used on purpose instead of `DefaultAzureCredential`. The default chain tries environment, workload identity and managed identity first, which is slow and surprising on a laptop. A mixed-tool team can use `DefaultAzureCredential` with `AZURE_TOKEN_CREDENTIALS=dev` (only developer-tool credentials) or a single credential name (`@azure/identity` ≥ 4.11).

**B. In-process loading.** Plain Node: a preload module (`node --import ./load-secrets.mjs app.js`) can use top-level `await` and fill `process.env` before the app starts. Next.js: `instrumentation.ts` `register()` "must complete before the server is ready to handle requests", so an async fetch there works. Next.js caveats:
- `next.config.*` is evaluated before `register()` and won't see the values.
- `NEXT_PUBLIC_*` values are inlined at **build** time, so a runtime resolver can't supply them (they shouldn't be secrets anyway).
- `register()` runs in both runtimes. Guard with `process.env.NEXT_RUNTIME === "nodejs"`, because the Azure SDK doesn't run on Edge.
- It only runs on server start. Rotated values need a restart.

Option A has none of these issues, which is why it's the default recommendation.

**C. Sync to a file.** Tools like [az-loadenv](https://github.com/curiousdev/az-loadenv) (Go, early-stage) or a script around `az keyvault secret show` write a resolved `.env.local`. It's simple and works offline afterwards, but it puts plaintext secrets back on disk, which is the problem arca exists to solve.

## The PIM scenario

With PIM, developers have an **eligible** (not active) Key Vault Secrets User assignment. Assigning it directly is best. PIM for Groups works too, but can be slower to take effect. The daily flow becomes:

1. **Activate** the role: Azure portal → PIM → My roles → Azure resources, or by script against the ARM `roleAssignmentScheduleRequests` API with `requestType: "SelfActivate"`:
   ```sh
   az rest --method put \
     --url "https://management.azure.com/<vaultResourceId>/providers/Microsoft.Authorization/roleAssignmentScheduleRequests/<new-guid>?api-version=2020-10-01" \
     --body '{"properties":{"principalId":"<your-object-id>","roleDefinitionId":"<vaultResourceId>/providers/Microsoft.Authorization/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6","requestType":"SelfActivate","justification":"local dev","scheduleInfo":{"expiration":{"type":"AfterDuration","duration":"PT8H"}}}}'
   ```
   (`4633458b-…` is the built-in Key Vault Secrets User role.) If the role setting requires MFA or a Conditional Access authentication context, a scripted activation can be rejected until the CLI token carries that claim. The portal is the dependable route.
2. **Satisfy the role settings** the admin chose: MFA, justification, ticket number, and possibly **approval** by one or more approvers.
3. **Wait for propagation.** Azure RBAC changes "can take up to 10 minutes", and Key Vault docs say to "allow several minutes". Signing out and back in (`az logout && az login`) forces a refresh.
4. `npm run dev`. The wrapper fetches the secrets once, and the running server keeps them in memory.
5. **Restarts and expiry.** While the activation is valid, you can restart as often as you like: each start fetches the secrets again with the active role. Activation lasts at most the configured maximum (1–24 h; 8 h is common). When it **expires**, a server that's already running keeps working, because the values are in its memory. But the first restart **after expiry** (a crash, `next.config` edit, branch switch, new terminal) fails with 403 until the role is reactivated, because nothing was saved locally to fall back on.

### What PIM changes in practice

- **Daily friction.** There's at least one activation per day plus a wait of a few minutes, and more if the activation window is shorter than the workday. With approval required, development stops until someone approves. This is the biggest DX cost, and developers will look for workarounds, mostly copying values into `.env.local`, which leaves you worse off than before.
- **Unclear failures.** A non-active role, a firewall block and a wrong tenant all show up as a 401/403 at startup. The resolver has to turn these into a clear message ("activate role X on kv-acme-dev"), otherwise the cost shows up as support questions.
- **Access is wider than the app's.** Developers usually get the role on the whole vault, so for the activation window they can read every secret in it, not just the ones the app references.
- **Agents during the activation window.** The resolver authenticates with the developer's `az` login, and anything running as the user can use that session. An AI agent with a shell can run `az keyvault secret show --vault-name kv-acme-dev --name database-url` directly, without going through the app. PIM narrows *when* that's possible, not *who*. You get audit logs for these reads (if Key Vault diagnostic settings are on), but no prevention.
- **Good fit for orgs that already use PIM.** If the vault holds shared, high-value secrets (a shared acceptance DB, third-party API keys), PIM gives time-bound, MFA-backed, justified and audited access with no standing permissions. Offboarding is just removing the eligibility.

## Advantages

- **No secret files in the repo or on disk** (options A and B). The committed `.env` holds only references.
- **One source of truth.** Rotation happens in the vault, values aren't shared over chat, and onboarding means granting a role, not passing a file around.
- **Same syntax as App Service / Functions app settings**, so local and deployed config line up.
- **Central revocation and audit**: who read which secret, when, from which IP.
- **With PIM**: no standing access, time limits, MFA, justification, approval, and an audit trail of activations.

## Disadvantages

- **Not supported by Azure.** You write and maintain the resolver, and none of the platform behaviour (caching, refresh, diagnostics) comes with it.
- **Online-only.** No network, VPN or vault reach means no dev server. It also adds one HTTPS round trip per secret at every start, which you can run in parallel. Throttling (4,000 non-write operations per 10 s per vault per region) only matters if something re-fetches in a loop.
- **Auth friction.** `az login`, the right tenant and subscription, MFA, and with PIM also activation, approval, propagation delay and mid-day expiry.
- **Shared values.** Every developer reading one vault gets the same `DATABASE_URL`. Per-developer values (a local Postgres, a personal Stripe test key) still need a local mechanism next to the vault, and one person's `az keyvault secret set` changes everyone's next start.
- **Naming mismatch.** Key Vault doesn't allow `_` in names, so you need a mapping between env var names and secret names.
- **Next.js specifics.** `NEXT_PUBLIC_*` is build-time, `next.config` loads before instrumentation, and Edge can't use the SDK. Option A avoids most of this.
- **No protection against agents on its own.** Resolved values sit in the dev server's `process.env` just as with `.env`, and the `az` session can read the vault directly. You'd still want output masking and the agent rules from [02](02-threat-model.md).

## Relevance to arca

Two possible integrations, not decided, listed only for later discussion:

- **Resolve at run time.** `arca run` could recognise `@Microsoft.KeyVault(...)` values and fetch them using the developer's Azure CLI login. This is option A plus arca's masking and agent rules. It needs network access and an active role at every start.
- **Pull into the store.** Something like `arca pull --from azure`, run by a human while the PIM role is active, could copy the referenced secrets into the encrypted local store. After that, `npm run dev` works offline and survives PIM expiry. It means a local copy of vault secrets that outlives the activation window, which an organisation using PIM may or may not accept.

## Sources

- [Use Key Vault references as app settings (App Service, Functions)](https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references)
- [App Configuration references: not resolved by the local Functions host](https://learn.microsoft.com/en-us/azure/app-service/app-service-configuration-references)
- [Container Apps: manage secrets](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets)
- [JavaScript App Configuration provider (Key Vault references)](https://learn.microsoft.com/en-us/azure/azure-app-configuration/reference-javascript-provider)
- [azd environment secrets (`akvs://`)](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/environment-secrets)
- [Azure SDK for JS: local dev with a developer account](https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/local-development-environment-developer-account)
- [Azure SDK for JS: credential chains / `AZURE_TOKEN_CREDENTIALS`](https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/credential-chains)
- [Key Vault RBAC guide (roles, Contributor/access-policy warning)](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide)
- [Secure your Key Vault (access policies lack PIM support)](https://learn.microsoft.com/en-us/azure/key-vault/general/security-features)
- [Key Vault service limits](https://learn.microsoft.com/en-us/azure/key-vault/general/service-limits)
- [PIM: Azure resource role settings](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-resource-roles-configure-role-settings)
- [PIM: activate Azure resource roles (REST SelfActivate)](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-resource-roles-activate-your-roles)
- [Azure RBAC troubleshooting (propagation up to 10 min)](https://learn.microsoft.com/en-us/azure/role-based-access-control/troubleshooting)
- [Next.js instrumentation](https://nextjs.org/docs/app/guides/instrumentation)
- [Phase: runtime secret injection in Next.js](https://phase.dev/blog/instrumenting-nextjs-with-runtime-secret-injection/)
- [az-loadenv](https://github.com/curiousdev/az-loadenv)
