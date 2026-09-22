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
  /** D1: `bm25ish` scale — `candidates` (today) or `absolute` (pool-level). */
  lexicalNormalization: 'candidates' as 'candidates' | 'absolute',
  /** D2: cosine scale — `raw` (today) or `calibrated` ([0,1] via floor/ceil). */
  semanticScale: 'raw' as 'raw' | 'calibrated',
  /** D2's calibration floor (text-embedding-v4 family initial value). */
  semanticFloor: 0.3,
  /** D2's calibration ceiling. */
  semanticCeil: 0.8,
  /** D3: how a feature whose channel did not recall the candidate is treated. */
  missingFeatureMode: 'zero' as 'zero' | 'absent',
} as const

/** The type of the table (so a schema can be typed from it). */
export type RetrievalDefaults = typeof RETRIEVAL_DEFAULTS
