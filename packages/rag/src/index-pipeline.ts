/**
 * The INDEX pipeline — the write side of the vector layer (V0, 规划 §6).
 *
 * One pure flow, four honest numbers:
 *
 * ```
 *   collect units (entries / one doc's chunks)
 *     → look up the content-addressed cache (sha256 + embedderVersion)
 *     → batch-embed the misses (batchSize, bounded concurrency, one retry)
 *     → atomic write vectors/<stem>.bin + .meta.json
 *     → partial failure marks {missing:n} instead of blocking the rest
 * ```
 *
 * Rules this file exists to keep:
 *
 * - **`--dry-run` costs nothing.** {@link planEmbed} does the whole collection
 *   and cache accounting without ever calling `embed`, so "how much would this
 *   cost" is answerable before spending anything (不变量 12 的可见面).
 * - **The budget is a hard stop** (不变量 12): at most `maxUnitsPerBuild`
 *   units per build. Exceeding it stops and REPORTS the remainder; it never
 *   silently spends more, and it never writes a partial index that pretends to
 *   be complete.
 * - **Failure is isolated**: a batch that fails after its retry contributes to
 *   `missing`, the rest still lands, and the index records `partial`. A vector
 *   layer that is 90% built is useful; one that refuses to build is not.
 * - **Determinism** (不变量 1): units are collected in a canonical order
 *   (ids ascending) so deleting `vectors/` and rebuilding reproduces the same
 *   bytes — not merely the same scores.
 *
 * @module @clue-harness/rag/index-pipeline
 */
import {
  embedCacheKey,
  embedderVersion as embedderVersionOf,
  entryTextAfterRedlines,
  normalizeEmbedText,
  readCachedVector,
  readVectorIndex,
  unitsFingerprint,
  vectorMetaFor,
  writeCachedVector,
  writeVectorIndex,
  type KbEntry,
  type KbStore,
  type VectorIndex,
  type VectorIndexMeta,
  type VectorTarget,
} from '@clue-harness/kb'
import type { Embedder } from './embedder.ts'
import { loadChunks, redlinesForDoc } from './chunks.ts'
import { readDocText } from '@clue-harness/kb'

/** One unit waiting to be embedded: its stable key, its text, its position. */
export interface EmbedUnit {
  /** The row key: an entryId, or `<docId>#<seq>` for a chunk. */
  key: string
  /** The text handed to the embedder (already redline-filtered). */
  text: string
}

/**
 * The text of one entry as the vector layer sees it (规划 §3 决策 5).
 *
 * Built from `entryTextAfterRedlines`, so an entry's retracted paragraphs
 * contribute NOTHING to its vector (不变量 4: redline 先过滤、后嵌入). Title
 * and tags come first because they are the entry's own summary of itself.
 * @param entry - the entry to render.
 * @returns the unit text.
 */
export function entryEmbedText(entry: KbEntry): string {
  return `${entry.title}\n${entry.tags.join(' ')}\n${entryTextAfterRedlines(entry)}`
}

/** The text of one chunk: its heading path plus its body, redline-filtered. */
export function chunkEmbedText(headingPath: string, body: string): string {
  return normalizeEmbedText(`${headingPath}\n${body}`)
}

/**
 * Collect the units one target addresses, in canonical order.
 *
 * Order is by key ascending, NOT by the store's display order (createdAt
 * desc): the index must be a function of the knowledge, and two runs a second
 * apart must produce byte-identical files (不变量 1).
 * @param store - the tier that owns the facts.
 * @param target - entries, or one document's chunks.
 * @returns the units to embed.
 */
export async function collectUnits(store: KbStore, target: VectorTarget): Promise<EmbedUnit[]> {
  if (target.kind === 'entries') {
    const entries = (await store.list()).filter((entry) => entry.status !== 'discarded' && entry.status !== 'superseded')
    return entries
      .map((entry) => ({ key: String(entry.id), text: entryEmbedText(entry) }))
      .sort((a, b) => a.key.localeCompare(b.key))
  }
  const text = await readDocText(store.dir, target.docId)
  if (text === null) return []
  const chunks = await loadChunks({ store, docId: target.docId })
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const redlines = (await redlinesForDoc(store, target.docId)).filter((line) => line.target === 'doc' && line.lines !== undefined)
  const units: EmbedUnit[] = []
  for (const chunk of chunks) {
    const dropped = (line: number): boolean => redlines.some((redline) => {
      const range = redline.lines as [number, number]
      if (redline.docId !== undefined && String(redline.docId) !== target.docId) return false
      return line >= range[0] && line <= range[1]
    })
    const body = lines.slice(chunk.startLine - 1, chunk.endLine)
      .filter((_, index) => !dropped(chunk.startLine + index))
      .join('\n')
    units.push({ key: `${target.docId}#${chunk.seq}`, text: chunkEmbedText(chunk.headingPath, body) })
  }
  return units
}

