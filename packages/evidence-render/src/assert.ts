/**
 * The built-in L2 assertion library (design doc §4.2: "这一层才是真正的证据").
 *
 * M1 ships a small starter set derived from snapshot facts alone — no extra
 * browser work. From M3 on, the KB's assertion library grows from real
 * failures (Judge proposes new assertions, human approves); this file stays
 * as the always-on floor.
 *
 * Pure logic over a snapshot: fully unit-testable, deterministic order
 * (document order via the tree walk).
 *
 * @module @clue-harness/evidence-render/assert
 */
import type { AssertionResult, LayoutSnapshot, ModuleNode } from './types.ts'

/** Walk the tree in document order (repeat expansions included). */
function walk(nodes: readonly ModuleNode[], visit: (node: ModuleNode) => void): void {
  for (const node of nodes) {
    visit(node)
    if (node.repeat !== null) walk(node.repeat.expanded, visit)
    walk(node.children, visit)
  }
}

const result = (name: string, pass: boolean, actual: string, expected: string | null, severity: 'error' | 'warn' = 'error'): AssertionResult =>
  ({ name, pass, actual, expected, severity })

/**
 * Run the built-in assertion set over one snapshot.
 * @param snapshot - the normalized capture (assertions run post-extraction).
 * @returns deterministic assertion results in document order.
 */
export function runBuiltinAssertions(snapshot: LayoutSnapshot): AssertionResult[] {
  const out: AssertionResult[] = []
  const modules: ModuleNode[] = []
  walk(snapshot.modules, (node) => modules.push(node))

  let mainCount = 0
  for (const node of modules) {
    if (node.kind === 'landmark' && node.label === '主区域') mainCount += 1

    // Marker modules must actually render — an invisible marked module means
    // the page under test is not the page the author meant.
    if (node.kind === 'marker') {
      out.push(result(
        `marked module ${node.id} renders`,
        node.visibility.displayed,
        node.visibility.displayed ? 'rendered' : 'not rendered (display/visibility/zero size)',
        'rendered',
      ))
      if (node.visibility.clipped) {
        out.push(result(`marked module ${node.id} has no overflow clipping`, false, 'content clipped by an ancestor overflow', 'no clipping', 'warn'))
      }
    }

    if (node.interactive !== null) {
      // Keyboard reachability: the "absolute-positioned button falls out of
      // the tab order" pitfall — the flagship demo of this whole layer.
      if (!node.interactive.disabled) {
        out.push(result(
          `${node.label} can be reached via Tab`,
          node.interactive.tabbable,
          node.interactive.tabbable ? 'in tab order' : 'not in tab order',
          'in tab order',
        ))
      }
      out.push(result(
        `${node.label} is not occluded`,
        !node.visibility.occluded,
        node.visibility.occluded
          ? `occluded${node.visibility.occludedBy !== null ? ` (by ${node.visibility.occludedBy})` : ''}`
          : 'center point is hit-testable',
        'center point is hit-testable',
      ))
    }

    // Readability floor for text-bearing modules (WCAG AA for normal text).
    if (node.style.contrastRatio !== null) {
      out.push(result(
        `${node.label} text contrast ≥ 4.5`,
        node.style.contrastRatio >= 4.5,
        `measured ${node.style.contrastRatio.toFixed(1)}`,
        '≥ 4.5',
        node.style.contrastRatio >= 3 ? 'warn' : 'error',
      ))
    }
  }

  out.push(result(
    'page has exactly one main landmark',
    mainCount === 1,
    mainCount === 1 ? '1' : `${mainCount}`,
    '1',
    'warn',
  ))
  return out
}
