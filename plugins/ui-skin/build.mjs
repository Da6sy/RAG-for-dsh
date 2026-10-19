/**
 * The ui-skin browser bundle build (esbuild).
 *
 * Artifact contract — byte-for-byte the shape dsh's own published client
 * bundles carry (and the same shape @clue-harness/ui-kb builds): a CJS closure
 * factory handed to `window.__ModuleLoader__.load`, externals resolved through
 * the module table's `require`, everything else inlined. The client-modules
 * node half serves this file at `/plugins/@clue-harness/ui-skin/client.js`
 * and lists it in `__DSH_BOOT__`.
 *
 * Externals are exactly the dsh client baseline (web/src/platform.ts):
 * PLATFORM_MODULES (react family, cordis, ui-slots, ui-primitives) plus the
 * preloaded runtime row. Type-only imports erase before bundling, so the
 * slot-contract packages (ui-settings/ui-renderer) create no module request.
 *
 * Run: `npm run build:ui` (repo root) or `node build.mjs` here.
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

/** The module-table id (the package name — client-modules keys by it). */
const ID = '@clue-harness/ui-skin'

const pkgDir = fileURLToPath(new URL('.', import.meta.url))

await build({
  absWorkingDir: pkgDir,
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'react',
  // The dsh client baseline: shell-seeded platform modules + the preloaded
  // runtime factory. A require() the table cannot answer throws at boot, so
  // anything NOT listed here must inline (esbuild's default for non-external).
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  // Browser bundles inline node-idiom deps that read process.env.NODE_ENV
  // (react's cjs branches); the artifacts default to production, matching
  // dsh's own client build defines.
  define: { 'process.env.NODE_ENV': '"production"' },
  // The module-loader handoff wrapper (dsh tsdown preset's banner/intro/footer).
  banner: {
    js: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(ID)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;`,
  },
  footer: { js: '\t\treturn module.exports;\n\t}\n});' },
  sourcemap: 'linked',
  logLevel: 'info',
})

console.log(`built ${ID} → lib/client.js`)
