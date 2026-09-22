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
  lines.push(`diff report — ${report.target}`)
  if (options.stale === true) {
    lines.push('⚠ baseline is stale: the bound source files changed, so the diff below may include changes the code was supposed to make; after reviewing, rebuild the baseline with --record.')
  }
  if (options.unconfirmed === true) {
    lines.push('⚠ baseline has not been human-confirmed (--confirm) yet; treat this comparison as reference only.')
  }
  if (report.identical) {
    lines.push('identical to the baseline: no structure, position, size, visibility or assertion changes.')
    return `${lines.join('\n')}\n`
  }
  lines.push(`${report.entries.length} changes:`)
  for (const entry of report.entries) {
    lines.push(`${SEVERITY_ICON[entry.severity]} [${entry.kind}] ${entry.label}: ${entry.detail}`)
  }
  const errors = report.entries.filter((e) => e.severity === 'error').length
  const warns = report.entries.filter((e) => e.severity === 'warn').length
  lines.push('')
  lines.push(`summary: ${errors} error · ${warns} warn · ${report.entries.length - errors - warns} info`)
  return `${lines.join('\n')}\n`
}

/**
 * Render the assertions block (used by both `show` and `compare` reports).
 * @param snapshot - the capture whose assertions to render.
 * @returns multi-line text (no trailing newline duplication).
 */
export function serializeAssertionsText(snapshot: LayoutSnapshot): string {
  const lines: string[] = ['checks:']
  if (snapshot.assertions.length === 0) {
    lines.push('  (no assertions ran)')
    return lines.join('\n')
  }
  for (const assertion of snapshot.assertions) {
    const expected = assertion.expected !== null ? `  expected: ${assertion.expected}` : ''
    lines.push(`  ${assertion.pass ? '✓' : '✗'} [${assertion.severity}] ${assertion.name}  actual: ${assertion.actual}${expected}`)
  }
  const failed = snapshot.assertions.filter((a) => !a.pass).length
  if (failed > 0) lines.push(`  (${failed} failed)`)
  return lines.join('\n')
}
