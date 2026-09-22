/**
 * Browser lifecycle (design doc §4.8: one browser instance per session).
 *
 * Launching Chromium costs 2–3 seconds ONCE; every capture after that is a
 * page navigation (tens of ms). `canLaunchBrowser()` probes availability so
 * browser-gated tests skip cleanly in environments without the system
 * libraries (containers) instead of failing mysteriously — the same pattern
 * dsh uses to key-gate its real-API tests.
 *
 * @module @clue-harness/evidence-render/browser
 */
import { chromium, type Browser, type BrowserContext } from 'playwright'

/** One launched browser; contexts are created per capture configuration. */
export interface RenderBrowser {
  /** Fresh isolated context with the deterministic capture settings. */
  context(viewport: { width: number; height: number }, dpr: number): Promise<BrowserContext>
  close(): Promise<void>
}

/** Probe outcome: availability plus the REAL failure reason (failures teach). */
export interface BrowserProbe {
  ok: boolean
  /** The most actionable line of the launch error (missing-library line wins), null when ok. */
  error: string | null
}

let probeCache: BrowserProbe | undefined

/** The system-library install hint for unsupported distros (Arch and friends). */
const ARCH_DEPS_HINT = 'sudo pacman -S --needed atk at-spi2-atk at-spi2-core cups libdrm '
  + 'libxkbcommon libxcomposite libxdamage libxfixes libxrandr mesa alsa-lib pango cairo nss nspr libxshmfence'

/** Extract the single most actionable line from a launch failure. */
function actionableLine(message: string): string {
  const lines = message.split('\n')
  return lines.find((line) => line.includes('shared libraries') || line.includes('cannot open'))
    ?? lines[0]
}

async function tryLaunch(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true })
  } catch {
    // Unprivileged containers cannot run Chromium's own setuid sandbox; the
    // outer OS sandbox (or the user's own machine policy) still confines the
    // browser, so the retry is safe — and it is the documented CI posture.
    return chromium.launch({ headless: true, chromiumSandbox: false })
  }
}

/**
 * Probe (once per process) whether a headless browser can run here, and WHY
 * not when it cannot: the skip message / error a user sees must name the
 * missing piece (e.g. `libatk-1.0.so.0: cannot open shared object file`),
 * not just "unavailable".
 * @returns the cached probe outcome.
 */
export async function probeBrowser(): Promise<BrowserProbe> {
  if (probeCache !== undefined) return probeCache
  try {
    const browser = await tryLaunch()
    await browser.close()
    probeCache = { ok: true, error: null }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    probeCache = { ok: false, error: actionableLine(message) }
  }
  return probeCache
}

/**
 * Boolean convenience over {@link probeBrowser}.
 * @returns true when launchRenderBrowser() is expected to succeed.
 */
export async function canLaunchBrowser(): Promise<boolean> {
  return (await probeBrowser()).ok
}

/**
 * Launch the shared browser instance.
 * @returns the render browser handle.
 * @throws a guidance-bearing error when Chromium cannot run: the real failure
 *   line first, then the exact install commands for binaries and system libs.
 */
export async function launchRenderBrowser(): Promise<RenderBrowser> {
  let browser: Browser
  try {
    browser = await tryLaunch()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `cannot launch Chromium: ${actionableLine(message)}\n`
      + '  browser binary: `npx playwright install chromium`\n'
      + `  system libs (distros where Playwright does not install them automatically, e.g. Arch/WSL Arch): ${ARCH_DEPS_HINT}\n`
      + '  (WSL Ubuntu/Debian: `npx playwright install --with-deps chromium` does it in one step)',
    )
  }
  return {
    context: (viewport, dpr) => browser.newContext({
      viewport,
      deviceScaleFactor: dpr,
      // Fixed scheme + reduced motion: two more sources of run-to-run drift.
      colorScheme: 'light',
      reducedMotion: 'reduce',
      locale: 'zh-CN',
      timezoneId: 'UTC',
    }),
    close: () => browser.close(),
  }
}
