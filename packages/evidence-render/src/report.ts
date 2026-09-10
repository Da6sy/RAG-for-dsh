/**
 * Human/model-facing report rendering (design doc §4.5: "输出=文本树+JSON+
 * 差异+检查结果"). Pure string work over diff/assert structures — the report
 * is what a model reads to decide what to fix, so its wording is part of the
 * product: every entry must be ACTIONABLE ("moved from A to B, relation
 * changed from X to Y"), never vague ("looks different").
 *
 * @module @clue-harness/evidence-render/report
 */
import type { DiffReport } from './diff.ts'
import type { LayoutSnapshot } from './types.ts'

const SEVERITY_ICON = { error: '✗', warn: '⚠', info: '·' } as const

/**
 * Render a diff report as text.
 * @param report - the diff output.
 * @param options - staleness/confirmation context lines to prepend.
 * @returns multi-line text ending with a newline.
 */
export function serializeDiffText(
  report: DiffReport,
  options: { stale?: boolean; unconfirmed?: boolean } = {},
): string {
  const lines: string[] = []
  lines.push(`差异报告 — ${report.target}`)
  if (options.stale === true) {
    lines.push('⚠ 基准已过期:绑定的源文件内容变了,以下差异可能包含"代码本来就该变"的部分;确认后请用 --record 重建基准。')
  }
  if (options.unconfirmed === true) {
    lines.push('⚠ 基准尚未经人工确认(--confirm),比对结果仅供参考。')
  }
  if (report.identical) {
    lines.push('与基准完全一致:没有结构、位置、尺寸、可见性或检查项变化。')
    return `${lines.join('\n')}\n`
  }
  lines.push(`共 ${report.entries.length} 处变化:`)
  for (const entry of report.entries) {
    lines.push(`${SEVERITY_ICON[entry.severity]} [${entry.kind}] ${entry.label}: ${entry.detail}`)
  }
  const errors = report.entries.filter((e) => e.severity === 'error').length
  const warns = report.entries.filter((e) => e.severity === 'warn').length
  lines.push('')
  lines.push(`小结: ${errors} 项严重 · ${warns} 项警告 · ${report.entries.length - errors - warns} 项提示`)
  return `${lines.join('\n')}\n`
}

/**
 * Render the assertions block (used by both `show` and `compare` reports).
 * @param snapshot - the capture whose assertions to render.
 * @returns multi-line text (no trailing newline duplication).
 */
export function serializeAssertionsText(snapshot: LayoutSnapshot): string {
  const lines: string[] = ['检查:']
  if (snapshot.assertions.length === 0) {
    lines.push('  (未运行断言)')
    return lines.join('\n')
  }
  for (const assertion of snapshot.assertions) {
    const expected = assertion.expected !== null ? `  期望: ${assertion.expected}` : ''
    lines.push(`  ${assertion.pass ? '✓' : '✗'} [${assertion.severity}] ${assertion.name}  实际: ${assertion.actual}${expected}`)
  }
  const failed = snapshot.assertions.filter((a) => !a.pass).length
  if (failed > 0) lines.push(`  (${failed} 项未通过)`)
  return lines.join('\n')
}
