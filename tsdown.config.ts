import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { cli: 'src/cli.ts', index: 'src/index.ts', guard: 'src/guard-entry.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: { entry: 'src/index.ts' },
  clean: true,
  // Dependencies stay external: the keychain binding is native, and the rest are small.
  deps: { neverBundle: [/^@napi-rs\/keyring/, 'cross-spawn', /^@clack\//] },
})
