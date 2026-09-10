/**
 * Deterministic snapshot serialization (design doc §4.4/§4.6).
 *
 * Two renderings of the same {@link LayoutSnapshot}:
 * - {@link serializeSnapshotText} — the tree a model (or you) reads: fixed
 *   field order, fixed flag vocabulary, no alignment padding that could drift.
 * - {@link serializeSnapshotJson} — the machine form: recursive key-sorted
 *   JSON, so object-construction order in the extractor can never leak into
 *   the bytes (the "three runs byte-identical" gate is about BYTES).
 *
 * {@link parseSnapshotJson} refuses any version but the current one — the
 * dsh house style: reject stale on-disk formats, never silently migrate.
 *
 * @module @clue-harness/evidence-render/serialize
 */
import {
  RENDER_SNAPSHOT_VERSION,
  type AssertionResult,
  type LayoutSnapshot,
  type ModuleNode,
} from './types.ts'

/** Tree glyphs (fixed; part of the serialized contract). */
const GLYPH_MID = '├─ '
const GLYPH_END = '└─ '
const GLYPH_PIPE = '│  '
const GLYPH_SPACE = '   '

/**
 * Recursively key-sort a JSON-serializable value.
 * @param value - any JSON-safe value.
 * @returns an equivalent value whose object keys are in sorted order.
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) sorted[key] = sortDeep(source[key])
    return sorted
  }
  return value
}

/**
 * Serialize with sorted object keys so byte output never depends on the
 * extractor's property-assignment order.
 * @param value - any JSON-safe value.
 * @param indent - JSON indentation (default 2; pretty bytes stay diffable).
 * @returns deterministic JSON text.
 */
export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortDeep(value), null, indent)
}

/**
 * Serialize a snapshot to its deterministic JSON form.
 * @param snapshot - the capture to serialize.
 * @returns stable JSON text (baseline files store exactly this).
 */
export function serializeSnapshotJson(snapshot: LayoutSnapshot): string {
  return stableStringify(snapshot)
}

/**
 * Parse a snapshot JSON, refusing foreign versions.
 * @param text - JSON produced by {@link serializeSnapshotJson}.
 * @returns the typed snapshot.
 * @throws when the version field mismatches or modules are missing —
 *   stale baselines are re-captured, never auto-migrated.
 */
export function parseSnapshotJson(text: string): LayoutSnapshot {
  const parsed = JSON.parse(text) as LayoutSnapshot
  if (parsed.version !== RENDER_SNAPSHOT_VERSION) {
    throw new Error(
      `render snapshot 版本不匹配: 文件是 v${String(parsed.version)}, 当前 v${RENDER_SNAPSHOT_VERSION}`
      + ' — 拒绝读取(不自动迁移), 请重新采集基准',
    )
  }
  if (!Array.isArray(parsed.modules)) {
    throw new Error('render snapshot 格式错误: 缺少 modules')
  }
  return parsed
}

/**
 * One module as a single text line: identity, box, grid, relations, flags,
 * text preview — always in this order.
 * @param node - the module to render.
 * @returns the line body (without tree glyphs).
 */
function moduleLine(node: ModuleNode): string {
  const segments: string[] = [
    `${node.label} <${node.kind}>`,
    `(${node.box.x}, ${node.box.y}, ${node.box.w}, ${node.box.h})`,
    `grid ${node.grid}`,
  ]
  if (node.relations.length > 0) segments.push(node.relations.join(' · '))

  const attrKeys = Object.keys(node.attrs).sort()
  if (attrKeys.length > 0) {
    segments.push(attrKeys.map((key) => `${key}=${JSON.stringify(node.attrs[key])}`).join(' '))
  }

  const flags: string[] = []
  if (!node.visibility.displayed) flags.push('未显示')
  if (!node.visibility.inViewport) flags.push('视口外')
  if (node.visibility.occluded) flags.push(`被遮挡${node.visibility.occludedBy !== null ? `(${node.visibility.occludedBy})` : ''}`)
  if (node.visibility.clipped) flags.push('溢出裁剪')
  if (node.interactive !== null) {
    const state = node.interactive
    flags.push(state.disabled ? '禁用' : '可交互')
    if (state.tabbable) flags.push(state.tabIndex !== null ? `Tab序${state.tabIndex}` : '可Tab')
    if (state.focused) flags.push('当前聚焦')
  }
  if (node.style.contrastRatio !== null) flags.push(`对比度${node.style.contrastRatio.toFixed(1)}`)
  if (node.repeat !== null) {
    const repeat = node.repeat
    flags.push(`×${repeat.count}${repeat.structureSame ? '结构一致' : '结构有异'}${repeat.gap !== null ? `间距${repeat.gap}` : ''}`)
  }
  for (const violation of node.violations) flags.push(`⚠ ${violation}`)
  if (flags.length > 0) segments.push(flags.join(' · '))

  if (node.text !== null) {
    const more = node.textLength !== null && node.textLength > node.text.length
      ? `…(共${node.textLength}字)`
      : ''
    segments.push(`文本 ${JSON.stringify(node.text)}${more}`)
  }
  return segments.join('  ')
}

/** Depth-first tree walk with fixed glyphs; repeat expansions render as children. */
function renderTree(nodes: readonly ModuleNode[], prefix: string, out: string[]): void {
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1
    out.push(`${prefix}${isLast ? GLYPH_END : GLYPH_MID}${moduleLine(node)}`)
    const childPrefix = prefix + (isLast ? GLYPH_SPACE : GLYPH_PIPE)
    if (node.repeat !== null && node.repeat.expanded.length > 0) {
      renderTree(node.repeat.expanded, childPrefix, out)
    }
    renderTree(node.children, childPrefix, out)
  })
}

/** One assertion as a single ✓/✗ line. */
function assertionLine(assertion: AssertionResult): string {
  const expected = assertion.expected !== null ? `  期望: ${assertion.expected}` : ''
  return `  ${assertion.pass ? '✓' : '✗'} [${assertion.severity}] ${assertion.name}  实际: ${assertion.actual}${expected}`
}

/**
 * Serialize a snapshot to the human/model-readable text tree (§4.4 sample
 * shape). Deterministic: identical snapshots produce identical bytes.
 * @param snapshot - the capture to render.
 * @returns multi-line text ending with a newline.
 */
export function serializeSnapshotText(snapshot: LayoutSnapshot): string {
  const lines: string[] = []
  const scroll = snapshot.page.needsScroll ? ' (需滚动)' : ''
  lines.push(
    `页面 ${snapshot.target}  视口 ${snapshot.viewport.width}×${snapshot.viewport.height}`
    + ` dpr ${snapshot.dpr}  页面总高 ${snapshot.page.height}${scroll}`,
  )
  lines.push('')
  renderTree(snapshot.modules, '', lines)
  lines.push('')
  lines.push('检查:')
  if (snapshot.assertions.length === 0) {
    lines.push('  (未运行断言)')
  } else {
    for (const assertion of snapshot.assertions) lines.push(assertionLine(assertion))
  }
  if (snapshot.markerHints.length > 0) {
    lines.push('')
    lines.push('标记提示:')
    for (const hint of snapshot.markerHints) lines.push(`  - ${hint}`)
  }
  return `${lines.join('\n')}\n`
}
