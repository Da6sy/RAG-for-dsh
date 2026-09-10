/**
 * L3 pixel capture (M6) — the escalation channel of design §4.2/§4.7.
 *
 * Screenshots are EXPENSIVE evidence (visual tokens cost multiples of text),
 * so they stay behind the doubt counter: this function is called when a
 * module's doubt threshold trips, and by the gate for modules already
 * escalated ("下次遇到它直接截图"). Two disciplines from §4.8 ride here:
 *
 * - determinism: captures run through the SAME normalized page lifecycle as
 *   inspections (animations off, fixed font stack, network-idle wait, fixed
 *   viewport/dpr) — a screenshot of a jittering page is noise;
 * - content-hash storage: PNGs land at `home/evidence/screenshots/<sha256>.png`,
 *   so an identical capture stores once (`reused`) and callers can skip
 *   re-judging a画面 they already hold. Bytes NEVER travel through the
 *   session log or the KB from here — the attachment service (face layer)
 *   owns that boundary (决策 #19).
 *
 * @module @clue-harness/evidence-render/capture
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { clueHome } from '@clue-harness/util'
import { launchRenderBrowser, probeBrowser } from './browser.ts'
import { DEFAULT_NORMALIZE_CONFIG, openNormalized, type NormalizeConfig } from './normalize.ts'
import { serveProject } from './server.ts'

export interface CaptureOptions {
  /** Absolute (or resolvable) project root the page lives in. */
  projectRoot: string
  /** Page path, project-relative. */
  page: string
  /** `data-module` id to clip to; the full viewport is captured when absent. */
  moduleId?: string
  /** ClueHarness home override (tests/demos). */
  home?: string
  viewport?: { width: number; height: number }
  dpr?: number
  /** Extra volatile-mask selectors (same vocabulary as inspections). */
  maskSelectors?: string[]
}

export interface CaptureResult {
  /** Absolute path of the content-addressed PNG. */
  path: string
  /** Content hash (the file's name). */
  sha256: string
  bytes: number
  /** True when an identical capture was already stored (no rewrite). */
  reused: boolean
}

/**
 * Capture one page (or one data-module's box) as a normalized PNG.
 * @param options - what to capture and where the project lives.
 * @returns the stored capture's metadata.
 * @throws guidance-bearing errors for missing pages/modules or unavailable
 *   browsers (the inspectPage posture).
 */
export async function captureScreenshot(options: CaptureOptions): Promise<CaptureResult> {
  const home = options.home ?? clueHome()
  const viewport = options.viewport ?? { width: 1440, height: 900 }
  const dpr = options.dpr ?? 1
  const projectRoot = await realpath(options.projectRoot)
  const pageRel = options.page.replace(/\\/g, '/').replace(/^\/+/, '')
  const pageAbs = path.resolve(projectRoot, pageRel)
  if (!pageAbs.startsWith(projectRoot)) throw new Error(`页面路径逃出项目根: ${options.page}`)
  const info = await stat(pageAbs).catch(() => null)
  if (info === null || !info.isFile()) throw new Error(`页面不存在: ${pageAbs}`)

  const probe = await probeBrowser()
  if (!probe.ok) {
    throw new Error(`无法启动 Chromium(${probe.error ?? '原因未知'});截图升级需要真实浏览器`)
  }

  const normalizeConfig: NormalizeConfig = {
    ...DEFAULT_NORMALIZE_CONFIG,
    maskSelectors: [...DEFAULT_NORMALIZE_CONFIG.maskSelectors, ...(options.maskSelectors ?? [])],
  }

  const server = await serveProject(projectRoot)
  const browser = await launchRenderBrowser()
  let png: Buffer
  try {
    const context = await browser.context(viewport, dpr)
    try {
      const page = await openNormalized(context, `${server.baseUrl}/${pageRel}`, normalizeConfig)
      if (options.moduleId !== undefined) {
        const locator = page.locator(`[data-module="${options.moduleId}"]`).first()
        if (await locator.count() === 0) {
          throw new Error(`页面 ${pageRel} 没有 data-module="${options.moduleId}" 的模块`)
        }
        png = await locator.screenshot({ type: 'png' })
      } else {
        png = await page.screenshot({ type: 'png' })
      }
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }

  // Content-addressed store: identical pixels store once (§4.8 缓存), so an
  // unchanged screen is never re-stored and callers can skip re-judging it.
  const sha256 = createHash('sha256').update(png).digest('hex')
  const dir = path.join(home, 'evidence', 'screenshots')
  const target = path.join(dir, `${sha256}.png`)
  let reused = true
  if ((await stat(target).catch(() => null)) === null) {
    await mkdir(dir, { recursive: true })
    // Write-then-rename would be the atomic ideal; a hash-named file is
    // already content-immutable, so a plain write is crash-safe enough
    // (a torn file fails its own hash check on read and is recaptured).
    await writeFile(target, png)
    reused = false
  }
  // Trust but verify the stored bytes (a torn predecessor must not pass).
  const stored = await readFile(target)
  if (createHash('sha256').update(stored).digest('hex') !== sha256) {
    await writeFile(target, png)
  }
  return { path: target, sha256, bytes: png.byteLength, reused }
}
