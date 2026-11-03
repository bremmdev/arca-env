# OS credential stores (Windows Credential Manager and the Linux Secret Service)

A program that needs a secret every time it starts, like a token, a password or an encryption key, has to keep it somewhere. A file next to the program is readable by anyone who finds it, and asking the user to type it every time is annoying. Operating systems solve this with a **credential store**: a per-user place for small secrets that the OS encrypts with something tied to the user's login, and unlocks for them when they log in. On Windows this is the **Credential Manager**. On Linux desktops it is a program that implements the **Secret Service** API, usually GNOME Keyring or KWallet. This document explains what both are for, how they work, when to use them and when not, and how arca uses them to keep its master key.

| Term | Meaning |
| --- | --- |
| Credential store | The OS's per-user place for small secrets, unlocked by the user's login. Also called a keychain or keyring |
| Credential | One entry in the store: a name to find it by, a user name, and a secret (the "blob") |
| Windows Credential Manager | The Windows credential store, plus the Control Panel window that shows it |
| DPAPI | Data Protection API. The Windows encryption that protects credentials with a key derived from the user's login |
| Target name | The unique name of a Windows credential, like `git:https://github.com` |
| Persistence | How long a Windows credential lives: this logon session, this computer, or roaming with the user's profile |
| Secret Service | A freedesktop.org standard: a D-Bus API for storing secrets. A spec, not a program |
| D-Bus | The message bus Linux desktop programs use to talk to each other. The *session bus* is the one for one logged-in user |
| Provider | A program that implements the Secret Service: GNOME Keyring, KWallet, KeePassXC |
| Collection | A group of items in the Secret Service, often called a keyring. Locked or unlocked as a whole |
| Item | One entry in a collection: a label, lookup attributes, and the secret |
| Attributes | Plain-text key/value pairs on an item, used to find it (`service=arca`). Not secret |
| Locked / unlocked | A locked collection is encrypted on disk and can't be read. Unlocking it (usually at login) makes every item readable |
| Kernel keyring (keyutils) | A separate Linux facility that keeps keys in kernel memory. Not the Secret Service, and gone after a reboot |
| Master key | arca's one random 32-byte key that unlocks every vault. The only thing arca puts in the credential store |

---

## Contents

