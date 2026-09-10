/**
 * Capture normalization (design doc §4.6: the determinism foundation).
 *
 * Everything that could make two captures of the SAME code differ is pinned
 * here, BEFORE extraction runs:
 * - fixed viewport + deviceScaleFactor + colorScheme + reducedMotion (context level, browser.ts);
 * - animations/transitions/caret-blink killed via an init script (runs before
 *   any page script, so page CSS can never win);
 * - a fixed font stack (font availability drifts across machines; the
 *   byte-identical gate is per-machine, but the stack removes in-run drift);
 * - volatile regions masked to a fixed placeholder (timestamps, random ids…);
 * - deterministic pre-capture state: scrolled to top, nothing focused,
 *   fonts loaded, one animation frame settled.
 *
 * @module @clue-harness/evidence-render/normalize
 */
import type { BrowserContext, Page } from 'playwright'

/** Normalization knobs. */
export interface NormalizeConfig {
  /** Selectors whose TEXT is replaced by a fixed placeholder before capture. */
  maskSelectors: string[]
  /** Attribute normalize stamps on masked elements (extractor reads it). */
  maskAttr: string
  /** Forced font stack for html (kills per-run font fallback drift). */
  fontStack: string
  /** Navigation/settle timeout, ms. */
  waitTimeoutMs: number
}

export const DEFAULT_NORMALIZE_CONFIG: NormalizeConfig = {
  maskSelectors: [],
  maskAttr: 'data-clue-masked',
  fontStack: "'Clue Render Fixed', 'DejaVu Sans', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif",
  waitTimeoutMs: 15000,
}

/**
 * The init script source, built once per config. Runs before ANY page script
 * on every navigation, so page stylesheets can never re-enable animation.
 * @param cfg - normalization config.
 * @returns script source for addInitScript.
 */
function buildInitScript(cfg: NormalizeConfig): string {
  // Plain string script (no closures): addInitScript ships it verbatim.
  return [
    '(function () {',
    '  var attach = function () {',
    '    var style = document.createElement("style");',
    '    style.setAttribute("data-clue-normalize", "");',
    '    style.textContent = ' + JSON.stringify(
      '*, *::before, *::after {'
      + 'animation: none !important;'
      + 'animation-delay: 0s !important;'
      + 'transition: none !important;'
      + 'caret-color: transparent !important;'
      + 'scroll-behavior: auto !important;'
      + `} html { font-family: ${cfg.fontStack} !important; }`,
    ) + ';',
    '    (document.head || document.documentElement).appendChild(style);',
    '  };',
    '  if (document.readyState === "loading") {',
    '    document.addEventListener("DOMContentLoaded", attach, { once: true });',
    '  } else { attach(); }',
    '})();',
  ].join('\n')
}

/**
 * Open `url` in a fresh page of `context`, fully normalized and settled.
 * @param context - browser context created with fixed viewport/dpr/scheme.
 * @param url - absolute URL served by our static server (never file://).
 * @param cfg - normalization config.
 * @returns a page in the deterministic pre-capture state.
 */
export async function openNormalized(
  context: BrowserContext,
  url: string,
  cfg: NormalizeConfig = DEFAULT_NORMALIZE_CONFIG,
): Promise<Page> {
  const page = await context.newPage()
  await page.addInitScript(buildInitScript(cfg))
  await page.goto(url, { waitUntil: 'networkidle', timeout: cfg.waitTimeoutMs })

  // Settle: fonts loaded, volatile text masked, scroll at origin, no focus,
  // one frame rendered. Order is part of the contract.
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(
    ({ selectors, maskAttr }: { selectors: string[]; maskAttr: string }) => {
      for (const selector of selectors) {
        for (const el of Array.from(document.querySelectorAll(selector))) {
          el.textContent = '▮'
          el.setAttribute(maskAttr, '')
        }
      }
    },
    { selectors: cfg.maskSelectors, maskAttr: cfg.maskAttr },
  )
  await page.evaluate(() => {
    window.scrollTo(0, 0)
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()) }))
  return page
}
