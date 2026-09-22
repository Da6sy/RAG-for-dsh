/**
 * The retrieval plane (V1/V2 wiring, 原规划 §3 决策 4 + §7).
 *
 * One place where the FACE decides what the knowledge base's retrieval looks
 * like right now, so no consumer has to reassemble the decision:
 *
 * ```
 *   settings (embedding + retrieval)  →  is an embedder available?
 *        yes → hybrid retriever (lexical + vector → RRF → rerank)
 *        no  → lexical retriever (today's path, unchanged)
 * ```
 *
 * Three rules keep that from becoming a second retrieval law:
 *
 * 1. **The tool channel is the only one wired in V0–V2** (拍板 4). The pre-step
 *    injection and the failure-signature gate keep the shipped retriever until
 *    V3 gives them their own profiles; that is why the plan lists "首版评测归因
 *    干净" as the reason for the split.
 * 2. **Rerank is configurable and reversible** (不变量 9): `rerank: false` +
 *    no embedder is exactly today's path, and the test suite pins that.
 * 3. **A changed key or endpoint takes effect on the next call** (不变量 11):
 *    the embedder reads its configuration through getters and resolves the key
 *    per operation, so nothing here caches a credential or an endpoint.
 *
 * @module @clue-harness/kb-face/retrieval-plane
 */
import { readSignals, type KbStore, type QueryHit } from '@clue-harness/kb'
import {
  appendRankLog,
  createHybridRetriever,
  ensureLexicalIndexes,
  ranklogFile,
  type ChunkVectorConfig,
  type VectorChannelState,
} from '@clue-harness/rag'
import type { Context } from '@deepseek-ai/cordis'
import {
  embeddingKeyStatus,
  embeddingReadinessNote,
  embeddingReady,
  readEmbeddingConfig,
  readRetrievalConfig,
  resolveEmbeddingKey,
  type EmbeddingConfig,
  type KeyStatus,
  type RetrievalConfig,
} from './embedding-config.ts'
import { createHttpEmbedder } from './http-embedder.ts'
import { embedderVersion } from '@clue-harness/kb'
import path from 'node:path'

/** The knobs a caller may pass for one retrieval. */
export interface PlaneRetrieveOptions {
  limit?: number
  includeExpired?: boolean
  /** Files changed in this work unit (the binding channel; gate/worklog only). */
  boostBindings?: readonly string[]
  /** Skip the reference touch (read-only inspection). */
  noTouch?: boolean
  /**
   * V3: which channel profile to use. V0–V2 shipped only `tool`; the pre-step
   * injection and the failure-signature gate now have their own rows (§7.3),
   * because their queries are mechanically written and shaped differently.
   */
  profile?: string
}

/** The answer of one plane retrieval, including the channel state. */
export interface PlaneRetrieval {
  hits: QueryHit[]
  /** Which channels actually ran. */
  channels: 'lexical' | 'hybrid'
  rerank: boolean
  profile: string
  /** Why the semantic channel did or did not contribute (不变量 5). */
  vector: VectorChannelState
  /**
   * R1: whether the first level answered from the inverted index or scanned the
   * corpus, plus the reason when it scanned (不变量 5 applies to performance
   * degradations too: "索引待建" must be readable, not just slower).
   */
  lexicalIndex: { used: boolean; note: string }
}

/** The retrieval plane's own state, as a panel or a CLI line reports it. */
export interface PlaneStatus {
  embedding: EmbeddingConfig
  retrieval: RetrievalConfig
  /** Whether an embedder can be built from this configuration. */
  ready: boolean
  /** The one-line reason when it is not. */
  note: string
  key: KeyStatus
  /** The `embedderVersion` in effect ('' when not ready). */
  embedderVersion: string
  /**
   * 落地计划 §2-7: WHERE rows go and whether writing has ever failed.
   *
   * This field exists because of a false alarm: a report read "8 rows, all
   * pre-step" as "the tool path never logs" without ever naming the file it
   * counted. A count without a source cannot be falsified.
   */
  ranklog: { enabled: boolean; file: string; failures: number; lastError: string | null }
}

/** What the plane needs from its host. */
export interface RetrievalPlaneOptions {
  /** ClueHarness home (the shared embed cache lives under it). */
  home?: string
  /** The plugin diagnostic name for the ranklog failure path. */
  onWarn?: (message: string) => void
}

