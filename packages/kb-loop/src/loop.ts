/**
 * The evidence-loop orchestrator (M3a engine form).
 *
 * One call = one closed-loop pass over a work unit:
 *   classify changes (§4.3 trigger rule)
 *     → inspect ONLY if renderable files changed and a page is known
 *     → attribute the outcome to referenced knowledge (conservatively)
 *     → record weighted signals into the KB ledger
 *     → freshness-check referenced entries' bindings
 *     → sweep (expire / strong-negative / purge / promotion suggestions)
 *
 * The Cordis face (M3b) will call this same engine from turn-boundary
 * listeners; the CLI calls it from `clue kb loop`. Engine first, faces on
 * demand — the M1/M2 precedent.
 *
 * @module @clue-harness/kb-loop/loop
 */
import path from 'node:path'
import {
  openGlobalStore,
  openProjectStore,
  readSignals,
  type KbEntry,
  type KbStore,
  type SignalRecord,
} from '@clue-harness/kb'
import { inspectPage, type InspectResult } from '@clue-harness/evidence-render'
import { classifyChanges, loadRenderSurfaceConfig, type RenderSurfaceConfig } from './classify.ts'
import { attributeEvidence, outcomeFromInspection, type AttributionPlan, type EvidenceOutcome } from './attribution.ts'
import type { WorkLog } from './worklog.ts'

export interface LoopOptions {
  worklog: WorkLog
  /** ClueHarness home override (tests/demos). */
  home?: string
  /** Extra volatile-mask selectors for the inspection. */
  maskSelectors?: string[]
  viewport?: { width: number; height: number }
  /**
   * Injectable inspection result (tests / pre-run inspections). When absent,
   * the loop runs `inspectPage` itself iff renderable files changed AND the
   * worklog names a page — the trigger rule enforced in code, not convention.
   */
  inspection?: InspectResult
  /** Skip the maintenance sweep (e.g. when the caller sweeps on a schedule). */
  noSweep?: boolean
  /**
   * Consecutive attributed evidence failures that flag a GLOBAL entry 待复核
   * (design §3.6 失败传播: 否则同一个坑在每个项目重踩一遍). Default 2 —
   * "连续验证失败" is plural, and one project's odd bug must not put a
   * global entry under review by itself.
   */
  globalFailureStreak?: number
}

/** One failure-propagation act (the report's observable). */
export interface PropagatedReview {
  entryId: string
  streak: number
  reason: string
}

export interface LoopReport {
  surface: RenderSurfaceConfig
  renderable: string[]
  other: string[]
  /** Null when the trigger rule skipped inspection (backend-only unit). */
  outcome: EvidenceOutcome | null
  plan: AttributionPlan | null
  recorded: SignalRecord[]
  /** Entries freshly flagged 待复核 by the binding check. */
  needsReviewRaised: string[]
  /** Global entries freshly flagged 待复核 by failure propagation (M5). */
  propagated: PropagatedReview[]
  sweep: Awaited<ReturnType<KbStore['sweep']>> | null
  inspection: InspectResult | null
}

const DEFAULT_GLOBAL_FAILURE_STREAK = 2

/**
 * Count the trailing consecutive attributed evidence failures of one entry
 * in its ledger. Any evidence PASS (or a human signal) breaks the streak —
 * "连续" means exactly that, read from the ledger, no extra state.
 * @param signals - the entry's own ledger rows, chronological.
 * @returns the trailing failure streak length.
 */
export function evidenceFailureStreak(signals: readonly SignalRecord[]): number {
  let streak = 0
  for (let i = signals.length - 1; i >= 0; i -= 1) {
    const record = signals[i]
    if (record.source !== 'evidence') break
    if (record.polarity !== 'negative') break
    streak += 1
  }
  return streak
}

/**
 * Run one closed-loop pass.
 * @param options - the work unit and knobs.
 * @returns everything that happened, for printing and for the M3b events.
 */
