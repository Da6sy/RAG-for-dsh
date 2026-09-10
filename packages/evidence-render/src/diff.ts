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
  if (dx !== 0) parts.push(dx > 0 ? `右移${dx}px` : `左移${-dx}px`)
  if (dy !== 0) parts.push(dy > 0 ? `下移${dy}px` : `上移${-dy}px`)
  return parts.join(' ')
}

function relationChange(before: readonly string[], after: readonly string[]): string | null {
  const added = after.filter((r) => !before.includes(r))
  const removed = before.filter((r) => !after.includes(r))
  if (added.length === 0 && removed.length === 0) return null
  const bits: string[] = []
  if (added.length > 0) bits.push(`新增 ${added.join('、')}`)
  if (removed.length > 0) bits.push(`失去 ${removed.join('、')}`)
  return `关系变化: ${bits.join('; ')}`
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
      kind: 'viewport', moduleId: null, label: '视口', severity: 'warn',
      detail: `视口/缩放不一致: ${baseline.viewport.width}×${baseline.viewport.height}@${baseline.dpr}`
        + ` → ${current.viewport.width}×${current.viewport.height}@${current.dpr};坐标差异在此比对中是噪声`,
    })
  }

  if (baseline.page.height !== current.page.height) {
    const delta = current.page.height - baseline.page.height
    push({
      kind: 'page', moduleId: null, label: '页面', severity: 'info',
      detail: `页面总高度 ${baseline.page.height} → ${current.page.height} (${delta > 0 ? '+' : ''}${delta}px)`,
    })
  }
  if (baseline.page.needsScroll !== current.page.needsScroll) {
    push({
      kind: 'page', moduleId: null, label: '页面', severity: 'info',
      detail: current.page.needsScroll ? '页面从无需滚动变为需要滚动' : '页面从需要滚动变为无需滚动',
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
        detail: `新增 <${node.kind}> ${boxText(node)} grid ${node.grid}`,
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
        detail: `尺寸 ${old.box.w}×${old.box.h} → ${node.box.w}×${node.box.h}`
          + ` (宽${dw >= 0 ? '+' : ''}${dw}, 高${dh >= 0 ? '+' : ''}${dh})`,
      })
    }

    if (old.visibility.occluded !== node.visibility.occluded) {
      push({
        kind: 'visibility', moduleId: id, label: entry.path,
        severity: node.visibility.occluded ? 'error' : 'info',
        detail: node.visibility.occluded
          ? `新被遮挡${node.visibility.occludedBy !== null ? `(遮挡者: ${node.visibility.occludedBy})` : ''}`
          : '不再被遮挡',
      })
    }
    if (old.visibility.clipped !== node.visibility.clipped) {
      push({
        kind: 'visibility', moduleId: id, label: entry.path,
        severity: node.visibility.clipped ? 'warn' : 'info',
        detail: node.visibility.clipped ? '内容新出现溢出裁剪' : '溢出裁剪消除',
      })
    }
    if (old.visibility.inViewport !== node.visibility.inViewport) {
      push({
        kind: 'visibility', moduleId: id, label: entry.path, severity: 'info',
        detail: node.visibility.inViewport ? '进入首屏视口' : '移出首屏视口(需滚动可见)',
      })
    }
    if (old.visibility.displayed !== node.visibility.displayed) {
      push({
        kind: 'visibility', moduleId: id, label: entry.path,
        severity: node.visibility.displayed ? 'info' : 'error',
        detail: node.visibility.displayed ? '恢复渲染' : '不再渲染(display/visibility/零尺寸)',
      })
    }

    if (old.interactive !== null && node.interactive !== null) {
      if (old.interactive.tabbable !== node.interactive.tabbable) {
        push({
          kind: 'interactive', moduleId: id, label: entry.path,
          severity: node.interactive.tabbable ? 'info' : 'error',
          detail: node.interactive.tabbable ? '恢复可 Tab 选中' : '掉出 Tab 顺序(键盘不可达)',
        })
      }
      if (old.interactive.disabled !== node.interactive.disabled) {
        push({
          kind: 'interactive', moduleId: id, label: entry.path, severity: 'warn',
          detail: node.interactive.disabled ? '变为禁用' : '变为可用',
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
        detail: `文字对比度 ${cBefore.toFixed(1)} → ${cAfter.toFixed(1)}${broke ? '(跌破 4.5 可读线)' : ''}`,
      })
    }

    if (old.text !== node.text) {
      push({
        kind: 'text', moduleId: id, label: entry.path, severity: 'info',
        detail: `文本 ${JSON.stringify(old.text)} → ${JSON.stringify(node.text)}`,
      })
    }

    if (old.repeat !== null && node.repeat !== null) {
      const changes: string[] = []
      if (old.repeat.count !== node.repeat.count) changes.push(`数量 ${old.repeat.count}→${node.repeat.count}`)
      if (old.repeat.gap !== node.repeat.gap) changes.push(`间距 ${String(old.repeat.gap)}→${String(node.repeat.gap)}`)
      if (old.repeat.structureSame !== node.repeat.structureSame) changes.push(node.repeat.structureSame ? '结构恢复一致' : '结构出现差异')
      if (changes.length > 0) {
        push({ kind: 'repeat', moduleId: id, label: entry.path, severity: 'info', detail: `重复组: ${changes.join(' · ')}` })
      }
    } else if ((old.repeat === null) !== (node.repeat === null)) {
      push({
        kind: 'repeat', moduleId: id, label: entry.path, severity: 'warn',
        detail: node.repeat !== null ? `变为重复组(×${node.repeat.count})` : '不再是重复组(结构发散?)',
      })
    }

    if ((old.moduleName === null) !== (node.moduleName === null)) {
      push({
        kind: 'marker', moduleId: id, label: entry.path, severity: 'info',
        detail: node.moduleName !== null ? `新增标记 data-module="${node.moduleName}"` : 'data-module 标记被移除',
      })
    }
  }

  for (const [id, entry] of before) {
    if (after.has(id)) continue
    const node = entry.node
    push({
      kind: 'removed', moduleId: id, label: entry.path,
      severity: node.kind === 'interactive' || node.kind === 'marker' ? 'error' : 'warn',
      detail: `消失(原 ${boxText(node)} grid ${node.grid})`,
    })
  }

  // Assertion flips — the evidence delta that feeds KB signals from M3 on.
  const beforeAssertions = new Map(baseline.assertions.map((a) => [a.name, a]))
  const afterAssertions = new Map(current.assertions.map((a) => [a.name, a]))
  for (const [name, now] of afterAssertions) {
    const was = beforeAssertions.get(name)
    if (was === undefined) {
      push({ kind: 'assertion', moduleId: null, label: name, severity: 'info', detail: `新检查项: ${now.pass ? '通过' : '未通过'} (实际: ${now.actual})` })
    } else if (was.pass !== now.pass) {
      push({
        kind: 'assertion', moduleId: null, label: name,
        severity: now.pass ? 'info' : 'error',
        detail: now.pass ? `检查转为通过 (实际: ${now.actual})` : `检查转为失败 (实际: ${now.actual}${now.expected !== null ? `, 期望: ${now.expected}` : ''})`,
      })
    }
  }
  for (const name of beforeAssertions.keys()) {
    if (!afterAssertions.has(name)) {
      push({ kind: 'assertion', moduleId: null, label: name, severity: 'warn', detail: '检查项消失(对应模块可能已不存在)' })
    }
  }

  for (const hint of current.markerHints) {
    if (!baseline.markerHints.includes(hint)) {
      push({ kind: 'hint', moduleId: null, label: '标记提示', severity: 'info', detail: hint })
    }
  }

  entries.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || a.kind.localeCompare(b.kind)
    || (a.moduleId ?? '').localeCompare(b.moduleId ?? '')
    || a.detail.localeCompare(b.detail))

  return { target: current.target, viewportChanged, entries, identical: entries.length === 0 }
}
