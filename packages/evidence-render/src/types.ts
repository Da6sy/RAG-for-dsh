/**
 * Render-snapshot vocabulary (design doc §4.2–§4.6).
 *
 * Determinism rules — these types are the contract for the "three runs,
 * byte-identical" gate (§4.6), so:
 *
 * - NO timestamps, NO random values, NO absolute machine paths anywhere in a
 *   snapshot. `target` is project-relative; capture time belongs to the
 *   baseline record wrapper (M1-5), never inside the snapshot itself.
 * - All coordinates are PAGE coordinates (document origin, scroll included),
 *   quantized to integers by the extractor; "outside the viewport" is a
 *   visibility flag, not a coordinate trick.
 * - `boxPct` values are rounded to one decimal at extraction time.
 * - Object key order never matters: the JSON serializer sorts keys.
 *
 * Bump {@link RENDER_SNAPSHOT_VERSION} on any structural change; readers
 * REFUSE mismatched versions (no auto-migration — the dsh house style).
 *
 * @module @clue-harness/evidence-render/types
 */

/** Structural version of the snapshot format. Refuse-on-mismatch, never migrate. */
export const RENDER_SNAPSHOT_VERSION = 1

/** Quantized integer rectangle in page coordinates. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Why this node counts as "one module" (§4.4 identification rules):
 * - `marker`      — carries a data-module attribute (the authoritative case);
 * - `landmark`    — semantic tag/ARIA role (header/nav/main/aside/footer/section/form);
 * - `interactive` — button/input/a/select/textarea (always recorded individually);
 * - `visual`      — a container with its own visual boundary (background/border/radius);
 * - `group`       — folded repeated-sibling container (see {@link RepeatInfo}).
 */
export type ModuleKind = 'marker' | 'landmark' | 'interactive' | 'visual' | 'group'

/** Folded repeated siblings: "12 results, same structure, first box, gap". */
export interface RepeatInfo {
  /** Total sibling count. */
  count: number
  /** Box of the first item (the only one serialized in full by default). */
  firstBox: Box
  /** Item spacing in px when uniform, else null. */
  gap: number | null
  /** Whether all items share the same child structure. */
  structureSame: boolean
  /** The first N items expanded as pseudo-children (extractor policy, default 2). */
  expanded: ModuleNode[]
}

/** Visibility facts, all deterministic given a settled page. */
export interface VisibilityInfo {
  /** Rendered at all (not display:none / zero-size / fully transparent). */
  displayed: boolean
  /** Inside the initial viewport without scrolling. */
  inViewport: boolean
  /** Covered by another element at its center point. */
  occluded: boolean
  /** Label of the occluding module when occluded, else null. */
  occludedBy: string | null
  /** Content clipped by an ancestor's overflow. */
  clipped: boolean
}

/** State that matters for interaction assertions; null for non-interactive nodes. */
export interface InteractiveState {
  tag: string
  /** Input type attribute when meaningful (submit/text/checkbox…), else null. */
  type: string | null
  disabled: boolean
  /** Reachable by sequential Tab navigation. */
  tabbable: boolean
  /** Explicit tabindex when set, else null. */
  tabIndex: number | null
  /** Currently holds focus (page-level singleton, deterministic after settle). */
  focused: boolean
}

/** One module in the semantic scene tree. */
export interface ModuleNode {
  /** Stable identity: the data-module value, else a deterministic structural path. */
  id: string
  /** Human/model-readable name: marker value, landmark name, or tag fallback. */
  label: string
  kind: ModuleKind
  /** Raw data-module value when present (null otherwise). */
  moduleName: string | null
  box: Box
  /** Box as viewport percentages, one decimal. */
  boxPct: Box
  /** Coarse grid position, e.g. "r2 c4-9" (12 columns; row band is a fixed px height). */
  grid: string
  /** Semantic relations, deterministic order: inside:<id>, below:<id>, sibling-after:<id>. */
  relations: string[]
  /** Truncated text preview (extractor cap), null when the node carries no own text. */
  text: string | null
  /** Full text length before truncation, null together with text. */
  textLength: number | null
  /** Whitelisted attributes only (sorted keys); never a full attribute dump. */
  attrs: Record<string, string>
  style: {
    position: string
    /** Computed z-index as authored ("auto" stays null). */
    zIndex: string | null
    /** Text/background contrast ratio, one decimal; null when not text-bearing. */
    contrastRatio: number | null
  }
  visibility: VisibilityInfo
  interactive: InteractiveState | null
  /** Set on group nodes that fold repeated siblings. */
  repeat: RepeatInfo | null
  /** L1-level problems observed on THIS node (occlusion, clip, tab-order loss…). */
  violations: string[]
  children: ModuleNode[]
}

/** One L2 assertion outcome — the actual evidence carrier (§4.2). */
export interface AssertionResult {
  name: string
  pass: boolean
  /** Measured value, already a string (deterministic formatting at assert time). */
  actual: string
  expected: string | null
  severity: 'error' | 'warn'
}

/** A complete, replayable L1+L2 observation of one page at one viewport. */
export interface LayoutSnapshot {
  version: typeof RENDER_SNAPSHOT_VERSION
  /** Project-relative page path (never absolute, never a query string with volatile values). */
  target: string
  viewport: { width: number; height: number }
  /** deviceScaleFactor the capture ran at. */
  dpr: number
  page: {
    width: number
    /** Full scroll height. */
    height: number
    needsScroll: boolean
  }
  modules: ModuleNode[]
  assertions: AssertionResult[]
  /** "Large unmarked block — consider adding data-module" hints (§4.4). */
  markerHints: string[]
}
