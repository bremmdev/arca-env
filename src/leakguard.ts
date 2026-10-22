import { execFileSync } from 'node:child_process'
import { relative } from 'node:path'
import { isSensitive, type Project } from './config.js'
import type { EnvFile } from './envfiles.js'
import { needlesFor, type Secret } from './redact.js'

// The leak guard keeps secrets from drifting back into .env files. It only reads files.

export const PUBLIC_PREFIXES = ['NEXT_PUBLIC_', 'VITE_', 'PUBLIC_', 'NUXT_PUBLIC_', 'EXPO_PUBLIC_', 'REACT_APP_', 'GATSBY_', 'STORYBOOK_']

const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PRIVATE|API_?KEY|_KEY$|^KEY$|CREDENTIAL|DSN|AUTH|SALT|SIGNING|WEBHOOK)/i
const KNOWN_PREFIXES = /^(sk_live_|sk_test_|rk_live_|rk_test_|whsec_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abpr]-|AKIA[0-9A-Z]{12}|ASIA[0-9A-Z]{12}|AIza[0-9A-Za-z_-]{20}|sk-[A-Za-z0-9_-]{20}|sk-ant-|re_[A-Za-z0-9]{16}|SG\.|npm_[A-Za-z0-9]{20}|-----BEGIN)/
const CREDENTIAL_URL = /^[a-z][a-z0-9+.-]*:\/\/[^:@/\s]*:[^@/\s]+@/i
const JWT = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/

export function isPublicName(key: string): boolean {
  return PUBLIC_PREFIXES.some((p) => key.startsWith(p))
}

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>()
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/** Heuristic: does this .env entry look like a secret? Returns the reason, or null. */
export function secretReason(key: string, value: string): string | null {
  const v = value.trim()
  if (v === '') return null
  if (CREDENTIAL_URL.test(v)) return 'a URL with a password'
  if (KNOWN_PREFIXES.test(v)) return 'a known secret format'
  if (JWT.test(v)) return 'a token (JWT)'
  if (v.length >= 24 && !/\s/.test(v) && !/^https?:\/\//i.test(v) && shannonEntropy(v) > 4.0) return 'a long random-looking value'
  if (!isPublicName(key) && SECRET_NAME.test(key) && plausibleSecretValue(v)) return 'a secret-like name'
  return null
}

function plausibleSecretValue(v: string): boolean {
  if (v.length < 8) return false
  if (/^(true|false|yes|no|on|off|null|undefined)$/i.test(v)) return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) && !CREDENTIAL_URL.test(v)) return false // a URL without credentials
  if (/^(your|change|replace|xxx|todo|<)/i.test(v)) return false // placeholders
  return true
}

export type Rule = 'stored' | 'declared' | 'heuristic'

export interface Finding {
  /** Path relative to the project root. */
  file: string
  key: string
  rule: Rule
  detail: string
  tracked: boolean
}

export function scanEnvFiles(project: Project, files: EnvFile[], secrets: Secret[]): Finding[] {
  const ignore = new Set(project.config.leakGuard.ignore)
  const needles = secrets.flatMap((s) => needlesFor(s).map((n) => ({ ...n, name: s.name })))
  const findings: Finding[] = []
  for (const file of files) {
    const name = relative(project.root, file.path) || file.name
    for (const entry of file.entries) {
      if (entry.value.trim() === '') continue
      // 1. Exact match with a stored value (or a variant like the URL password).
      const hit = needles.find((n) => entry.value.includes(n.text))
      if (hit) {
        const detail =
          hit.name === entry.key
            ? `${entry.key} is stored in arca but also in plaintext in ${name}`
            : `${entry.key} in ${name} contains the value of ${hit.name}, which is stored in arca`
        findings.push({ file: name, key: entry.key, rule: 'stored', detail, tracked: false })
        continue
      }
      if (ignore.has(entry.key)) continue
      const decl = project.config.vars[entry.key]
      // 2. Declared sensitive, but set in a .env file.
      if (decl && isSensitive(decl)) {
        findings.push({ file: name, key: entry.key, rule: 'declared', detail: `${entry.key} is declared sensitive in arca.json but set in ${name}`, tracked: false })
        continue
      }
      // 3. Looks like a secret (undeclared keys only).
      if (!decl) {
        const reason = secretReason(entry.key, entry.value)
        if (reason) findings.push({ file: name, key: entry.key, rule: 'heuristic', detail: `${entry.key} in ${name} looks like a secret (${reason})`, tracked: false })
      }
    }
  }
  markTracked(project.root, findings)
  return findings
}

/** Escalates findings in files tracked by git. One git call, only when there are findings. */
function markTracked(root: string, findings: Finding[]): void {
  if (findings.length === 0) return
  const files = [...new Set(findings.map((f) => f.file))]
  try {
    const out = execFileSync('git', ['ls-files', '--', ...files], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
    const tracked = new Set(out.split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\//g, '\\')))
    for (const f of findings) {
      if (tracked.has(f.file) || tracked.has(f.file.replace(/\\/g, '/')) || tracked.has(f.file.replace(/\//g, '\\'))) f.tracked = true
    }
  } catch {
    // not a git repo, or git missing
  }
}

export function summarizeFindings(findings: Finding[]): string {
  const files = [...new Set(findings.map((f) => f.file))]
  const tracked = findings.some((f) => f.tracked)
  const what = findings.length === 1 ? '1 possible secret' : `${findings.length} possible secrets`
  return `arca: ${what} in ${files.join(', ')}${tracked ? ' (committed to git!)' : ''}. Run \`npx arca doctor\` for details.`
}
