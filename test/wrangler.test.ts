import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isBuildScript } from '../src/commands/init.js'
import { member, parseJsonc } from '../src/jsonc.js'
import { declareSecrets, findWranglerConfig, planSecrets } from '../src/wrangler.js'
import { tempDir } from './helpers.js'

/** Writes `text` as the project's Wrangler config, declares `names`, returns the new text. */
function declared(file: string, text: string, names = ['STRIPE_SECRET_KEY', 'DATABASE_URL']): string {
  const dir = tempDir()
  writeFileSync(join(dir, file), text)
  declareSecrets(dir, file, names)
  return readFileSync(join(dir, file), 'utf8')
}

function required(text: string): unknown {
  const doc = parseJsonc(text)
  expect(doc).not.toBeNull()
  const list = member(member(doc!, 'secrets'), 'required')
  return list?.type === 'array' ? list.items.map((n) => (n.type === 'value' ? n.value : undefined)) : undefined
}

describe('parseJsonc', () => {
  it('reads comments, trailing commas and nested values', () => {
    const doc = parseJsonc('// top\n{ /* a */ "a": [1, "x", { "b": true },], "c": null, }\n')
    expect(doc?.type).toBe('object')
    expect(member(doc!, 'c')).toMatchObject({ type: 'value', value: null })
    expect(member(doc!, 'a')).toMatchObject({ type: 'array' })
  })

  it.each(['{ "a": 1 ', '{ a: 1 }', '{ "a": 1 } x', '{ "a": "un\nclosed" }', '/* open { }'])('rejects %j', (text) => {
    expect(parseJsonc(text)).toBeNull()
  })
})

describe('declaring secrets in a Wrangler config', () => {
  it('adds secrets.required to wrangler.jsonc, keeping comments and layout', () => {
    const before = [
      '{',
      '  // my worker',
      '  "name": "w",',
      '  "main": "src/index.js", // entry',
      '  "vars": { "PLAIN": "1" } // config',
      '}',
      '',
    ].join('\n')
    expect(declared('wrangler.jsonc', before)).toBe([
      '{',
      '  // my worker',
      '  "name": "w",',
      '  "main": "src/index.js", // entry',
      '  "vars": { "PLAIN": "1" }, // config',
      '  "secrets": { "required": ["STRIPE_SECRET_KEY", "DATABASE_URL"] }',
      '}',
      '',
    ].join('\n'))
  })

  it('keeps trailing commas, tabs and CRLF', () => {
    const before = '{\r\n\t"name": "w",\r\n\t"vars": {},\r\n}\r\n'
    expect(declared('wrangler.jsonc', before)).toBe('{\r\n\t"name": "w",\r\n\t"vars": {},\r\n\t"secrets": { "required": ["STRIPE_SECRET_KEY", "DATABASE_URL"] },\r\n}\r\n')
  })

  it('works on a one-line file', () => {
    const after = declared('wrangler.json', '{ "name": "w" }')
    expect(after).toBe('{ "name": "w", "secrets": { "required": ["STRIPE_SECRET_KEY", "DATABASE_URL"] } }')
    expect(JSON.parse(after).secrets.required).toEqual(['STRIPE_SECRET_KEY', 'DATABASE_URL'])
  })

  it('appends to an existing list, one-line or multi-line', () => {
    expect(declared('wrangler.jsonc', '{ "secrets": { "required": ["API_KEY"] } }')).toBe('{ "secrets": { "required": ["API_KEY", "STRIPE_SECRET_KEY", "DATABASE_URL"] } }')
    const multi = '{\n  "secrets": {\n    "required": [\n      "API_KEY", // the old one\n    ],\n  },\n}\n'
    const after = declared('wrangler.jsonc', multi)
    expect(after).toBe('{\n  "secrets": {\n    "required": [\n      "API_KEY", // the old one\n      "STRIPE_SECRET_KEY",\n      "DATABASE_URL",\n    ],\n  },\n}\n')
    expect(required(after)).toEqual(['API_KEY', 'STRIPE_SECRET_KEY', 'DATABASE_URL'])
  })

  it('fills an empty list, or a secrets object without one', () => {
    expect(required(declared('wrangler.jsonc', '{ "secrets": { "required": [] } }'))).toEqual(['STRIPE_SECRET_KEY', 'DATABASE_URL'])
    const after = declared('wrangler.jsonc', '{\n  "secrets": {\n    // later\n  }\n}\n')
    expect(after).toBe('{\n  "secrets": {\n    "required": ["STRIPE_SECRET_KEY", "DATABASE_URL"]\n  }\n}\n')
  })

  it('appends a [secrets] table to wrangler.toml', () => {
    const before = 'name = "w"\nmain = "src/index.js"\n\n[vars]\nPLAIN = "1"\n'
    expect(declared('wrangler.toml', before)).toBe(`${before}\n[secrets]\nrequired = ["STRIPE_SECRET_KEY", "DATABASE_URL"]\n`)
  })
})

