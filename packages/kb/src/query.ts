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
import { tokenize } from './tokenize.ts'
import { bm25Fields, bm25fScore, buildLexicalStats, type LexicalStats } from './bm25.ts'
import type { KbStore } from './store.ts'
import { readChunks } from './docs.ts'
import type { KbEntry, KbEntryId, KbKind, KbRedline } from './types.ts'

export interface QueryOptions {
  /**
   * R1 (落地计划 §2-1): validated inverted indexes, project tier first.
   *
   * When present, the first level never materializes the corpus: the statistics
   * come from the index and only the entries that actually contain one of the
   * query's tokens are loaded and scored. Absent/empty ⇒ the scan path, which
   * is still the reference implementation.
   */
  lexicalIndexes?: readonly LexicalIndex[]
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
  /** Which first-level formula to score with. Default 'bm25' (see {@link LexicalScorer}). */
  scorer?: LexicalScorer
  now?: Date
}

/**
 * Which first-level ranking formula to use (R2 of the BM25 plan).
 *
 * `weights` is the pre-R2 behavior (bare sum of field weights) and exists so
 * that `lexicalScorer: 'weights'` reproduces it EXACTLY — the rollback switch
 * the plan requires, pinned by a test. `bm25` is the shipping default.
 */
export type LexicalScorer = 'weights' | 'bm25'

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

/**
 * The score decomposition of one hit (V2, 规划 §8.1 原则 3).
 *
 * Every surface that shows a rank can show WHY: the features that fed the
 * linear score, what each contributed, the multiplicative governance factors,
 * and the channel ranks the fusion assigned. It is optional because the plain
 * lexical path (`--rerank off`) has nothing to explain beyond its own score —
 * and inventing a breakdown there would be a lie about what ran.
 */
export interface HitExplanation {
  /** The score this hit was ORDERED by. */
  score: number
  /** The first level's score, kept visible so the two stages stay separable. */
  lexicalScore: number
  /** Cosine similarity, or null when the vector channel did not recall it. */
  semantic: number | null
  /** channel → 1-based rank from the fusion stage. */
  channels: Record<string, number>
  /** Raw feature values (§8.2). */
  features: Record<string, number>
  /** `weight × feature` per additive term. */
  contributions: Record<string, number>
  /** The multiplicative status/tier/review factors. */
  factors: Record<string, number>
  /** Human-readable lines, one per term that moved the score. */
  lines: string[]
}

export interface QueryHit {
  entry: KbEntry
  score: number
  /** Which query tokens matched where (title/tag/text) — explainable retrieval. */
  matched: string[]
  /** Status/review annotations the consumer MUST show alongside the hit. */
  annotations: string[]
  /**
   * M9-1: how many derived chunks the entry's document has (0 / absent when
   * the entry carries no doc). Purely informational — it powers the "含原文
   * N 段" annotation and the panel badge; the chunks themselves are never
   * loaded by retrieval (一级 is cheap by construction).
   */
  docHeadingCount?: number
  /** V2: the rerank/channel breakdown, when the hybrid path produced this hit. */
  explain?: HitExplanation
}

/**
 * The redline helpers moved to `redline.ts` (R1) so `lexical-index.ts` can
 * filter text exactly like scoring does WITHOUT importing this module — the
 * index and the query path must agree on what "the text" is, and a cycle
 * between them would be the wrong way to guarantee it. Imported for local use
 * AND re-exported (a bare re-export does not put the names in this module's
 * scope), because `query.ts` is where they have always been imported from.
 */
import { entryTextAfterRedlines, redlinedRatio } from './redline.ts'
import { bm25fScoreFrom, type PrecomputedFields } from './bm25.ts'
import { lexicalCandidates, lexicalStatsFrom, mergeLexicalIndexes, type LexicalIndex } from './lexical-index.ts'
export { entryTextAfterRedlines, isRedlinedChar, redlinedRatio } from './redline.ts'

