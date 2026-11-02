import { spawn } from 'node:child_process'
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { storeRoot } from '../src/paths.js'
import { atomicWrite } from '../src/store.js'
import { harness, tempDir, writeJson } from './helpers.js'

// Where the store lives, who can read its files, and writes that survive Windows file locks.

describe('store location', () => {
  it('Windows: %LOCALAPPDATA%\\arca, never the roaming profile', () => {
    const env = { LOCALAPPDATA: join('C:', 'Users', 'me', 'AppData', 'Local'), APPDATA: join('C:', 'Users', 'me', 'AppData', 'Roaming') }
    expect(storeRoot(env, 'win32')).toBe(join(env.LOCALAPPDATA, 'arca'))
  })

  it('Windows without LOCALAPPDATA: AppData\\Local in the home folder', () => {
    expect(storeRoot({}, 'win32')).toBe(join(homedir(), 'AppData', 'Local', 'arca'))
  })

  it('Linux: $XDG_DATA_HOME/arca, else ~/.local/share/arca', () => {
    expect(storeRoot({ XDG_DATA_HOME: join('/data', 'me') }, 'linux')).toBe(join('/data', 'me', 'arca'))
    expect(storeRoot({ XDG_DATA_HOME: '' }, 'linux')).toBe(join(homedir(), '.local', 'share', 'arca'))
    expect(storeRoot({}, 'linux')).toBe(join(homedir(), '.local', 'share', 'arca'))
  })

  it('ARCA_HOME wins on every platform', () => {
    for (const platform of ['win32', 'linux'] as const) expect(storeRoot({ ARCA_HOME: join('/x', 'store'), LOCALAPPDATA: '/l' }, platform)).toBe(join('/x', 'store'))
  })
})

/** Every file and folder under `dir`, with its permission bits. */
function modes(dir: string): { path: string; mode: number; isDir: boolean }[] {
  const out: { path: string; mode: number; isDir: boolean }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name)
    out.push({ path, mode: statSync(path).mode & 0o777, isDir: entry.isDirectory() })
  }
  return out
}

describe.runIf(process.platform === 'linux')('file permissions (Linux)', () => {
  it('the store is private to the user after every kind of write', async () => {
    // A store folder arca creates itself (not mkdtemp's), with a fresh passphrase key.
    const store = join(tempDir(), 'store')
    const h = harness(tempDir(), store)
    const env = { ARCA_KEYCHAIN: 'passphrase' }
    writeJson(join(h.dir, 'arca.json'), { id: 'arc_permtest', name: 'perm-test', vars: { A_KEY: { required: true } } })

    for (const args of [
      ['set', 'A_KEY'], // master.key.enc, config.json, the vault
      ['set', 'A_KEY'], // the vault again, plus .bak
      ['restore', 'A_KEY'],
      ['profiles', 'add', 'acc'],
      ['set', 'A_KEY', '--profile', 'acc'],
      ['use', 'acc'], // state.json
      ['policy', 'set', 'agent-run', 'deny'], // policy.vault
    ]) {
      const { code, io } = await h.human(args, { env, stdin: args[0] === 'set' ? `value-${Math.random()}` : undefined })
      expect(code, `${args.join(' ')}\n${io.all()}`).toBe(0)
    }

    const all = modes(store)
    expect(all.map((e) => e.path.slice(store.length + 1).replaceAll('\\', '/')).sort()).toEqual(
      expect.arrayContaining(['config.json', 'master.key.enc', 'projects/arc_permtest/default.vault', 'projects/arc_permtest/default.vault.bak', 'projects/arc_permtest/acc.vault', 'projects/arc_permtest/state.json', 'projects/arc_permtest/policy.vault']),
    )
    expect(statSync(store).mode & 0o777).toBe(0o700)
    const open = all.filter((e) => (e.mode & 0o077) !== 0).map((e) => `${e.path} ${e.mode.toString(8)}`)
    expect(open).toEqual([])
  })

  it('export --output makes the file private, even when it already existed', async () => {
    const h = harness()
    writeJson(join(h.dir, 'arca.json'), { id: 'arc_exporttest', name: 'export-test', vars: { A_KEY: { required: true } } })
    expect((await h.human(['set', 'A_KEY'], { stdin: 'value-to-export-1234' })).code).toBe(0)

    const fresh = join(h.dir, 'fresh.env')
    const existing = join(h.dir, 'existing.env')
    writeFileSync(existing, 'OLD=1\n')
    chmodSync(existing, 0o644)
    for (const file of [fresh, existing]) {
      const { code, io } = await h.human(['export', '--output', file])
      expect(code, io.all()).toBe(0)
      expect(readFileSync(file, 'utf8')).toContain('A_KEY=')
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  })
})

/** Opens `file` the way antivirus and indexers do: no delete sharing, so a rename over it fails. */
async function holdOpen(file: string, ms: number) {
  const script = `$f = [IO.File]::Open('${file.replaceAll("'", "''")}', 'Open', 'Read', 'Read'); 'locked'; [Threading.Thread]::Sleep(${ms}); $f.Close()`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => d.toString().includes('locked') && resolve())
    child.on('exit', (code) => reject(new Error(`holder exited early (${code})`)))
  })
  return child
}

describe.runIf(process.platform === 'win32')('writes while another program holds the file (Windows)', () => {
  it('retries a rename blocked for a few hundred milliseconds, then succeeds', async () => {
    const file = join(tempDir(), 'vault.json')
    writeFileSync(file, 'old')
    const holder = await holdOpen(file, 300) // longer than the old 200 ms retry window
    atomicWrite(file, 'new')
    expect(readFileSync(file, 'utf8')).toBe('new')
    holder.kill()
  }, 20_000)

  it('gives up on a file held for long, keeping the old content and no temp file', async () => {
    const dir = tempDir()
    const file = join(dir, 'vault.json')
    writeFileSync(file, 'old')
    const holder = await holdOpen(file, 5000)
    try {
      expect(() => atomicWrite(file, 'new')).toThrow(/EPERM|EBUSY|EACCES/)
      expect(readFileSync(file, 'utf8')).toBe('old')
      expect(readdirSync(dir)).toEqual(['vault.json'])
    } finally {
      holder.kill()
    }
  }, 20_000)
})
