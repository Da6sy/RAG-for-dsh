/**
 * Knowledge-base vocabulary (design doc §3.2/§3.3/§3.4, decisions #5–#12, #24).
 *
 * Storage doctrine (decision: facts vs index split):
 * - FACTS (this file's shapes) live as one JSON file per entry under
 *   `<home>/kb/<project-key>/entries/` — human-readable, hand-fixable, the
 *   only source of truth; plus append-only `signals.jsonl` (lesson 8: the
 *   ledger is history, never rewritten) and a small `approvals.json` queue.
 * - INDEXES (FTS/vectors) are DERIVED and arrive with the rag package
 *   (M3/M4): they can always be rebuilt from facts, never the reverse.
 *
 * Determinism note: unlike render snapshots, entries legitimately carry
 * timestamps — they are records, not captures.
 *
 * @module @clue-harness/kb/types
 */
import type { Branded, SessionId } from '@clue-harness/compat'

/** Entry file format version; refuse-on-mismatch, never migrate (house style). */
export const KB_FORMAT_VERSION = 1

/** Opaque entry id (branded — cannot be mixed with plain strings or other brands). */
export type KbEntryId = Branded<'KbEntryId'>

/** Brand a string as a {@link KbEntryId} (zero runtime cost). */
export function KbEntryId(id: string): KbEntryId {
  return id as KbEntryId
}

/** The four lifecycle states (decision #8; user's original four-phase design). */
export type KbStatus = 'candidate' | 'trusted' | 'expired' | 'discarded'

/** Entry kinds (design §3.2). Rendering knowledge is a SUBSET (decision #24). */
export type KbKind = 'fact' | 'decision' | 'snippet' | 'map' | 'pitfall' | 'asset'

/** Which KB tier an entry lives in (decision #14: two tiers, project wins). */
export type KbTier = 'project' | 'global'

/** A bound source file: project-relative path + the content hash at binding time. */
export interface SourceBinding {
  /** Project-relative (decision #7: never absolute — survives moves). */
  path: string
  /** sha256 of the file bytes when the binding was recorded/last accepted. */
  contentHash: string
}

/** Where the knowledge came from — every entry can answer "who taught you this". */
export interface KbProvenance {
  /** 'cli' | 'agent:<id>' | 'generalization' | ... (free-form, honest label). */
  createdBy: string
  createdAt: string
  /** Optional session anchor (populated from M3 on, when the loop proposes). */
  session?: { id: SessionId; seq?: number }
  note?: string
}

/** One lifecycle/flag event in the entry's own history (audit trail). */
export interface KbHistoryEvent {
  at: string
  /** Status transition, an orthogonal flag change, or an audited text edit. */
  change: 'status' | 'needsReview' | 'reviewCleared' | 'rebind' | 'textUpdated'
  from: KbStatus | null
  to: KbStatus | boolean | null
  reason: string
}

/** A knowledge entry — the atom of the product's data asset. */
export interface KbEntry {
  version: typeof KB_FORMAT_VERSION
  id: KbEntryId
  tier: KbTier
  kind: KbKind
  title: string
  text: string
  tags: string[]
  /** Bound source files; hash drift raises the orthogonal needs-review flag. */
  bindings: SourceBinding[]
  provenance: KbProvenance
  status: KbStatus
  /** ORTHOGONAL to status (decision: not a fifth state): "may no longer hold". */
  needsReview: boolean
  reviewReason: string | null
  stats: {
    /** Last time the entry was surfaced by retrieval or explicitly used. */
    lastReferencedAt: string | null
    referenceCount: number
  }
  history: KbHistoryEvent[]
  /** Set when entering discarded; drives the 60-day retention purge (decision #11). */
  discardedAt: string | null
}

/** Signal polarity/source vocabulary (decision #9: tiered weights). */
export interface SignalRecord {
  at: string
  entryId: KbEntryId
  polarity: 'positive' | 'negative'
  /** human > evidence > implicit; negatives: user rejection > attributed evidence failure. */
  source: 'human' | 'evidence' | 'implicit'
  /** Signed weight, copied from config at record time (config changes never rewrite history). */
  weight: number
  note: string
}

/** Actions that require a human decision (decision #12: batched, never popups). */
export type ApprovalAction = 'promote' | 'discard' | 'rescue' | 'reactivate'

/** One pending (or resolved) item in the batched approval queue. */
export interface ApprovalRequest {
  id: string
  entryId: KbEntryId
  action: ApprovalAction
  reason: string
  /** Window score at request time (context for the decision, not re-checked). */
  scoreAtRequest: number
  createdAt: string
  resolvedAt: string | null
  resolution: 'approved' | 'rejected' | null
}

/** Tunables — every number the decisions named, in one configurable place. */
export interface KbConfig {
  /** Sliding window for score computation (decision #9: 30 days). */
  windowDays: number
  /** Unreferenced this long → expired (design §3.3 "长期未被引用"). */
  expireAfterDays: number
  /** Discarded entries retained this long, then purged (decision #11: 60). */
  discardRetentionDays: number
  weights: {
    /** You explicitly confirmed the knowledge. */
    human: number
    /** Objective evidence: attributed verification pass/fail. */
    evidence: number
    /** Implicit: surfaced AND used AND uncorrected (recorded by the M3 loop). */
    implicit: number
    /** You said "不对" — the heaviest negative (decision #9). */
    userReject: number
    /** Used as basis and verification failed, attributed (decision #9, accepted). */
    evidenceFail: number
  }
  /**
   * Window score that makes a candidate eligible for a promote REMINDER.
   * Confirmed at 20 (user decision): trust is earned slowly — roughly four
   * human confirmations, or a mixed basket (2×human + 2×evidence + 2×implicit
   * = 18… keep stacking). The discard bound is symmetric (-20), so a single
   * user rejection (-6) no longer discards on its own; sustained negativity
   * (e.g. 4 rejections = -24) does. A misclick cannot kill knowledge.
   */
  trustThreshold: number
  /**
   * Explicit discard bound (M5). Absent keeps the symmetric derivation
   * (-trustThreshold) on BOTH tiers — user decision: global knowledge is not
   * killed faster for being global; §3.6's "更敏感" is realized through
   * failure propagation (待复核 flags) instead. The field remains a
   * deployment knob for an explicitly different bound.
   */
  discardThreshold?: number
  /** Kinds whose promotion can be suggested on objective evidence alone. */
  objectiveKinds: KbKind[]
}

export const DEFAULT_KB_CONFIG: KbConfig = {
  windowDays: 30,
  expireAfterDays: 90,
  discardRetentionDays: 60,
  weights: { human: 5, evidence: 3, implicit: 1, userReject: -6, evidenceFail: -3 },
  trustThreshold: 20,
  objectiveKinds: ['asset', 'snippet', 'pitfall'],
}

/** Directory meta: the realpath anchor that detects project-key collisions. */
export interface KbMeta {
  version: typeof KB_FORMAT_VERSION
  tier: KbTier
  /** Realpath of the project root this KB belongs to ('' for global). */
  projectRoot: string
  createdAt: string
}