/**
 * The tokenizer moved to `tokenize.ts` in R1 so `bm25.ts` can share it without
 * a module cycle; re-exported here because it is part of this module's public
 * surface (chunker, chunks, the CLI and tests all import it).
 */
export { tokenize } from './tokenize.ts'

const STATUS_FACTOR: Record<string, number> = { trusted: 1, candidate: 0.85, expired: 0.5 }
const TIER_FACTOR: Record<string, number> = { project: 1, global: 0.8 }

/**
 * Score one entry's FIELD tokens against the query.
 *
 * M9-4 invariant 3 (redline 先过滤、后评分): the body tokens are taken from the
 * text AFTER redlines are removed, so a redlined (wrong) paragraph contributes
 * NOTHING to recall — deleting its tokens is the point, not a side effect.
 *
 * EXPORTED since V0: this is the first level's ranking law, and the hybrid
 * retriever (rag) needs the same score and the same `matched` tokens to build
 * its lexical channel. A second copy would make every fused rank a statement
 * about the copy rather than about the product — the same reason
 * `scoreChunkText` is exported.
 * @param entry - the entry to score.
 * @param queryTokens - the query's tokens.
 * @param weights - field weights.
 * @returns the score plus the matched tokens.
 */
export function scoreEntry(
  entry: KbEntry,
  queryTokens: readonly string[],
  weights: RetrievalWeights,
  options: { scorer?: LexicalScorer; stats?: LexicalStats; fields?: PrecomputedFields } = {},
): { score: number; matched: string[] } {
  const scorer: LexicalScorer = options.scorer ?? 'weights'
  let raw: number
  let matched: string[]

  if (scorer === 'bm25' && options.fields !== undefined && options.stats !== undefined) {
    // R1: the inverted index already knows which query tokens live in which
    // field and how long each field is, so a candidate can be scored WITHOUT
    // re-tokenizing it. The arithmetic is the same function the scanning path
    // calls (`bm25fScoreFrom`), and the post-processing below is shared — one
    // ranking law, two ways of reaching it.
    const scored = bm25fScoreFrom(options.fields, queryTokens, options.stats, weights)
    raw = scored.score
    matched = scored.matched
  } else if (scorer === 'bm25') {
    // BM25F: the formula lives in bm25.ts, one implementation for both levels
    // (this one and the reranker's `bm25ish` feature). Stats are required; a
    // caller that forgot them gets the old behavior rather than a wrong score.
    if (options.stats === undefined) {
      const fields = bm25Fields({ title: entry.title, tags: entry.tags, text: entryTextAfterRedlines(entry) })
      const stats = buildLexicalStats([{ title: entry.title, tags: entry.tags, text: entryTextAfterRedlines(entry) }])
      const scored = bm25fScore(fields, queryTokens, stats, weights)
      raw = scored.score
      matched = scored.matched
    } else {
      const fields = bm25Fields({ title: entry.title, tags: entry.tags, text: entryTextAfterRedlines(entry) })
      const scored = bm25fScore(fields, queryTokens, options.stats, weights)
      raw = scored.score
      matched = scored.matched
    }
  } else {
    const titleTokens = new Set(tokenize(entry.title))
    const tagTokens = new Set(tokenize(entry.tags.join(' ')))
    const textTokens = new Set(tokenize(entryTextAfterRedlines(entry)))
    let sum = 0
    const hits: string[] = []
    for (const token of queryTokens) {
      let hit = 0
      if (titleTokens.has(token)) hit += weights.title
      if (tagTokens.has(token)) hit += weights.tag
      if (textTokens.has(token)) hit += weights.text
      if (hit > 0) {
        sum += hit
        hits.push(token)
      }
    }
    raw = sum
    matched = hits
  }

  return applyGovernanceFactors(entry, raw, matched, scorer)
}

