/**
 * The hybrid retriever (V2, 规划 §7): 词法与向量并联召回 → RRF 融合 → 特征精排.
 *
 * ```
 *   query → profile 规范化
 *         → ┌ 词法召回: scoreEntry (the M2 law, unchanged, hard-zero gate)
 *           └ 向量召回: embed(query) → cosine, top N   (无向量层则整路跳过)
 *         → RRF 融合 (k=60, 通道权重按 profile)
 *         → 精排: 确定性特征线性打分 (§8.2)
 *         → 过滤与呈现: 状态/层级/redline 标注照旧 + 分数分解
 * ```
 *
 * Four disciplines this file is responsible for:
 *
 * 1. **回滚可证** (不变量 9): `channels: 'lexical'` + `rerank: false` does not
 *    merely resemble today's behavior — it DELEGATES to the shipped full-text
 *    retriever, so the two cannot drift apart. A test pins the equality.
 * 2. **降级诚实** (不变量 5): every way the semantic channel can be off
 *    (未配置 / 索引缺失 / 版本过期 / partial / 调用失败) is a named state, and
 *    the returned hits carry a note saying which one it was. A lexical-only
 *    answer is never dressed up as a semantic one.
 * 3. **查询不改变知识** (宪法 4): unless `rebuildOnRead` is on, this path writes
 *    nothing. When it IS on, the only writes are derived-layer ones —
 *    `vectors/` and the embed cache — which is the same precedent chunks set
 *    in M9. No signal, no status, no approval, ever.
 * 4. **同一实现** : the lexical channel calls kb's exported `scoreEntry`, the
 *    finalization calls kb's `enrichHit`, and chunk keys roll up through
 *    `rollUpToKeys`. There is no second ranking law anywhere in this file.
 *
 * @module @clue-harness/rag/hybrid
 */
import path from 'node:path'
import {
  annotationsFor,
  buildLexicalStats,
  embedderVersion as embedderVersionOf,
  enrichHit,
  entryTextAfterRedlines,
  readSignals,
  readVectorIndex,
  scoreEntry,
  tokenize,
  windowScores,
  type KbEntry,
  type KbKind,
  type KbStore,
  type LexicalScorer,
  type QueryHit,
  type RetrievalWeights,
  type VectorIndex,
  type VectorTarget,
} from '@clue-harness/kb'
import type { Embedder } from './embedder.ts'
import { createFulltextRetriever, normalizePath, type RagRetriever, type RetrieveOptions } from './retrieve.ts'
import { rollUpToKeys, rrfFuse, DEFAULT_RRF_K, type FusedCandidate } from './fuse.ts'
import { searchVectors, type VectorHit } from './vector-search.ts'
import { buildVectorIndex, vectorIndexIsCurrent } from './index-pipeline.ts'
import {
  buildCorpusStats,
  rerankAll,
  type RerankCandidate,
  type RerankFeatureWeights,
  type RerankResult,
} from './rerank.ts'
import { normalizeQuery, resolveProfile, type ChannelProfile, type NormalizedQuery } from './profiles.ts'
import { RETRIEVAL_DEFAULTS, resolveLexicalNormalization, resolveSemanticScale } from './defaults.ts'
import {
  lexicalStatsFrom,
  mergeLexicalIndexes,
  queryKb,
  type LexicalIndex,
} from '@clue-harness/kb'
import { llmRerank as runLlmRerank, type LlmRankPort, type LlmRerankOutcome } from './llm-rerank.ts'

/** Which recall channels participate. */
export type RecallChannels = 'lexical' | 'vector' | 'hybrid'

/** Why the semantic channel did or did not contribute (不变量 5's vocabulary). */
export interface VectorChannelState {
  status:
    | 'used'              // recalled normally
    | 'disabled'          // this call asked for lexical only
    | 'not-configured'    // no embedder in effect
    | 'index-missing'     // no vector layer built yet
    | 'index-stale'       // built under another embedderVersion
    | 'partial'           // usable, but some units were never embedded
    | 'error'             // the embedder call failed (message carries no key)
  /** One honest line a surface can show verbatim. */
  note: string
  /** Rows the index holds (when one was read). */
  count?: number
  /** Units known to be missing from the index. */
  missing?: number
  /** The dimension in effect. */
  dim?: number
}

