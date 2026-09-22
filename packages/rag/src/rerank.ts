/**
 * Deterministic feature reranking (V2, 规划 §8).
 *
 * The second stage of retrieval: the lexical recall keeps doing what it always
 * did (hard-zero gate, redline-filtered tokens, status filtering), and this
 * module reorders what it recalled — plus whatever the vector channel added —
 * by an explicit, inspectable linear score.
 *
 * Three properties are the whole point (规划 §8.1):
 *
 * 1. **Deterministic.** Hand-built features, fixed weights, no model call, no
 *    sampling. The same query over the same library gives the same order
 *    (不变量 7), and every number that produced it is returned to the caller.
 * 2. **Filtering stays filtering.** Status, tier, the needs-review flag and
 *    redlines remain MULTIPLIERS and annotations here, exactly as they were in
 *    `scoreEntry`. Reranking can never resurrect something the first level
 *    filtered, and it can never promote a discarded entry (规划 §8.1 原则 2).
 * 3. **Explainable.** Each hit carries `features`, `contributions`, `factors`
 *    and a human line per term, so every surface (CLI `--explain`, the panel,
 *    tool output) can answer "why is this ranked first" without a second
 *    implementation of the arithmetic.
 *
 * The one new scoring idea is `bm25ish`: the plan's answer to structural gap
 * §1.3-2 (no IDF, no length normalization, long entries win by bulk). Term
 * frequency is binary here (presence per field), so the classic k1/b shape
 * degenerates to a length-normalized, IDF-weighted presence score — which is
 * exactly what a bigram-tokenized Chinese corpus needs.
 *
 * @module @clue-harness/rag/rerank
 */
import {
  DEFAULT_WEIGHTS,
  bm25fScoreFrom,
  bm25CountFields,
  bm25Fields,
  bm25fScore,
  type TermFrequency,
  buildLexicalStats,
  entryTextAfterRedlines,
  idf as kbIdf,
  redlinedRatio,
  tokenize,
  type KbEntry,
  type LexicalStats,
  type RetrievalWeights,
} from '@clue-harness/kb'
import { normalizePath } from './retrieve.ts'

/**
 * The channel profiles moved to `profiles.ts` in V3 (they gained a query
 * normalization spec, which is behavior rather than a weight table). Re-exported
 * here so the V2 call sites and tests keep one import path.
 */
export { CHANNEL_PROFILES, resolveProfile } from './profiles.ts'
// Imported for local use AND re-exported: a re-export alone does not put the
// name in this module's scope, and the context below needs the type.
import type { ChannelProfile } from './profiles.ts'
export type { ChannelProfile }

/** The feature weights (规划 §8.2 初值; every one of them is tunable). */
export interface RerankFeatureWeights {
  bm25ish: number
  exactPhrase: number
  semantic: number
  specificity: number
  bindingOverlap: number
  redlinePenalty: number
  freshness: number
  signalScore: number
  docMountBonus: number
  /**
   * D4 (`docs/开发记录.md` §3): the SEMANTIC channel's rank as
   * a feature. Default weight 0 — the plan's 待拍板 §9-3: add the feature, keep
   * the behavior, decide the weight only after an A/B.
   */
  semanticRank: number
  /** D4: the FUSION order's normalized rank as a feature (also default 0). */
  fusedRank: number
  /**
   * D3: the "this channel did not recall me" indicator. Default weight 0, and it
   * exists so that a missing value can be *learned about* rather than only being
   * absent (the plan's §3-D3 optional 缺失指示特征).
   */
  semanticAbsent: number
}

/** The shipped initial values — the plan's table, verbatim. */
export const DEFAULT_FEATURE_WEIGHTS: RerankFeatureWeights = {
  bm25ish: 1,
  exactPhrase: 0.6,
  semantic: 0.8,
  specificity: 0.5,
  bindingOverlap: 0.5,
  redlinePenalty: -0.3,
  freshness: 0.2,
  signalScore: 0.3,
  docMountBonus: 0.15,
  // D4/D3: shipped at 0 so that "关掉即今天" holds by construction. The plan
  // requires an A/B with numbers before any of these stops being zero.
  semanticRank: 0,
  fusedRank: 0,
  semanticAbsent: 0,
}