/**
 * The governance multipliers plus the rounding law — the half of the score that
 * depends only on the entry's FACTS, not on its text.
 *
 * Extracted in R1 so the indexed path can score a candidate straight from the
 * index's per-entry facts (status / tier / needsReview) without reading the
 * entry file: a common query token matches thousands of entries, and loading
 * each of them to discover its status was the dominant cost left in the indexed
 * path. One implementation for both paths, as always.
 * @param facts - status/tier/needsReview (an entry or the index's facts record).
 * @param raw - the raw lexical score.
 * @param matched - the tokens that earned it.
 * @param scorer - which rounding law applies (see below).
 * @returns the score a caller orders by, plus the matched tokens.
 */
export function applyGovernanceFactors(
  facts: { status: KbEntry['status']; tier: KbEntry['tier']; needsReview: boolean },
  raw: number,
  matched: readonly string[],
  scorer: LexicalScorer,
): { score: number; matched: string[] } {
  if (raw === 0 || matched.length === 0) return { score: 0, matched: [] }
  const adjusted = raw
    * (STATUS_FACTOR[facts.status] ?? 0)
    * (TIER_FACTOR[facts.tier] ?? 1)
    * (facts.needsReview ? 0.7 : 1)
  // `weights` keeps the historical two-decimal rounding (its raw score is a
  // small integer, so nothing is lost). BM25's score is continuous: rounding it
  // would manufacture ties and degrade the order into "by entryId", so the
  // ordering value stays exact.
  return { score: scorer === 'bm25' ? adjusted : Math.round(adjusted * 100) / 100, matched: [...matched] }
}

/**
 * The status/review annotations a consumer MUST show alongside an entry
 * (decision #10/#21's presentation law). Exported for retrieval providers
 * that synthesize hits outside queryKb (the rag package's binding-recall
 * channel) — the discipline travels with the data, one implementation.
 *
 * M9-1 adds the document facts: an entry with a原文层 says so, plus how many
 * 段 are behind it, so EVERY surface (CLI, panel, tool output) tells the reader
 * the same thing without each counting for itself.
 * @param entry - the entry to annotate.
 * @param docFacts - the derived chunk count (absent = "haz un doc, count unknown").
 * @returns the annotation lines (empty for a clean trusted project entry).
 */
export function annotationsFor(entry: KbEntry, docFacts?: { chunkCount?: number }): string[] {
  const notes: string[] = []
  if (entry.status === 'expired') notes.push('已过期、未复核 — 可读不可直接作为写操作依据(引用需审批)')
  if (entry.status === 'candidate') notes.push('候选知识(尚未人工批准为可信)')
  if (entry.status === 'superseded') notes.push('已被拆分替代(历史条目,仅供溯源)')
  if (entry.needsReview) notes.push(`待复核: ${entry.reviewReason ?? '原因未记录'}`)
  if (entry.tier === 'global') notes.push('来自全局库(项目库同题知识优先)')
  if (entry.doc !== undefined) {
    const count = docFacts?.chunkCount ?? 0
    notes.push(count > 0 ? `含原文 ${count} 段,细节用 kb_detail 下钻` : '含原文快照,细节用 kb_detail 下钻')
  }
  const redlines = entry.redlines ?? []
  if (redlines.length > 0) {
    notes.push(`含 ${redlines.length} 处人工划除段(已从显示与评分中移除${redlines.every((l) => l.target === 'text') ? '' : ',原文层细节见 kb_detail'})`)
  }
  return notes
}

/**
 * The "on the way out" half of a retrieval: freshness checks, the reference
 * touch, and the document facts — applied to the hits a caller is about to
 * RETURN, never to the candidates it merely considered.
 *
 * Split out of {@link queryKb} in V0 because the hybrid retriever fuses two
 * channels and can therefore not reuse queryKb's loop. Calling this from both
 * is what keeps the side-effect surface exactly what it has been since M2: a
 * returned hit re-hashes its bindings and its mounted doc's source, gets its
 * `含原文 N 段` fact, and is touched (which drives the expire timer, and
 * records NO signal — see the module doc).
 * @param store - the tier that owns the entry (null for a synthetic hit).
 * @param entry - the entry to finalize.
 * @param hit - the scored hit it came from.
 * @param options - the timestamp and the no-touch switch.
 * @returns the enriched hit, annotations re-derived from the (possibly flagged) entry.
 */
