/**
 * The retrieval seam (M4).
 *
 * `RagRetriever` is the interface the embedding implementation will satisfy
 * later (design 讲解框 C: 全文先行,向量后补;§1.2's index-epoch machinery
 * arrives WITH that implementation — nothing today needs it). The shipped
 * provider is full-text over the kb engine's `queryKb`, plus the one ranking
 * augmentation the evidence loop makes possible and plain retrieval cannot:
 *
 * **Binding recall** — when the caller knows which files this work unit
 * changed (the gate always does), an entry BOUND to one of those files was
 * written about the exact code under verification. That is a CATEGORICAL
 * relevance fact, not a score nudge: a multiplicative boost loses to any
 * token-rich distractor (measured: ×1.5 cannot cross a 4× text-score gap),
 * and worse, a bound entry sharing NO token with the failure signature is
 * invisible to text scoring at all. So bindings run as their own recall
 * channel and bound hits rank as their own stratum:
 *
 *   stratum 1: bound to a changed file (text-matched ones first by boosted
 *              score, then binding-only recalls), each ANNOUNCED in its
 *              annotations — explainable retrieval stays a product rule;
 *   stratum 2: everything else, in queryKb's order.
 *
 * @module @clue-harness/rag/retrieve
 */
import { annotationsFor, queryKb, type KbEntry, type KbStore, type QueryHit, type RetrievalWeights } from '@clue-harness/kb'

/** One retrieval call's knobs. */
export interface RetrieveOptions {
  /** Maximum hits to return (config topK when absent). */
  limit?: number
  /** Include expired entries (annotated). Default false. */
  includeExpired?: boolean
  /** Also search the global tier (both channels). Default true. */
  includeGlobal?: boolean
  /**
   * Files changed in this work unit (normalized-relative). Entries bound to
   * any of them are recalled and ranked in the bound stratum.
   */
  boostBindings?: readonly string[]
}

/**
 * The retrieval capability seam. The full-text provider ships now; an
 * embedding provider (vector + hybrid, index epoch) implements the same
 * two-method surface without any consumer changing.
 */
export interface RagRetriever {
  /**
   * Retrieve ranked hits for one query.
   * @param query - the query text (user input or a failure signature).
   * @param options - per-call knobs.
   * @returns ranked hits, annotations intact.
   */
  retrieve(query: string, options?: RetrieveOptions): Promise<QueryHit[]>
  /** The provider's human name (reports and logs). */
  readonly provider: string
}

/** Retriever configuration (the M2 "配置化" promise lands here). */
export interface RetrieverConfig {
  /** Field weights; absent keys keep the kb defaults (3/2/1). */
  weights?: Partial<RetrievalWeights>
  /**
   * Score multiplier applied to text-matched bound hits (their promoted
   * score is what the annotation explains). Default 1.5. Set to 1 to keep
   * raw scores; the bound stratum applies regardless (it is the ranking
   * fact) — pass NO boostBindings to disable binding recall entirely.
   */
  bindingBoost?: number
  /** Default hit cap. Default 5. */
  topK?: number
}

const DEFAULT_BINDING_BOOST = 1.5
const DEFAULT_TOP_K = 5

/**
 * Normalize one relative path for set comparisons (win separators → posix,
 * drop a leading ./). Mirrors kb-loop's normalizeRelative; duplicated as two
 * lines on purpose — engines do not import engines sideways.
 * @param value - the path as recorded.
 * @returns the comparison form.
 */
export function normalizePath(value: string): string {
  const posix = value.replace(/\\/g, '/')
  return posix.startsWith('./') ? posix.slice(2) : posix
}

/** The bound-file intersection of one entry, normalized. */
function involvedBindings(entry: KbEntry, changed: ReadonlySet<string>): string[] {
  return entry.bindings.map((binding) => normalizePath(binding.path)).filter((p) => changed.has(p))
}

/**
 * Create the full-text retriever over the two KB tiers.
 * @param project - the project-tier store (nullable for global-only).
 * @param global - the global-tier store (nullable).
 * @param config - weights, boost, and default cap.
 * @returns the retriever.
 */
export function createFulltextRetriever(
  project: KbStore | null,
  global: KbStore | null,
  config: RetrieverConfig = {},
): RagRetriever {
  const boost = config.bindingBoost ?? DEFAULT_BINDING_BOOST
  const topK = config.topK ?? DEFAULT_TOP_K
  return {
    provider: 'fulltext',
    async retrieve(query: string, options: RetrieveOptions = {}): Promise<QueryHit[]> {
      const limit = options.limit ?? topK
      const changed = new Set((options.boostBindings ?? []).map(normalizePath))
      // Over-fetch before re-ranking: queryKb sorts and slices internally,
      // and the bound stratum must be able to lift a hit that plain scoring
      // ranked below the cap. ×3 is deterministic headroom, not a tunable.
      const bindingRecall = changed.size > 0
      const hits = await queryKb(project, global, {
        text: query,
        limit: bindingRecall ? limit * 3 : limit,
        ...(options.includeExpired !== undefined ? { includeExpired: options.includeExpired } : {}),
        ...(options.includeGlobal !== undefined ? { includeGlobal: options.includeGlobal } : {}),
        ...(config.weights !== undefined ? { weights: config.weights } : {}),
      })
      if (!bindingRecall) return hits.slice(0, limit)

      // Stratum split: text hits bound to a changed file (boosted, announced)
      // versus the rest (queryKb's order preserved within each group).
      const boundText: QueryHit[] = []
      const unbound: QueryHit[] = []
      const seen = new Set<string>()
      for (const hit of hits) {
        seen.add(String(hit.entry.id))
        const involved = involvedBindings(hit.entry, changed)
        if (involved.length === 0) {
          unbound.push(hit)
          continue
        }
        boundText.push({
          ...hit,
          score: Math.round(hit.score * boost * 100) / 100,
          annotations: [...hit.annotations, `绑定文件在本次改动中(${involved.join(', ')}),按相关性加权`],
        })
      }

      // Binding-only recall: entries bound to a changed file that text
      // scoring never surfaced (zero token overlap — the signature names the
      // failure, the entry names the fix; they need not share words). Same
      // status doctrine as queryKb: discarded never, expired only annotated
      // and only when asked.
      const boundOnly: QueryHit[] = []
      const tiers: (KbStore | null)[] = [project, global]
      for (const store of tiers) {
        if (store === null) continue
        if (store.tier === 'global' && options.includeGlobal === false) continue
        for (const entry of await store.list()) {
          if (entry.status === 'discarded') continue
          if (entry.status === 'expired' && options.includeExpired !== true) continue
          if (seen.has(String(entry.id))) continue
          const involved = involvedBindings(entry, changed)
          if (involved.length === 0) continue
          seen.add(String(entry.id))
          boundOnly.push({
            entry,
            score: 0,
            matched: [],
            annotations: [
              ...annotationsFor(entry),
              `绑定文件在本次改动中(${involved.join(', ')}),文本未直接匹配、按绑定召回`,
            ],
          })
        }
      }

      // Bound stratum first (text-matched by boosted score, then binding-only
      // in store order), then the unbound remainder. Deterministic: every
      // group keeps a stable order and ids break remaining ties.
      const ranked = [
        ...boundText.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)),
        ...boundOnly,
        ...unbound,
      ]
      return ranked.slice(0, limit)
    },
  }
}