/** What one build WOULD do — the `--dry-run` answer, computed without any call. */
export interface EmbedPlan {
  target: VectorTarget
  /** The stamp the build would write. */
  embedderVersion: string
  dim: number
  /** Units addressed by the corpus. */
  units: number
  /** Units whose vector is already in the shared cache (no call needed). */
  cacheHits: number
  /** Units that would be sent to the embedder. */
  toEmbed: number
  /** Units actually sendable inside the budget. */
  withinBudget: number
  /** True when the corpus exceeds `maxUnitsPerBuild`. */
  budgetHit: boolean
  /** Characters that would be sent (the cost proxy). */
  chars: number
  /** Batches the pipeline would issue. */
  batches: number
  /** True when an existing index already matches the corpus and stamp. */
  upToDate: boolean
}

/** Batching/concurrency/budget knobs (from the settings page, 规划 §9.3). */
export interface EmbedBuildOptions {
  /** ClueHarness home — where the shared text cache lives. */
  home: string
  embedder: Embedder
  target: VectorTarget
  /** Hard cap on units per build (不变量 12). */
  maxUnitsPerBuild?: number
  batchSize?: number
  concurrency?: number
  /** Recompute even when the index already matches (cache still consulted). */
  rebuild?: boolean
  /** Injectable clock (tests). */
  at?: string
}

/** The shipped pipeline defaults (规划 §9.3 配置项清单). */
export const DEFAULT_BATCH_SIZE = 32
export const DEFAULT_CONCURRENCY = 1
export const DEFAULT_MAX_UNITS_PER_BUILD = 2000

/**
 * Whether one already-written index still describes the corpus and embedder in
 * effect. Membership (keys), order, text (via {@link unitsFingerprint}) and
 * the embedder stamp all have to agree — anything less would let a stale vector
 * keep answering for text that changed (规划 §5.2).
 * @param index - the index read from disk (null when absent).
 * @param version - the current `embedderVersion`.
 * @param keys - the unit keys in canonical order.
 * @param unitsHash - the fingerprint of the units' texts.
 * @returns true when the index can be used as-is.
 */
export function isCurrentIndex(
  index: VectorIndex | null,
  version: string,
  keys: readonly string[],
  unitsHash: string,
): boolean {
  if (index === null) return false
  if (index.meta.embedderVersion !== version) return false
  if (index.meta.unitsHash !== unitsHash) return false
  if (index.meta.count !== keys.length) return false
  return index.meta.idOrder.every((key, position) => key === keys[position])
}

/** What one build did (the CLI and the panel print this verbatim). */
export interface EmbedBuildReport {
  target: VectorTarget
  embedderVersion: string
  dim: number
  units: number
  cacheHits: number
  /** Units sent to the embedder. */
  embedded: number
  /** `embed()` invocations (the call count the settings page reports). */
  calls: number
  /** Characters sent (the cost proxy). */
  chars: number
  /** Units that failed and are therefore ABSENT from the index. */
  missing: number
  /** Units skipped because the budget stopped the build. */
  skipped: number
  /** True when the index was left untouched (already current). */
  upToDate: boolean
  rows: number
}

/** One batch outcome: the vectors produced and the units that failed. */
interface BatchResult {
  vectors: Map<string, Float32Array>
  missing: EmbedUnit[]
  chars: number
  /** Endpoint invocations this batch cost (the retry counts as one). */
  calls: number
}

/**
 * Embed one batch, retrying once.
 *
 * One retry, not a loop: a persistent failure is a condition to REPORT (the
 * unit becomes `missing` and the index says `partial`), not a reason to keep
 * hammering an endpoint that is already unhealthy.
 * @param embedder - the port.
 * @param units - the batch.
 * @returns the produced vectors plus the units that failed.
 */