export async function enrichHit(
  store: KbStore | null,
  entry: KbEntry,
  hit: QueryHit,
  options: { at: string; noTouch?: boolean },
): Promise<QueryHit> {
  let current = entry
  if (store !== null && current.bindings.length > 0) {
    current = await store.checkBindings(current.id, options.at)
  }
  if (store !== null && current.doc !== undefined) {
    current = await store.checkDocs(current.id, options.at)
  }
  if (!options.noTouch && store !== null) {
    current = await store.touch(current.id, options.at)
  }
  return withDocFacts(store, current, hit)
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

  const scorer: LexicalScorer = options.scorer ?? 'bm25'
  const indexes = options.lexicalIndexes ?? []
  /**
   * R1: the indexed path. Same filters, same filters' ORDER, same scores — but
   * the corpus is never materialized and an entry that contains none of the
   * query's tokens is never read (BM25F is a sum over the query's tokens, so
   * such an entry's score is zero by arithmetic, not by convention).
   */
  if (indexes.length > 0 && scorer === 'bm25') {
    const index = mergeLexicalIndexes(indexes)
    const stats = lexicalStatsFrom(index)
    /**
     * PASS 1 — score from the index alone, without reading a single entry.
     *
     * The index carries everything the score needs (postings, field lengths,
     * status/tier/review) and nothing the SCORE needs requires the entry's text
     * (the tokens already came from the postings). Measured reason: a common
     * query token matches thousands of entries, and a file read per candidate
     * was the dominant cost left after the scan was removed.
     */
    const scored: Array<{ id: string; tier: KbEntry['tier']; score: number; matched: string[] }> = []
    for (const candidate of lexicalCandidates(index, queryTokens)) {
      const facts = candidate.facts
      if (facts.status === 'discarded') continue
      if (facts.status === 'expired' && options.includeExpired !== true) continue
      if (options.kinds !== undefined && !options.kinds.includes(facts.kind)) continue
      const raw = bm25fScoreFrom(candidate.fields, queryTokens, stats, weights)
      const { score, matched } = applyGovernanceFactors(facts, raw.score, raw.matched, scorer)
      if (score === 0 || matched.length === 0) continue
      scored.push({ id: candidate.id, tier: facts.tier, score, matched })
    }
    scored.sort((a, b) =>
      b.score - a.score
      || (a.tier === b.tier ? 0 : a.tier === 'project' ? -1 : 1)
      || a.id.localeCompare(b.id))

    /**
     * PASS 2 — read only what can be RETURNED.
     *
     * `limit` is what the caller asked for; enrichment (freshness hashes, the
     * reference touch, doc facts) is the expensive per-hit work, and it is
     * done on the rows that leave this function. The scan path does it for
     * every hit it considered; that difference is a PERFORMANCE fact, and the
     * returned rows are provably the same (same sort key before and after
     * enrichment — enrichment annotates, it never re-scores).
     */
    const indexed: QueryHit[] = []
    for (const row of scored.slice(0, limit)) {
      // The index records the tier, but a lookup falls back to the other one:
      // the entry id is the identity, and "which store owns it" must never be
      // the reason a hit disappears (a mis-recorded tier would otherwise be a
      // silent ranking change).
      const preferred = row.tier === 'global' ? global : project
      const other = row.tier === 'global' ? project : global
      const entry = preferred === null
        ? (other === null ? null : await other.get(row.id as KbEntryId))
        : (await preferred.get(row.id as KbEntryId)) ?? (other === null ? null : await other.get(row.id as KbEntryId))
      if (entry === null) continue
      indexed.push({ entry, score: row.score, matched: row.matched, annotations: annotationsFor(entry) })
    }
    return finishQuery(indexed, { project, global, options, at, limit })
  }

  // The corpus is MATERIALIZED first so BM25 can see the corpus statistics
  // (df + per-field average lengths) before it scores anything. The filters and
  // their order are unchanged — this is the same loop, split in two.
  const corpus: KbEntry[] = []
  for (const store of tiers) {
    for (const entry of await store.list()) {
      if (entry.status === 'discarded') continue
      if (entry.status === 'expired' && options.includeExpired !== true) continue
      if (options.kinds !== undefined && !options.kinds.includes(entry.kind)) continue
      corpus.push(entry)
    }
  }
  const stats = scorer === 'bm25'
    ? buildLexicalStats(corpus.map((entry) => ({
      title: entry.title,
      tags: entry.tags,
      text: entryTextAfterRedlines(entry),
    })))
    : undefined

  const hits: QueryHit[] = []
  for (const entry of corpus) {
    const { score, matched } = scoreEntry(entry, queryTokens, weights, { scorer, ...(stats !== undefined ? { stats } : {}) })
    if (score === 0 || matched.length === 0) continue
    hits.push({ entry, score, matched, annotations: annotationsFor(entry) })
  }

  return finishQuery(hits, { project, global, options, at, limit })
}

