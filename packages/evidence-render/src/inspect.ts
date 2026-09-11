/**
 * The render-inspection orchestrator (design doc §4 end-to-end flow, M1 scope):
 *
 *   serve project → open page (normalized) → extract L1 → run L2 assertions
 *     → mode: show | record | compare | confirm → text report
 *
 * One browser instance per inspect call; one context per viewport. The
 * orchestrator owns ALL lifecycle (server, browser) with finally-teardown —
 * a crashed capture must never leave a stray Chromium or a bound port.
 *
 * @module @clue-harness/evidence-render/inspect
 */
import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { RENDER_SNAPSHOT_VERSION, type LayoutSnapshot } from './types.ts'
import { serializeSnapshotJson, serializeSnapshotText } from './serialize.ts'
import { DEFAULT_EXTRACT_CONFIG, extractInPage, type ExtractConfig, type RawLayout } from './extract.ts'
import { DEFAULT_NORMALIZE_CONFIG, openNormalized, type NormalizeConfig } from './normalize.ts'
import { serveProject } from './server.ts'
import { launchRenderBrowser, probeBrowser } from './browser.ts'
import { runBuiltinAssertions } from './assert.ts'
import { diffSnapshots, type DiffReport } from './diff.ts'
import { serializeAssertionsText, serializeDiffText } from './report.ts'
import {
  baselinePath, baselineSnapshot, clueHome, confirmBaseline, isStale,
  loadBaseline, saveBaseline, sourceHash, type BaselineRecord,
} from './baseline.ts'

export type InspectMode = 'show' | 'record' | 'compare' | 'confirm'

export interface InspectOptions {
  /** Absolute (or resolvable) project root the page lives in. */
  projectRoot: string
  /** Page path, project-relative (posix or win separators both accepted). */
  page: string
  mode: InspectMode
  /** ClueHarness home the baselines live under (M9 central storage). */
  home?: string
  viewport?: { width: number; height: number }
  dpr?: number
  /** Extra volatile-region selectors to mask before capture. */
  maskSelectors?: string[]
  extract?: Partial<ExtractConfig>
  normalize?: Partial<NormalizeConfig>
  /** Also write the raw snapshot JSON here (debugging aid). */
  jsonOut?: string
}

export interface InspectResult {
  snapshot: LayoutSnapshot | null
  snapshotText: string
  baseline: BaselineRecord | null
  stale: boolean
  diff: DiffReport | null
  /** Final human/model-facing report text. */
  report: string
  baselinePath: string | null
  /** False when error-severity evidence exists (CLI maps this to exit code 1). */
  exitOk: boolean
}

/**
 * Run one render inspection.
 * @param options - what to capture and which mode to run.
 * @returns snapshot, diff (compare mode), and the rendered report.
 * @throws guidance-bearing errors for missing pages or unavailable browsers.
 */