/** The retrieval knobs (规划 §9.3 B 检索调优). */
export interface HybridConfig {
  /** Which channels recall. Default 'hybrid'. */
  channels?: RecallChannels
  /** The channel profile name (规划 §7.3). Default 'tool'. */
  profile?: string
  /** Field weights of the lexical channel. */
  weights?: Partial<RetrievalWeights>
  /** Default hit cap. Default 5. */
  topK?: number
  /** Per-channel recall depth before fusion. Default 50. */
  recallDepth?: number
  /** Candidates entering the rerank stage. Default 30. */
  rerankCandidates?: number
  /** Whether to rerank. Default true. */
  rerank?: boolean
  /**
   * F2 (规划 §3.2): the cap on candidates that ONLY the vector channel recalled.
   *
   * Semantics SUPPLEMENT the lexical channel, never replace it. The measured
   * damage was exactly that replacement: with equal RRF weights a vector-only
   * candidate outranks a lexically-recalled one sitting at rank 25–30, and since
   * the reranker only sees `rerankCandidates` rows, 1.10 gold documents per
   * query never reached it. Lexically-recalled candidates are never capped.
   * Absent = no cap (today's behavior).
   */
  maxVectorOnly?: number
  /**
   * F1 escape hatch: run the vector channel even when the embedder reports no
   * semantic ability (`semantics: 'none'`). Off by default — the gate is the
   * correct production behavior — and used by the pipeline probes (offline
   * tests and harness runs) whose whole purpose is to exercise the vector path
   * with a deterministic fake.
   */
  allowNoAbilityEmbedder?: boolean
  /**
   * Which first-level formula ranks the lexical channel (R2 of the BM25 plan).
   * Default 'bm25'; 'weights' reproduces pre-R2 behavior exactly, which is the
   * rollback switch the plan requires.
   */
  lexicalScorer?: LexicalScorer
  /** RRF constant. Default 60. */
  rrfK?: number
  /** Per-channel weight overrides (win over the profile's table). */
  channelWeights?: { lexical?: number; vector?: number }
  /** Feature weights (§8.2). */
  featureWeights?: Partial<RerankFeatureWeights>
  /** D1: what `bm25ish` is relative to (`candidates` = today, `absolute` = pool scale). */
  lexicalNormalization?: 'auto' | 'candidates' | 'absolute'
  /** D2: whether the cosine is calibrated onto [0,1] (`raw` = today). */
  semanticScale?: 'auto' | 'raw' | 'calibrated'
  /** D2's calibration bounds (from the embedder family, not per corpus). */
  semanticFloor?: number
  semanticCeil?: number
  /**
   * D3 (`docs/开发记录.md` §3): how a feature whose channel did
   * not recall the candidate is treated. `zero` (default) is today.
   */
  missingFeatureMode?: 'zero' | 'absent'
  /**
   * R1 (落地计划 §2-1): validated inverted indexes (project tier first).
   *
   * With them, the retriever stops materializing the corpus: the lexical channel
   * is answered by `queryKb`'s indexed path, the corpus statistics come from the
   * index, and only the entries that can actually be returned are loaded. The
   * plan's rule applies unchanged — a missing/stale/corrupt index is a
   * DEGRADATION, so the caller passes nothing and the scan path runs as before.
   */
  lexicalIndexes?: readonly LexicalIndex[]
  /** R1: how the index step went, so the result can say whether the corpus was scanned. */
  lexicalIndexNote?: string
  /** The embedder in effect (absent = lexical only, honestly annotated). */
  embedder?: Embedder
  /** ClueHarness home — where the shared embed cache and rebuild writes live. */
  home?: string
  /**
   * Rebuild a missing/stale index during a query (规划 §5.3, the chunks
   * precedent). Requires `home`. Default true when an embedder is configured;
   * bound by `maxUnitsPerBuild`, and a failure degrades instead of throwing.
   */
  rebuildOnRead?: boolean
  /** The rebuild budget per call (不变量 12). Default 2000. */
  maxUnitsPerBuild?: number
  /** The promote threshold the signal feature normalizes against. */
  trustThreshold?: number
  /** Inject the clock (tests). */
  now?: Date
  /** Per-call ranklog sink (V2: 攒 LTR 标注). Absent = no log written. */
  onRank?: (line: RankLogLine) => Promise<void> | void
  /**
   * V5 (规划 §8.4): the optional model reranker, default OFF. It runs AFTER the
   * deterministic rerank and its result is reported as a DIFF against it — the
   * deterministic order is never discarded silently, because the whole point of
   * ruling it in was that it is the explainable one.
   */
  llmRerank?: boolean
  /** The model seam (`kb-face`'s chat host). Absent = the feature cannot run. */
  llmRerankPort?: LlmRankPort
  /** Per-call ceiling for the model rerank (default 20s). */
  llmRerankTimeoutMs?: number
  /** Where to report WHY a model rerank did not apply (the caller surfaces it). */
  llmRerankErrorSink?: (reason: string) => void
}

/** One row of `ranklog.jsonl` — the data LTR would be trained on later (§8.4). */
export interface RankLogLine {
  at: string
  profile: string
  channels: RecallChannels
  rerank: boolean
  query: string
  /** Candidate keys in final order, with the features that ordered them. */
  candidates: Array<{ id: string; score: number; lexicalScore: number; semantic: number | null; features: Record<string, number> }>
  vector: VectorChannelState['status']
}