/** The plane: one instance per mounted face. */
export interface RetrievalPlane {
  /**
   * Retrieve through the configured channels for one project root.
   * @param stores - the tier pair the query addresses.
   * @param text - the query.
   * @param options - per-call knobs.
   * @returns hits plus the honest channel state.
   */
  retrieve(stores: { project: KbStore; global: KbStore }, text: string, options?: PlaneRetrieveOptions): Promise<PlaneRetrieval>
  /** The current configuration and vector-layer posture. */
  status(): Promise<PlaneStatus>
  /**
   * V4 (原规划 §12): the chunk-level vector channel for二级检索, or null when no
   * embedder is configured (then the caller keeps the lexical path, visibly).
   * @returns the channel config, or null.
   */
  chunkVector(): ChunkVectorConfig | null
}

/**
 * Create the plane.
 *
 * Configuration is read per call rather than captured at mount: the settings
 * document is hot-reloaded by its provider, and a plane that froze its config
 * would make every settings change need a restart — the exact failure mode
 * 不变量 11 forbids.
 * @param ctx - the plugin context (settings/credentials optional).
 * @param options - home and diagnostics.
 * @returns the plane.
 */
export function createRetrievalPlane(ctx: Context, options: RetrievalPlaneOptions = {}): RetrievalPlane {
  const warn = options.onWarn ?? (() => {})

  const liveEmbedder = () => createHttpEmbedder({
    getConfig: () => {
      const config = readEmbeddingConfig(ctx)
      return {
        baseUrl: config.baseUrl,
        model: config.model,
        dim: config.dim,
        headers: config.headers,
        timeoutMs: config.timeoutMs,
        batchSize: config.batchSize,
      }
    },
    // Per operation, never memoized (不变量 11 / 原规划 §9.4-4).
    resolveKey: () => resolveEmbeddingKey(ctx, readEmbeddingConfig(ctx)),
  })

  const retrieve = async (
    stores: { project: KbStore; global: KbStore },
    text: string,
    retrieveOptions: PlaneRetrieveOptions = {},
  ): Promise<PlaneRetrieval> => {
    const embedding = readEmbeddingConfig(ctx)
    const tuning = readRetrievalConfig(ctx)
    const ready = embeddingReady(embedding)
    const useVector = ready && tuning.fusion === 'rrf'
    const home = options.home
    const profile = retrieveOptions.profile ?? 'tool'
    // R1 (落地计划 §2-1): the faced layer owns the POLICY — make sure every tier
    // has an index, rebuilding a derived layer silently when it is merely
    // missing/stale, and handing the retriever the honest note when it is not.
    // Rollback switch, and the switch an A/B needs: `CLUE_LEXICAL_INDEX=off`
    // (or `scan`) reproduces the pre-R1 scanning path exactly.
    const indexMode = (process.env.CLUE_LEXICAL_INDEX ?? '').toLowerCase()
    const lexical = indexMode === 'off' || indexMode === 'scan'
      ? { indexes: [], status: 'missing' as const, note: '词法索引被显式关闭(CLUE_LEXICAL_INDEX=off),本次扫描全库' }
      : await ensureLexicalIndexes([stores.project, stores.global], {
        // F4①: the tokenizer mode is part of what an index MEANS, so a switch
        // rebuilds rather than answering from postings that lack the subtokens.
        identifierSubtokens: tuning.identifierSubtokens,
      })
    if (process.env.CLUE_LEXICAL_INDEX_DEBUG === '1') {
      warn(`[r1-debug] 索引候选=${lexical.indexes.length} 状态=${lexical.status} 备注=${lexical.note}`)
    }
    const retriever = createHybridRetriever(stores.project, stores.global, {
      ...(lexical.indexes.length > 0 ? { lexicalIndexes: lexical.indexes } : {}),
      lexicalIndexNote: lexical.note,
      channels: useVector ? 'hybrid' : 'lexical',
      profile,
      rerank: tuning.rerank,
      lexicalScorer: tuning.lexicalScorer,
      topK: retrieveOptions.limit ?? 5,
      recallDepth: tuning.recallDepth,
      rerankCandidates: tuning.rerankCandidates,
      rrfK: tuning.rrfK,
      channelWeights: tuning.channelWeights,
      featureWeights: tuning.featureWeights,
      lexicalNormalization: tuning.lexicalNormalization,
      semanticScale: tuning.semanticScale,
      semanticFloor: tuning.semanticFloor,
      semanticCeil: tuning.semanticCeil,
      missingFeatureMode: tuning.missingFeatureMode,
      termFrequency: tuning.termFrequency,
      identifierSubtokens: tuning.identifierSubtokens,
      // `0` means "no quota" in the settings vocabulary; the engine's own
      // vocabulary is "absent", so the translation lives here and nowhere else.
      ...(tuning.maxVectorOnly > 0 ? { maxVectorOnly: tuning.maxVectorOnly } : {}),
      channelWeightMode: tuning.channelWeightMode,
      semanticNormalization: tuning.semanticNormalization,
      semanticGateMinSpread: tuning.semanticGateMinSpread,
      trustThreshold: stores.project.config.trustThreshold,
      ...(useVector ? { embedder: liveEmbedder() } : {}),
      ...(home !== undefined ? { home } : {}),
      ...(tuning.ranklog && home !== undefined ? {
        // 落地计划 §2-7: a write failure names its TARGET FILE and is counted,
        // because "the log is empty" and "the log could not be written" are
        // different facts and only one of them is the product's problem.
        onRankError: (error: unknown) => {
          ranklogFailures += 1
          lastRanklogError = error instanceof Error ? error.message : String(error)
          warn(`ranklog sink 抛错(不影响检索) — 目标文件 ${lastRanklogFile}: ${lastRanklogError}`)
        },
        onRank: async (line: {
          at: string
          profile: string
          channels: 'lexical' | 'vector' | 'hybrid'
          rerank: boolean
          query: string
          candidates: Array<{ id: string; score: number; lexicalScore: number; semantic: number | null; features: Record<string, number> }>
          vector: VectorChannelState['status']
        }) => {
          // The ranklog carries ids, features and the query — never a secret
          // (原规划 §9.4-1). A write failure is reported, never thrown: the log
          // is annotation data, not the product's job (原规划 §5.3 护栏 2).
          const file = ranklogFile(stores.project.dir)
          lastRanklogFile = file
          try {
            await appendRankLog(stores.project.dir, line)
          } catch (error) {
            ranklogFailures += 1
            lastRanklogError = error instanceof Error ? error.message : String(error)
            warn(`ranklog 写入失败(不影响检索) — 目标文件 ${file}: ${lastRanklogError}`)
          }
        },
      } : {}),
    })
    const detailed = await retriever.retrieveDetailed(text, {
      ...(retrieveOptions.limit !== undefined ? { limit: retrieveOptions.limit } : {}),
      ...(retrieveOptions.includeExpired !== undefined ? { includeExpired: retrieveOptions.includeExpired } : {}),
      ...(retrieveOptions.boostBindings !== undefined ? { boostBindings: retrieveOptions.boostBindings } : {}),
      ...(retrieveOptions.noTouch !== undefined ? { noTouch: retrieveOptions.noTouch } : {}),
    })
    return {
      hits: detailed.hits,
      lexicalIndex: detailed.lexicalIndex,
      channels: useVector ? 'hybrid' : 'lexical',
      rerank: detailed.rerank,
      profile: detailed.profile.name,
      vector: detailed.vector,
    }
  }

  /** 落地计划 §2-7: ranklog write failures, counted and named (never just a warn). */
  let ranklogFailures = 0
  let lastRanklogFile = ''
  let lastRanklogError: string | null = null

  const status = async (): Promise<PlaneStatus> => {
    const embedding = readEmbeddingConfig(ctx)
    const ready = embeddingReady(embedding)
    return {
      embedding,
      retrieval: readRetrievalConfig(ctx),
      ready,
      note: embeddingReadinessNote(embedding),
      key: await embeddingKeyStatus(ctx, embedding),
      embedderVersion: ready ? embedderVersion({ modelId: embedding.model, dim: embedding.dim }) : '',
      ranklog: {
        enabled: readRetrievalConfig(ctx).ranklog && options.home !== undefined,
        file: lastRanklogFile,
        failures: ranklogFailures,
        lastError: lastRanklogError,
      },
    }
  }

  /**
   * The chunk channel's configuration, resolved per call (hot settings).
   *
   * Reading per call is the same discipline the entry channel follows: a
   * changed endpoint or key reaches the next retrieval without a restart
   * (不变量 11), and a disabled provider turns the channel off immediately
   * instead of leaving a stale embedder in a closure.
   */
  const chunkVector = (): ChunkVectorConfig | null => {
    const embedding = readEmbeddingConfig(ctx)
    if (!embeddingReady(embedding)) return null
    const home = options.home
    if (home === undefined) return null
    return {
      embedder: liveEmbedder(),
      home,
      rebuildOnRead: true,
      maxUnitsPerBuild: embedding.maxUnitsPerBuild,
    }
  }

  return { retrieve, status, chunkVector }
}

/**
 * The signals a ranklog summary joins against (one ledger read per tier).
 * @param stores - the tier pair.
 * @returns the ledger rows (both tiers concatenated).
 */
export async function planeSignals(stores: { project: KbStore; global: KbStore }) {
  return [
    ...await readSignals(path.join(stores.project.dir, 'signals.jsonl')),
    ...await readSignals(path.join(stores.global.dir, 'signals.jsonl')),
  ]
}