/** The status multipliers — unchanged from the first level (不变量 9 的可回滚性). */
export const RERANK_STATUS_FACTOR: Record<string, number> = { trusted: 1, candidate: 0.85, expired: 0.5 }

/** The tier multipliers — unchanged from the first level. */
export const RERANK_TIER_FACTOR: Record<string, number> = { project: 1, global: 0.8 }

/** The needs-review multiplier — unchanged from the first level. */
export const RERANK_REVIEW_FACTOR = 0.7

/**
 * The BM25 shape constants — re-exported from the engine, never redefined here.
 * Two copies of `k1` is exactly the accident the plan's §3.4 forbids (and an
 * architecture test now fails on it).
 */
export { BM25_B, BM25_K1 } from '@clue-harness/kb'

/** The freshness half-life in days (规划 §8.2 `freshness`). */
export const FRESHNESS_HALF_LIFE_DAYS = 30

/** One document's corpus statistics input (`key` is the entryId). */
export interface CorpusDoc {
  key: string
  title: string
  tags: readonly string[]
  text: string
}

/**
 * Corpus-wide statistics the term weights need (built once per retrieval).
 *
 * Since R2 these ARE the first level's statistics — one type, one builder, both
 * levels: `bm25ish` is now a normalization of the same score the first level
 * ranks by, not a second opinion about term weighting.
 */
export type CorpusStats = LexicalStats

/**
 * Build the corpus statistics one retrieval needs.
 *
 * Built from the SAME redline-filtered text the first level scores, so a
 * retracted paragraph cannot influence IDF (不变量 4) — otherwise redlining
 * would silently change how every OTHER entry ranks.
 * @param docs - the corpus (both tiers).
 * @returns document frequencies and the average length.
 */
export function buildCorpusStats(docs: readonly CorpusDoc[]): CorpusStats {
  return buildLexicalStats(docs.map((doc) => ({ title: doc.title, tags: doc.tags, text: doc.text })))
}

/** Robertson/Sparck-Jones IDF — imported, never re-derived (plan §3.4). */
const idf = kbIdf

/** The field tokens of one entry (redline-filtered body, like the first level). */
export function entryFieldTokens(entry: KbEntry): { title: Set<string>; tag: Set<string>; text: Set<string> } {
  return {
    title: new Set(tokenize(entry.title)),
    tag: new Set(tokenize(entry.tags.join(' '))),
    text: new Set(tokenize(entryTextAfterRedlines(entry))),
  }
}

/** One candidate entering the rerank stage. */
export interface RerankCandidate {
  entry: KbEntry
  /** The first level's score (kept for the breakdown and for `--rerank off`). */
  lexicalScore: number
  /** The tokens the first level matched. */
  matched: readonly string[]
  /** Cosine similarity, when the vector channel recalled this candidate. */
  semantic?: number
  /** Annotations the caller must show (status/review/doc facts). */
  annotations: readonly string[]
  /** Derived chunk count behind the entry's evidence (M9-1 fact). */
  docHeadingCount?: number
  /**
   * D4: this candidate's rank (1-based) inside the SEMANTIC channel.
   *
   * Absent means "the vector channel did not recall this candidate" — D3's
   * missing state, not a bad rank. The RAW rank is what the caller passes; the
   * normalization to 0–1 happens in {@link rerankAll}, which is the only place
   * that knows the pool size.
   */
  semanticRank?: number
  /** D4: this candidate's rank (1-based) in the FUSED order it arrived in. */
  fusedRank?: number
}