/** The full answer of one hybrid retrieval (the CLI's `--explain` uses it). */
export interface HybridRetrieval {
  /**
   * R1: whether the first level answered from the inverted index or by scanning
   * the corpus, plus the reason when it scanned. A degradation that cannot be
   * read is indistinguishable from a performance regression.
   */
  lexicalIndex: { used: boolean; note: string }
  hits: QueryHit[]
  vector: VectorChannelState
  profile: ChannelProfile
  channels: RecallChannels
  rerank: boolean
  /** How many candidates each channel recalled (before fusion). */
  recalled: { lexical: number; vector: number }
  /** How many candidates the fusion produced, before the rerank cap. */
  fused: number
  /** What each channel was actually given (V3: 按 profile 规范化后的两份 query). */
  normalized: NormalizedQuery
  /**
   * The model rerank's outcome, when it ran and succeeded. `null` means it did
   * not run (off, or fewer than two candidates); absent means it failed or timed
   * out and the deterministic order stands (规划 §8.4 超时降级).
   */
  llmRerank?: LlmRerankOutcome | null
}

/**
 * The shipped defaults — re-exported from the engine's single table
 * (`defaults.ts`), never re-typed here: two copies of a default is how a
 * benchmark silently measured the wrong configuration (F0 of the F-plan).
 */
export { RETRIEVAL_DEFAULTS, resolveLexicalNormalization, resolveSemanticScale } from './defaults.ts'
export const DEFAULT_RECALL_DEPTH = RETRIEVAL_DEFAULTS.recallDepth
export const DEFAULT_RERANK_CANDIDATES = RETRIEVAL_DEFAULTS.rerankCandidates

/**
 * Internal control-flow signal: "this query has nothing for the semantic
 * channel". It is thrown and caught inside one call, never escaping the
 * retriever — an ordinary `undefined` return would be indistinguishable from
 * "the channel found nothing", and the two states read very differently to a
 * user (one is a profile fact, the other is a miss).
 */
class SemanticSkip extends Error {}

/** The one honest line for the "nothing to embed" state (V3 `gate` profile). */
const SEMANTIC_SKIP_NOTE = '该 query 在 profile 下只剩标识符(已按 profile 只走词法通道)'

/** One corpus member: the entry plus the store that owns it. */
interface CorpusEntry {
  entry: KbEntry
  store: KbStore
}

/** Build the annotation a degraded vector channel must leave on every hit. */
function degradationNote(state: VectorChannelState): string | null {
  switch (state.status) {
    case 'used':
    case 'disabled':
      return null
    case 'not-configured':
      return '语义通道未启用(嵌入未配置)— 本次为纯词法结果'
    case 'index-missing':
      return '向量层待建 — 本次为纯词法结果(未伪装成语义命中)'
    case 'index-stale':
      return '向量层版本已过期,待重建 — 本次为纯词法结果'
    case 'partial':
      return `向量层不完整(缺 ${state.missing ?? 0} 条)— 语义通道只覆盖已建部分`
    case 'error':
      return `语义通道本次失败(${state.note}),已退回纯词法`
  }
}

/**
 * Create the hybrid retriever over the two KB tiers.
 *
 * @param project - the project-tier store (nullable).
 * @param global - the global-tier store (nullable).
 * @param config - channels, profile, fusion, rerank and rebuild knobs.
 * @returns a `RagRetriever` whose `retrieve` returns reranked hits with their breakdown.
 */
/**
 * R1: the index state every retrieval result carries.
 * @param config - the retriever configuration.
 * @returns `used` plus the note to print.
 */
function lexicalIndexState(config: HybridConfig): { used: boolean; note: string } {
  const used = (config.lexicalIndexes?.length ?? 0) > 0
  return {
    used,
    note: config.lexicalIndexNote
      ?? (used ? '词法索引可用(本次未扫描全库)' : '未提供词法索引,本次扫描全库'),
  }
}

