/**
 * Selector-contract audit for the skin stylesheet.
 *
 * The design forbids hash class names and deep structural selectors because
 * both turn silently wrong after an upstream build (`§3.2 禁止清单`). This
 * module is the executable form of that rule: it extracts every selector from
 * the sheet (including rules nested in `@media`/`@supports`) and reports any
 * selector that leaves the four allowed stable surfaces.
 *
 * Kept pure so the house runner (`node --test`, no browser) can pin it.
 *
 * @module @clue-harness/ui-skin/audit
 */

/**
 * Shell attributes the sheet may key on. Each one is documented in the W0
 * appendix (docs/设计规划_前端UI美化插件.md) with the source file:line that
 * writes it. Plugin-owned `data-cl-xs-*` attributes are allowed by prefix.
 */
export const ALLOWED_DATA_ATTRIBUTES: readonly string[] = Object.freeze([
  // theme palette selector (ui-layout theme-presenter)
  'ds-dark-theme',
  // renderer slot wrappers; the frame/sidebar/center sit inside `root`/`sidebar`
  'slot',
  // layout frame / columns
  'rightbar-col',
  'shell-overlay',
  'window-drag',
  'platform',
  'windows-titlebar',
  // conversation surface
  'conversation-content',
  'composer-card',
  'chat-flow-kind',
  'submission-echo',
  'pending-steering',
  // dock surfaces
  'dockkit-pane',
  'dockkit-float',
  'dockkit-host',
  'dockkit-empty',
  'dockkit-divider',
  'animating',
  // settings modal + terminal + file viewer
  'shortcut-modal',
  'sidebar-terminal',
  'document-preview',
  'document-markdown',
])

/** Class-name fragments the bubble fallback may match (the one documented exception). */
export const ALLOWED_CLASS_FRAGMENTS: readonly string[] = Object.freeze(['bubble', 'userRow'])

/** The plugin's own class prefix. */
export const CLASS_PREFIX = 'cl-xs-'

/**
 * Third-party public DOM classes the sheet may target. xterm's DOM renderer
 * writes the theme background as an inline style on `.xterm-scrollable-element`,
 * so making the terminal see-through requires a class selector on xterm's
 * documented structure (not a dsh CSS-module hash). The contract test pins the
 * class name in the installed terminal chunk.
 */
export const ALLOWED_CLASS_PREFIXES: readonly string[] = Object.freeze([CLASS_PREFIX, 'xterm'])

/** One selector violation. */
export interface AuditViolation {
  selector: string
  rule: string
}

/** Remove CSS comments. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Remove `@keyframes` blocks entirely (their steps are not selectors). */
function stripKeyframes(css: string): string {
  let out = ''
  let index = 0
  while (index < css.length) {
    const start = css.indexOf('@keyframes', index)
    if (start === -1) { out += css.slice(index); break }
    out += css.slice(index, start)
    const open = css.indexOf('{', start)
    if (open === -1) break
    let depth = 0
    let end = open
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1
      else if (css[end] === '}') {
        depth -= 1
        if (depth === 0) { end += 1; break }
      }
    }
    index = end
  }
  return out
}

/**
 * Extract selector preludes (the text before each `{`) that are not at-rules.
 * @param css - the stylesheet text.
 * @returns one entry per rule, comments and at-rule preludes removed.
 */
export function extractSelectors(css: string): string[] {
  const text = stripKeyframes(stripComments(css))
  const selectors: string[] = []
  let buffer = ''
  let depth = 0
  for (const char of text) {
    if (char === '{') {
      const prelude = buffer.trim()
      if (prelude !== '' && !prelude.startsWith('@')) selectors.push(prelude)
      buffer = ''
      depth += 1
    } else if (char === '}') {
      buffer = ''
      depth = Math.max(0, depth - 1)
    } else if (char === ';' && depth === 0) {
      buffer = ''
    } else {
      buffer += char
    }
  }
  return selectors
}

/** Split one selector list on top-level commas (parens/brackets aware). */
export function splitSelectorList(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let buffer = ''
  for (const char of list) {
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      parts.push(buffer.trim())
      buffer = ''
    } else {
      buffer += char
    }
  }
  if (buffer.trim() !== '') parts.push(buffer.trim())
  return parts
}

/** The allowed structural pseudo-classes (a single positional reference, not a chain). */
const ALLOWED_STRUCTURAL = /^:(first-child|last-child|first-of-type|last-of-type)$/

/** Count direct-child combinators OUTSIDE functional pseudo-classes. */
function topLevelChildHops(selector: string): number {
  let depth = 0
  let hops = 0
  for (const char of selector) {
    if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    else if (char === '>' && depth === 0) hops += 1
  }
  return hops
}

