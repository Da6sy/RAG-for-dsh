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

/** Opaque document id (branded — the immutable snapshot's name). */
export type KbDocId = Branded<'KbDocId'>

/** Brand a string as a {@link KbDocId} (zero runtime cost). */
export function KbDocId(id: string): KbDocId {
  return id as KbDocId
}

/**
 * The four lifecycle states (decision #8; user's original four-phase design)
 * plus M9's `superseded` — the TERMINAL state a split leaves behind (proposal
 * §3/§5b): excluded from retrieval and generalization, stats frozen, never
 * swept, never revivable. The provenance chain must outlive every retention
 * window, which is exactly why it is NOT `discarded`.
 */
export type KbStatus = 'candidate' | 'trusted' | 'expired' | 'discarded' | 'superseded'

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

/**
 * Where in an immutable document snapshot a knowledge entry's evidence sits
 * (M9, proposal §3) — the EVIDENCE LOCATION, never an identity. Line numbers
 * never drift because the snapshot is immutable; `quoteAnchor` is what lets a
 * human align摘要↔原文 across versions (拍板 1: 段首 40 字).
 */
export interface DocAnchor {
  /** Markdown heading path (`## A > ### B`) when the段 sits under headings. */
  headingPath?: string
  /** Inclusive 1-based line range in `docs/<docId>.md`. */
  lines?: [number, number]
  /** First 40 characters of the段 — for humans and cross-version alignment. */
  quoteAnchor: string
}

/**
 * A human-authored redline inside an entry (M9-4, proposal §5a): the "this part
 * is wrong now" annotation that takes those lines out of BOTH display and
 * scoring, without touching the entry's single governance粒度. Binding is to a
 * concrete `docId` — never to a source path (invariant 2).
 */
export interface KbRedline {
  /** The kind of range this redline removes. */
  target: 'doc' | 'text'
  /** The snapshot the lines refer to (absent for `text` targets). */
  docId?: KbDocId
  /** 1-based inclusive line range; absent for `text` targets. */
  lines?: [number, number]
  /** First 40 characters of the redlined段 (human/version alignment). */
  quoteAnchor: string
  headingPath?: string
  /** 1-based inclusive character range for `text` targets. */
  chars?: [number, number]
  /** Why the段 is wrong (lands in the entry's history verbatim). */
  reason: string
  at: string
  /** Who did it — a human surface ('cli' | 'web'), never a model. */
  by: string
}

/**
 * The document pointer one entry may carry (proposal §3). Optional by design:
 * entries without one keep their pre-M9 behavior exactly.
 */
export interface EntryDocRef {
  docId: KbDocId
  anchor?: DocAnchor
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
  /** Status transition, an orthogonal flag change, an audited text edit, or
   *  one of M9's entry-internal governance acts (redline) / lifecycle events
   *  (split). */
  change: 'status' | 'needsReview' | 'reviewCleared' | 'rebind' | 'textUpdated' | 'redline' | 'split'
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
  /**
   * M9 (optional): the immutable原文 snapshot this entry's evidence lives in.
   * Absent = the entry's own正文 is all there is (the pre-M9 shape).
   */
  doc?: EntryDocRef
  /**
   * M9-4 (optional): human redlines —段-level "this part is wrong now". They
   * filter BOTH display and scoring; the entry stays the only治理 subject.
   */
  redlines?: KbRedline[]
  /**
   * M9-4 (optional): set on the OLD entry when a split supersedes it — where
   * its knowledge went. The new entries inherit evidence, never governance.
   */
  splitInto?: KbEntryId[]
}

/**
 * One immutable document snapshot's record (proposal §3). The bytes live in
 * `docs/<docId>.md`; this record is what drift detection hashes against and
 * what the panel lists. It carries NO status, NO signal, NO lifecycle: a
 * Document is evidence, and evidence is never governed (宪法 3).
 */
export interface DocRecord {
  version: typeof KB_FORMAT_VERSION
  docId: KbDocId
  /** Project-relative path this snapshot was taken FROM (drift detection only). */
  sourcePath: string
  /** sha256 of the snapshot bytes (the immutability stamp). */
  contentHash: string
  /** sha256 of the SOURCE file at ingest time (what checkDocs compares). */
  sourceHash: string
  sizeChars: number
  /** Line count of the snapshot (line anchors are bounded by it). */
  lineCount: number
  ingestedAt: string
  /** The docId this snapshot replaces (a NEW version — never an overwrite). */
  supersedes?: KbDocId
}

/**
 * The embedding-normalization stamp (V0, 原规划 §5.2). It participates in
 * {@link embedderVersion} so that changing HOW vectors are normalized (L2 vs
 * none, truncation, pooling) invalidates the whole derived layer exactly like
 * a model or dimension change does — a vector computed under a different
 * norm is not comparable with one computed under this one.
 */
export const EMBED_NORM_VERSION = 'l2-v1'

