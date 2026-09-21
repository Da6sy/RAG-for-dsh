/**
 * `@clue-harness/rag` — retrieval augmentation (M4) and两级检索 (M9).
 *
 * Business-package discipline (design §2.1): zero dsh imports; the only
 * sibling dependency is the kb engine (stores, queryKb, QueryHit, the
 * chunker). The Cordis-facing consumption happens in kb-face (the gate's
 * second stage and the `kb_detail` tool) — engines first, faces on demand
 * (the M1/M2/M3a precedent).
 *
 * Capabilities:
 * 1. `failureSignature` — the deterministic retrieval query derived from a
 *    FAILED verification (assertions + diff errors + changed files);
 * 2. `RagRetriever` + `createFulltextRetriever` — the retrieval seam
 *    (full-text now; embedding/index-epoch later per 讲解框 C) with the
 *    binding boost: entries bound to files this work unit changed re-rank
 *    up, ANNOUNCED in annotations (explainable retrieval stays a rule);
 * 3. `renderRetrievalAssist` — the gate assist block injected alongside the
 *    correction report (complaint + precedent in one message);
 * 4. M9: `ingestFile` (the write-time slicing channel), `queryChunks` +
 *    `buildExcerpt` (the second level: 原文哪一段) and `renderDetailView`
 *    (the `kb_detail` answer). None of them govern anything — Entry is still
 *    the only thing with status, signals and a lifecycle.
 *
 * @module @clue-harness/rag
 */
export { failureSignature, type SignatureOptions, type SignatureSource } from './signature.ts'
export {
  createFulltextRetriever,
  normalizePath,
  type RagRetriever,
  type RetrieveOptions,
  type RetrieverConfig,
} from './retrieve.ts'
export { renderRetrievalAssist } from './assist.ts'
export { extractText, formatOf, htmlToMarkdown, type ExtractedText, type SourceFormat } from './extract.ts'
export { defaultSourcePath, ingestFile, type IngestOptions, type IngestPreviewChunk, type IngestReport } from './ingest.ts'
export {
  anchorLabel,
  buildExcerpt,
  chunkQueryTokens,
  DEFAULT_CHUNK_WEIGHTS,
  loadChunks,
  NO_DOC_NOTICE,
  queryChunks,
  redlinesForDoc,
  scoreChunkText,
  resolveChunkSources,
  type ChunkHit,
  type ChunkVectorConfig,
  type ChunkVectorState,
  type ChunkRetrievalConfig,
  type ChunkSource,
  type QueryChunksOptions,
} from './chunks.ts'
export {
  DEFAULT_DETAIL_EXCERPT_CHARS,
  DEFAULT_DETAIL_MAX_CHARS,
  renderChunkBlock,
  renderDetailView,
  type DetailView,
} from './detail.ts'
export {
  DEFAULT_HASH_DIM,
  HASH_EMBEDDER_ID,
  hashEmbedder,
  type Embedder,
} from './embedder.ts'
export {
  DEFAULT_MAX_UNITS_PER_BUILD,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  buildVectorIndex,
  chunkEmbedText,
  collectUnits,
  entryEmbedText,
  planEmbed,
  vectorIndexIsCurrent,
  type EmbedBuildOptions,
  type EmbedBuildReport,
  type EmbedPlan,
  type EmbedUnit,
} from './index-pipeline.ts'
export { DEFAULT_RRF_K, normalizedPathSet, rrfFuse, rollUpToKeys, type FusedCandidate, type RankedChannel } from './fuse.ts'
export {
  CHANNEL_PROFILES,
  isIdentifierToken,
  normalizeQuery,
  resolveProfile,
  type ChannelProfile,
  type NormalizedQuery,
  type ProfileNormalization,
} from './profiles.ts'
export { docIdOfChunkKey, searchVectors, type VectorHit, type VectorSearchOptions } from './vector-search.ts'
export {
  BM25_B,
  BM25_K1,
  DEFAULT_FEATURE_WEIGHTS,
  FRESHNESS_HALF_LIFE_DAYS,
  RERANK_REVIEW_FACTOR,
  RERANK_STATUS_FACTOR,
  RERANK_TIER_FACTOR,
  bm25Raw,
  buildCorpusStats,
  entryFieldTokens,
  exactPhraseFeature,
  rerankAll,
  rerankOne,
  type CorpusDoc,
  type CorpusStats,
  type RerankCandidate,
  type RerankContext,
  type RerankFeatureWeights,
  type RerankResult,
} from './rerank.ts'
export {
  DEFAULT_RECALL_DEPTH,
  DEFAULT_RERANK_CANDIDATES,
  createHybridRetriever,
  type HybridConfig,
  type HybridRetrieval,
  type RankLogLine,
  type RecallChannels,
  type VectorChannelState,
} from './hybrid.ts'
export {
  LLM_RERANK_EXCERPT_CHARS,
  LLM_RERANK_MAX_CANDIDATES,
  buildRerankPrompt,
  describeRerankDiff,
  llmRerank,
  parseRerankAnswer,
  type LlmRankPort,
  type LlmRerankOutcome,
  type RerankMove,
  type RerankPromptCandidate,
} from './llm-rerank.ts'
export {
  DEFAULT_LABEL_WINDOW_MS,
  LTR_FEATURES,
  LTR_MIN_QUERIES,
  buildTrainingSet,
  evaluateWeights,
  handWeights,
  ltrReadiness,
  trainLogistic,
  type LtrEvaluation,
  type LtrModel,
  type LtrReadiness,
  type TrainingRow,
} from './ltr.ts'
export {
  RANKLOG_VERSION,
  ranklogFile,
  appendRankLog,
  readRankLog,
  summarizeRankLog,
  type RankLogRow,
  type RankLogSummary,
} from './ranklog.ts'