describe('planning the secrets', () => {
  const plan = (file: string, text: string, names = ['STRIPE_SECRET_KEY', 'DATABASE_URL']) => {
    const dir = tempDir()
    writeFileSync(join(dir, file), text)
    expect(findWranglerConfig(dir)).toBe(file)
    return planSecrets(dir, file, names)
  }

  it('lists only the missing names, and env sections without their own secrets', () => {
    const text = '{ "secrets": { "required": ["STRIPE_SECRET_KEY"] }, "env": { "staging": {}, "production": { "secrets": { "required": [] } } } }'
    expect(plan('wrangler.jsonc', text)).toEqual({ kind: 'add', missing: ['DATABASE_URL'], envs: ['staging'] })
    expect(plan('wrangler.jsonc', text, ['STRIPE_SECRET_KEY'])).toEqual({ kind: 'current', envs: ['staging'] })
  })

  it("leaves a config that doesn't parse, or has an odd secrets field, alone", () => {
    expect(plan('wrangler.jsonc', '{ "name": "w", ').kind).toBe('invalid')
    expect(plan('wrangler.json', '{ "secrets": ["X"] }').kind).toBe('invalid')
  })

  it('reads a TOML secrets table, and leaves editing it to the user', () => {
    const text = 'name = "w"\n\n[secrets]\nrequired = [\n  "STRIPE_SECRET_KEY",\n]\n\n[env.staging]\nname = "w-staging"\n'
    expect(plan('wrangler.toml', text)).toEqual({ kind: 'manual', missing: ['DATABASE_URL'], envs: ['staging'] })
    expect(plan('wrangler.toml', text, ['STRIPE_SECRET_KEY'])).toEqual({ kind: 'current', envs: ['staging'] })
    expect(plan('wrangler.toml', 'name = "w"\nsecrets = { required = ["STRIPE_SECRET_KEY"] }\n', ['STRIPE_SECRET_KEY']).kind).toBe('current')
    expect(plan('wrangler.toml', 'name = "w"\n').kind).toBe('add')
  })

  it('finds the config the way Wrangler does: json, then jsonc, then toml', () => {
    const dir = tempDir()
    expect(findWranglerConfig(dir)).toBeNull()
    writeFileSync(join(dir, 'wrangler.toml'), '')
    writeFileSync(join(dir, 'wrangler.jsonc'), '{}')
    expect(findWranglerConfig(dir)).toBe('wrangler.jsonc')
  })
})

describe('isBuildScript', () => {
  it.each([
    ['astro build', true],
    ['npx vite build --mode staging', true],
    ['node build', false],
    ['react-router build', true],
    ['astro dev', false],
    ['vite', false],
    ['tsc && vite build', false],
    ['wrangler deploy', false],
    ['esbuild build', false],
  ])('%s → %s', (script, expected) => {
    expect(isBuildScript(script)).toBe(expected)
  })
})