export async function inspectPage(options: InspectOptions): Promise<InspectResult> {
  const viewport = options.viewport ?? { width: 1440, height: 900 }
  const dpr = options.dpr ?? 1
  const projectRoot = await realpath(options.projectRoot)
  const pageRel = options.page.replace(/\\/g, '/').replace(/^\/+/, '')
  const pageAbs = path.resolve(projectRoot, pageRel)
  if (!pageAbs.startsWith(projectRoot)) throw new Error(`页面路径逃出项目根: ${options.page}`)
  const info = await stat(pageAbs).catch(() => null)
  if (info === null || !info.isFile()) throw new Error(`页面不存在: ${pageAbs}`)

  // confirm needs no capture at all — the fast path.
  if (options.mode === 'confirm') {
    const record = await confirmBaseline(projectRoot, pageRel, options.home)
    const confirmedFile = await baselinePath(projectRoot, pageRel, options.home)
    return {
      snapshot: null, snapshotText: '', baseline: record, stale: false, diff: null,
      report: `基准已人工确认: ${pageRel}\n  文件: ${confirmedFile}\n`,
      baselinePath: confirmedFile, exitOk: true,
    }
  }

  const hashes: Record<string, string> = { [pageRel]: await sourceHash(pageAbs) }

  const probe = await probeBrowser()
  if (!probe.ok) {
    throw new Error(
      `无法启动 Chromium(${probe.error ?? '原因未知'})。\n`
      + '  浏览器二进制: `npx playwright install chromium`\n'
      + '  系统库(Arch 等 Playwright 不自动装库的发行版): 见 packages/evidence-render/src/browser.ts 的 pacman 清单\n'
      + '  (WSL Ubuntu/Debian: `npx playwright install --with-deps chromium` 一步到位)',
    )
  }

  const extractConfig: ExtractConfig = { ...DEFAULT_EXTRACT_CONFIG, ...options.extract }
  const normalizeConfig: NormalizeConfig = {
    ...DEFAULT_NORMALIZE_CONFIG,
    ...options.normalize,
    maskSelectors: [...DEFAULT_NORMALIZE_CONFIG.maskSelectors, ...(options.maskSelectors ?? [])],
  }

  const server = await serveProject(projectRoot)
  const browser = await launchRenderBrowser()
  let snapshot: LayoutSnapshot
  try {
    const context = await browser.context(viewport, dpr)
    try {
      const page = await openNormalized(context, `${server.baseUrl}/${pageRel}`, normalizeConfig)
      const raw: RawLayout = await page.evaluate(extractInPage, extractConfig)
      snapshot = {
        version: RENDER_SNAPSHOT_VERSION,
        target: pageRel,
        viewport,
        dpr,
        page: { ...raw.page, needsScroll: raw.page.height > viewport.height },
        modules: raw.modules,
        assertions: [],
        markerHints: raw.markerHints,
      }
      snapshot.assertions = runBuiltinAssertions(snapshot)
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }

  if (options.jsonOut !== undefined) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(options.jsonOut, `${serializeSnapshotJson(snapshot)}\n`, 'utf8')
  }

  const snapshotText = serializeSnapshotText(snapshot)
  const assertionsText = serializeAssertionsText(snapshot)
  const failedError = snapshot.assertions.some((a) => !a.pass && a.severity === 'error')

  if (options.mode === 'show') {
    return {
      snapshot, snapshotText, baseline: null, stale: false, diff: null,
      report: `${snapshotText}\n${assertionsText}\n`,
      baselinePath: null, exitOk: !failedError,
    }
  }

  if (options.mode === 'record') {
    const existing = await loadBaseline(projectRoot, pageRel, options.home)
    const saved = await saveBaseline(projectRoot, snapshot, hashes, options.home)
    const lines = [
      `基准已保存(待人工确认): ${pageRel}`,
      `  文件: ${saved.path}`,
      existing !== null
        ? `  注意: 覆盖了原有基准(confirmed=${String(existing.confirmed)}),需要重新 --confirm。`
        : '  下一步: 人工核对上面的结构树与检查结果,认可后运行 --confirm 转正。',
    ]
    return {
      snapshot, snapshotText, baseline: saved.record, stale: false, diff: null,
      report: `${lines.join('\n')}\n\n${snapshotText}\n${assertionsText}\n`,
      baselinePath: saved.path, exitOk: true,
    }
  }

  // compare
  const record = await loadBaseline(projectRoot, pageRel, options.home)
  if (record === null) {
    return {
      snapshot, snapshotText, baseline: null, stale: false, diff: null,
      report: `尚无基准,本次按单次记录输出(运行 --record 可把它存为基准):\n\n${snapshotText}\n${assertionsText}\n`,
      baselinePath: null, exitOk: !failedError,
    }
  }
  const stale = isStale(record, hashes)
  const baseline = baselineSnapshot(record)
  const diff = diffSnapshots(baseline, snapshot)
  const diffText = serializeDiffText(diff, { stale, unconfirmed: !record.confirmed })
  const diffErrors = diff.entries.some((e) => e.severity === 'error')
  return {
    snapshot, snapshotText, baseline: record, stale, diff,
    report: `${diffText}\n${assertionsText}\n\n当前结构树:\n${snapshotText}`,
    baselinePath: await baselinePath(projectRoot, pageRel, options.home),
    exitOk: !diffErrors && !failedError,
  }
}
