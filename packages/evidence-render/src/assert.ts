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
        `标记模块 ${node.id} 已渲染`,
        node.visibility.displayed,
        node.visibility.displayed ? '已渲染' : '未渲染(display/visibility/零尺寸)',
        '已渲染',
      ))
      if (node.visibility.clipped) {
        out.push(result(`标记模块 ${node.id} 无溢出裁剪`, false, '内容被祖先 overflow 裁剪', '无裁剪', 'warn'))
      }
    }

    if (node.interactive !== null) {
      // Keyboard reachability: the "absolute-positioned button falls out of
      // the tab order" pitfall — the flagship demo of this whole layer.
      if (!node.interactive.disabled) {
        out.push(result(
          `${node.label} 可被 Tab 选中`,
          node.interactive.tabbable,
          node.interactive.tabbable ? '在 Tab 顺序中' : '不在 Tab 顺序中',
          '在 Tab 顺序中',
        ))
      }
      out.push(result(
        `${node.label} 未被遮挡`,
        !node.visibility.occluded,
        node.visibility.occluded
          ? `被遮挡${node.visibility.occludedBy !== null ? `(遮挡者: ${node.visibility.occludedBy})` : ''}`
          : '中心点可命中',
        '中心点可命中',
      ))
    }

    // Readability floor for text-bearing modules (WCAG AA for normal text).
    if (node.style.contrastRatio !== null) {
      out.push(result(
        `${node.label} 文字对比度 ≥ 4.5`,
        node.style.contrastRatio >= 4.5,
        `实测 ${node.style.contrastRatio.toFixed(1)}`,
        '≥ 4.5',
        node.style.contrastRatio >= 3 ? 'warn' : 'error',
      ))
    }
  }

  out.push(result(
    '页面有且仅有一个 main 地标',
    mainCount === 1,
    mainCount === 1 ? '1 个' : `${mainCount} 个`,
    '1 个',
    'warn',
  ))
  return out
}
