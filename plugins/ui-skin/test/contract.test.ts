/**
 * ui-skin contract tests against the INSTALLED dsh client bundles.
 *
 * The skin's whole selector strategy rests on facts that live upstream: the
 * semantic `data-*` hooks, the bubble's CSS-module local name (the one
 * documented fallback), the palette attribute, and the settings namespace
 * mechanism. This test reads the shipped client bundles the way the browser
 * will receive them, so an upstream upgrade that renames a hook fails here
 * instead of silently un-skinning a surface.
 *
 * It also pins the plugin's own wiring: the dual-face package declaration,
 * the entry id that doubles as the settings namespace, and the built bundle's
 * module-loader shape.
 *
 * @module @clue-harness/ui-skin/test/contract
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKIN_SHEET } from '../src/client/styles.ts'
import { extractSelectors, splitSelectorList } from '../src/audit.ts'
import { SETTINGS_NS } from '../src/skin-config.ts'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')

/** Resolve an installed dsh client package's directory. */
function packageOf(name: string): string {
  return dirname(require.resolve(`${name}/package.json`))
}

/**
 * Concatenate every client chunk of a package. dsh ships lazy chunks as
 * `lib/client.<area>.js` (the terminal body is one), and the hook may live in
 * either the main bundle or a chunk.
 */
function clientSource(name: string): string {
  const dir = join(packageOf(name), 'lib')
  const chunks = readdirSync(dir).filter(entry => /^client\..+\.js$/.test(entry) || entry === 'client.js')
  assert.ok(chunks.length > 0, `${name} has no client bundle`)
  return chunks.map(chunk => readFileSync(join(dir, chunk), 'utf8')).join('\n')
}

/** One hook the stylesheet depends on and the module that must keep it. */
const HOOKS: readonly { module: string; needle: string; label: string }[] = [
  { module: '@deepseek-ai/dsh-client-ui-chat', needle: 'data-chat-flow-kind', label: 'chat row kind' },
  { module: '@deepseek-ai/dsh-client-ui-chat', needle: 'data-submission-echo', label: 'submission echo row' },
  { module: '@deepseek-ai/dsh-client-ui-chat', needle: 'data-pending-steering', label: 'pending steering row' },
  { module: '@deepseek-ai/dsh-client-ui-settings-general', needle: 'data-shortcut-modal', label: 'settings modal' },
  { module: '@deepseek-ai/dsh-client-ui-conversation', needle: 'data-conversation-content', label: 'conversation surface' },
  { module: '@deepseek-ai/dsh-client-ui-conversation', needle: 'data-composer-card', label: 'composer card' },
  { module: '@deepseek-ai/dsh-client-ui-conversation', needle: 'data-window-drag', label: 'conversation header drag mark' },
  { module: '@deepseek-ai/dsh-client-ui-sidebar-right', needle: 'data-dockkit-pane', label: 'dock pane' },
  { module: '@deepseek-ai/dsh-client-ui-sidebar-right', needle: 'data-dockkit-float', label: 'floating window' },
  { module: '@deepseek-ai/dsh-client-ui-layout', needle: 'data-rightbar-col', label: 'right column' },
  { module: '@deepseek-ai/dsh-client-ui-layout', needle: 'data-ds-dark-theme', label: 'dark palette attribute' },
  { module: '@deepseek-ai/dsh-client-ui-renderer', needle: 'data-slot', label: 'slot wrapper' },
  { module: '@deepseek-ai/dsh-client-ui-sidebar-terminal', needle: 'data-sidebar-terminal', label: 'terminal container' },
  { module: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', needle: 'data-document-preview', label: 'file preview surface' },
  { module: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', needle: 'data-document-markdown', label: 'markdown preview surface' },
]

test('shell hooks the stylesheet relies on still exist in the installed bundles', () => {
  for (const hook of HOOKS) {
    const source = clientSource(hook.module)
    assert.ok(source.includes(hook.needle), `${hook.label} (${hook.needle}) vanished from ${hook.module}`)
  }
})

test('the bubble fallback class name is still a CSS-module local name', () => {
  const chat = clientSource('@deepseek-ai/dsh-client-ui-chat')
  // The build prefixes a per-package hash: `.Sixlwa_bubble` today, any hash
  // tomorrow — what matters is the stable LOCAL part our [class*="bubble"]
  // selector matches.
  assert.match(chat, /\.\w+_bubble\b/, 'the user bubble local class name changed')
  assert.match(chat, /\.\w+_userRow\b/, 'the bubble row local class name changed')
})

test('xterm keeps the DOM renderer whose inline background the sheet overrides', () => {
  const terminalPackage = packageOf('@deepseek-ai/dsh-client-ui-sidebar-terminal')
  const manifest = JSON.parse(readFileSync(join(terminalPackage, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  // A canvas addon would paint pixels into a canvas and make the CSS override
  // impossible; the glass terminal relies on xterm 6's DOM renderer.
  assert.equal(manifest.dependencies?.['@xterm/addon-canvas'], undefined)
  assert.equal(manifest.peerDependencies?.['@xterm/addon-canvas'], undefined)
  const terminal = clientSource('@deepseek-ai/dsh-client-ui-sidebar-terminal')
  assert.ok(terminal.includes('xterm-scrollable-element'), 'xterm lost the element that carries the theme background')
  assert.ok(terminal.includes('xterm-dom-renderer-owner'), 'xterm no longer bundles the DOM renderer')
})

test('the stylesheet only keys on hooks this test actually covers', () => {
  const covered = new Set(HOOKS.map(hook => hook.needle))
  const attributes = new Set<string>()
  for (const rule of extractSelectors(SKIN_SHEET)) {
    for (const selector of splitSelectorList(rule)) {
      for (const match of selector.matchAll(/\[(data-[a-z0-9-]+)/g)) {
        const name = match[1]!
        if (name.startsWith('data-cl-xs-')) continue
        attributes.add(name)
      }
    }
  }
  for (const attribute of attributes) {
    assert.ok(covered.has(attribute), `selector uses ${attribute}, but no contract hook asserts it exists upstream`)
  }
})

test('the plugin declares both faces and installs as a bundle', () => {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    name: string
    exports: Record<string, string>
    dsh: { bundle?: { patch?: string }; client?: { platform?: string; inject?: string[] } }
  }
  assert.equal(pkg.name, '@clue-harness/ui-skin')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.client?.platform, 'web')
  assert.deepEqual(pkg.dsh.client?.inject, ['@deepseek-ai/dsh-client-ui-settings'])
  assert.equal(pkg.dsh.bundle?.patch, './cordis.patch.yml')
  // The cordis row id IS the settings namespace the browser asks for.
  const patch = readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, new RegExp(`id:\\s*${SETTINGS_NS}\\b`))
  assert.match(patch, /name:\s*'@clue-harness\/ui-skin'/)
})

test('the built bundle keeps the module-loader artifact shape', () => {
  const artifact = join(packageDir, 'lib', 'client.js')
  if (!existsSync(artifact)) {
    // `npm run build:ui` owns the artifact; a checkout that has not built yet
    // should not fail the logic suite.
    return
  }
  const text = readFileSync(artifact, 'utf8')
  assert.ok(text.includes('__ModuleLoader__.load'), 'missing module-loader banner')
  assert.ok(text.includes('@clue-harness/ui-skin'), 'module id missing')
  assert.ok(text.includes('clue-ui-skin'), 'the style tag id must ship')
  // The stylesheet is injected from this artifact rather than a build-time CSS
  // file: the plugin needs it to ride the fiber (removable at runtime).
  assert.ok(text.includes('clue-ui-skin'))
})
