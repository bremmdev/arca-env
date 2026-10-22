import { describe, expect, it } from 'vitest'
import { Redactor, createMaskedWriter, needlesFor } from '../src/redact.js'

const secret = { name: 'API_KEY', value: 'sk_test_abc123XYZ' }
const db = { name: 'DATABASE_URL', value: 'postgres://app:s3cr3t-pass@localhost:5432/acme' }

describe('needles', () => {
  it('covers raw, encoded and base64 forms', () => {
    const r = new Redactor(needlesFor(secret))
    expect(r.redact(`key=${secret.value}`)).toBe('key=[arca:API_KEY]')
    expect(r.redact(Buffer.from(secret.value).toString('base64'))).toBe('[arca:API_KEY]')
    const weird = { name: 'TOKEN', value: 'a b/c"d\\e?f' }
    const rw = new Redactor(needlesFor(weird))
    expect(rw.redact(encodeURIComponent(weird.value))).toBe('[arca:TOKEN]')
    expect(rw.redact(JSON.stringify({ t: weird.value }))).toBe('{"t":"[arca:TOKEN]"}')
  })

  it('masks the password inside a connection string, and the full URL', () => {
    const r = new Redactor(needlesFor(db))
    expect(r.redact(`connecting to ${db.value}`)).toBe('connecting to [arca:DATABASE_URL]')
    expect(r.redact('password authentication failed: s3cr3t-pass')).toBe('password authentication failed: [arca:DATABASE_URL#password]')
    expect(r.redact('postgres://app:s3cr3t-pass@db.internal/other')).toBe('postgres://[arca:DATABASE_URL#credentials]@db.internal/other')
  })

  it('skips values too short to mask safely', () => {
    expect(needlesFor({ name: 'PORT', value: '3000' })).toEqual([])
  })
})

describe('streaming', () => {
  it('masks a secret split at every possible chunk boundary', () => {
    const text = `before ${secret.value} middle ${db.value} after`
    for (let cut = 0; cut <= text.length; cut++) {
      for (let cut2 = cut; cut2 <= text.length; cut2 += 7) {
        const r = new Redactor([...needlesFor(secret), ...needlesFor(db)])
        const out = r.push(text.slice(0, cut)) + r.push(text.slice(cut, cut2)) + r.push(text.slice(cut2)) + r.flush()
        expect(out).toBe('before [arca:API_KEY] middle [arca:DATABASE_URL] after')
      }
    }
  })

  it('emits normal output immediately and only holds a possible prefix', () => {
    const r = new Redactor(needlesFor(secret))
    expect(r.push('hello world\n')).toBe('hello world\n')
    expect(r.push('value: sk_te')).toBe('value: ')
    expect(r.pending).toBe(true)
    expect(r.push('a')).toBe('sk_tea')
    expect(r.pending).toBe(false)
  })

  it('flushes a held prefix after the timeout', async () => {
    const out: string[] = []
    const w = createMaskedWriter(new Redactor(needlesFor(secret)), (s) => out.push(s), 20)
    w.write(Buffer.from('prompt> sk_t'))
    expect(out.join('')).toBe('prompt> ')
    await new Promise((r) => setTimeout(r, 60))
    expect(out.join('')).toBe('prompt> sk_t')
  })

  it('does not split multi-byte characters', () => {
    const out: string[] = []
    const w = createMaskedWriter(new Redactor(needlesFor({ name: 'K', value: 'geheim€wachtwoord' })), (s) => out.push(s))
    const bytes = Buffer.from('€ x geheim€wachtwoord €')
    for (const b of bytes) w.write(Buffer.from([b]))
    w.end()
    expect(out.join('')).toBe('€ x [arca:K] €')
  })

  it('prefers the full value over a partial match', () => {
    const r = new Redactor(needlesFor(db))
    expect(r.push(db.value.slice(0, 20)) + r.push(db.value.slice(20)) + r.flush()).toBe('[arca:DATABASE_URL]')
  })
})
