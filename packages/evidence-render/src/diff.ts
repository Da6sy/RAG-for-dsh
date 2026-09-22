/**
 * Structured snapshot diffing (design doc §4.5: "核心产出是差异报告").
 *
 * Alignment is by stable module id — this is exactly what data-module markers
 * buy us: two captures align by identity, not by guessing from position. The
 * output is a deterministic, severity-ordered entry list; report.ts turns it
 * into the human/model-facing text.
 *
 * Pure logic: no browser, no I/O — fully unit-testable.
 *
 * @module @clue-harness/evidence-render/diff
 */
import type { LayoutSnapshot, ModuleNode } from './types.ts'

/** Tunables for change significance. */
export interface DiffOptions {
  /** Position delta (px) counted as a move. Coordinates are pre-quantized. */
  moveThresholdPx?: number
  /** Size delta (px) counted as a resize. */
  sizeThresholdPx?: number
  /** Contrast ratio delta worth mentioning. */
  contrastEpsilon?: number
}

export const DEFAULT_DIFF_OPTIONS: Required<DiffOptions> = {
  moveThresholdPx: 0,
  sizeThresholdPx: 0,
  contrastEpsilon: 0.5,
}

/** One atomic change. `detail` is already human-readable (report layer only formats). */
export interface DiffEntry {
  kind:
    | 'added' | 'removed' | 'moved' | 'resized' | 'visibility'
    | 'interactive' | 'contrast' | 'text' | 'repeat' | 'marker'
    | 'assertion' | 'page' | 'viewport' | 'hint'
  /** Stable module id, null for page-level entries. */
  moduleId: string | null
  label: string
  detail: string
  severity: 'error' | 'warn' | 'info'
}

export interface DiffReport {
  target: string
  viewportChanged: boolean
  entries: DiffEntry[]
  identical: boolean
}

interface FlatEntry {
  node: ModuleNode
  /** Human-readable ancestor path ("主区域 > 搜索栏"). */
  path: string
}

/** Flatten the module tree (including repeat expansions) keyed by stable id. */
function flatten(nodes: readonly ModuleNode[], prefix = ''): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>()
  for (const node of nodes) {
    const path = prefix === '' ? node.label : `${prefix} > ${node.label}`
    out.set(node.id, { node, path })
    for (const child of node.repeat?.expanded ?? []) {
      // Expanded repeats share the group's subtree slot; key them under their own id.
      out.set(child.id, { node: child, path: `${path} > ${child.label}` })
      for (const grand of child.children) collectInto(out, grand, `${path} > ${child.label}`)
    }
    for (const child of node.children) collectInto(out, child, path)
  }
  return out
}

function collectInto(out: Map<string, FlatEntry>, node: ModuleNode, prefix: string): void {
  const path = `${prefix} > ${node.label}`
  out.set(node.id, { node, path })
  for (const child of node.repeat?.expanded ?? []) collectInto(out, child, path)
  for (const child of node.children) collectInto(out, child, path)
}

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 } as const

function moveWords(dx: number, dy: number): string {
  const parts: string[] = []
  if (dx !== 0) parts.push(dx > 0 ? `moved right ${dx}px` : `moved left ${-dx}px`)
  if (dy !== 0) parts.push(dy > 0 ? `moved down ${dy}px` : `moved up ${-dy}px`)
  return parts.join(' ')
}

function relationChange(before: readonly string[], after: readonly string[]): string | null {
  const added = after.filter((r) => !before.includes(r))
  const removed = before.filter((r) => !after.includes(r))
  if (added.length === 0 && removed.length === 0) return null
  const bits: string[] = []
  if (added.length > 0) bits.push(`gained ${added.join(', ')}`)
  if (removed.length > 0) bits.push(`lost ${removed.join(', ')}`)
  return `relations changed: ${bits.join('; ')}`
}

function boxText(node: ModuleNode): string {
  return `(${node.box.x}, ${node.box.y}, ${node.box.w}, ${node.box.h})`
}

/**
 * Diff a baseline snapshot against a current capture.
 * @param baseline - the confirmed reference capture.
 * @param current - the fresh capture.
 * @param options - significance thresholds.
 * @returns deterministic severity-ordered report.
 */
