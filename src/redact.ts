import { StringDecoder } from 'node:string_decoder'

// Streaming masker for child output. Every stored secret (plus its common encodings)
// is a "needle". Output is emitted immediately, except for a short tail that might be
// the start of a needle; that tail is held until the next chunk or a 50 ms timeout.

export const MIN_NEEDLE_LENGTH = 6

export interface Needle {
  text: string
  replacement: string
}

export interface Secret {
  name: string
  value: string
}

/** Builds needles for a value: raw, URL-encoded, JSON-escaped, base64, base64url and URL credentials. */
export function needlesFor(secret: Secret): Needle[] {
  const { name, value } = secret
  const out: Needle[] = []
  const add = (text: string, replacement = `[arca:${name}]`) => {
    if (text.length >= MIN_NEEDLE_LENGTH) out.push({ text, replacement })
  }
  if (value.length < MIN_NEEDLE_LENGTH) return out
  add(value)
  add(encodeURIComponent(value))
  add(JSON.stringify(value).slice(1, -1))
  add(Buffer.from(value, 'utf8').toString('base64'))
  add(Buffer.from(value, 'utf8').toString('base64url'))
  const url = parseCredentialUrl(value)
  if (url) {
    // DB drivers often print the password, or user:password, without the rest of the URL.
    add(`${url.rawUser}:${url.rawPassword}`, `[arca:${name}#credentials]`)
    add(url.rawPassword, `[arca:${name}#password]`)
    if (url.password !== url.rawPassword) add(url.password, `[arca:${name}#password]`)
  }
  return out
}

function parseCredentialUrl(value: string): { rawUser: string; rawPassword: string; password: string } | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^:@/\s]*):([^@/\s]+)@/i.exec(value)
  if (!m) return null
  const rawPassword = m[2]!
  let password = rawPassword
  try {
    password = decodeURIComponent(rawPassword)
  } catch {
    // keep raw
  }
  return { rawUser: m[1]!, rawPassword, password }
}

export class Redactor {
  private byFirst = new Map<string, Needle[]>()
  private held = ''
  readonly size: number

  constructor(needles: Needle[]) {
    // Dedupe, then try the longest needle first at each position.
    const unique = new Map<string, Needle>()
    for (const n of needles) {
      const existing = unique.get(n.text)
      // A full-value replacement beats a partial one for the same text.
      if (!existing || (existing.replacement.includes('#') && !n.replacement.includes('#'))) unique.set(n.text, n)
    }
    const sorted = [...unique.values()].sort((a, b) => b.text.length - a.text.length)
    for (const n of sorted) {
      const c = n.text[0]!
      const list = this.byFirst.get(c) ?? []
      list.push(n)
      this.byFirst.set(c, list)
    }
    this.size = unique.size
  }

  /** Masks a complete string (no streaming). */
  redact(text: string): string {
    return this.scan(text, true).out
  }

  /** Feeds a chunk; returns what can be printed now. */
  push(chunk: string): string {
    const { out, hold } = this.scan(this.held + chunk, false)
    this.held = hold
    return out
  }

  /** Returns the held tail, masked as far as possible. */
  flush(): string {
    const { out } = this.scan(this.held, true)
    this.held = ''
    return out
  }

  get pending(): boolean {
    return this.held.length > 0
  }

  private scan(text: string, final: boolean): { out: string; hold: string } {
    if (this.size === 0) return { out: text, hold: '' }
    let out = ''
    let i = 0
    let plainStart = 0
    while (i < text.length) {
      const candidates = this.byFirst.get(text[i]!)
      if (candidates) {
        let match: Needle | null = null
        let partial = false
        for (const n of candidates) {
          if (i + n.text.length <= text.length) {
            if (text.startsWith(n.text, i)) {
              match = n
              break
            }
          } else if (!final && n.text.startsWith(text.slice(i))) {
            // A longer needle could still match once more data arrives.
            partial = true
          }
        }
        if (partial) {
          out += text.slice(plainStart, i)
          return { out, hold: text.slice(i) }
        }
        if (match) {
          out += text.slice(plainStart, i) + match.replacement
          i += match.text.length
          plainStart = i
          continue
        }
      }
      i++
    }
    out += text.slice(plainStart)
    return { out, hold: '' }
  }
}

/** Wires a byte stream through a Redactor into `write`, with the 50 ms hold-back flush. */
export function createMaskedWriter(redactor: Redactor, write: (s: string) => void, flushMs = 50) {
  const decoder = new StringDecoder('utf8')
  let timer: NodeJS.Timeout | null = null
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (redactor.pending) {
      timer = setTimeout(() => {
        timer = null
        const s = redactor.flush()
        if (s) write(s)
      }, flushMs)
      timer.unref?.()
    }
  }
  return {
    write(chunk: Buffer | string) {
      const s = redactor.push(typeof chunk === 'string' ? chunk : decoder.write(chunk))
      if (s) write(s)
      schedule()
    },
    end() {
      if (timer) clearTimeout(timer)
      timer = null
      const s = redactor.push(decoder.end()) + redactor.flush()
      if (s) write(s)
    },
  }
}