async function embedBatch(embedder: Embedder, units: readonly EmbedUnit[]): Promise<BatchResult> {
  const texts = units.map((unit) => unit.text)
  const chars = texts.reduce((sum, text) => sum + text.length, 0)
  let calls = 0
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      calls += 1
      const vectors = await embedder.embed(texts)
      if (vectors.length !== units.length) {
        throw new Error(`embedder 返回 ${vectors.length} 个向量,但请求了 ${units.length} 个文本(适配器必须按序一一对应)`)
      }
      const out = new Map<string, Float32Array>()
      units.forEach((unit, index) => {
        const vector = vectors[index] as Float32Array
        if (vector.length !== embedder.dim) {
          throw new Error(`embedder 返回维度 ${vector.length},与声明的 dim ${embedder.dim} 不符`)
        }
        out.set(unit.key, vector)
      })
      return { vectors: out, missing: [], chars, calls }
    } catch (error) {
      if (attempt === 1) return { vectors: new Map(), missing: [...units], chars, calls }
      void error
    }
  }
  return { vectors: new Map(), missing: [...units], chars, calls }
}

/**
 * Embed one batch, splitting it when the provider refuses the whole thing.
 *
 * Providers cap batch size in ways no client can know in advance (measured:
 * dashscope's embeddings API answers `batch size is invalid, it should not be
 * larger than 10` with HTTP 400 for 25 inputs). Retrying the same oversized
 * batch would fail identically, and silently dropping 32 units is worse than
 * useless — so a failed batch is HALVED and retried, down to single units and
 * to a bounded depth. The cost is bounded too: worst case a 32-unit batch costs
 * a handful of extra calls instead of losing the data.
 *
 * @param embedder - the port.
 * @param units - the batch.
 * @param depth - how many times this batch has been split already.
 * @returns the produced vectors plus whatever still failed.
 */
async function embedBatchResilient(embedder: Embedder, units: readonly EmbedUnit[], depth = 0): Promise<BatchResult> {
  const result = await embedBatch(embedder, units)
  if (result.missing.length === 0 || units.length === 1 || depth >= 3) return result
  const half = Math.ceil(units.length / 2)
  const [left, right] = await Promise.all([
    embedBatchResilient(embedder, units.slice(0, half), depth + 1),
    embedBatchResilient(embedder, units.slice(half), depth + 1),
  ])
  return {
    vectors: new Map([...left.vectors, ...right.vectors]),
    missing: [...left.missing, ...right.missing],
    chars: left.chars + right.chars,
    // The FAILED attempt is real cost: the plan's whole point about cost
    // visibility is that the number reflects what the endpoint was asked to do,
    // not what it agreed to do.
    calls: result.calls + left.calls + right.calls,
  }
}

/**
 * Plan a build without performing any embedding call.
 * @param store - the tier that owns the facts.
 * @param options - home, embedder, target, budget/batch knobs.
 * @returns the plan (units, cache hits, cost estimate, whether it is up to date).
 */
export async function planEmbed(store: KbStore, options: EmbedBuildOptions): Promise<EmbedPlan> {
  const version = embedderVersionOf({ modelId: options.embedder.id, dim: options.embedder.dim })
  const budget = options.maxUnitsPerBuild ?? DEFAULT_MAX_UNITS_PER_BUILD
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const units = await collectUnits(store, options.target)
  const keys = units.map((unit) => unit.key)
  const unitsHash = unitsFingerprint(units)
  const existing = await readVectorIndex(store.dir, options.target)
  const upToDateWithoutRebuild = isCurrentIndex(existing, version, keys, unitsHash)
  if (options.rebuild !== true && upToDateWithoutRebuild) {
    return {
      target: options.target,
      embedderVersion: version,
      dim: options.embedder.dim,
      units: units.length,
      cacheHits: 0,
      toEmbed: 0,
      withinBudget: 0,
      budgetHit: false,
      chars: 0,
      batches: 0,
      upToDate: true,
    }
  }
  let cacheHits = 0
  const misses: EmbedUnit[] = []
  for (const unit of units) {
    const key = embedCacheKey(unit.text)
    const cached = await readCachedVector(options.home, version, key, options.embedder.dim)
    if (cached === null) misses.push(unit)
    else cacheHits += 1
  }
  const withinBudget = Math.min(misses.length, budget)
  return {
    target: options.target,
    embedderVersion: version,
    dim: options.embedder.dim,
    units: units.length,
    cacheHits,
    toEmbed: misses.length,
    withinBudget,
    budgetHit: misses.length > budget,
    chars: misses.slice(0, withinBudget).reduce((sum, unit) => sum + unit.text.length, 0),
    batches: Math.ceil(withinBudget / batchSize),
    upToDate: false,
  }
}

