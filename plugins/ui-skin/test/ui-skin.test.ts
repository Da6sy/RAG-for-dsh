/**
 * ui-skin pure-logic tests: config normalization, contrast arithmetic, the
 * surface plan's readability guard, and the selector audit.
 *
 * The browser surfaces split their math into React-free modules precisely so
 * the house runner (node --test with strip-types, no jsdom) can pin it. The
 * built bundle and the real shell are proven one level up by the contract
 * test and the browser acceptance pass.
 *
 * @module @clue-harness/ui-skin/test/pure
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWED_CLASS_FRAGMENTS, ALLOWED_CLASS_PREFIXES, ALLOWED_DATA_ATTRIBUTES, auditStylesheet, countImportant, extractSelectors, splitSelectorList,
} from '../src/audit.ts'
import {
  backdropEndpoints, composite, contrastRatio, minAlphaForContrast, parseColor,
} from '../src/contrast.ts'
import { computeSurfacePlan } from '../src/plan.ts'
import {
  BG_KINDS, DEFAULT_SETTINGS, GLASS_PRESETS, IMAGE_MAX_BYTES, PRESETS, SETTINGS_NS, THEME_FALLBACK,
  cssPosition, cssSize, normalizeHex, normalizeSettings, presetOf, presetVariant, resolveMaskColor, validRemoteUrl,
} from '../src/skin-config.ts'
import { SKIN_SHEET } from '../src/client/styles.ts'
import { Config } from '../src/index.ts'

test('normalizeSettings: empty/foreign sections land on the documented defaults', () => {
  assert.deepEqual(normalizeSettings({}), { ...DEFAULT_SETTINGS })
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS })
  assert.deepEqual(normalizeSettings('nope'), { ...DEFAULT_SETTINGS })
  assert.equal(normalizeSettings({ bgKind: 'weird' }).bgKind, 'none')
  assert.equal(normalizeSettings({ bgFit: 'stretch' }).bgFit, 'cover')
  assert.equal(normalizeSettings({ bgPosition: 'middle' }).bgPosition, 'center')
  assert.equal(normalizeSettings({ perfMode: 'turbo' }).perfMode, 'auto')
  assert.equal(normalizeSettings({ bgPreset: 'neon' }).bgPreset, 'aurora')
})

test('normalizeSettings: every numeric knob is clamped into its documented range', () => {
  assert.equal(normalizeSettings({ maskOpacity: 4 }).maskOpacity, 0.9)
  assert.equal(normalizeSettings({ maskOpacity: -1 }).maskOpacity, 0)
  assert.equal(normalizeSettings({ glassStrength: 9 }).glassStrength, 1)
  assert.equal(normalizeSettings({ bubbleIntensity: Number.NaN }).bubbleIntensity, DEFAULT_SETTINGS.bubbleIntensity)
  assert.equal(normalizeSettings({ bgBlur: 99 }).bgBlur, 24)
  assert.equal(normalizeSettings({ bgBlur: -3 }).bgBlur, 0)
  assert.equal(normalizeSettings({ glassBlur: 99 }).glassBlur, 24)
  assert.equal(normalizeSettings({ glassBlur: -1 }).glassBlur, 0)
  assert.equal(normalizeSettings({ glassPanels: 'yes' }).glassPanels, true)
})

test('normalizeSettings: colours canonicalize, remote URLs trim, unknown keys drop', () => {
  assert.equal(normalizeSettings({ maskColor: '#ABC' }).maskColor, '#aabbcc')
  assert.equal(normalizeSettings({ maskColor: '#123456' }).maskColor, '#123456')
  assert.equal(normalizeSettings({ maskColor: 'red' }).maskColor, 'auto')
  assert.equal(normalizeSettings({ maskColor: '#12345' }).maskColor, 'auto')
  assert.equal(normalizeSettings({ bgUrl: '  https://x.test/a.png  ' }).bgUrl, 'https://x.test/a.png')
  assert.equal(normalizeHex('#FFF'), '#ffffff')
  assert.equal(normalizeHex('#ffff'), undefined)
})

test('the one-click glass presets stay inside the documented ranges', () => {
  assert.deepEqual(GLASS_PRESETS.map(preset => preset.id), ['clear', 'balanced', 'frosted'])
  for (const preset of GLASS_PRESETS) {
    assert.ok(preset.strength >= 0 && preset.strength <= 1)
    assert.ok(preset.blur >= 0 && preset.blur <= 24)
  }
  assert.ok(GLASS_PRESETS[0]!.blur <= 4, 'clear must be nearly unblurred')
})

test('the Host schema defaults equal the renderer defaults (one source of truth)', () => {
  const resolved = Config({}) as unknown as Record<string, { get: () => unknown } | undefined>
  for (const [key, expected] of Object.entries(DEFAULT_SETTINGS)) {
    const slot = resolved[key]
    assert.ok(slot !== undefined && typeof slot.get === 'function', `schema lost field ${key}`)
    assert.deepEqual(slot.get(), expected, `schema default drifted for ${key}`)
  }
  assert.deepEqual(Object.keys(resolved).sort(), Object.keys(DEFAULT_SETTINGS).sort())
  // The id the browser half asks settings for must stay a legal namespace.
  assert.match(SETTINGS_NS, /^[a-z][a-z0-9-]*$/)
})

test('mask colour resolution: auto follows the scheme, a custom hex wins', () => {
  const auto = { ...DEFAULT_SETTINGS, maskColor: 'auto' }
  assert.equal(resolveMaskColor(auto, 'light'), '#f2f4f8')
  assert.equal(resolveMaskColor(auto, 'dark'), '#0a0f18')
  assert.equal(resolveMaskColor({ ...auto, maskColor: '#123456' }, 'dark'), '#123456')
})

test('presets: three, each with a light and a dark variant that differ', () => {
  assert.deepEqual(PRESETS.map(preset => preset.id), ['aurora', 'dusk', 'mist'])
  for (const preset of PRESETS) {
    assert.ok(preset.light.image.length > 40)
    assert.ok(preset.dark.image.length > 40)
    assert.notEqual(preset.light.image, preset.dark.image)
    assert.ok(preset.light.grey > 200, `${preset.id} light grey`)
    assert.ok(preset.dark.grey < 60, `${preset.id} dark grey`)
    assert.equal(presetVariant(preset, 'dark'), preset.dark)
  }
  assert.equal(presetOf('mist').label, '雾海')
  assert.equal(presetOf('nope' as never).id, 'aurora')
})

test('css helpers: positions, fit modes, closed enums, URL validation', () => {
  assert.equal(cssPosition('top-left'), 'left top')
  assert.equal(cssPosition('bottom-right'), 'right bottom')
  assert.equal(cssPosition('center'), 'center center')
  assert.equal(cssSize('contain'), 'contain')
  assert.equal(cssSize('auto'), 'auto')
  assert.deepEqual([...BG_KINDS], ['none', 'preset', 'image', 'url'])
  assert.equal(validRemoteUrl('https://x.test/a.jpg'), true)
  assert.equal(validRemoteUrl('http://x.test/a.jpg'), true)
  assert.equal(validRemoteUrl('javascript:alert(1)'), false)
  assert.equal(validRemoteUrl('file:///tmp/a.png'), false)
  assert.equal(validRemoteUrl('not a url'), false)
  assert.equal(IMAGE_MAX_BYTES, 8 * 1024 * 1024)
})

test('contrast: WCAG extremes, compositing and parsing', () => {
  const black = { r: 0, g: 0, b: 0 }
  const white = { r: 255, g: 255, b: 255 }
  assert.equal(Math.round(contrastRatio(black, white)), 21)
  assert.equal(contrastRatio(white, white), 1)
  assert.deepEqual(composite(white, 0.5, black), { r: 128, g: 128, b: 128 })
  assert.deepEqual(composite(white, 0, black), black)
  assert.deepEqual(parseColor('#0f1115'), { r: 15, g: 17, b: 21 })
  assert.deepEqual(parseColor('#abc'), { r: 170, g: 187, b: 204 })
  assert.deepEqual(parseColor('rgb(1 2 3)'), { r: 1, g: 2, b: 3 })
  assert.deepEqual(parseColor('rgba(4, 5, 6, 0.4)'), { r: 4, g: 5, b: 6 })
  assert.equal(parseColor('currentColor'), undefined)
  // A mid grey can never carry near-white text, even fully opaque.
  assert.equal(minAlphaForContrast({ r: 128, g: 128, b: 128 }, { r: 245, g: 245, b: 245 }, black), 1)
})

test('contrast guard: the alpha search is allowed below 0.60 when the backdrop is friendly', () => {
  const white = { r: 255, g: 255, b: 255 }
  const text = { r: 15, g: 17, b: 21 }
  const backdrop = { r: 200, g: 200, b: 200 }
  const alpha = minAlphaForContrast(white, text, backdrop)
  assert.ok(alpha < 0.6, `expected a sub-0.60 floor, got ${alpha}`)
  assert.ok(contrastRatio(composite(white, alpha, backdrop), text) >= 4.5)
})

test('backdrop endpoints: scrim pulls the wallpaper range toward its own colour', () => {
  const black = { r: 0, g: 0, b: 0 }
  const [lo, hi] = backdropEndpoints(128, black, 0.5, 32)
  assert.ok(hi.r > lo.r)
  assert.ok(lo.r < 128 && hi.r < 128, 'a black scrim darkens both endpoints')
  const [loClear, hiClear] = backdropEndpoints(128, black, 0, 32)
  assert.equal(loClear.r, 96)
  assert.equal(hiClear.r, 160)
})

test('surface plan: defaults pass 4.5:1 with glass-transparent surfaces', () => {
  const plan = computeSurfacePlan({
    settings: { ...DEFAULT_SETTINGS },
    theme: 'dark',
    surface: parseColor(THEME_FALLBACK.dark.surface)!,
    text: parseColor(THEME_FALLBACK.dark.text)!,
    averageGrey: 60,
  })
  assert.equal(plan.ok, true)
  assert.ok(plan.baseAlpha >= 0.5 && plan.baseAlpha <= 1)
  assert.ok(plan.baseAlpha < 0.86, 'default strength makes the surface genuinely translucent')
  assert.ok(plan.sidebarAlpha <= plan.baseAlpha, 'the sidebar is the airier panel')
  assert.ok(plan.dialogAlpha >= plan.baseAlpha, 'the settings page is the more solid panel')
  assert.ok(plan.terminalAlpha > plan.baseAlpha, 'terminal/document keep a slightly stronger tint')
  assert.ok(plan.terminalAlpha <= 0.92)
  assert.ok(plan.minContrast >= 4.5)
})

test('surface plan: the guard raises alpha over a blown-out wallpaper', () => {
  const bright = computeSurfacePlan({
    settings: { ...DEFAULT_SETTINGS, glassStrength: 1, maskOpacity: 0 },
    theme: 'dark',
    surface: parseColor(THEME_FALLBACK.dark.surface)!,
    text: parseColor(THEME_FALLBACK.dark.text)!,
    averageGrey: 255,
  })
  assert.ok(bright.baseAlpha > 0.6, `guard should lift 0.60, got ${bright.baseAlpha}`)
  assert.ok(bright.minContrast >= 4.5)
  // Same recipe over a normal photo keeps the deeper, prettier alpha.
  const normal = computeSurfacePlan({
    settings: { ...DEFAULT_SETTINGS, glassStrength: 1 },
    theme: 'dark',
    surface: parseColor(THEME_FALLBACK.dark.surface)!,
    text: parseColor(THEME_FALLBACK.dark.text)!,
    averageGrey: 70,
  })
  assert.ok(normal.baseAlpha < bright.baseAlpha)
})

test('surface plan: perf.low keeps the glass language but caps its transparency', () => {
  const args = {
    theme: 'light' as const,
    surface: parseColor(THEME_FALLBACK.light.surface)!,
    text: parseColor(THEME_FALLBACK.light.text)!,
    averageGrey: 200,
  }
  const auto = computeSurfacePlan({ ...args, settings: { ...DEFAULT_SETTINGS } })
  const low = computeSurfacePlan({ ...args, settings: { ...DEFAULT_SETTINGS, perfMode: 'low' } })
  assert.ok(low.baseAlpha > auto.baseAlpha, 'low-power surfaces are more solid')
  assert.ok(low.baseAlpha < 0.9, 'low-power still renders translucency, not a flat panel')
})

test('surface plan: light scheme and readability-off stay in contract', () => {
  const light = computeSurfacePlan({
    settings: { ...DEFAULT_SETTINGS, bubbleReadability: false, bubbleIntensity: 1 },
    theme: 'light',
    surface: parseColor(THEME_FALLBACK.light.surface)!,
    text: parseColor(THEME_FALLBACK.light.text)!,
    averageGrey: 240,
  })
  assert.ok(light.baseAlpha <= 1)
  assert.ok(light.bubbleAlpha < light.baseAlpha, 'bubbles sit in front of the conversation surface')
  assert.ok(light.bubbleContrast > 4.5, 'light glass is friendly to dark text')
})

test('selector audit: the shipped sheet is clean; !important is xterm + the Windows caption probe', () => {
  assert.deepEqual(auditStylesheet(SKIN_SHEET), [])
  // xterm writes its theme background as an INLINE style; only !important can
  // clear it. The second one overrides the Windows desktop preload's caption
  // probe, whose colour is also an inline style read by setTitleBarOverlay.
  assert.equal(countImportant(SKIN_SHEET), 2)
  const selectors = extractSelectors(SKIN_SHEET)
  assert.ok(selectors.length > 40, 'the sheet was parsed')
  assert.ok(selectors.some(selector => selector.includes('data-conversation-content')))
  assert.ok(selectors.some(selector => selector.includes('data-shortcut-modal')))
  assert.ok(selectors.some(selector => selector.includes('cl-xs-preview')))
})

test('selector audit: every forbidden pattern is actually caught', () => {
  const bad = [
    '.a1b2c3 { color: red }',
    'div > div > div > div { color: red }',
    '[data-not-a-hook] { color: red }',
    '[class*="hashed_1"] { color: red }',
    ':nth-child(3) { color: red }',
    '#not-root { color: red }',
    '.cl-xs-x:hover { color: red }',
  ].join('\n')
  const violations = auditStylesheet(bad)
  assert.ok(violations.length >= 6, `expected each pattern to be reported, got ${String(violations.length)}`)
  assert.ok(violations.some(v => v.rule.includes('not an allowed stable class')))
  assert.ok(violations.some(v => v.rule.includes('direct-child hops')))
  assert.ok(violations.some(v => v.rule.includes('W0 allowlist')))
  assert.ok(violations.some(v => v.rule.includes('class fragment')))
  assert.ok(violations.some(v => v.rule.includes('positional')))
  assert.ok(violations.some(v => v.rule.includes('stable hook')))
})

test('frost stays off ancestors of fixed UI (Windows controls, KB drawer, dock floats)', () => {
  const rules = [...SKIN_SHEET.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selectors: selector.split(',').map(s => s.trim()), body }))
  const bodiesFor = (selector: string) => rules.filter(rule => rule.selectors.some(s => s.endsWith(selector))).map(rule => rule.body)
  // Browser-only regression from the Windows client: a filtered ancestor turns
  // position:fixed buttons/drawers into descendants of that ancestor's box.
  for (const selector of [
    "#root [data-slot='root'] > div > div:has(> [data-slot='sidebar'])",
    'header[data-window-drag]',
    '[data-rightbar-col]',
  ]) {
    for (const body of bodiesFor(selector)) {
      assert.ok(!/backdrop-filter/.test(body), `${selector} must not be a filtered containing block: ${body}`)
    }
  }
  // The sidebar still frosts, but on a sibling pseudo layer, not the buttons' ancestor.
  assert.ok(bodiesFor("#root [data-slot='root'] > div > div:has(> [data-slot='sidebar'])::before").some(body => /backdrop-filter/.test(body)))
  // The right dock frosts panes, not the container that hosts fixed floats.
  assert.ok(bodiesFor('[data-dockkit-pane]').some(body => /backdrop-filter/.test(body)))
})

test('the frame track transition is pre-armed, not left to the shell effect timing', () => {
  assert.ok(SKIN_SHEET.includes('data-cl-xs-track-animating'))
  assert.ok(SKIN_SHEET.includes('transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out)'))
})

test('the Windows centre corner gets a masked glass patch', () => {
  assert.ok(SKIN_SHEET.includes('--cl-xs-center-left'))
  assert.ok(SKIN_SHEET.includes('radial-gradient(circle var(--dsh-windows-content-radius'))
})

test('selector audit: xterm public classes are an explicit, documented exception', () => {
  assert.deepEqual(auditStylesheet('.xterm-scrollable-element { background-color: transparent !important }'), [])
  assert.ok(ALLOWED_CLASS_PREFIXES.includes('xterm'))
  assert.ok(ALLOWED_DATA_ATTRIBUTES.includes('document-preview'))
})

test('selector audit: at-rules are parsed but never treated as selectors', () => {
  const sheet = '@media (min-width: 1px) { .cl-xs-a { color: red } }\n@supports (display: grid) { [data-cl-xs-on] { color: red } }'
  const selectors = extractSelectors(sheet)
  assert.ok(selectors.includes('.cl-xs-a'))
  assert.ok(selectors.includes('[data-cl-xs-on]'))
  assert.ok(!selectors.some(selector => selector.startsWith('@')))
  assert.deepEqual(splitSelectorList('.a, :is(.b, .c)'), ['.a', ':is(.b, .c)'])
  assert.ok(ALLOWED_CLASS_FRAGMENTS.includes('bubble'))
  assert.ok(ALLOWED_DATA_ATTRIBUTES.includes('conversation-content'))
  assert.ok(ALLOWED_DATA_ATTRIBUTES.includes('dockkit-pane'))
})