1. [The problem](#1-the-problem)
2. [What a credential store does, and what it doesn't](#2-what-a-credential-store-does-and-what-it-doesnt)
3. [Windows Credential Manager](#3-windows-credential-manager)
4. [The Linux Secret Service](#4-the-linux-secret-service)
5. [Not the same thing: the Linux kernel keyring](#5-not-the-same-thing-the-linux-kernel-keyring)
6. [Side by side](#6-side-by-side)
7. [When to use a credential store, and when not](#7-when-to-use-a-credential-store-and-when-not)
8. [Pitfalls](#8-pitfalls)
9. [How arca uses them](#9-how-arca-uses-them)
10. [Open points for arca](#10-open-points-for-arca)
11. [Looking at arca's entry, and testing](#11-looking-at-arcas-entry-and-testing)
12. [Sources](#12-sources)

---

## 1. The problem

Some examples of programs that need a secret without asking for it:

- **Git** needs your GitHub token on every `git push`. Git Credential Manager keeps it in the OS store, so you log in once.
- **The GitHub CLI** (`gh`) keeps its OAuth token there, so `gh pr list` just works.
- **A remote desktop client** remembers the password for a server.
- **arca** needs a key to decrypt the vault with your project's secrets, every time you run `npm run dev`.

The obvious places to keep such a secret all have a problem:

| Where | Problem |
| --- | --- |
| A plain file (`~/.config/app/token`) | Readable by anything that reads files: backups, sync tools, an agent browsing your home folder. One wrong `git add` and it's public |
| An encrypted file | Then the *key* to that file has to live somewhere. Next to it is no better than no encryption (dotenvx's `.env.keys` problem) |
| Ask the user each time | Safe, but nobody wants to type a password before every `git push` or `npm run dev` |
| An environment variable | Visible to every child process and in shell history and profiles |

The OS already has one secret it trusts: **the user's login**. A credential store hangs everything off that. When you log in, the OS unlocks a store that only your account can open, and programs running as you can then read their secrets without asking. When you're logged out, or the disk is copied to another machine, the store is encrypted and useless.

---

## 2. What a credential store does, and what it doesn't

Both Windows and Linux stores have the same basic shape:

```
your program  ──(name: "arca" / "master-key/v1")──►  OS credential store  ──►  encrypted file in your profile
              ◄──────────── secret bytes ──────────                            (key derived from your login)
```

1. A program **writes** a credential under a name it picks.
2. The store **encrypts it** with a key tied to the user's login and saves it in the user's profile.
3. Later, a program **reads it back** by the same name. Because the user is logged in, the store is unlocked, and the read just works: no prompt.

What that gives you:

- **Nothing in your project or your files in plain text.** The secret isn't found by grepping, globbing, indexing or backing up your home folder.
- **Protection at rest.** A stolen laptop with a powered-off disk, or a copied profile folder, doesn't reveal the secret without the user's password.
- **Separation between users.** Another account on the same machine can't read your store.
- **No password to type.** The login already unlocked it.

What it does **not** give you, on Windows and Linux:

- **Protection from other programs running as you.** Any process running under your account can read any credential, by name, without a prompt. There is no per-app permission on generic credentials in Windows, and none in GNOME Keyring. (macOS is different: each keychain item has an access list tied to the app that created it.)
- **A backup.** If the store is lost (reinstall, new machine, a forced password reset), the secrets in it are gone.
- **A place for big data.** These stores are built for passwords and tokens, not files.

**The key point: a credential store protects secrets from people and things that aren't logged in as you. It doesn't protect them from code that is.** That's the same for every tool that uses one, including 1Password's CLI integration, `gh`, and arca.

---

## 3. Windows Credential Manager

### What it stores

Open it from **Control Panel → User Accounts → Credential Manager** (or search "Credential Manager" in Start). It has two tabs:

| Tab | What's in it | Who uses it |
| --- | --- | --- |
| **Web Credentials** | Passwords saved by old Internet Explorer / early Edge, and apps using the WinRT `PasswordVault` API | Mostly legacy |
| **Windows Credentials** | Three sections: *Windows Credentials* (logons to other machines, e.g. `TERMSRV/server` for remote desktop), *Certificate-Based Credentials*, and **Generic Credentials** | Generic Credentials is where ordinary apps put their secrets: Git, `gh`, Docker, Copilot CLI, arca |

Underneath, each credential is a `CREDENTIALW` structure. The fields that matter:

| Field | What it is |
| --- | --- |
| `Type` | `CRED_TYPE_GENERIC` for app secrets. `CRED_TYPE_DOMAIN_PASSWORD` and friends are for Windows' own logons to other machines |
| `TargetName` | The unique name the credential is found by. For generic credentials, any string up to 32,767 characters |
| `UserName` | A user name stored next to the secret. Informational for generic credentials |
| `CredentialBlob` | The secret itself, as bytes. **At most 2,560 bytes** (`CRED_MAX_CREDENTIAL_BLOB_SIZE`, 5 × 512) |
| `Persist` | How long it lives (below) |
| `Comment`, `Attributes` | Optional extra data |

The type matters for who can read the blob. For a **generic** credential, the program that calls `CredRead` gets the secret back. For a **domain password** credential, it doesn't: only the Local Security Authority (LSA) can use it, to log on to the other machine for you. Apps can't read your saved remote desktop passwords this way. They can read every generic credential.

### Persistence

| Value | Meaning |
| --- | --- |
| `CRED_PERSIST_SESSION` | Lives until you log off |
| `CRED_PERSIST_LOCAL_MACHINE` | Kept on this computer, for this user. Despite the name, still per user, not shared with other accounts |
| `CRED_PERSIST_ENTERPRISE` | Kept on this computer, **and** roams to other computers with the user's profile, if the organisation uses roaming profiles. On a home PC it behaves like `LOCAL_MACHINE` |

### Where it lives and how it's protected

Credentials are stored as encrypted files in your user profile, under `AppData\Local\Microsoft\Credentials` and `AppData\Roaming\Microsoft\Credentials` (the roaming ones are the `ENTERPRISE` kind). They are encrypted with **DPAPI**:

```
your Windows password
  → derives a key that protects your DPAPI master key (in AppData\Roaming\Microsoft\Protect\<your SID>)
    → that master key encrypts each credential file
```

So the files are worthless on their own. Copy them to another machine, or read them from another account, and they can't be decrypted. While you're logged in, Windows has your DPAPI key available, and any program running as you can ask for a decrypted credential.

A consequence worth knowing: **if an administrator resets a local account's password** (instead of you changing it with the old one), the chain above breaks and DPAPI-protected data, credentials included, can no longer be decrypted. Domain accounts have a recovery key on the domain controller. Microsoft accounts and normal password changes are handled for you.

### Talking to it

The API is four functions in `advapi32.dll` (header `wincred.h`):

| Function | Does |
| --- | --- |
| `CredWriteW` | Creates or replaces a credential |
| `CredReadW` | Reads one by target name and type, **including the secret** for generic credentials |
| `CredDeleteW` | Deletes one |
| `CredEnumerateW` | Lists credentials, optionally filtered by a target prefix like `git:*` |

There is no prompt, no permission check and no "which app is asking" in any of them. If your process runs as the user, the call succeeds.

From the command line, `cmdkey` manages credentials:

```powershell
cmdkey /list                                        # every credential: target, type, user. Never the secret
cmdkey /list:master-key/v1.arca                     # one credential
cmdkey /generic:myapp /user:me /pass:hunter2        # create a generic credential
cmdkey /delete:myapp                                # delete it
```

`cmdkey` never *shows* a secret, and PowerShell has no built-in command for it. That's a choice of those tools, not a protection: a few lines of C#, Rust or a Node addon calling `CredReadW` print it.

### What it isn't

- **Not Credential Guard.** Credential Guard isolates Windows' own domain logon secrets (NTLM hashes, Kerberos tickets) in a virtualised enclave. It doesn't touch generic credentials.
- **Not Windows Hello.** Hello can protect a key with the TPM and ask for your face, fingerprint or PIN before each use. Credential Manager never asks.
- **Not a sync service.** Credentials don't follow your Microsoft account to a new PC. Only domain roaming profiles move them, and the Credential Manager window has a manual **Back up Credentials** / **Restore Credentials** option (a password-protected `.crd` file).

---

## 4. The Linux Secret Service

### A spec, not a program

Linux has no single built-in credential store. Instead, freedesktop.org (the project behind shared Linux desktop standards) defines the **Secret Service API**: a set of D-Bus interfaces that any program can implement. A program that wants to store a secret talks to whatever provider is running, without caring which one it is.

| Provider | Where you find it |
| --- | --- |
| **GNOME Keyring** (`gnome-keyring-daemon`) | GNOME, Cinnamon, MATE, Xfce, most Ubuntu and Fedora desktops. The reference implementation |
| **KWallet** | KDE Plasma. Has its own older API, and newer versions also provide the Secret Service API |
| **KeePassXC** | The password manager can act as the provider (Settings → Secret Service Integration), so secrets land in a KeePass database |
| **oo7** | A newer Rust implementation from the GNOME project, meant to replace `gnome-keyring-daemon` |

Only one provider can own the Secret Service name on the bus at a time. If two are installed, whichever starts first wins.

### Collections, items and attributes

```
Secret Service  (bus name org.freedesktop.secrets, object /org/freedesktop/secrets)
├── collection "login"     ← the alias "default" usually points here. On disk, unlocked at login
│   ├── item  label "GitHub CLI"                attributes { service: "gh:github.com", username: "…" }   secret: ••••
│   └── item  label "keyring:master-key/v1@arca" attributes { service: "arca", username: "master-key/v1" } secret: ••••
└── collection "session"   ← in memory only, gone at logout
```

- A **collection** is a keyring: a group of items encrypted together, with one password. Most users only ever have `login`.
- The alias **`default`** is where programs put things when they don't pick a collection. On GNOME it points to `login`.
- An **item** has a human-readable **label**, a set of **attributes**, and the **secret** (bytes plus a content type).
- **Attributes are how you find an item.** There's no single "target name" like on Windows. A program searches for items whose attributes match, for example `{ service: "arca", username: "master-key/v1" }`. The spec says attributes are **not secret**: don't put anything sensitive in them.

### Locked and unlocked

A collection is either **locked** (encrypted, can't be read) or **unlocked** (every item readable by anyone who asks). With GNOME Keyring the `login` collection is a file, `~/.local/share/keyrings/login.keyring`, encrypted with a password that is normally **the same as your login password**. That's what makes it invisible:

```
you type your password at the login screen
  → PAM (the Linux login framework) runs pam_gnome_keyring with that password
    → gnome-keyring-daemon starts and unlocks the "login" collection
      → for the rest of the session, programs read their secrets without a prompt
```

If the passwords differ, or the keyring wasn't unlocked at login (automatic login, fingerprint login, an SSH session), the collection stays locked. The first program that needs a secret then triggers an **unlock prompt**: a desktop dialog asking for the keyring password. No desktop, no dialog, so the read fails.

### Talking to it

Programs talk to the provider over the **session bus**, the D-Bus instance for the logged-in user. Its address is in the environment variable `DBUS_SESSION_BUS_ADDRESS`. A read goes like this:

1. **Open a session** (`OpenSession`). The program and the provider agree how to transfer secrets: `plain`, or a Diffie-Hellman exchange that encrypts secrets on the bus (`dh-ietf1024-sha256-aes128-cbc-pkcs7`). Encryption keeps secrets out of bus monitors and logs. It doesn't stop other same-user programs, which can just ask for the same item.
2. **Search** (`SearchItems`) with attributes. The answer comes back as two lists: matching items that are unlocked, and ones that are locked.
3. **Unlock** if needed (`Unlock`). The provider may return a **prompt** object, and the program asks it to show the dialog.
4. **Get the secret** (`GetSecret`).

Most programs never see this, because they use a library: **libsecret** (C, used by most GNOME apps and by Git's `libsecret` credential helper), Python's `secretstorage` and `keyring`, Rust's `secret-service` and `oo7` crates, and in Node `@napi-rs/keyring`.

From the command line, `secret-tool` (in the `libsecret-tools` package) uses libsecret:

```bash
secret-tool store --label='My app' service myapp username me   # reads the secret from stdin
secret-tool lookup service myapp username me                   # prints the secret
secret-tool search service myapp                               # prints label, attributes AND the secret
secret-tool clear service myapp username me                    # deletes it
```

The GUI is **Seahorse** ("Passwords and Keys") on GNOME, or KWalletManager on KDE.

### Who can read it

GNOME Keyring has **no per-app access control**. Once `login` is unlocked, any process that can reach your session bus, which means any process running as you in that session, can search and read any item. KWallet has some per-app rules in its own API, but not for programs using the Secret Service API.

Sandboxed apps are the exception. A **Flatpak** app can't reach your session bus's Secret Service directly. It uses the Secret portal (`org.freedesktop.portal.Secret`) instead, which gives each app its own secret, so apps can't read each other's.

---

## 5. Not the same thing: the Linux kernel keyring

Linux also has a **kernel keyring**, managed with `keyctl` (package `keyutils`). Libraries sometimes treat it as a credential store, so it's easy to mix up with the Secret Service. It is very different:

| | Secret Service | Kernel keyring (keyutils) |
| --- | --- | --- |
| Where the keys live | An encrypted file on disk, managed by a user-space daemon | **Kernel memory** |
| Survives a reboot | Yes | **No** |
| Needs a desktop session / D-Bus | Yes | No. Works in SSH sessions, containers, WSL |
| Kinds of keyring | Collections | Thread, process, session, user, and a per-user *persistent* keyring. The persistent one expires after a few days without use and still doesn't survive a reboot |
| Good for | Secrets that must last | A **cache**: keep something unlocked for a while, then forget it |

The kernel keyring is a good place to cache a secret you can get again (for example a key you just unwrapped with a passphrase), and a bad place to keep the **only copy** of one. The docs of the Rust store arca's binding uses say it plainly: the facility "is completely in-memory and will not persist across reboots".

---

## 6. Side by side

| | Windows Credential Manager | Linux Secret Service |
| --- | --- | --- |
| What it is | A part of Windows | A D-Bus spec, implemented by GNOME Keyring, KWallet, KeePassXC… |
| Always there | Yes, on every Windows with a user logon | Only in a desktop session with a provider installed and running |
| How you find an entry | Target name (unique string) | Attribute search (key/value pairs) |
| Unlocked by | Your Windows logon (DPAPI) | PAM at login, or an unlock prompt |
| Prompts | Never | When a collection is locked |
| Per-app access control | No (generic credentials) | No (GNOME Keyring) |
| Size limit | 2,560 bytes per secret | No practical limit for small secrets |
| CLI | `cmdkey` (never shows the secret) | `secret-tool` (does show it) |
| GUI | Control Panel → Credential Manager | Seahorse, KWalletManager |
| Typical failure | SSH sessions and services without your login | No D-Bus, no provider, or a locked keyring with nobody to type the password |

---

## 7. When to use a credential store, and when not

| Situation | Use | Why |
| --- | --- | --- |
| A small secret a desktop tool needs on every run (a token, a refresh token) | **The credential store** | Unlocked by the login, no prompt, nothing in plain text on disk |
| A lot of secrets, or secrets that change together | **One key in the store, plus a file encrypted with it** (envelope encryption) | Stays under size limits, one atomic file write, one entry in the user's credential list. arca, psst and Electron's `safeStorage` work this way |
| A secret that must survive a lost machine | The store **plus a backup** you control, or a password manager | The store is not a backup |
| A headless Linux server, a container, CI | **Not** the Secret Service. Use the platform's secret mechanism (CI secrets, systemd credentials, a mounted file), or a key wrapped with a passphrase | There's no session bus or unlocked keyring there |
| A secret for a Windows service running as another account | **Not** your Credential Manager. Use that account's store, or DPAPI for the machine | Each account has its own store |
| A secret other programs running as you must not read | **Not** the store alone. Use something that asks first: Windows Hello, a password manager that prompts, a passphrase | The store gives every same-user process the same access |
| Something that only needs to live for a few hours on Linux | The **kernel keyring** with a timeout | In memory, expires on its own, works without a desktop |

A rule of thumb: **use the credential store for what lets you *start*, not for what you *store*.** Keep the item small and few, and keep the real data in a file it unlocks.

---

## 8. Pitfalls

### Windows

- **Remote and background sessions.**
  - Over OpenSSH with key-based login, in some services, and in scheduled tasks set to "Do not store password", Windows doesn't have your DPAPI key. `CredWrite` and `CredRead` then fail, typically with error 1312, "A specified logon session does not exist".
  - Fix: run the tool in a normal interactive logon, or log in to SSH with a password.
- **A forced password reset.** An administrator reset of a local account's password makes existing credentials unreadable (see [DPAPI](#where-it-lives-and-how-its-protected)).
- **A new PC or a reinstall.** Credentials don't move with the Microsoft account. Only domain roaming profiles and the manual Back up Credentials option move them.
- **The 2,560-byte limit.**
  - Libraries that store text as UTF-16 (the native Windows encoding) use 2 bytes per character, so only about 1,280 characters fit.
  - A long JWT or a private key may not fit.
  - Fix: keep a key in the store and the data in a file.
- **One shared namespace.**
  - Every app's generic credentials live side by side, found by target name.
  - Two apps that both pick `token` overwrite each other.
  - Fix: prefix target names with the app (`git:`, `gh:`, `arca`).
- **"cmdkey doesn't show it" isn't protection.** Any program running as you can call `CredReadW`.

### Linux

- **D-Bus is there, but no provider.**
  - `DBUS_SESSION_BUS_ADDRESS` only says a session bus exists. On most systemd distributions every login gets one, including SSH logins on servers and minimal desktops with no keyring.
  - Checking for the name `org.freedesktop.secrets` on the bus isn't enough either. D-Bus *activates* an installed provider on first use, so the name can be missing and still work, and a provider that starts can still fail. In a test, an auto-started GNOME Keyring with no unlocked `login` collection answered every read and write with "Secret Service: no result found".
  - Fix: actually try it (write, read back) and have a plan for when it fails.
- **Libraries that fall back silently.**
  - Some libraries switch to the kernel keyring when there's no Secret Service, without telling you.
  - The write and the read work, even across processes, and everything looks fine until the reboot that wipes it.
  - Fix: ask the library for the Secret Service explicitly and fail when it's missing.
  - This happened to arca, see [How arca uses them](#the-linux-kernel-keyring-bug-fixed-2026-11-02).
- **A locked keyring with nobody to type the password.**
  - Automatic login, fingerprint login and SSH sessions don't unlock `login`.
  - On a desktop the user gets a dialog. Without one, the read fails or hangs.
- **Login password changed outside PAM.**
  - If the account password changes in a way that doesn't update the keyring, the two no longer match.
  - The keyring then stops unlocking at login and prompts instead.
- **WSL.**
  - WSL usually has a session bus (systemd) and even a GUI (WSLg), but no keyring provider installed.
  - Even with GNOME Keyring installed, nothing unlocks it at login.
- **Containers and CI.** No session bus and no provider, unless you start both yourself (`dbus-run-session`, then `gnome-keyring-daemon --unlock`).
- **Binary secrets.**
  - KWallet only stores UTF-8 text.
  - Fix: encode binary keys (base64) before storing them.
- **`secret-tool search` prints secrets.** Don't run it where the output is logged or seen by an agent.
- **Attributes are not secret.** They're visible in Seahorse and to anyone who searches. Never put a value in them.

---

## 9. How arca uses them

### One key, not one item per secret

arca keeps exactly **one** item in the credential store: a random 32-byte **master key**. The secrets themselves live in AES-256-GCM vault files in the store folder (`%LOCALAPPDATA%\arca` on Windows, `~/.local/share/arca` on Linux), and each vault's key is derived from the master key ([03 §3](../03-architecture.md#3-crypto)).

```
OS credential store                      store folder (outside every repo)
└── master key (32 bytes, base64)  ──►   projects/<id>/ontwikkel.vault   (AES-256-GCM)
                                         projects/<id>/acceptatie.vault
                                         …
```

Why not one credential per secret, like envchain or secretspec:

- **Size.** A Windows blob holds at most 2,560 bytes. A connection string or private key can be bigger.
- **Atomic changes.** `arca import` writes many values at once. One encrypted file is one atomic rename. Many credential writes can fail halfway.
- **Clutter.** Dozens of `DATABASE_URL`-style entries per project in the user's Credential Manager or Seahorse.
- **The kernel keyring.** Per-item storage would put every secret at risk of the silent fallback ([pitfalls](#linux)).

It's the [rule of thumb](#7-when-to-use-a-credential-store-and-when-not): the store holds what lets arca *start*.

### What arca writes

arca uses `@napi-rs/keyring`, a Node binding for the Rust `keyring` crates with prebuilt binaries. The entry is service `arca`, user `master-key/v1`. A store at a custom `ARCA_HOME` gets its own user name, so two stores never share a key:

```ts
// From src/keychain.ts
export function keychainAccount(store: Store, io: IO): string {
  const defaultRoot = storeRoot({ ...io.env, ARCA_HOME: undefined }, io.platform)
  if (store.root === defaultRoot) return 'master-key/v1'
  const hash = createHash('sha256').update(store.root).digest('hex').slice(0, 12)
  return `master-key/v1/${hash}`
}
```

How that lands in each store:

| | Windows Credential Manager | Linux Secret Service |
| --- | --- | --- |
| Kind | Generic credential | Item in the `default` collection (usually `login`). Always the Secret Service: arca pins the binding to it, so it never lands in the kernel keyring |
| Name | Target `master-key/v1.arca` (the binding joins user and service with a `.`) | Attributes `service=arca`, `username=master-key/v1` |
| Shown as | `master-key/v1.arca` under Generic Credentials | Label `keyring:master-key/v1@arca` |
| Secret | The key as base64 (44 characters), stored as UTF-16: 88 of the 2,560 bytes | The key as base64, which also keeps KWallet happy |
| Persistence | `CRED_PERSIST_ENTERPRISE` (the binding's default): roams with a domain profile, otherwise local | Lasts as long as the collection |

This is what `cmdkey /list` shows on a machine where arca has run:

```text
Target: LegacyGeneric:target=master-key/v1.arca
Type: Generic
User: master-key/v1
```

(`LegacyGeneric:` is how `cmdkey` labels generic credentials. It doesn't mean anything is outdated.)

And this is the Linux item, as `secret-tool search --all service arca` showed it in a test container with GNOME Keyring (secret line left out; `/probe` is a test account):

```text
[/1]
label = keyring:master-key/v1/probe@arca
attribute.service = arca
attribute.username = master-key/v1/probe
```

### Choosing the backend

arca has two ways to keep the master key: in the OS store (`os`), or wrapped with a passphrase in `master.key.enc` in the store folder (`passphrase`, see [03 §4](../03-architecture.md#4-keychain-adapter-and-fallbacks)). It picks once, on the first write, and records the choice in the store's `config.json`. First a guess from the environment:

```ts
// From src/keychain.ts
export function chooseBackend(store: Store, io: IO): Backend {
  const configured = configuredBackend(store, io) // config.json, then ARCA_KEYCHAIN
  if (configured) return configured
  if (io.platform === 'linux') {
    const wsl = Boolean(io.env.WSL_DISTRO_NAME) || readSafe('/proc/version').toLowerCase().includes('microsoft')
    if (wsl || !io.env.DBUS_SESSION_BUS_ADDRESS) return 'passphrase'
  }
  return 'os'
}
```

On Linux, `os` is only a guess (D-Bus is there, so a Secret Service might be). So when the first key is created, `loadMasterKey` tries it for real, and falls back to a passphrase if it doesn't work:

```ts
// From src/keychain.ts, loadMasterKey: the first key, when the Secret Service was guessed
try {
  return await createMasterKey(store, io, 'os')
} catch (e) {
  io.stderr.write(`arca: no working Secret Service keyring (${reason}). Using a passphrase instead.\n`)
  return createMasterKey(store, io, 'passphrase')
}
```

| Where | Backend | Why |
| --- | --- | --- |
| Windows | `os` | Credential Manager is always there |
| Linux desktop (GNOME, KDE) | `os` | Secret Service, unlocked at login |
| Linux with D-Bus but no working Secret Service (minimal desktop, tiling WM, SSH into a systemd server) | `passphrase`, with a one-line note | arca tried the Secret Service on the first write and it failed |
| WSL | `passphrase` | No keyring provider by default. Detected by `WSL_DISTRO_NAME` or `microsoft` in `/proc/version` |
| Docker Desktop containers on Windows | `passphrase` | They run on the WSL2 kernel, so they look like WSL. Right anyway: containers rarely have a keyring |
| Linux without a session bus (SSH without systemd, containers, CI) | `passphrase` | No Secret Service is possible |
| `ARCA_KEYCHAIN` or `config.json` set | What it says, no fallback | The user knows better |

Two safety checks around it:

- **Read back after writing.** `writeOsKey` reads the key back and refuses a store that didn't keep it. Since the binding is pinned to the Secret Service, this is a plain sanity check; it was never able to catch the kernel keyring fallback (see below).
- **Never a second key.** If the key is missing but vaults exist, arca refuses to create a new one, because the old vaults could never be decrypted again. `arca run` and `arca set` stop with "no master key found" and the store path, and `arca doctor` reports "Master key missing, but vaults exist". Tested against the real Credential Manager and GNOME Keyring (`test/keychain.test.ts`).

### The Linux kernel keyring bug (fixed 2026-11-02)

Issue P3 in [08](../08-issue-log.md). Until 0.2.1, arca created its entry without pinning the store. On Linux, `@napi-rs/keyring` then tries the Secret Service and **silently falls back to the kernel keyring** when there is none. `chooseBackend` returned `os` whenever D-Bus was there, so on a machine with D-Bus but no working Secret Service:

1. The first `arca set` wrote the master key to **kernel memory**.
2. The read-back check passed. The key even survived between processes, so every `arca run` worked.
3. The next reboot deleted the key, and every vault in the store became undecryptable.

Reproduced in Docker (`node:24`, `dbus` installed, no keyring daemon, seccomp off so the kernel keyring works as on a real machine):

| Situation | Unpinned (≤ 0.2.1) | Pinned to the Secret Service (now) |
| --- | --- | --- |
| No D-Bus | Writes to the kernel keyring | Throws in the constructor |
| D-Bus, no keyring daemon | **Writes to the kernel keyring**; a second process reads it back | Throws: "org.freedesktop.secrets was not provided by any .service files" |
| D-Bus, GNOME Keyring auto-started but no unlocked collection | Throws: "no result found" | Throws: "no result found" |
| D-Bus + unlocked GNOME Keyring | Works | Works |

The fix has two parts: every entry on Linux is created with `{ linux: { store: 'secret-service' } }`, and the first key falls back to a passphrase when the Secret Service fails (above). A store that ≤ 0.2.1 already put in the kernel keyring isn't rescued: arca no longer reads the kernel keyring, so it now gets "could not read the OS keychain" right away instead of losing the key at the next reboot. Deleting the store folder and setting the values again fixes it.

`arca doctor` shows which one is in use, as `Key storage: Windows Credential Manager`, `Key storage: Secret Service (GNOME Keyring / KWallet)` or `Key storage: passphrase (master.key.enc)`.

### What it protects, and what it can't

It protects:

- **The vaults on disk.** Without the master key they're ciphertext, and the key is never next to them.
- **Against copies.** A backup of the store folder, a synced home folder or another account on the machine can't open the vaults.
- **The DX.** No master password: the login unlocked the store, so `npm run dev` never prompts on Windows or a Linux desktop.

It **can't** stop a process running as you from reading the key. `cmdkey` won't show it, but an agent that writes `node -e "…new Entry('arca','master-key/v1').getPassword()…"` gets it, on both Windows and Linux. That is threat model [L8](../02-threat-model.md#leak-channels-and-mitigations): deliberate circumvention, accepted and documented. arca's job is to keep values out of an agent's context *by accident*, and reading the credential store by hand is not an accident. A gate that asks first (Windows Hello with a TPM-bound key) is the Phase 3 answer ([06](../06-roadmap.md)).

### Why each part

| Choice | Why | Instead of |
| --- | --- | --- |
| The OS store by default | No password to type, nothing in plain text, and it's already there on Windows and Linux desktops | A master password on every run, which nobody keeps using |
| One master key, vaults in files | Size limits, atomic writes, one tidy entry, and the secrets never touch the kernel keyring | One credential per secret (envchain, secretspec) |
| `@napi-rs/keyring` | Maintained, prebuilt binaries for Windows and Linux (glibc and musl, x64 and arm64), sync API for the fast path | keytar (unmaintained), or calling `cmdkey`/`secret-tool` (slow, and `secret-tool` prints secrets) |
| Base64 secret | Text works on every backend (KWallet only stores UTF-8, Windows stores UTF-16) | Raw bytes |
| Pinned to the Secret Service, passphrase when it fails | The kernel keyring would be the only copy of the key, and a reboot would destroy every vault | Trusting the binding's fallback (what ≤ 0.2.1 did) |
| The backend is recorded on first write | A store doesn't switch backends later and "lose" its key | Choosing again on every run |
| A separate account per `ARCA_HOME` | Tests and second stores never touch the real key | One shared entry |

---

## 10. Open points for arca

Resolved:

- ✅ **D-Bus without a Secret Service silently used the kernel keyring.** Confirmed in Docker and fixed, see [the bug](#the-linux-kernel-keyring-bug-fixed-2026-11-02). The doc's earlier reading of the README was right: it didn't fail, it fell back.
- ✅ **The read-back check didn't catch the fallback.** Confirmed: the key read back fine, even from a second process. Pinning the store removed the case it was meant to catch.

Still open:

- **Stores created by ≤ 0.2.1 in the kernel keyring.** Not rescued (see the end of [the bug](#the-linux-kernel-keyring-bug-fixed-2026-11-02)). Probably no real users. If one turns up: read the kernel keyring entry once, rewrap it with a passphrase, switch the store's backend.
- **The error tip for a configured store.** When the OS keychain fails on a store whose `config.json` says `os`, the message suggests `ARCA_KEYCHAIN=passphrase`, but the recorded backend wins over that variable, so the tip doesn't help.
- ✅ **A locked keyring in a non-interactive run** (checked 2026-11-02 in Docker, P8). With no way to show an unlock dialog, `arca run` fails at once, no hang: "Secret Service: unlock prompt was dismissed". The message now says the keyring is locked and how to unlock it, instead of suggesting passphrase mode. On a desktop the provider shows its dialog instead (not checked by hand).
- **Windows over SSH.** Not a bug, but worth a line in `doctor` or the docs: a key-based SSH session into Windows may not be able to read Credential Manager (error 1312).

---

## 11. Looking at arca's entry, and testing

### Looking at it by hand

Windows:

```powershell
cmdkey /list:master-key/v1.arca          # shows it exists, never the key
```

Or Control Panel → Credential Manager → Windows Credentials → Generic Credentials → `master-key/v1.arca`.

Linux:

```bash
secret-tool search --all service arca    # ⚠️ prints the key
```

Or Seahorse → Login → `keyring:master-key/v1@arca`.

**Don't delete the entry** (`cmdkey /delete`, `secret-tool clear`, the GUI) while vaults exist. Every vault in the store becomes unreadable, and arca will refuse to create a new key until you delete the store folder.

### Tests

The plan is in [10](../10-platform-testing.md). The parts about credential stores:

- **Most tests use passphrase mode** (`test/helpers.ts`), so they never touch a real credential store.
- **`test/keychain.test.ts`** (built 2026-11-02). The real OS store, opt-in with `ARCA_TEST_OS_KEYCHAIN=1`.
  - Each test store is a throwaway `ARCA_HOME`, so it gets its own account (`master-key/v1/<hash>`) and never touches your key. Entries are deleted afterwards.
  - Checks: the first `set` picks the OS store by itself and writes no `master.key.enc`; two stores get two entries; `doctor` names the store; a deleted entry gives "no master key found" and no new key is created over the old vaults.
  - Runs in the `windows-latest` CI jobs (Credential Manager), and in the `keychain-linux` job: `gnome-keyring` under `dbus-run-session` with an unlocked keyring.
  - Passed on 2026-11-02 against your own Credential Manager and against GNOME Keyring in Docker.
  - The planned "read it back from a new process" check was dropped: pinning removed the in-memory fallback it was meant to catch.
- **`test/backend.test.ts`** (built 2026-11-02). Runs everywhere.
  - `chooseBackend` for Windows, Linux with and without D-Bus, WSL (`WSL_DISTRO_NAME`), `ARCA_KEYCHAIN`, and the store's recorded backend.
  - On real Linux (not WSL): with a D-Bus address that can't connect, the first key falls back to a passphrase with the note, and the next load reads it without one. The real keyring is never touched.
- **Locally with Docker.** Docker Desktop containers look like WSL (P4), so auto-detection can't be tested there. Force `ARCA_KEYCHAIN=os` to test the Secret Service itself. To see the kernel keyring as on a real machine, run with `--security-opt seccomp=unconfined` (Docker blocks it by default).
- **Manual, on WSL.** Install `gnome-keyring` and `libsecret-tools`, run with `ARCA_KEYCHAIN=os`, and check the key survives `wsl --shutdown` (M5). The reverse check is no longer needed: the fallback was reproduced in Docker, and arca can't reach the kernel keyring any more.

---

## 12. Sources

**Microsoft**
- [`CREDENTIALW` structure](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw) (types, persistence, size limits)
- [`CredReadW`](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw), [`CredWriteW`](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew), [`CredEnumerateW`](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credenumeratew)
- [`cmdkey`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmdkey)
- [Credential Manager in Windows](https://support.microsoft.com/en-us/windows/credential-manager-in-windows-1b5c916a-6a16-889f-8581-fc16e8165ac0)
- [`CryptProtectData` (DPAPI)](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
- [Credential Guard overview](https://learn.microsoft.com/en-us/windows/security/identity-protection/credential-guard/)

**freedesktop.org and Linux**
- [Secret Service API specification](https://specifications.freedesktop.org/secret-service-spec/latest/)
- [libsecret documentation](https://gnome.pages.gitlab.gnome.org/libsecret/) and `secret-tool(1)`
- [GNOME Keyring](https://wiki.gnome.org/Projects/GnomeKeyring) and [ArchWiki: GNOME/Keyring](https://wiki.archlinux.org/title/GNOME/Keyring) (PAM unlocking, headless use)
- [ArchWiki: KDE Wallet](https://wiki.archlinux.org/title/KDE_Wallet)
- [KeePassXC: Secret Service integration](https://keepassxc.org/docs/KeePassXC_UserGuide#_secret_service_integration)
- [XDG Desktop Portal: Secret](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Secret.html)
- [`keyrings(7)`](https://man7.org/linux/man-pages/man7/keyrings.7.html) and [`persistent-keyring(7)`](https://man7.org/linux/man-pages/man7/persistent-keyring.7.html)

**Libraries arca depends on** (checked November 2026, `@napi-rs/keyring` 2.1.2)
- [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) (README: Linux backend selection and the silent keyutils fallback)
- [`windows-native-keyring-store`](https://docs.rs/windows-native-keyring-store) (generic credentials, `user.service` target, UTF-16, Enterprise persistence by default)
- [`dbus-secret-service-keyring-store`](https://docs.rs/dbus-secret-service-keyring-store) (default collection, `service`/`username` attributes, `keyring:{user}@{service}` label, encrypted session, unlock on search)
- [`linux-keyutils-keyring-store`](https://docs.rs/linux-keyutils-keyring-store) ("completely in-memory and will not persist across reboots")

**Other tools that use these stores**
- [Git Credential Manager: credential stores](https://github.com/git-ecosystem/git-credential-manager/blob/main/docs/credstores.md)
- [`gh auth login`](https://cli.github.com/manual/gh_auth_login) (token in the system credential store)
- In this repo: [01 prior art](../01-prior-art.md) (psst, envchain, secretspec, aws-vault), [02 threat model](../02-threat-model.md) (L7, L8), [03 architecture §3–4](../03-architecture.md#3-crypto), [10 platform testing](../10-platform-testing.md)