/**
 * The "on the way out" half, shared by the scanning and the indexed path.
 *
 * Extracted in R1 so the indexed path cannot quietly skip a step (freshness
 * checks, the reference touch, doc facts, the deterministic sort and the limit)
 * — the two paths must differ in HOW they find candidates, never in what they
 * do with them.
 * @param hits - scored candidates (each carrying its own entry and score).
 * @param context - the stores, the query options and the clock.
 * @returns the finished, limited hit list.
 */
async function finishQuery(
  hits: readonly QueryHit[],
  context: {
    project: KbStore | null
    global: KbStore | null
    options: QueryOptions
    at: string
    limit: number
  },
): Promise<QueryHit[]> {
  const { project, global, options, at, limit } = context
  // Binding freshness is checked on the way out: a hit on a stale-bound entry
  // must arrive annotated (this is the M2 acceptance "改绑定文件→自动待复核").
  // M9-1: doc drift is the same act one layer down — checkDocs re-hashes the
  // snapshot's SOURCE path and flags every entry mounted on that doc, so a
  // changed upstream document questions its knowledge exactly like a changed
  // bound file does. The snapshot itself is never rewritten (invariant 7).
  const freshened: QueryHit[] = []
  for (const hit of hits) {
    const store = hit.entry.tier === 'global' ? global : project
    freshened.push(await enrichHit(store, hit.entry, hit, { at, ...(options.noTouch !== undefined ? { noTouch: options.noTouch } : {}) }))
  }

  freshened.sort((a, b) =>
    b.score - a.score
    || (a.entry.tier === b.entry.tier ? 0 : a.entry.tier === 'project' ? -1 : 1)
    || a.entry.id.localeCompare(b.entry.id))
  return freshened.slice(0, limit)
}

/**
 * Attach the "含原文 N 段" fact to one hit (M9-1/§4 一级). Cheap by design:
 * only the CHUNK LEDGER is read (one small file), never the snapshot text.
 * A missing/foreign ledger leaves the count at the record's honest 0.
 * @param store - the tier that owns the entry (null for synthetic hits).
 * @param entry - the (freshness-checked) entry.
 * @param hit - the scored hit it came from.
 * @returns the hit with its document facts and re-derived annotations.
 */
async function withDocFacts(store: KbStore | null, entry: KbEntry, hit: QueryHit): Promise<QueryHit> {
  if (store === null || entry.doc === undefined) return { ...hit, entry, annotations: annotationsFor(entry) }
  const chunks = await readChunks(store.dir, entry.doc.docId)
  return {
    ...hit,
    entry,
    annotations: annotationsFor(entry, { chunkCount: chunks.length }),
    docHeadingCount: chunks.length,
  }
}