/** Everything the features need that is not a property of the candidate. */
export interface RerankContext {
  /** The query as typed (for `exactPhrase`). */
  queryText: string
  /** The query's tokens. */
  queryTokens: readonly string[]
  /** Corpus statistics (IDF + length normalization). */
  stats: CorpusStats
  /** Files changed in this work unit (normalized); empty disables the feature. */
  changedFiles?: ReadonlySet<string>
  /** Whether the profile lets binding overlap count (规划 §7.3). */
  bindingWeightEnabled?: boolean
  /** entryId → window score (the signal ledger's contribution). */
  signalScores?: ReadonlyMap<string, number>
  /** The promote threshold the signal score is normalized against. */
  trustThreshold?: number
  /** Injectable clock. */
  now?: Date
  /** Field weights for the term-frequency part (defaults: title 3 / tag 2 / text 1). */
  fieldWeights?: RetrievalWeights
  /** Feature weights (partial: absent keys keep the plan's table values). */
  weights?: Partial<RerankFeatureWeights>
  /** The channel profile (recorded in the explanation; weights live in fusion). */
  profile?: ChannelProfile
  /**
   * D1 (`docs/开发记录.md` §3): what `bm25ish` is relative TO.
   *
   * `candidates` (default, = today) divides by the best raw score IN the
   * candidate set, so SOME document is always scaled to 1.0 — the feature cannot
   * express "this query has no real lexical evidence in this corpus".
   * `absolute` saturates against a POOL-level scale instead:
   * `bm25abs = raw / (raw + scale_q)`, so a weak pool produces weak values.
   */
  lexicalNormalization?: 'candidates' | 'absolute'
  /**
   * D2 (§3): whether the raw cosine is mapped onto the same [0,1] scale as the
   * other features. `raw` (default, = today) keeps the uncalibrated cosine;
   * `calibrated` clamps `(cos − floor)/(ceil − floor)`.
   */
  semanticScale?: 'raw' | 'calibrated'
  /** The calibration floor (a cosine below this counts as no semantic evidence). */
  semanticFloor?: number
  /** The calibration ceiling (a cosine at or above this counts as full evidence). */
  semanticCeil?: number
  /**
   * D3: what a feature whose channel did NOT recall the candidate means.
   *
   * `zero` (default, = today) folds "not recalled" and "recalled with a low
   * score" into the same number. `absent` keeps them apart: the term contributes
   * nothing AND is excluded from every candidate-set normalization, and
   * `--explain` says 未参与 instead of printing a `+0.000` line.
   *
   * Honest note: in the CURRENT additive model the two modes produce identical
   * scores (a missing term contributes 0 anyway, and the only candidate-set
   * normalization — D1's `candidates` mode — already ignores zero raw scores).
   * What `absent` buys today is the tri-state bookkeeping, the explain line and
   * the absence indicator; it becomes arithmetically decisive only if a future
   * feature normalizes over "recalled by this channel" only.
   */
  missingFeatureMode?: 'zero' | 'absent'
  /** F4②: presence (shipped) or real counts — must match how `stats` was built. */
  termFrequency?: TermFrequency
  /** F4①: subword expansion — must match how the index and the stats were built. */
  identifierSubtokens?: boolean
  /** D4: the number of candidates the semantic channel recalled (rank normalizer). */
  semanticPoolSize?: number
  /** D4: the number of candidates in the fused window (rank normalizer). */
  fusedPoolSize?: number
}