/**
 * The ONE place an embedder version string is built (原规划 §5.2 不变量 8).
 *
 * M9 taught this lesson the hard way: `chunkerVersion` was written as a string
 * literal in three different files, so every query decided the ledger needed a
 * rebuild (坑 1 of `k-mtzi7ju0-a9b33b`). The vector layer must not repeat it,
 * so `embedderVersion` exists as this single exported function and nowhere
 * else; an architecture test pins that.
 *
 * @param input - the embedder's stable id (model name) and its REAL dimension.
 * @returns `<modelId>@dim=<dim>:<EMBED_NORM_VERSION>`.
 */
export function embedderVersion(input: { modelId: string; dim: number }): string {
  return `${input.modelId}@dim=${input.dim}:${EMBED_NORM_VERSION}`
}

/**
 * The lexical-index format stamp (落地计划 §2-1).
 *
 * Same rule as {@link embedderVersion}: the string is built in exactly ONE
 * place, and an architecture test pins that. The lesson is on the record —
 * `chunkerVersion` once lived as a literal in three files and every query
 * decided the ledger was stale (坑 1 of `k-mtzi7ju0-a9b33b`). The inverted
 * index is a derived layer of the same kind, so it gets the same treatment.
 *
 * Bump the trailing revision whenever the POSTINGS' meaning changes (fields,
 * tokenizer contract, presence-vs-count semantics) — a changed meaning with an
 * unchanged stamp is how a stale index keeps answering.
 */
export const LEXICAL_INDEX_FORMAT = 'lexical-v1'

/**
 * The ONE place a lexical-index version string is built.
 * @returns the format stamp the index files must carry.
 */
export function lexicalIndexVersion(): string {
  return `${LEXICAL_INDEX_FORMAT}:k1=${1.2}:b=${0.75}`
}

/**
 * One derived retrieval unit (proposal §3/§4). Chunks own NOTHING: no status,
 * no signal, no approval, no lifecycle. They are rebuilt from the immutable
 * snapshot whenever `chunkerVersion` no longer matches the current chunker.
 */
export interface ChunkRecord {
  /** 1-based position in the document (stable, deterministic). */
  seq: number
  headingPath: string
  /** 1-based inclusive line range in the snapshot. */
  startLine: number
  endLine: number
  chars: number
  /** First 40 characters of the段 (anchor for humans + redline alignment). */
  quoteAnchor: string
  /**
   * When this chunk was produced by the sliding window (no structure), the
   * `seq` it overlaps with — queryChunks dedupes on it (拍板 2).
   */
  overlapWith?: number
  /** The chunker configuration that produced this row. */
  chunkerVersion: string
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

/**
 * Actions that require a human decision (decision #12: batched, never popups).
 *
 * M9-4 adds `redline-review`: the threshold act of a划除占比 crossing
 * {@link REDLINE_PROPOSAL_RATIO} — the SYSTEM proposes split-or-discard and a
 * human decides (反自我豁免: a model may never redline, promote or split).
 */
export type ApprovalAction = 'promote' | 'discard' | 'rescue' | 'reactivate' | 'redline-review'

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
  /**
   * M9: the chunker configuration stamp. A `chunks/<docId>.jsonl` whose rows
   * carry a different stamp is REBUILT (派生可重建, proposal §2 宪法 2) — this
   * is the one number that makes a chunker change self-healing.
   */
  chunkerVersion: string
}

/** The shipped chunker shape: 结构优先段≤800; 无结构滑窗 800/600 (拍板 2). */
export const DEFAULT_CHUNKER_VERSION = 'struct-800-w800s600-v1'

/** The shipped window size in characters (one 段's budget). */
export const DEFAULT_CHUNK_CHARS = 800

/** The shipped step between two window starts (⇒ 200 characters of overlap). */
export const DEFAULT_WINDOW_STEP = 600

/** Characters of a段 quoted into its anchor (为人和跨版本对齐服务). */
export const DEFAULT_QUOTE_ANCHOR_CHARS = 40

/** The M9 redline threshold: beyond this划除占比 a split/discard proposal is queued. */
export const REDLINE_PROPOSAL_RATIO = 0.4

export const DEFAULT_KB_CONFIG: KbConfig = {
  windowDays: 30,
  expireAfterDays: 90,
  discardRetentionDays: 60,
  weights: { human: 5, evidence: 3, implicit: 1, userReject: -6, evidenceFail: -3 },
  trustThreshold: 20,
  objectiveKinds: ['asset', 'snippet', 'pitfall'],
  chunkerVersion: DEFAULT_CHUNKER_VERSION,
}

/** Directory meta: the realpath anchor that detects project-key collisions. */
export interface KbMeta {
  version: typeof KB_FORMAT_VERSION
  tier: KbTier
  /** Realpath of the project root this KB belongs to ('' for global). */
  projectRoot: string
  createdAt: string
}