export function diffSnapshots(
  baseline: LayoutSnapshot,
  current: LayoutSnapshot,
  options: DiffOptions = {},
): DiffReport {
  const opts = { ...DEFAULT_DIFF_OPTIONS, ...options }
  const entries: DiffEntry[] = []
  const push = (entry: DiffEntry): void => { entries.push(entry) }

  const viewportChanged =
    baseline.viewport.width !== current.viewport.width
    || baseline.viewport.height !== current.viewport.height
    || baseline.dpr !== current.dpr
  if (viewportChanged) {
    push({
      kind: 'viewport', moduleId: null, label: 'viewport', severity: 'warn',
      detail: `viewport/scale mismatch: ${baseline.viewport.width}×${baseline.viewport.height}@${baseline.dpr}`
        + ` → ${current.viewport.width}×${current.viewport.height}@${current.dpr}; coordinate differences are noise in this comparison`,
    })
  }

  if (baseline.page.height !== current.page.height) {
    const delta = current.page.height - baseline.page.height
    push({
      kind: 'page', moduleId: null, label: 'page', severity: 'info',
      detail: `full page height ${baseline.page.height} → ${current.page.height} (${delta > 0 ? '+' : ''}${delta}px)`,
    })
  }
  if (baseline.page.needsScroll !== current.page.needsScroll) {
    push({
      kind: 'page', moduleId: null, label: 'page', severity: 'info',
      detail: current.page.needsScroll ? 'page went from no-scroll to needs-scroll' : 'page went from needs-scroll to no-scroll',
    })
  }

  const before = flatten(baseline.modules)
  const after = flatten(current.modules)

  for (const [id, entry] of after) {
    const prev = before.get(id)
    const node = entry.node
    if (prev === undefined) {
      push({
        kind: 'added', moduleId: id, label: entry.path,
        severity: node.kind === 'marker' || node.kind === 'interactive' ? 'warn' : 'info',
        detail: `added <${node.kind}> ${boxText(node)} grid ${node.grid}`,
      })
      continue
    }
    const old = prev.node

    const dx = node.box.x - old.box.x
    const dy = node.box.y - old.box.y
    if (Math.abs(dx) > opts.moveThresholdPx || Math.abs(dy) > opts.moveThresholdPx) {
      const rel = relationChange(old.relations, node.relations)
      const grid = old.grid !== node.grid ? ` · grid ${old.grid} → ${node.grid}` : ''
      push({
        kind: 'moved', moduleId: id, label: entry.path, severity: 'warn',
        detail: `${boxText(old)} → ${boxText(node)} (${moveWords(dx, dy)})${grid}${rel !== null ? ` · ${rel}` : ''}`,
      })
    }

    const dw = node.box.w - old.box.w
    const dh = node.box.h - old.box.h
    if (Math.abs(dw) > opts.sizeThresholdPx || Math.abs(dh) > opts.sizeThresholdPx) {
      const areaBefore = Math.max(1, old.box.w * old.box.h)
      const areaDelta = Math.abs(node.box.w * node.box.h - areaBefore) / areaBefore
      push({
        kind: 'resized', moduleId: id, label: entry.path,
        severity: areaDelta > 0.25 ? 'warn' : 'info',
        detail: `size ${old.box.w}×${old.box.h} → ${node.box.w}×${node.box.h}`
          + ` (width ${dw >= 0 ? '+' : ''}${dw}, height ${dh >= 0 ? '+' : ''}${dh})`,
      })
    }

    if (old.visibility.occluded !== node.visibility.occluded) {
      push({
        kind: 'visibility', moduleId: id, label: entry.path,
        severity: node.visibility.occluded ? 'error' : 'info',
        detail: node.visibility.occluded
          ? `newly occluded${node.visibility.occludedBy !== null ? ` (by ${node.visibility.occludedBy})` : ''}`
          : 'no longer occluded',
      })
    }
    if (old.visibility.clipped !== node.visibility.clipped) {
      push({
        kind: 'visibility', moduleId: id, label: entry.path,
        severity: node.visibility.clipped ? 'warn' : 'info',
        detail: node.visibility.clipped ? 'content newly overflow-clipped' : 'overflow clipping gone',
      })
    }
    if (old.visibility.inViewport !== node.visibility.inViewport) {
      push({
        kind: 'visibility', moduleId: id, label: entry.path, severity: 'info',
        detail: node.visibility.inViewport ? 'entered the above-the-fold viewport' : 'left the above-the-fold viewport (visible only by scrolling)',
      })
    }
    if (old.visibility.displayed !== node.visibility.displayed) {
      push({
        kind: 'visibility', moduleId: id, label: entry.path,
        severity: node.visibility.displayed ? 'info' : 'error',
        detail: node.visibility.displayed ? 'renders again' : 'no longer rendered (display/visibility/zero size)',
      })
    }

    if (old.interactive !== null && node.interactive !== null) {
      if (old.interactive.tabbable !== node.interactive.tabbable) {
        push({
          kind: 'interactive', moduleId: id, label: entry.path,
          severity: node.interactive.tabbable ? 'info' : 'error',
          detail: node.interactive.tabbable ? 'tabbable again' : 'fell out of tab order (unreachable by keyboard)',
        })
      }
      if (old.interactive.disabled !== node.interactive.disabled) {
        push({
          kind: 'interactive', moduleId: id, label: entry.path, severity: 'warn',
          detail: node.interactive.disabled ? 'became disabled' : 'became enabled',
        })
      }
    }

    const cBefore = old.style.contrastRatio
    const cAfter = node.style.contrastRatio
    if (cBefore !== null && cAfter !== null && Math.abs(cAfter - cBefore) > opts.contrastEpsilon) {
      const broke = cBefore >= 4.5 && cAfter < 4.5
      push({
        kind: 'contrast', moduleId: id, label: entry.path,
        severity: broke ? 'error' : 'info',
        detail: `text contrast ${cBefore.toFixed(1)} → ${cAfter.toFixed(1)}${broke ? ' (dropped below the 4.5 readability line)' : ''}`,
      })
    }

    if (old.text !== node.text) {
      push({
        kind: 'text', moduleId: id, label: entry.path, severity: 'info',
        detail: `text ${JSON.stringify(old.text)} → ${JSON.stringify(node.text)}`,
      })
    }

    if (old.repeat !== null && node.repeat !== null) {
      const changes: string[] = []
      if (old.repeat.count !== node.repeat.count) changes.push(`count ${old.repeat.count}→${node.repeat.count}`)
      if (old.repeat.gap !== node.repeat.gap) changes.push(`gap ${String(old.repeat.gap)}→${String(node.repeat.gap)}`)
      if (old.repeat.structureSame !== node.repeat.structureSame) changes.push(node.repeat.structureSame ? 'structure became consistent again' : 'structure now differs')
      if (changes.length > 0) {
        push({ kind: 'repeat', moduleId: id, label: entry.path, severity: 'info', detail: `repeat group: ${changes.join(' · ')}` })
      }
    } else if ((old.repeat === null) !== (node.repeat === null)) {
      push({
        kind: 'repeat', moduleId: id, label: entry.path, severity: 'warn',
        detail: node.repeat !== null ? `became a repeat group (×${node.repeat.count})` : 'no longer a repeat group (structure diverged?)',
      })
    }

    if ((old.moduleName === null) !== (node.moduleName === null)) {
      push({
        kind: 'marker', moduleId: id, label: entry.path, severity: 'info',
        detail: node.moduleName !== null ? `gained marker data-module="${node.moduleName}"` : 'data-module marker removed',
      })
    }
  }

  for (const [id, entry] of before) {
    if (after.has(id)) continue
    const node = entry.node
    push({
      kind: 'removed', moduleId: id, label: entry.path,
      severity: node.kind === 'interactive' || node.kind === 'marker' ? 'error' : 'warn',
      detail: `gone (was ${boxText(node)} grid ${node.grid})`,
    })
  }

  // Assertion flips — the evidence delta that feeds KB signals from M3 on.
  const beforeAssertions = new Map(baseline.assertions.map((a) => [a.name, a]))
  const afterAssertions = new Map(current.assertions.map((a) => [a.name, a]))
  for (const [name, now] of afterAssertions) {
    const was = beforeAssertions.get(name)
    if (was === undefined) {
      push({ kind: 'assertion', moduleId: null, label: name, severity: 'info', detail: `new assertion: ${now.pass ? 'passing' : 'failing'} (actual: ${now.actual})` })
    } else if (was.pass !== now.pass) {
      push({
        kind: 'assertion', moduleId: null, label: name,
        severity: now.pass ? 'info' : 'error',
        detail: now.pass ? `assertion flipped to pass (actual: ${now.actual})` : `assertion flipped to fail (actual: ${now.actual}${now.expected !== null ? `, expected: ${now.expected}` : ''})`,
      })
    }
  }
  for (const name of beforeAssertions.keys()) {
    if (!afterAssertions.has(name)) {
      push({ kind: 'assertion', moduleId: null, label: name, severity: 'warn', detail: 'assertion disappeared (its module may no longer exist)' })
    }
  }

  for (const hint of current.markerHints) {
    if (!baseline.markerHints.includes(hint)) {
      push({ kind: 'hint', moduleId: null, label: 'marker hint', severity: 'info', detail: hint })
    }
  }

  entries.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || a.kind.localeCompare(b.kind)
    || (a.moduleId ?? '').localeCompare(b.moduleId ?? '')
    || a.detail.localeCompare(b.detail))

  return { target: current.target, viewportChanged, entries, identical: entries.length === 0 }
}