export async function runEvidenceLoop(options: LoopOptions): Promise<LoopReport> {
  const { worklog } = options
  const store = await openProjectStore(worklog.projectRoot, options.home)
  const surface = await loadRenderSurfaceConfig(worklog.projectRoot, options.home)
  const { renderable, other } = classifyChanges(worklog.changedFiles, surface)

  // Load the referenced entries across BOTH tiers: a session may have cited
  // global knowledge (retrieval merges tiers, so attribution must too).
  // Missing ids are reported, never fatal — a purged entry referenced by an
  // old worklog must not brick the loop.
  let globalStore: KbStore | null = null
  const referenced: KbEntry[] = []
  const owning = new Map<string, KbStore>()
  const missing: string[] = []
  for (const id of worklog.referencedEntryIds) {
    const local = await store.get(id as KbEntry['id'])
    if (local !== null) {
      referenced.push(local)
      owning.set(String(local.id), store)
      continue
    }
    globalStore ??= await openGlobalStore(options.home)
    const global = await globalStore.get(id as KbEntry['id'])
    if (global === null) missing.push(id)
    else {
      referenced.push(global)
      owning.set(String(global.id), globalStore)
    }
  }

  // Binding freshness on referenced entries (raises 待复核 orthogonally).
  // Project tier only: checkBindings itself ignores global entries (their
  // bindings, if any, point into no particular project).
  const needsReviewRaised: string[] = []
  for (const entry of referenced) {
    if (entry.tier === 'global' || entry.bindings.length === 0) continue
    const before = entry.needsReview
    const after = await store.checkBindings(entry.id)
    if (!before && after.needsReview) needsReviewRaised.push(entry.id)
  }

  // The trigger rule (§4.3): inspection happens ONLY for renderable changes.
  let inspection = options.inspection ?? null
  if (inspection === null && worklog.page !== undefined && renderable.length > 0) {
    inspection = await inspectPage({
      projectRoot: worklog.projectRoot,
      page: worklog.page,
      mode: 'compare',
      maskSelectors: options.maskSelectors,
      viewport: options.viewport,
    })
  }
  const outcome = inspection === null ? null : outcomeFromInspection(inspection)

  // Attribution → signals, each recorded in the tier that OWNS the entry.
  let plan: AttributionPlan | null = null
  const recorded: SignalRecord[] = []
  const propagated: PropagatedReview[] = []
  if (outcome !== null && referenced.length > 0) {
    plan = attributeEvidence(outcome, referenced, renderable, {
      ...(worklog.attributionMode !== undefined ? { attributionMode: worklog.attributionMode } : {}),
      projectLabel: path.basename(worklog.projectRoot),
    })
    for (const planned of [...plan.pass, ...plan.fail]) {
      const owner = owning.get(String(planned.entryId)) ?? store
      recorded.push(await owner.recordSignal(planned.entryId, planned.signal, planned.note))
    }
    // Failure propagation (design §3.6): a GLOBAL entry whose attributed
    // failures stack up gets flagged 待复核 in its own ledger — the flag is
    // what every project's retrieval annotations will now carry.
    const streakBound = options.globalFailureStreak ?? DEFAULT_GLOBAL_FAILURE_STREAK
    if (globalStore !== null) {
      const ledger = await readSignals(path.join(globalStore.dir, 'signals.jsonl'))
      for (const entry of referenced) {
        if (entry.tier !== 'global') continue
        const mine = ledger.filter((record) => record.entryId === entry.id)
        const streak = evidenceFailureStreak(mine)
        if (streak < streakBound) continue
        const before = entry.needsReview
        const reason = `失败传播: 连续 ${streak} 次归因成立的验证失败(最近项目 ${path.basename(worklog.projectRoot)})`
        const after = await globalStore.flagNeedsReview(entry.id, reason)
        if (!before && after.needsReview) propagated.push({ entryId: String(entry.id), streak, reason })
      }
    }
  }

  const sweep = options.noSweep === true ? null : await store.sweep()

  if (missing.length > 0) {
    // Surface, don't hide: the report is the loop's observable.
    plan = plan ?? { pass: [], fail: [], unattributed: [] }
    for (const id of missing) plan.unattributed.push({ entryId: id as KbEntry['id'], reason: '工单引用的条目已不存在(可能已被清退)' })
  }

  return { surface, renderable, other, outcome, plan, recorded, needsReviewRaised, propagated, sweep, inspection }
}
