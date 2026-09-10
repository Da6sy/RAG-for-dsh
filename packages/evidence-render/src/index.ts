/**
 * `@clue-harness/evidence-render` — the render evidence provider (M1 engine).
 *
 * Public surface: the orchestrator (`inspectPage`), the vocabulary types, the
 * serializers, the baseline store, and the browser probe (for test gating).
 * The in-page extractor is exported for the browser-gated tests only; it must
 * never be called outside `page.evaluate`.
 *
 * The Cordis tool face (`render_layout` / `render_assert` on ctx.tools) lands
 * with the M3/M4 loop integration — engines first, consumers when they exist.
 *
 * @module @clue-harness/evidence-render
 */
export {
  RENDER_SNAPSHOT_VERSION,
  type AssertionResult,
  type Box,
  type InteractiveState,
  type LayoutSnapshot,
  type ModuleKind,
  type ModuleNode,
  type RepeatInfo,
  type VisibilityInfo,
} from './types.ts'
export {
  parseSnapshotJson,
  serializeSnapshotJson,
  serializeSnapshotText,
  stableStringify,
} from './serialize.ts'
export {
  DEFAULT_DIFF_OPTIONS,
  diffSnapshots,
  type DiffEntry,
  type DiffOptions,
  type DiffReport,
} from './diff.ts'
export { runBuiltinAssertions } from './assert.ts'
export {
  DEFAULT_EXTRACT_CONFIG,
  extractInPage,
  type ExtractConfig,
  type RawLayout,
} from './extract.ts'
export {
  DEFAULT_NORMALIZE_CONFIG,
  openNormalized,
  type NormalizeConfig,
} from './normalize.ts'
export { serveProject, type StaticServerHandle } from './server.ts'
export { canLaunchBrowser, launchRenderBrowser, probeBrowser, type BrowserProbe, type RenderBrowser } from './browser.ts'
export {
  BASELINE_RECORD_VERSION,
  baselinePath,
  baselineSnapshot,
  baselinesDir,
  clueHome,
  confirmBaseline,
  encodeSegment,
  isStale,
  loadBaseline,
  saveBaseline,
  sourceHash,
  type BaselineRecord,
} from './baseline.ts'
export { serializeAssertionsText, serializeDiffText } from './report.ts'
export { inspectPage, type InspectMode, type InspectOptions, type InspectResult } from './inspect.ts'
export { captureScreenshot, type CaptureOptions, type CaptureResult } from './capture.ts'
