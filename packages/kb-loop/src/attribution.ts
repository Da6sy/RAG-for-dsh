/**
 * Evidence → signal attribution (decision #9's "归因成立才记中等负信号").
 *
 * The conservatism rule is the whole point:
 * - a PASSING verification credits every referenced entry (cheap, safe);
 * - a FAILING verification penalizes an entry ONLY when attribution holds —
 *   the entry is bound to at least one of the changed renderable files.
 *   Unbound or unrelated-binding entries land in `unattributed` and receive
 *   NO signal: punishing knowledge we cannot tie to the failure is how good
 *   entries get murdered by unrelated bugs.
 *
 * @module @clue-harness/kb-loop/attribution
 */
import type { KbEntry } from '@clue-harness/kb'
import type { InspectResult } from '@clue-harness/evidence-render'
import { normalizeRelative } from './classify.ts'

/** The evidence verdict distilled to what attribution needs. */
export interface EvidenceOutcome {
  /** No error-severity diff entries and no failed error-severity assertions. */
  exitOk: boolean
  errorCount: number
  failedAssertions: string[]
  errorEntrySummaries: string[]
}

/**
 * Distill an inspection result into an outcome.
 * @param result - the render inspection result (compare or show mode).
 * @returns the attribution-facing verdict.
 */
export function outcomeFromInspection(result: InspectResult): EvidenceOutcome {
  const failedAssertions = (result.snapshot?.assertions ?? [])
    .filter((a) => !a.pass)
    .map((a) => `${a.name}(实际: ${a.actual})`)
  const errorEntries = (result.diff?.entries ?? [])
    .filter((e) => e.severity === 'error')
    .map((e) => `[${e.kind}] ${e.label}: ${e.detail}`)
  return {
    exitOk: result.exitOk,
    errorCount: errorEntries.length + failedAssertions.length,
    failedAssertions,
    errorEntrySummaries: errorEntries,
  }
}

/** One planned signal (the loop records these through KbStore). */
export interface PlannedSignal {
  entryId: KbEntry['id']
  signal: 'evidence-pass' | 'evidence-fail'
  note: string
}

export interface AttributionPlan {
  pass: PlannedSignal[]
  fail: PlannedSignal[]
  /** Referenced entries that receive nothing, with the reason (transparency). */
  unattributed: Array<{ entryId: KbEntry['id']; reason: string }>
}

/**
 * Attribution context for one plan (M5: tier-aware failure rules).
 */
export interface AttributionOptions {
  /**
   * How the referenced set was gathered. 'cited' (kb_cite declarations) is
   * precise enough to attribute failures of GLOBAL entries, which carry no
   * project bindings for the second gate to check. 'surfaced' (or absent)
   * keeps global entries unattributable on failure — the exposure
   * approximation must never punish knowledge across every project.
   */
  attributionMode?: 'cited' | 'surfaced'
  /** Human project label for audit notes (e.g. the root's basename). */
  projectLabel?: string
}

/**
 * Build the signal plan for one verification outcome.
 * @param outcome - the distilled verdict.
 * @param referenced - entries actually used as basis in this work unit.
 * @param changedRenderable - renderable files this unit changed (normalized-relative).
 * @param options - attribution mode and audit label.
 * @returns the plan; recording is the caller's job.
 */
export function attributeEvidence(
  outcome: EvidenceOutcome,
  referenced: readonly KbEntry[],
  changedRenderable: readonly string[],
  options: AttributionOptions = {},
): AttributionPlan {
  const plan: AttributionPlan = { pass: [], fail: [], unattributed: [] }
  const changed = new Set(changedRenderable.map(normalizeRelative))
  const where = options.projectLabel !== undefined && options.projectLabel !== '' ? `,项目 ${options.projectLabel}` : ''

  for (const entry of referenced) {
    if (outcome.exitOk) {
      plan.pass.push({
        entryId: entry.id,
        signal: 'evidence-pass',
        note: `渲染验证通过(引用过该知识${where})`,
      })
      continue
    }
    // Failure: attribution via source bindings ∩ changed renderable files.
    const involved = entry.bindings
      .map((b) => normalizeRelative(b.path))
      .filter((p) => changed.has(p))
    if (involved.length > 0) {
      const failures = [...outcome.errorEntrySummaries, ...outcome.failedAssertions].slice(0, 3)
      plan.fail.push({
        entryId: entry.id,
        signal: 'evidence-fail',
        note: `渲染验证失败且归因成立(绑定文件 ${involved.join(', ')} 在本次改动中${where}): ${failures.join(' | ') || '存在 error 级证据'}`,
      })
      continue
    }
    // GLOBAL entries carry no project bindings (they transcend any one
    // project's files). Their failure gate is the PRECISE citation itself:
    // the model declared this entry as its basis AND verification failed.
    // The exposure approximation never attributes across projects (design
    // §3.6 失败传播 must not degenerate into cross-project blame).
    if (entry.tier === 'global' && options.attributionMode === 'cited') {
      const failures = [...outcome.errorEntrySummaries, ...outcome.failedAssertions].slice(0, 3)
      plan.fail.push({
        entryId: entry.id,
        signal: 'evidence-fail',
        note: `渲染验证失败且归因成立(全局条目,模型精确引用为依据${where}): ${failures.join(' | ') || '存在 error 级证据'}`,
      })
      continue
    }
    if (entry.tier === 'global') {
      plan.unattributed.push({ entryId: entry.id, reason: '全局条目无项目绑定且引用非精确(曝光回退),失败不可归因,不记信号' })
    } else if (entry.bindings.length === 0) {
      plan.unattributed.push({ entryId: entry.id, reason: '条目无源文件绑定,失败不可归因,不记信号' })
    } else {
      plan.unattributed.push({ entryId: entry.id, reason: '绑定的文件不在本次改动内,失败不可归因,不记信号' })
    }
  }
  return plan
}