export function createHybridRetriever(
  project: KbStore | null,
  global: KbStore | null,
  config: HybridConfig = {},
): RagRetriever & { retrieveDetailed(query: string, options?: RetrieveOptions & { kinds?: KbKind[]; noTouch?: boolean }): Promise<HybridRetrieval> } {
  const channels = config.channels ?? 'hybrid'
  // (the ability gate below re-derives `effectiveChannels` once `config` is in scope)
  const profile = resolveProfile(config.profile)
  const rerankEnabled = config.rerank ?? RETRIEVAL_DEFAULTS.rerank
  const topK = config.topK ?? 5
  const recallDepth = config.recallDepth ?? RETRIEVAL_DEFAULTS.recallDepth
  const rerankCandidates = config.rerankCandidates ?? RETRIEVAL_DEFAULTS.rerankCandidates
  const rrfK = config.rrfK ?? RETRIEVAL_DEFAULTS.rrfK
  const lexWeight = config.channelWeights?.lexical ?? profile.lexicalWeight
  const vecWeight = config.channelWeights?.vector ?? profile.semanticWeight
  /**
   * F1: a no-ability embedder may not enter fusion.
   *
   * `hashEmbedder` self-reports `semantics: 'none'`; letting it fuse is how the
   * measured deficit was produced (its rank noise displaced lexical results),
   * and the plan's fix is explicit: "semantics === 'none' 的 hashEmbedder ⇒
   * 直接 0,且不进入融合". The channel is not removed — it is DECLARED inactive
   * with a reason, so every surface can say why (不变量 5).
   */
  const abilityGated = config.embedder !== undefined
    && config.embedder.semantics === 'none'
    && config.allowNoAbilityEmbedder !== true
  const effectiveChannels: RecallChannels = abilityGated ? 'lexical' : channels
  const channelStateNote = abilityGated
    ? '嵌入器自报语义能力=0(确定性兜底),按 F1 不进入融合 — 本次为纯词法结果'
    : null
  /**
   * 落地计划 §2-2 (按通道启用 D1/D2): the scale decisions belong HERE, because
   * this is the only place that knows which channels ACTUALLY ran — `auto` must
   * be resolved after the F1 ability gate, not before it (a gated hybrid IS a
   * lexical run, and it must get the lexical档位).
   */
  const lexicalNormalization = resolveLexicalNormalization(
    config.lexicalNormalization ?? RETRIEVAL_DEFAULTS.lexicalNormalization,
    effectiveChannels,
  )
  const semanticScale = resolveSemanticScale(
    config.semanticScale ?? RETRIEVAL_DEFAULTS.semanticScale,
    effectiveChannels,
  )
  const lexicalOnly = effectiveChannels === 'lexical' && !rerankEnabled
  // Invariant 9 is satisfied by CONSTRUCTION, not by imitation: the exact
  // today's-behavior configuration IS the shipped full-text retriever.
  const fulltext = createFulltextRetriever(project, global, {
    ...(config.weights !== undefined ? { weights: config.weights } : {}),
    ...(config.topK !== undefined ? { topK: config.topK } : {}),
    // The rollback switch must reach the DELEGATED path too: `--channel lexical
    // --rerank off` is exactly the configuration the plan names as the way to
    // reproduce pre-R2 behavior (R2 of docs/开发记录.md).
    ...(config.lexicalScorer !== undefined ? { lexicalScorer: config.lexicalScorer } : {}),
    // R1: the delegated rollback path gets the SAME index, so turning reranking
    // off stays a quality switch rather than becoming a performance cliff.
    ...(config.lexicalIndexes !== undefined ? { lexicalIndexes: config.lexicalIndexes } : {}),
  })

  const storeOf = (entry: KbEntry): KbStore | null => (entry.tier === 'global' ? global : project)

  /** The entries a query may consider, with the first level's filters applied. */
  const corpus = async (options: { includeExpired?: boolean; includeGlobal?: boolean; kinds?: KbKind[] }): Promise<CorpusEntry[]> => {
    const tiers: KbStore[] = []
    if (project !== null) tiers.push(project)
    if (global !== null && options.includeGlobal !== false) tiers.push(global)
    const out: CorpusEntry[] = []
    for (const store of tiers) {
      for (const entry of await store.list()) {
        if (entry.status === 'discarded') continue
        if (entry.status === 'expired' && options.includeExpired !== true) continue
        if (entry.status === 'superseded') continue
        if (options.kinds !== undefined && !options.kinds.includes(entry.kind)) continue
        out.push({ entry, store })
      }
    }
    return out
  }

  /**
   * Recall through the vector channel for one tier.
   * @param store - the tier whose index to search.
   * @param query - the query vector.
   * @param depth - how many hits to keep.
   * @returns hits plus a state describing whether the index was usable.
   */
  const vectorRecall = async (store: KbStore, query: Float32Array, depth: number): Promise<{ hits: VectorHit[]; state: VectorChannelState; index: VectorIndex | null }> => {
    const target: VectorTarget = { kind: 'entries' }
    const version = config.embedder === undefined ? null : embedderVersionOf({ modelId: config.embedder.id, dim: config.embedder.dim })
    let index = await readVectorIndex(store.dir, target)
    if (index !== null && version !== null && index.meta.embedderVersion !== version) {
      index = null
      const rebuilt = await maybeRebuild(store, target, 'index-stale')
      if (rebuilt !== null) index = rebuilt
      else return { hits: [], state: staleState(version), index: null }
    }
    if (index === null) {
      const rebuilt = await maybeRebuild(store, target, 'index-missing')
      if (rebuilt === null) {
        return { hits: [], state: { status: 'index-missing', note: `向量层待建(${store.tier})` }, index: null }
      }
      index = rebuilt
    }
    const hits = searchVectors(index, query, { limit: depth })
    const missing = index.meta.partial?.missing ?? 0
    return {
      hits,
      index,
      state: { status: missing > 0 ? 'partial' : 'used', note: '语义通道已参与', count: index.meta.count, dim: index.meta.dim, ...(missing > 0 ? { missing } : {}) },
    }
  }

  /** The stale-index state, phrased for the reader (nothing else is knowable about it). */
  const staleState = (version: string | null): VectorChannelState => ({
    status: 'index-stale',
    note: version === null ? '嵌入未配置' : `向量层版本与当前嵌入(${version})不符`,
  })

  /**
   * Rebuild an index during a query, when allowed and possible.
   * Failure NEVER throws through retrieval (规划 §5.3 护栏 2).
   * @param store - the tier to rebuild.
   * @param target - which index.
   * @param reason - the state that triggered the rebuild (for the log line).
   * @returns the freshly built index, or null when the rebuild was skipped/failed.
   */
  const maybeRebuild = async (store: KbStore, target: VectorTarget, reason: string): Promise<VectorIndex | null> => {
    const allowed = config.rebuildOnRead ?? true
    if (!allowed || config.embedder === undefined || config.home === undefined) return null
    try {
      const current = await vectorIndexIsCurrent(store, target, embedderVersionOf({ modelId: config.embedder.id, dim: config.embedder.dim }))
      if (!current) {
        await buildVectorIndex(store, {
          home: config.home,
          embedder: config.embedder,
          target,
          ...(config.maxUnitsPerBuild !== undefined ? { maxUnitsPerBuild: config.maxUnitsPerBuild } : {}),
        })
      }
      return await readVectorIndex(store.dir, target)
    } catch (error) {
      void reason
      void error
      return null
    }
  }

  /** Signal scores for every entry of one retrieval (one ledger read per tier). */
  const signalScores = async (now: Date): Promise<Map<string, number>> => {
    const merged = new Map<string, number>()
    for (const store of [project, global]) {
      if (store === null) continue
      const ledger = await readSignals(path.join(store.dir, 'signals.jsonl'))
      for (const [key, value] of windowScores(ledger, now, store.config.windowDays)) merged.set(key, value)
    }
    return merged
  }

  const retrieveDetailedImpl = async (
    query: string,
    options: RetrieveOptions & { kinds?: KbKind[]; noTouch?: boolean } = {},
  ): Promise<HybridRetrieval> => {
    const limit = options.limit ?? topK
    const now = config.now ?? new Date()
    const at = now.toISOString()
    // V3 (§7.3): the profile decides what each channel SEES. Lexical always
    // gets the whole query (paths and identifiers are its gold), the semantic
    // channel gets the prose — and for `gate` the identifiers are taken out of
    // it, because embedding a path dilutes the vector and can even make two
    // unrelated files look alike.
    const normalized = normalizeQuery(profile, query)
    const queryTokens = tokenize(normalized.lexical)

    // The rollback path, delegated (不变量 9).
    if (lexicalOnly) {
      const hits = await fulltext.retrieve(query, options)
      // The F1 ability gate delegates here too, so its REASON must survive the
      // delegation: a reader who sees pure-lexical results is entitled to know
      // whether they asked for that or the embedder could not help.
      const annotated = channelStateNote === null
        ? hits
        : hits.map((hit) => ({ ...hit, annotations: [...hit.annotations, channelStateNote] }))
      return {
        hits: annotated,
        vector: { status: 'disabled', note: channelStateNote ?? '本次只走词法通道(--channel lexical --rerank off)' },
        profile,
        channels: effectiveChannels,
        rerank: false,
        recalled: { lexical: hits.length, vector: 0 },
        fused: hits.length,
        lexicalIndex: lexicalIndexState(config),
        normalized,
      }
    }
    if (queryTokens.length === 0) {
      return {
        hits: [],
        vector: { status: effectiveChannels === 'vector' ? 'used' : 'disabled', note: '空查询' },
        profile,
        channels: effectiveChannels,
        rerank: rerankEnabled,
        recalled: { lexical: 0, vector: 0 },
        fused: 0,
        lexicalIndex: lexicalIndexState(config),
        normalized,
      }
    }

    const weights: RetrievalWeights = { title: 3, tag: 2, text: 1, ...(config.weights ?? {}) }
    const lexicalScorer: LexicalScorer = config.lexicalScorer ?? RETRIEVAL_DEFAULTS.lexicalScorer
    /**
     * R1: with an index, the corpus is never materialized.
     *
     * The measured reason (nfcorpus, 3.6k entries): `store.list()` alone costs
     * ~1.25s per query (every entry file read and parsed) and the stats pass
     * another ~0.21s — for a question that will return five rows. So the indexed
     * path takes the corpus statistics from the index, asks `queryKb` for the
     * lexical channel (which loads only the entries it returns), and loads the
     * remaining window entries by id.
     */
    const mergedIndex = lexicalScorer === 'bm25' && (config.lexicalIndexes?.length ?? 0) > 0
      ? mergeLexicalIndexes(config.lexicalIndexes as readonly LexicalIndex[])
      : null
    const members = mergedIndex === null
      ? await corpus({
        ...(options.includeExpired !== undefined ? { includeExpired: options.includeExpired } : {}),
        ...(options.includeGlobal !== undefined ? { includeGlobal: options.includeGlobal } : {}),
        ...(options.kinds !== undefined ? { kinds: options.kinds } : {}),
      })
      : []
    const byId = new Map(members.map((member) => [String(member.entry.id), member]))
    /** Load one entry by id (indexed path): the tier comes from the index, with the other tier as a fallback. */
    const loadById = async (key: string): Promise<CorpusEntry | null> => {
      const cached = byId.get(key)
      if (cached !== undefined) return cached
      const facts = mergedIndex?.meta.entries[key]
      const preferred = facts?.tier === 'global' ? global : project
      const other = facts?.tier === 'global' ? project : global
      const entry = (preferred === null ? null : await preferred.get(key as never))
        ?? (other === null ? null : await other.get(key as never))
      if (entry === null) return null
      const member: CorpusEntry = { entry, store: (entry.tier === 'global' ? global : project) as KbStore }
      byId.set(key, member)
      return member
    }
    // One stats pass per retrieval serves BOTH levels: the lexical channel's
    // BM25F and the reranker's `bm25ish` feature normalize the same numbers.
    const corpusStats = mergedIndex !== null
      ? lexicalStatsFrom(mergedIndex)
      : (lexicalScorer === 'bm25' || rerankEnabled
        ? buildLexicalStats(members.map((member) => ({
          title: member.entry.title,
          tags: member.entry.tags,
          text: entryTextAfterRedlines(member.entry),
        })))
        : undefined)

    // ── lexical channel ────────────────────────────────────────────────────
    type LexicalRow = { id: string; score: number; matched: string[]; tier: KbEntry['tier'] }
    let lexical: LexicalRow[] = []
    if (effectiveChannels !== 'vector') {
      if (mergedIndex !== null) {
        // The engine's own indexed path: same filters, same scores, and it
        // loads entries only for the rows it returns.
        const hits = await queryKb(project, global, {
          text: normalized.lexical,
          limit: recallDepth,
          noTouch: true,
          lexicalIndexes: config.lexicalIndexes as readonly LexicalIndex[],
          ...(options.includeExpired !== undefined ? { includeExpired: options.includeExpired } : {}),
          ...(options.includeGlobal !== undefined ? { includeGlobal: options.includeGlobal } : {}),
          ...(options.kinds !== undefined ? { kinds: options.kinds } : {}),
        })
        lexical = hits.map((hit) => ({
          id: String(hit.entry.id),
          score: hit.score,
          matched: hit.matched,
          tier: hit.entry.tier,
        }))
      } else {
        lexical = members
          .map((member) => ({
            id: String(member.entry.id),
            tier: member.entry.tier,
            ...scoreEntry(member.entry, queryTokens, weights, {
              scorer: lexicalScorer,
              ...(corpusStats !== undefined ? { stats: corpusStats } : {}),
            }),
          }))
          .filter((row) => row.score > 0 && row.matched.length > 0)
          .sort((a, b) =>
            b.score - a.score
            || (a.tier === b.tier ? 0 : a.tier === 'project' ? -1 : 1)
            || a.id.localeCompare(b.id))
      }
    }
    const lexicalRanked = rollUpToKeys(lexical.slice(0, recallDepth).map((row) => ({ key: row.id })))
    const lexicalById = new Map(lexical.map((row) => [row.id, row]))

    // ── vector channel ────────────────────────────────────────────────────
    let state: VectorChannelState
    const semanticById = new Map<string, number>()
    let vectorRanked: string[] = []
    if (effectiveChannels === 'lexical') {
      state = { status: 'disabled', note: channelStateNote ?? '本次只走词法通道(--channel lexical)' }
    } else if (config.embedder === undefined) {
      state = { status: 'not-configured', note: '嵌入端点未配置(enabled=false 或缺 baseUrl/model)' }
    } else {
      const embedder = config.embedder
      try {
        // The SEMANTIC text, not the raw query: for `gate` that is the prose
        // with every path and identifier removed. An empty semantic text means
        // the query was nothing but identifiers — the honest answer is "this
        // channel has nothing to embed", not an embedding of boilerplate.
        if (normalized.semantic.trim() === '') throw new SemanticSkip()
        const [queryVector] = await embedder.embed([normalized.semantic])
        if (queryVector === undefined) throw new Error('embedder 未返回查询向量')
        const tiers: KbStore[] = []
        if (project !== null) tiers.push(project)
        if (global !== null && options.includeGlobal !== false) tiers.push(global)
        const merged: Array<{ hit: VectorHit; tier: KbStore['tier'] }> = []
        const states: VectorChannelState[] = []
        for (const store of tiers) {
          const recalled = await vectorRecall(store, queryVector, recallDepth)
          states.push(recalled.state)
          for (const hit of recalled.hits) merged.push({ hit, tier: store.tier })
        }
        merged.sort((a, b) =>
          b.hit.score - a.hit.score
          || (a.tier === b.tier ? 0 : a.tier === 'project' ? -1 : 1)
          || a.hit.key.localeCompare(b.hit.key))
        for (const row of merged) {
          // A key whose entry is gone (or filtered out) cannot be recalled:
          // a stale row must never resurrect deleted knowledge.
          if (!(mergedIndex?.meta.entries[row.hit.key] !== undefined || byId.has(row.hit.key))) continue
          if (!semanticById.has(row.hit.key)) semanticById.set(row.hit.key, row.hit.score)
        }
        vectorRanked = [...semanticById.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([key]) => key)
        const usable = states.filter((s) => s.status === 'used' || s.status === 'partial')
        state = usable.length === 0
          ? states[0] ?? { status: 'index-missing', note: '向量层待建' }
          : usable.some((s) => s.status === 'partial') && usable.every((s) => s.status === 'partial')
            ? usable[0] as VectorChannelState
            : { status: 'used', note: '语义通道已参与', ...(usable[0]?.count !== undefined ? { count: usable[0].count } : {}), ...(usable[0]?.dim !== undefined ? { dim: usable[0].dim } : {}) }
      } catch (error) {
        if (error instanceof SemanticSkip) {
          // Nothing to embed. This is NOT a failure and NOT a miss: it is a
          // fact about the profile, and it says so in those words.
          state = { status: 'disabled', note: SEMANTIC_SKIP_NOTE }
        } else {
          // The adapter's error text carries the status code and host, never a
          // key (规划 §9.4-2); the retrieval degrades instead of failing.
          state = { status: 'error', note: error instanceof Error ? error.message : String(error) }
        }
      }
    }

    // ── RRF fusion ────────────────────────────────────────────────────────
    const fusedCandidates = effectiveChannels === 'vector'
      ? rrfFuse([{ name: 'vector', weight: vecWeight, ranked: vectorRanked }], rrfK)
      : rrfFuse([
        { name: 'lexical', weight: lexWeight, ranked: lexicalRanked },
        { name: 'vector', weight: vecWeight, ranked: vectorRanked },
      ], rrfK)
    // F2: apply the vector-only quota BEFORE the window slice, keeping the
    // fusion order (the quota decides who gets IN, never the order among them).
    const capped = config.maxVectorOnly === undefined
      ? fusedCandidates
      : (() => {
        const kept: FusedCandidate[] = []
        let vectorOnly = 0
        for (const row of fusedCandidates) {
          if (row.ranks.lexical === undefined) {
            if (vectorOnly >= (config.maxVectorOnly as number)) continue
            vectorOnly += 1
          }
          kept.push(row)
        }
        return kept
      })()
    const fused = capped.slice(0, rerankCandidates)
    if (mergedIndex !== null) {
      // Only now is it known which entries can possibly matter: the fused
      // window (plus the lexical rows whose `matched`/score the explanation
      // quotes). Everything else stays on disk.
      for (const key of new Set([...lexicalRanked.slice(0, recallDepth), ...fused.map((row) => row.key), ...vectorRanked.slice(0, recallDepth)])) {
        await loadById(key)
      }
    }

    // ── deterministic rerank (or the fused order, honestly labeled) ───────
    const note = degradationNote(state)
    const buildHit = (key: string, score: number, result: RerankResult | null, fusedRow: FusedCandidate): QueryHit | null => {
      const member = byId.get(key)
      if (member === undefined) return null
      const lexicalRow = lexicalById.get(key)
      const semantic = semanticById.get(key) ?? null
      return {
        entry: member.entry,
        score: Math.round(score * 10000) / 10000,
        matched: lexicalRow?.matched ?? [],
        annotations: annotationsFor(member.entry),
        explain: {
          score: Math.round(score * 10000) / 10000,
          lexicalScore: lexicalRow?.score ?? 0,
          semantic,
          channels: { ...fusedRow.ranks },
          features: result?.features ?? {},
          contributions: result?.contributions ?? {},
          factors: result?.factors ?? {},
          lines: result?.explanation ?? [
            `未精排:按 RRF 融合分排序(词法通道名次 ${fusedRow.ranks.lexical ?? '-'} / 语义通道名次 ${fusedRow.ranks.vector ?? '-'})`,
          ],
        },
      }
    }

    let ordered: QueryHit[] = []
    if (rerankEnabled) {
      // D4: the semantic channel's own order, as a rank. Built from the same
      // sorted list the fusion used, so the feature and the fusion can never
      // disagree about who the semantic channel preferred.
      const semanticRankById = new Map<string, number>()
      vectorRanked.forEach((key, index) => semanticRankById.set(key, index + 1))
      const candidates: RerankCandidate[] = []
      for (const row of fused) {
        const member = byId.get(row.key)
        if (member === undefined) continue
        const lexicalRow = lexicalById.get(row.key)
        const semantic = semanticById.get(row.key)
        const semanticRank = semanticRankById.get(row.key)
        candidates.push({
          entry: member.entry,
          lexicalScore: lexicalRow?.score ?? 0,
          matched: lexicalRow?.matched ?? [],
          ...(semantic !== undefined ? { semantic } : {}),
          ...(semanticRank !== undefined ? { semanticRank } : {}),
          annotations: annotationsFor(member.entry),
        })
      }
      const results = rerankAll(candidates, {
        // `exactPhrase` is a LEXICAL feature: it must see the whole query,
        // identifiers included (that is what makes a path hit decisive).
        queryText: normalized.lexical,
        queryTokens,
        stats: corpusStats ?? buildCorpusStats(members.map((member) => ({
          key: String(member.entry.id),
          title: member.entry.title,
          tags: member.entry.tags,
          text: entryTextAfterRedlines(member.entry),
        }))),
        ...(options.boostBindings !== undefined ? { changedFiles: new Set(options.boostBindings.map(normalizePath)) } : {}),
        bindingWeightEnabled: profile.bindingRecall && options.boostBindings !== undefined,
        signalScores: await signalScores(now),
        trustThreshold: config.trustThreshold ?? project?.config.trustThreshold ?? global?.config.trustThreshold ?? 20,
        now,
        ...(config.featureWeights !== undefined ? { weights: config.featureWeights } : {}),
        // The RESOLVED values, never `auto`: `rerankOne` must not have to know
        // about channels, and an unresolved `auto` reaching it would silently
        // mean "candidates" (the wrong answer for a hybrid run).
        lexicalNormalization,
        semanticScale,
        ...(config.semanticFloor !== undefined ? { semanticFloor: config.semanticFloor } : {}),
        ...(config.semanticCeil !== undefined ? { semanticCeil: config.semanticCeil } : {}),
        ...(config.missingFeatureMode !== undefined ? { missingFeatureMode: config.missingFeatureMode } : {}),
        profile,
      })
      for (const result of results) {
        const fusedRow = fused.find((row) => row.key === String(result.candidate.entry.id))
        const hit = buildHit(String(result.candidate.entry.id), result.score, result, fusedRow ?? { key: '', score: 0, ranks: {}, contributions: {} })
        if (hit !== null) ordered.push(hit)
      }
    } else {
      // Rerank off: the fused order IS the ranking law, and it is labeled as
      // such in each hit's explanation rather than passed off as a reranked one.
      for (const row of fused) {
        const hit = buildHit(row.key, row.score, null, row)
        if (hit !== null) ordered.push(hit)
      }
    }

    // ── V5: the optional model rerank, reported as a DIFF ─────────────────
    let llmOutcome: LlmRerankOutcome | null | undefined
    if (config.llmRerank === true && config.llmRerankPort !== undefined && ordered.length >= 2) {
      llmOutcome = await runLlmRerank(
        config.llmRerankPort,
        normalized.lexical,
        ordered.slice(0, rerankCandidates).map((hit) => ({
          id: String(hit.entry.id),
          title: hit.entry.title,
          excerpt: entryTextAfterRedlines(hit.entry),
          score: hit.score,
        })),
        {
          maxCandidates: rerankCandidates,
          ...(config.llmRerankTimeoutMs !== undefined ? { timeoutMs: config.llmRerankTimeoutMs } : {}),
          onError: (reason) => { config.llmRerankErrorSink?.(reason) },
        },
      )
      const applied = llmOutcome
      if (applied !== null && applied !== undefined) {
        const rankOf = new Map(applied.order.map((id, index) => [id, index]))
        const rest = ordered.slice(rerankCandidates)
        ordered = [
          ...ordered.slice(0, rerankCandidates)
            .map((hit) => ({ hit, position: rankOf.get(String(hit.entry.id)) ?? Number.MAX_SAFE_INTEGER }))
            .sort((a, b) => a.position - b.position)
            .map((row) => row.hit),
          ...rest,
        ]
        // The breakdown says which order is which, so nobody mistakes a model
        // rerank for the deterministic one.
        const moves = new Map(applied.moves.map((move) => [move.id, move]))
        ordered = ordered.map((hit) => {
          const move = moves.get(String(hit.entry.id))
          if (hit.explain === undefined || move === undefined) return hit
          return {
            ...hit,
            explain: {
              ...hit.explain,
              lines: [...hit.explain.lines, `模型重排:第 ${move.from} → 第 ${move.to}(${applied.ms}ms)`],
            },
          }
        })
      }
    }

    // ── finalization: the same on-the-way-out acts queryKb performs ───────
    const final: QueryHit[] = []
    for (const hit of ordered.slice(0, limit)) {
      const store = storeOf(hit.entry)
      const enriched = await enrichHit(store, hit.entry, hit, { at, ...(options.noTouch === true ? { noTouch: true } : {}) })
      // Two honest notes can apply: the channel's own degradation, and F1's
      // ability gate. Both must reach the reader.
      const notes = [note, channelStateNote].filter((value): value is string => value !== null && value !== undefined)
      final.push(notes.length === 0 ? enriched : { ...enriched, annotations: [...enriched.annotations, ...notes] })
    }

    if (config.onRank !== undefined) {
      try {
        await config.onRank({
          at,
          profile: profile.name,
          channels: effectiveChannels,
          rerank: rerankEnabled,
          query,
          candidates: final.map((hit) => ({
            id: String(hit.entry.id),
            score: hit.score,
            lexicalScore: hit.explain?.lexicalScore ?? 0,
            semantic: hit.explain?.semantic ?? null,
            features: hit.explain?.features ?? {},
          })),
          vector: state.status,
        })
      } catch {
        // A ranklog failure must never fail a retrieval (plan §5.3 护栏 2).
      }
    }

    return {
      hits: final,
      vector: state,
      profile,
      channels: effectiveChannels,
      rerank: rerankEnabled,
      recalled: { lexical: lexical.length, vector: vectorRanked.length },
      fused: fusedCandidates.length,
      lexicalIndex: lexicalIndexState(config),
      normalized,
      ...(config.llmRerank === true ? { llmRerank: llmOutcome ?? null } : {}),
    }
  }

  return {
    provider: channels === 'lexical' ? 'fulltext' : `hybrid:${profile.name}`,
    retrieve: async (query, options) => (await retrieveDetailedImpl(query, options)).hits,
    retrieveDetailed: retrieveDetailedImpl,
  }
}
