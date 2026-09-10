/**
 * `@clue-harness/kb-loop` — the self-improvement loop engine (M3a).
 *
 * Business-package discipline: depends only on sibling ClueHarness packages
 * (kb, evidence-render, util) — zero dsh imports. The Cordis face that drives
 * this engine from agent-loop events (tools/result observation, turn-boundary
 * inspection, retrieval injection) is M3b.
 *
 * @module @clue-harness/kb-loop
 */
export {
  DEFAULT_RENDER_SURFACE,
  classifyChanges,
  loadRenderSurfaceConfig,
  normalizeRelative,
  type RenderSurfaceConfig,
} from './classify.ts'
export {
  attributeEvidence,
  outcomeFromInspection,
  type AttributionOptions,
  type AttributionPlan,
  type EvidenceOutcome,
  type PlannedSignal,
} from './attribution.ts'
export { buildWorkLog, loadWorkLog, saveWorkLog, type WorkLog } from './worklog.ts'
export {
  evidenceFailureStreak,
  runEvidenceLoop,
  type LoopOptions,
  type LoopReport,
  type PropagatedReview,
} from './loop.ts'
export {
  doubtLedgerPath,
  escalatedModules,
  markEscalated,
  openDoubtCounts,
  readDoubtLedger,
  recordDoubt,
  type DoubtEvent,
  type DoubtKind,
  type DoubtRecord,
  type EscalationEvent,
} from './doubt.ts'
export {
  entrySimilarity,
  overlapCoefficient,
  suggestGeneralizations,
  type GeneralizationOptions,
  type GeneralizationProposal,
  type GeneralizationScan,
} from './generalize.ts'
