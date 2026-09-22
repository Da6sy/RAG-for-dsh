/**
 * The ONE table of retrieval defaults (F0 of `docs/开发记录.md`).
 *
 * Why this file exists: the same knob had a default written in TWO places — the
 * settings namespace (`packages/kb-face/src/embedding-config.ts`, what the
 * product reads) and the retriever's own fallbacks (`hybrid.ts`, what an
 * offline harness reads when it passes nothing). Measured consequence: changing
 * the settings default moved NOTHING in `scripts/bench-beir.mjs`, and three
 * consecutive benchmark runs with materially different settings produced
 * byte-identical numbers — the harness was reading the library's fallback, not
 * the configuration under test.
 *
 * The engine owns the values (it is the layer both paths depend on); the
 * settings schema and the retrievers read them from here. A knob may be
 * overridden at either level, but its DEFAULT exists once.
 *
 * @module @clue-harness/rag/defaults
 */

/** Every retrieval knob's shipped default, in one place. */
export const RETRIEVAL_DEFAULTS = {
  /** Fusion strategy (only `rrf` ships). */
  fusion: 'rrf',
  /** RRF constant. */
  rrfK: 60,
  /** Per-channel fusion weights. */
  channelWeights: { lexical: 1, vector: 1 },
  /** Per-channel recall depth before fusion. */
  recallDepth: 50,
  /** Candidates entering the rerank stage. */
  rerankCandidates: 30,
  /** Whether the deterministic reranker runs at all. */
  rerank: true,
  /** V5's optional model reranker (default off). */
  llmRerank: false,
  /** Whether retrievals append a ranklog row. */
  ranklog: true,
  /** The query-writing doctrine the prompt teaches (`intent` | `keywords`). */
  queryStyle: 'intent' as 'intent' | 'keywords',
  /** The first-level ranking formula (`bm25` | `weights`). */
  lexicalScorer: 'bm25' as 'bm25' | 'weights',
  /**
   * D1: `bm25ish` scale.
   *
   * `auto` (the shipped default since 落地计划 §2-2) resolves BY CHANNEL: the
   * absolute scale exists to put two channels on one ruler, so it applies when
   * the semantic channel really participates (`hybrid`) and stays off when the
   * single lexical channel is all there is. Measured reason: with the absolute
   * scale unconditionally on, the pure-lexical tier lost ground (scifact
   * 0.6788 → 0.6501, cosqa 0.3003 → 0.2833) while the hybrid tier gained
   * everywhere — the plan's judgement is that the gain and the loss have
   * different causes and must not share one switch.
   *
   * Explicit values (`candidates` / `absolute`) always win: they are what a
   * single-variable A/B and a rollback need.
   */
  lexicalNormalization: 'auto' as 'auto' | 'candidates' | 'absolute',
  /** D2: cosine scale — `auto` (by channel, see above), `raw`, or `calibrated`. */
  semanticScale: 'auto' as 'auto' | 'raw' | 'calibrated',
  /** D2's calibration floor (text-embedding-v4 family initial value). */
  semanticFloor: 0.3,
  /** D2's calibration ceiling. */
  semanticCeil: 0.8,
  /** D3: how a feature whose channel did not recall the candidate is treated. */
  missingFeatureMode: 'zero' as 'zero' | 'absent',
  /**
   * F4② (落地计划 §2-4): how BM25 reads a field's term frequency — `presence`
   * (shipped: a token counts once) or `count` (the real frequency). It moves the
   * length basis with it (distinct tokens vs total tokens), because the plan
   * measured them as ONE variable; the statistics follow from the same switch.
   */
  termFrequency: 'presence' as 'presence' | 'count',
} as const

/** The type of the table (so a schema can be typed from it). */
export type RetrievalDefaults = typeof RETRIEVAL_DEFAULTS

/** Which channel shape the scale is being resolved FOR. */
export type ScaleChannel = 'lexical' | 'vector' | 'hybrid'

/**
 * Resolve D1's scale for a channel shape (落地计划 §2-2).
 *
 * `auto` = "the absolute scale only where there are two channels to reconcile":
 * `hybrid` gets `absolute`, every single-channel shape gets `candidates`
 * (today's behavior). This is a PURE function on purpose — it is the whole
 * decision, so it can be tested without a store, an embedder or a corpus.
 * @param value - the configured档位 (`auto` when the caller says nothing).
 * @param channels - the channel shape that ACTUALLY ran (after the F1 gate).
 * @returns `candidates` or `absolute`, never `auto`.
 */
export function resolveLexicalNormalization(
  value: 'auto' | 'candidates' | 'absolute',
  channels: ScaleChannel,
): 'candidates' | 'absolute' {
  if (value !== 'auto') return value
  return channels === 'hybrid' ? 'absolute' : 'candidates'
}

/**
 * Resolve D2's semantic scale for a channel shape (same doctrine as D1).
 * @param value - the configured档位 (`auto` when the caller says nothing).
 * @param channels - the channel shape that ACTUALLY ran (after the F1 gate).
 * @returns `raw` or `calibrated`, never `auto`.
 */
export function resolveSemanticScale(
  value: 'auto' | 'raw' | 'calibrated',
  channels: ScaleChannel,
): 'raw' | 'calibrated' {
  if (value !== 'auto') return value
  return channels === 'hybrid' ? 'calibrated' : 'raw'
}
