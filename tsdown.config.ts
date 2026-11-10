import { defineConfig } from 'tsdown'

// Dependencies stay external: the keychain binding is native, and the rest are small.
const deps = { neverBundle: [/^@napi-rs\/keyring/, 'cross-spawn', /^@clack\//] }

export default defineConfig([
  {
    entry: {
      cli: 'src/cli.ts',
      index: 'src/index.ts',
      guard: 'src/guard-entry.ts',
      register: 'src/register-entry.ts',
      'register-helper': 'src/register-helper.ts',
    },
    format: 'esm',
    platform: 'node',
    target: 'node24',
    dts: { entry: ['src/index.ts', 'src/register-entry.ts'] },
    clean: true,
    deps,
  },
  {
    // `require('@bremmdev/arca-env/register')`. Its own bundle: CommonJS can't share ESM chunks.
    entry: { register: 'src/register-cjs.ts' },
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    dts: true,
    clean: false,
    deps,
  },
])