/**
 * Audit one stylesheet against the design's selector contract.
 * @param css - the stylesheet source (template text; escapes are resolved by TS).
 * @returns every violation, empty when the sheet is clean.
 */
export function auditStylesheet(css: string): AuditViolation[] {
  const violations: AuditViolation[] = []
  for (const rule of extractSelectors(css)) {
    for (const selector of splitSelectorList(rule)) {
      const report = (message: string): void => { violations.push({ selector, rule: message }) }

      // Hash-free classes only: our own prefix or nothing.
      for (const match of selector.matchAll(/(^|[\s>+~(])\.(-?[_a-zA-Z][\w-]*)/g)) {
        const name = match[2]!
        if (!ALLOWED_CLASS_PREFIXES.some(prefix => name.startsWith(prefix))) report(`class ".${name}" is not an allowed stable class`)
      }
      // Any class selector not preceded by the allowed delimiters (e.g. after
      // `:is(` or `:where(`) is caught by the broader scan below.
      for (const match of selector.matchAll(/(?<![\w-])(?:\.)(-?[_a-zA-Z][\w-]*)/g)) {
        const name = match[1]!
        if (!ALLOWED_CLASS_PREFIXES.some(prefix => name.startsWith(prefix))) report(`class ".${name}" is not an allowed stable class`)
      }

      // IDs: only the shell's stable mount point.
      for (const match of selector.matchAll(/#(-?[_a-zA-Z][\w-]*)/g)) {
        if (match[1] !== 'root') report(`id "#${match[1]!}" is not a stable hook`)
      }

      // data-* attributes: the documented allowlist (or our own prefix).
      for (const match of selector.matchAll(/\[(data-[a-z0-9-]+)/g)) {
        const attr = match[1]!.slice('data-'.length)
        if (!attr.startsWith('cl-xs-') && !ALLOWED_DATA_ATTRIBUTES.includes(attr)) {
          report(`data attribute "data-${attr}" is not in the W0 allowlist`)
        }
      }

      // The single class-fragment fallback: only the documented bubble names.
      for (const match of selector.matchAll(/\[class[*^$]=['"]?([^'"\]]*)['"]?\]/g)) {
        const fragment = match[1]!
        if (!ALLOWED_CLASS_FRAGMENTS.includes(fragment)) {
          report(`class fragment "[class*=${fragment}]" is not the documented bubble fallback`)
        }
      }

      // No positional chains. Pseudo-ELEMENTS (::after, ::-webkit-slider-thumb)
      // are ours to paint and are not part of the selector-vocabulary check.
      const pseudoSelector = selector.replace(/::[a-z-]+/g, '')
      if (/:nth-(child|of-type|last-child|last-of-type)\(/.test(selector)) report('positional :nth-* selectors are forbidden')
      for (const match of pseudoSelector.matchAll(/:(?!:)([a-z-]+)/g)) {
        const pseudo = match[1]!
        if (['first-child', 'last-child', 'first-of-type', 'last-of-type'].includes(pseudo)) continue
        // Pseudo-classes we rely on semantically (state on a stable hook).
        if ([
          'not', 'where', 'is', 'has', 'focus', 'focus-visible', 'hover', 'disabled', 'active',
        ].includes(pseudo)) continue
        if (ALLOWED_STRUCTURAL.test(`:${pseudo}`)) continue
        report(`pseudo-class ":${pseudo}" is not part of the stable surface vocabulary`)
      }

      // Structural depth: at most two direct-child hops from the stable root.
      // Hops inside :has(...) describe the MATCHED element's children, not an
      // extra descent from #root, so only top-level combinators count.
      const childHops = topLevelChildHops(selector)
      if (childHops > 2) report(`selector descends through ${String(childHops)} direct-child hops`)

      // No attribute selectors on anything but data-* (class fragments excepted)
      // or aria state on the plugin's own controls.
      for (const match of selector.matchAll(/\[([a-z-]+)(?:[*^$]?=|\])/g)) {
        const attr = match[1]!
        if (attr === 'class' || attr.startsWith('data-') || attr.startsWith('aria-')) continue
        // The Windows desktop preload's caption probe is a hidden <span> whose
        // inline style carries `--dsw-specific-sidebar-fill`; the caption rule
        // must override that inline value, so this one style attribute is the
        // documented exception. Any other [style] remains forbidden.
        if (attr === 'style' && selector.includes('--dsw-specific-sidebar-fill')) continue
        report(`attribute selector "[${attr}]" is not a stable surface`)
      }
    }
  }
  return violations
}

/** Count `!important` declarations (the sheet is expected to need none). */
export function countImportant(css: string): number {
  return (stripComments(css).match(/!important/g) ?? []).length
}