/**
 * Build (or rebuild) one derived index.
 *
 * The whole corpus is embedded through the cache, so a second ingest of the
 * same corpus issues ZERO calls (V1 acceptance). Vectors of units that fail
 * are simply absent — never zero-filled, because a zero vector would read as
 * "maximally dissimilar" instead of "unknown", and the reader would have no
 * way to tell the difference.
 * @param store - the tier that owns the facts.
 * @param options - home, embedder, target, budget/batch knobs.
 * @returns what the build did.
 */
export async function buildVectorIndex(store: KbStore, options: EmbedBuildOptions): Promise<EmbedBuildReport> {
  const version = embedderVersionOf({ modelId: options.embedder.id, dim: options.embedder.dim })
  const budget = options.maxUnitsPerBuild ?? DEFAULT_MAX_UNITS_PER_BUILD
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
  const at = options.at ?? new Date().toISOString()
  const units = await collectUnits(store, options.target)
  const keys = units.map((unit) => unit.key)
  const unitsHash = unitsFingerprint(units)

  const existing = await readVectorIndex(store.dir, options.target)
  const upToDate = isCurrentIndex(existing, version, keys, unitsHash)
  if (options.rebuild !== true && upToDate) {
    return {
      target: options.target,
      embedderVersion: version,
      dim: options.embedder.dim,
      units: units.length,
      cacheHits: 0,
      embedded: 0,
      calls: 0,
      chars: 0,
      missing: 0,
      skipped: 0,
      upToDate: true,
      rows: keys.length,
    }
  }

  // 1) cache pass
  const vectors = new Map<string, Float32Array>()
  const misses: EmbedUnit[] = []
  for (const unit of units) {
    const key = embedCacheKey(unit.text)
    const cached = await readCachedVector(options.home, version, key, options.embedder.dim)
    if (cached === null) misses.push(unit)
    else vectors.set(unit.key, cached)
  }
  const cacheHits = units.length - misses.length

  // 2) budgeted, batched embedding
  const sendable = misses.slice(0, budget)
  const skipped = misses.length - sendable.length
  const batches: EmbedUnit[][] = []
  for (let i = 0; i < sendable.length; i += batchSize) batches.push(sendable.slice(i, i + batchSize))

  let calls = 0
  let chars = 0
  let missing = 0
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, batches.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      const batch = batches[index]
      if (batch === undefined) return
      const result = await embedBatchResilient(options.embedder, batch)
      calls += result.calls
      chars += result.chars
      missing += result.missing.length
      for (const [key, vector] of result.vectors) {
        vectors.set(key, vector)
        // Persist through the cache so the NEXT build (any workspace) is free.
        const unit = batch.find((candidate) => candidate.key === key)
        if (unit !== undefined) await writeCachedVector(options.home, version, embedCacheKey(unit.text), vector)
      }
    }
  })
  await Promise.all(workers)

  // 3) one atomic write, rows in canonical key order
  const idOrder: string[] = []
  const rows: number[] = []
  for (const unit of units) {
    const vector = vectors.get(unit.key)
    if (vector === undefined) continue
    idOrder.push(unit.key)
    for (const value of vector) rows.push(value)
  }
  const meta: VectorIndexMeta = vectorMetaFor({
    embedderVersion: version,
    dim: options.embedder.dim,
    idOrder,
    unitsHash,
    builtAt: at,
    missing: missing + skipped,
  })
  await writeVectorIndex(store.dir, options.target, meta, Float32Array.from(rows))

  return {
    target: options.target,
    embedderVersion: version,
    dim: options.embedder.dim,
    units: units.length,
    cacheHits,
    embedded: sendable.length - missing,
    calls,
    chars,
    missing: missing + skipped,
    skipped,
    upToDate: false,
    rows: idOrder.length,
  }
}

/**
 * Whether one index is current for the corpus and the embedder in effect.
 *
 * The read path asks this and rebuilds on `false` — the same "check the stamp,
 * repair by recomputing" contract chunks have had since M9 (宪法 2).
 * @param store - the tier that owns the facts.
 * @param target - which index.
 * @param version - the current `embedderVersion`.
 * @returns true when the index exists, is complete for the corpus, and matches.
 */
export async function vectorIndexIsCurrent(store: KbStore, target: VectorTarget, version: string): Promise<boolean> {
  const index = await readVectorIndex(store.dir, target)
  if (index === null || index.meta.embedderVersion !== version) return false
  if (index.meta.partial !== undefined) return false
  const units = await collectUnits(store, target)
  if (units.length !== index.meta.count) return false
  return index.meta.idOrder.every((key, position) => key === units[position]?.key)
}
