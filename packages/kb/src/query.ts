/**
 * M2 retrieval: scan-based, deterministic, status-aware.
 *
 * Scope honesty (flagged deviation): the design's M2 row listed SQLite/FTS
 * and embedding as "nice to have here"; we deliberately ship the simplest
 * retrieval that satisfies the acceptance ("手动放一条知识→检索到") and defer
 * ranking quality to the rag package (M3/M4) where it becomes MEASURABLE
 * (eval sets, hybrid weights). Scanning facts is fine at interview scale
 * (hundreds–thousands of entries) and keeps facts the only dependency.
 *
 * Doctrine encoded here (decisions #9/#10/#14):
 * - a query hit TOUCHES the entry (drives the expire timer) but records NO
 *   implicit signal — "retrieved" alone must never move scores (that needs
 *   "used AND uncorrected", which only the M3 loop can observe);
 * - expired entries are excluded by default; with includeExpired they come
 *   back ANNOTATED (读=放行带标注 — the read side of the expired tiering);
 * - discarded entries are never returned;
 * - global hits rank below project hits (tier factor — project shadows
 *   global, the same "nearer scope wins" shape as lesson 7's tool shadowing);
 * - needsReview hits are annotated (the model must see "may be stale").
 *
 * Tokenizer: ASCII words (≥2 chars) + CJK bigrams — bigrams make 2-character
 * Chinese queries work, which FTS5's trigram tokenizer could not.
 *
 * @module @clue-harness/kb/query
 */
import type { KbStore } from './store.ts'
import type { KbEntry, KbKind } from './types.ts'

export interface QueryOptions {
  /** Query text. */
  text: string
  kinds?: KbKind[]
  /** Include expired entries (annotated). Default false (decision #10). */
  includeExpired?: boolean
  /** Also search the global tier (merged under the project tier). Default true. */
  includeGlobal?: boolean
  limit?: number
  /** Skip the reference touch (read-only inspection, e.g. tests/demos). */
  noTouch?: boolean
  /**
   * Field weights for scoring (the M2 promise: configurable once the rag
   * package owns retrieval tuning). Absent fields keep the shipped defaults
   * title 3 / tag 2 / text 1 — behavior is unchanged unless a caller tunes.
   */
  weights?: Partial<RetrievalWeights>
  now?: Date
}

/** The tunable scoring weights (rag-package config surface). */
export interface RetrievalWeights {
  /** Title-token match weight. */
  title: number
  /** Tag-token match weight. */
  tag: number
  /** Body-token match weight. */
  text: number
}

/** The shipped defaults (M2 decision: 标题×3 / 标签×2 / 正文×1). */
export const DEFAULT_WEIGHTS: RetrievalWeights = { title: 3, tag: 2, text: 1 }

export interface QueryHit {
  entry: KbEntry
  score: number
  /** Which query tokens matched where (title/tag/text) — explainable retrieval. */
  matched: string[]
  /** Status/review annotations the consumer MUST show alongside the hit. */
  annotations: string[]
}

/** Split text into deterministic match tokens (ASCII words + CJK bigrams). */
export function tokenize(text: string): string[] {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9_]{2,}/g)) tokens.add(match[0])
  for (const run of lower.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run)
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.add(run.slice(i, i + 2))
  }
  return [...tokens].sort()
}

const STATUS_FACTOR: Record<string, number> = { trusted: 1, candidate: 0.85, expired: 0.5 }
const TIER_FACTOR: Record<string, number> = { project: 1, global: 0.8 }

function scoreEntry(entry: KbEntry, queryTokens: readonly string[], weights: RetrievalWeights): { score: number; matched: string[] } {
  const titleTokens = new Set(tokenize(entry.title))
  const tagTokens = new Set(tokenize(entry.tags.join(' ')))
  const textTokens = new Set(tokenize(entry.text))
  let score = 0
  const matched: string[] = []
  for (const token of queryTokens) {
    let hit = 0
    if (titleTokens.has(token)) hit += weights.title
    if (tagTokens.has(token)) hit += weights.tag
    if (textTokens.has(token)) hit += weights.text
    if (hit > 0) {
      score += hit
      matched.push(token)
    }
  }
  if (score === 0) return { score: 0, matched: [] }
  const adjusted = score
    * (STATUS_FACTOR[entry.status] ?? 0)
    * (TIER_FACTOR[entry.tier] ?? 1)
    * (entry.needsReview ? 0.7 : 1)
  return { score: Math.round(adjusted * 100) / 100, matched }
}

/**
 * The status/review annotations a consumer MUST show alongside an entry
 * (decision #10/#21's presentation law). Exported for retrieval providers
 * that synthesize hits outside queryKb (the rag package's binding-recall
 * channel) — the discipline travels with the data, one implementation.
 * @param entry - the entry to annotate.
 * @returns the annotation lines (empty for a clean trusted project entry).
 */
export function annotationsFor(entry: KbEntry): string[] {
  const notes: string[] = []
  if (entry.status === 'expired') notes.push('已过期、未复核 — 可读不可直接作为写操作依据(引用需审批)')
  if (entry.status === 'candidate') notes.push('候选知识(尚未人工批准为可信)')
  if (entry.needsReview) notes.push(`待复核: ${entry.reviewReason ?? '原因未记录'}`)
  if (entry.tier === 'global') notes.push('来自全局库(项目库同题知识优先)')
  return notes
}

/**
 * Query one or two tiers, merged with project precedence.
 * @param project - the project-tier store (optional when querying global only).
 * @param global - the global-tier store (skipped when includeGlobal is false).
 * @param options - query knobs.
 * @returns ranked hits (deterministic: score desc, then tier, then id).
 */
export async function queryKb(
  project: KbStore | null,
  global: KbStore | null,
  options: QueryOptions,
): Promise<QueryHit[]> {
  const queryTokens = tokenize(options.text)
  if (queryTokens.length === 0) return []
  const limit = options.limit ?? 8
  const weights: RetrievalWeights = { ...DEFAULT_WEIGHTS, ...options.weights }
  const now = options.now ?? new Date()
  const at = now.toISOString()

  const tiers: KbStore[] = []
  if (project !== null) tiers.push(project)
  if (global !== null && options.includeGlobal !== false) tiers.push(global)

  const hits: QueryHit[] = []
  for (const store of tiers) {
    for (const entry of await store.list()) {
      if (entry.status === 'discarded') continue
      if (entry.status === 'expired' && options.includeExpired !== true) continue
      if (options.kinds !== undefined && !options.kinds.includes(entry.kind)) continue
      const { score, matched } = scoreEntry(entry, queryTokens, weights)
      if (score === 0 || matched.length === 0) continue
      hits.push({ entry, score, matched, annotations: annotationsFor(entry) })
    }
  }

  // Binding freshness is checked on the way out: a hit on a stale-bound entry
  // must arrive annotated (this is the M2 acceptance "改绑定文件→自动待复核").
  const freshened: QueryHit[] = []
  for (const hit of hits) {
    const store = hit.entry.tier === 'global' ? global : project
    let entry = hit.entry
    if (store !== null && entry.bindings.length > 0) {
      entry = await store.checkBindings(entry.id, at)
    }
    if (!options.noTouch && store !== null) {
      entry = await store.touch(entry.id, at)
    }
    freshened.push({ ...hit, entry, annotations: annotationsFor(entry) })
  }

  freshened.sort((a, b) =>
    b.score - a.score
    || (a.entry.tier === b.entry.tier ? 0 : a.entry.tier === 'project' ? -1 : 1)
    || a.entry.id.localeCompare(b.entry.id))
  return freshened.slice(0, limit)
}