/** One reranked candidate with its full arithmetic. */
export interface RerankResult {
  candidate: RerankCandidate
  score: number
  /** Raw feature values, each in its own natural range. */
  features: Record<string, number>
  /** `weight × feature` for every additive term (negative for penalties). */
  contributions: Record<string, number>
  /** The multiplicative terms applied to the additive sum. */
  factors: Record<string, number>
  /** Human-readable lines: one per term that moved the score. */
  explanation: string[]
  /**
   * D3: the feature keys that are MISSING because their channel did not recall
   * this candidate (`semantic`, `semanticRank`). Empty in the `zero` mode, where
   * the distinction is deliberately not drawn.
   */
  missing: string[]
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The BM25-shaped lexical feature, normalized to 0–1 across the candidate set.
 *
 * Normalization is per-query (divided by the best raw value in the candidate
 * set) rather than absolute: BM25's raw magnitude depends on the query's
 * tokens and the corpus's vocabulary, and an absolute scale would make the
 * fixed `bm25ish` weight mean something different for every query.
 * @param entry - the entry to score.
 * @param queryTokens - the query's tokens.
 * @param stats - corpus statistics.
 * @param fieldWeights - title/tag/text weights.
 * @returns the raw (unnormalized) term score.
 */
export function bm25Raw(
  entry: KbEntry,
  queryTokens: readonly string[],
  stats: CorpusStats,
  fieldWeights: RetrievalWeights,
  termFrequency: TermFrequency = 'presence',
  identifierSubtokens = false,
): number {
  // Delegated to the engine's BM25F: the formula has ONE implementation
  // (`packages/kb/src/bm25.ts`), and this feature is now literally "the first
  // level's score, normalized" rather than a parallel term-weighting scheme.
  const fields = { title: entry.title, tags: entry.tags, text: entryTextAfterRedlines(entry) }
  const tokenizeOptions = { identifierSubtokens }
  if (termFrequency !== 'count') {
    return bm25fScore(bm25Fields(fields, tokenizeOptions), queryTokens, stats, fieldWeights).score
  }
  // The count form carries real frequencies AND total-token lengths, so the
  // feature that mirrors the first level mirrors it under either mode. The
  // engine's own `precomputedFrom` is the single source of that pairing.
  const counts = bm25CountFields(fields, tokenizeOptions)
  const total = (map: ReadonlyMap<string, number>): number => {
    let sum = 0
    for (const value of map.values()) sum += value
    return sum
  }
  return bm25fScoreFrom({
    lengths: { title: total(counts.title), tag: total(counts.tag), text: total(counts.text) },
    counts,
  }, queryTokens, stats, fieldWeights, 'count').score
}

/** Collapse whitespace and case for verbatim phrase matching. */
function normalizePhrase(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Whether the query appears verbatim in the entry.
 *
 * Full-query match wins; otherwise any whitespace-separated segment of at
 * least 4 characters counts as a 关键名词 hit (规划 §8.2: "查询整串/关键名词
 * 逐字命中"). The 4-character floor is what keeps single common bigrams from
 * claiming a phrase bonus.
 * @param haystack - the entry's title + tags + redline-filtered text, normalized.
 * @param queryText - the query as typed.
 * @returns 1 for a full hit, 0.5 for a key-noun hit, 0 otherwise.
 */
export function exactPhraseFeature(haystack: string, queryText: string): number {
  const query = normalizePhrase(queryText)
  if (query.length === 0) return 0
  if (haystack.includes(query)) return 1
  const segments = query.split(/[\s,，、;；:：]+/).filter((segment) => segment.length >= 4)
  return segments.some((segment) => haystack.includes(segment)) ? 0.5 : 0
}

/** Exponential freshness decay on the last reference (or creation) time. */
function freshnessOf(entry: KbEntry, now: Date): number {
  const anchor = Date.parse(entry.stats.lastReferencedAt ?? entry.provenance.createdAt)
  if (Number.isNaN(anchor)) return 0
  const ageDays = Math.max(0, (now.getTime() - anchor) / DAY_MS)
  return 0.5 ** (ageDays / FRESHNESS_HALF_LIFE_DAYS)
}

/** The binding-overlap ratio of one candidate (0 when nothing is bound). */
function bindingOverlapOf(entry: KbEntry, changed: ReadonlySet<string>): number {
  if (changed.size === 0 || entry.bindings.length === 0) return 0
  const involved = entry.bindings.map((binding) => normalizePath(binding.path)).filter((path) => changed.has(path))
  return involved.length === 0 ? 0 : involved.length / changed.size
}

/**
 * Score one candidate from its features.
 *
 * `score = (Σ weight_f × feature_f) × Π factor_f`, where the factors are the
 * status/tier/review multipliers the first level already applied. Keeping them
 * as multipliers (rather than folding them into the weights) is what makes
 * `--explain` readable: a reader sees "candidate ×0.85" as a governance fact,
 * not as an unexplained score gap.
 * @param candidate - the candidate to score.
 * @param context - corpus statistics, query, profile and weights.
 * @param bm25Normalizer - the best raw BM25 in the candidate set (see {@link rerankAll}).
 * @returns the score plus every term behind it.
 */
export function rerankOne(candidate: RerankCandidate, context: RerankContext, bm25Normalizer: number): RerankResult {
  const weights = { ...DEFAULT_FEATURE_WEIGHTS, ...(context.weights ?? {}) }
  const fieldWeights = context.fieldWeights ?? DEFAULT_WEIGHTS
  const now = context.now ?? new Date()
  const entry = candidate.entry

  const raw = bm25Raw(
    entry,
    context.queryTokens,
    context.stats,
    fieldWeights,
    context.termFrequency ?? 'presence',
    context.identifierSubtokens === true,
  )
  const lexicalMode = context.lexicalNormalization ?? 'candidates'
  const bm25ish = lexicalMode === 'absolute'
    // D1: corpus-level saturation. `bm25Normalizer` carries the POOL scale in
    // this mode (see rerankAll); the value stays < 1 for a weak pool, which is
    // the whole point — "no real lexical evidence" becomes expressible.
    ? (raw <= 0 ? 0 : raw / (raw + Math.max(bm25Normalizer, 1e-9)))
    : (bm25Normalizer <= 0 ? 0 : raw / bm25Normalizer)
  const haystack = normalizePhrase(`${entry.title} ${entry.tags.join(' ')} ${entryTextAfterRedlines(entry)}`)
  const exactPhrase = exactPhraseFeature(haystack, context.queryText)
  // ── D3: the tri-state of a channel feature ────────────────────────────────
  // `present` = the channel recalled this candidate. `value` = the feature's
  // number, which is 0 in BOTH modes when the channel did not recall it (the
  // difference is bookkeeping: `absent` drops the term from the summation and
  // from every candidate-set statistic, and says so in `--explain`).
  const missingMode = context.missingFeatureMode ?? 'zero'
  const semanticPresent = candidate.semantic !== undefined
  const semanticRaw = candidate.semantic ?? 0
  // D2: put the cosine on the same scale as everything else. The floor/ceil come
  // from the embedder family's calibration (a setting), never from the candidate
  // set — a per-candidate-set scaling would just be D1's problem again.
  const semantic = (context.semanticScale ?? 'raw') === 'calibrated'
    ? Math.max(0, Math.min(1, (semanticRaw - (context.semanticFloor ?? 0.3)) / Math.max(1e-9, (context.semanticCeil ?? 0.8) - (context.semanticFloor ?? 0.3))))
    : semanticRaw
  // D4: rank as a feature. `1 − (rank−1)/(N−1)` maps the channel's own order
  // onto 0–1; a single-candidate pool is 1 by definition. This cannot replace
  // D1/D2 (the plan's worked example: rank normalization alone still loses),
  // which is why the weight ships at 0.
  const rankFeature = (rank: number | undefined, poolSize: number | undefined): number => {
    if (rank === undefined || !Number.isFinite(rank) || rank < 1) return 0
    if (poolSize === undefined || poolSize <= 1) return 1
    return Math.max(0, Math.min(1, 1 - (rank - 1) / (poolSize - 1)))
  }
  const semanticRankPresent = candidate.semanticRank !== undefined
  const semanticRank = rankFeature(candidate.semanticRank, context.semanticPoolSize)
  const fusedRank = rankFeature(candidate.fusedRank, context.fusedPoolSize)
  const semanticAbsent = semanticPresent ? 0 : 1
  const specificity = context.queryTokens.length === 0 ? 0 : candidate.matched.length / context.queryTokens.length
  const bindingOverlap = (context.bindingWeightEnabled ?? false) && context.changedFiles !== undefined
    ? bindingOverlapOf(entry, context.changedFiles)
    : 0
  const redlineRatio = redlinedRatio(entry)
  const freshness = freshnessOf(entry, now)
  const threshold = context.trustThreshold ?? 20
  const signalScore = context.signalScores === undefined
    ? 0
    : Math.max(0, Math.min(1, (context.signalScores.get(String(entry.id)) ?? 0) / threshold))
  const docMountBonus = entry.doc === undefined ? 0 : 1

  const features: Record<string, number> = {
    bm25ish,
    exactPhrase,
    semantic,
    specificity,
    bindingOverlap,
    redlineRatio,
    freshness,
    signalScore,
    docMountBonus,
    semanticRank,
    fusedRank,
    semanticAbsent,
  }
  /**
   * D3: which terms are ABSENT (their channel did not recall this candidate).
   *
   * Only channel features can be absent — `exactPhrase`, `freshness` and friends
   * are properties of the entry, not of a recall decision, so a 0 there really
   * does mean "scored 0".
   */
  const missing: string[] = missingMode === 'absent'
    ? [
      ...(semanticPresent ? [] : ['semantic']),
      ...(semanticRankPresent ? [] : ['semanticRank']),
    ]
    : []
  const absent = new Set(missing)
  const term = (key: string, value: number): number => (absent.has(key) ? 0 : value)
  const contributions: Record<string, number> = {
    bm25ish: weights.bm25ish * bm25ish,
    exactPhrase: weights.exactPhrase * exactPhrase,
    semantic: term('semantic', weights.semantic * semantic),
    specificity: weights.specificity * specificity,
    bindingOverlap: weights.bindingOverlap * bindingOverlap,
    redlinePenalty: weights.redlinePenalty * redlineRatio,
    freshness: weights.freshness * freshness,
    signalScore: weights.signalScore * signalScore,
    docMountBonus: weights.docMountBonus * docMountBonus,
    semanticRank: term('semanticRank', weights.semanticRank * semanticRank),
    fusedRank: weights.fusedRank * fusedRank,
    semanticAbsent: weights.semanticAbsent * semanticAbsent,
  }
  const factors: Record<string, number> = {
    statusFactor: RERANK_STATUS_FACTOR[entry.status] ?? 0,
    tierFactor: RERANK_TIER_FACTOR[entry.tier] ?? 1,
    reviewPenalty: entry.needsReview ? RERANK_REVIEW_FACTOR : 1,
  }
  const additive = Object.values(contributions).reduce((sum, value) => sum + value, 0)
  // The multiplicative seed MUST be 1: seeding with 0 (as the additive sum
  // legitimately does) would zero every score and look like "no match" instead
  // of crashing — the worst possible failure shape.
  const multiplier = Object.values(factors).reduce((product, value) => product * value, 1)
  const score = Math.round(additive * multiplier * 10000) / 10000

  const explanation: string[] = []
  const label: Record<string, string> = {
    bm25ish: '词法 BM25(含 IDF 与长度归一)',
    exactPhrase: '查询逐字命中',
    semantic: '语义相似度',
    specificity: '查询覆盖率',
    bindingOverlap: '绑定文件在本次改动中',
    redlinePenalty: '划除惩罚',
    freshness: '新鲜度',
    signalScore: '窗口信号分',
    docMountBonus: '有原文层可下钻',
    semanticRank: '语义名次',
    fusedRank: '融合名次',
    semanticAbsent: '语义缺失指示',
  }
  for (const [key, value] of Object.entries(contributions)) {
    // D3: present-but-tiny is silent (as before); absent-and-counting is not.
    if (Math.abs(value) < 0.0005) continue
    explanation.push(`${label[key] ?? key} ${value >= 0 ? '+' : ''}${value.toFixed(3)}`)
  }
  for (const key of missing) {
    const weight = key === 'semanticRank' ? weights.semanticRank : weights.semantic
    if (weight === 0) continue
    explanation.push(`${label[key] ?? key} 未参与(该通道未召回,不计 0 分)`)
  }
  explanation.push(`词法召回分 ${candidate.lexicalScore}(保留,不参与精排)`)
  if (factors.statusFactor !== 1) explanation.push(`状态 ${entry.status} ×${factors.statusFactor}`)
  if (factors.tierFactor !== 1) explanation.push(`全局层 ×${factors.tierFactor}`)
  if (factors.reviewPenalty !== 1) explanation.push(`待复核 ×${factors.reviewPenalty}`)
  if (context.profile !== undefined) {
    explanation.push(`通道 profile ${context.profile.name}(词法 ×${context.profile.lexicalWeight} / 语义 ×${context.profile.semanticWeight})`)
  }
  return { candidate, score, features, contributions, factors, explanation, missing }
}

/**
 * Rerank a whole candidate set.
 *
 * BM25 is normalized against the best candidate in the set, so the set has to
 * be scored in two passes — the plan's `rerankCandidates` (default 30) bounds
 * that set, which is why the normalizer is well defined and cheap.
 * @param candidates - the fused candidate set.
 * @param context - corpus statistics, query, profile and weights.
 * @returns the results, best first (deterministic: score desc, tier, then id).
 */
export function rerankAll(candidates: readonly RerankCandidate[], context: RerankContext): RerankResult[] {
  const fieldWeights = context.fieldWeights ?? DEFAULT_WEIGHTS
  const raws = candidates.map((candidate) => bm25Raw(
    candidate.entry,
    context.queryTokens,
    context.stats,
    fieldWeights,
    context.termFrequency ?? 'presence',
    context.identifierSubtokens === true,
  ))
  let best = 0
  for (const raw of raws) best = Math.max(best, raw)
  /**
   * D1's `scale_q`: a POOL-level statistic, deliberately not "the best one".
   *
   * The plan recommends a corpus-wide quantile once the inverted index exists
   * and a recall-pool quantile as the documented approximation until then. The
   * pool here IS the recall pool (`rerankCandidates` deep), so p90 of its raw
   * scores is that approximation; with fewer than 3 candidates it degrades to
   * the max (nothing to estimate from) and the caller should treat the value as
   * approximate.
   */
  const scaleQ = (() => {
    const positive = raws.filter((raw) => raw > 0).sort((a, b) => a - b)
    if (positive.length === 0) return 0
    if (positive.length < 3) return positive[positive.length - 1] as number
    return positive[Math.min(positive.length - 1, Math.floor(positive.length * 0.9))] as number
  })()
  const lexicalMode = context.lexicalNormalization ?? 'candidates'
  /**
   * D4: the pool sizes the rank features normalize against.
   *
   * Both are derived here rather than asked of the caller: the semantic pool is
   * "how many candidates this channel recalled" (nothing else can know it), and
   * the fused pool is the window we were handed — `fusedRank` defaults to the
   * position in that array, which IS the fusion order (the caller fuses before
   * it calls us, and 不变量 1 keeps that order untouched).
   */
  const semanticPoolSize = candidates.filter((candidate) => candidate.semanticRank !== undefined).length
  const fusedContext: RerankContext = {
    ...context,
    semanticPoolSize: context.semanticPoolSize ?? semanticPoolSize,
    fusedPoolSize: context.fusedPoolSize ?? candidates.length,
  }
  return candidates
    .map((candidate, index) => rerankOne(
      candidate.fusedRank === undefined ? { ...candidate, fusedRank: index + 1 } : candidate,
      fusedContext,
      lexicalMode === 'absolute' ? scaleQ : best,
    ))
    .sort((a, b) =>
      b.score - a.score
      || (a.candidate.entry.tier === b.candidate.entry.tier ? 0 : a.candidate.entry.tier === 'project' ? -1 : 1)
      || String(a.candidate.entry.id).localeCompare(String(b.candidate.entry.id)))
}

