/**
 * Second-level retrieval (M9-2, proposal §4 二级 + §14): "原文哪一段".
 *
 * The全 部 job of this module is to answer with ANCHORS — `docId`, lines,
 * `headingPath`, `quoteAnchor` — never with a new retrievable entity. Three
 * disciplines make that true:
 *
 * 1. **Pure read** (宪法 4): nothing here writes. No signal, no status, no
 *    approval, no touch. `kb_detail` being read must not count as "used" —
 *    only `kb_cite` does that (归因划清).
 * 2. **No query-time slicing** (宪法 2/§4): chunks are read from the derived
 *    ledger; a missing or stale ledger is REBUILT from the immutable snapshot
 *    and then read. The query path never invents a temporary段.
 * 3. **Redline-aware** (invariant 3): a chunk fully inside a `doc`-target
 *    redline is dropped; a chunk overlapping one is returned with
 *    `partialRedline` and its划过 lines marked in the excerpt. Scoring the
 *    entry and showing its evidence must agree about what is no longer true.
 *
 * @module @clue-harness/rag/chunks
 */
import {
  chunkDocument,
  DEFAULT_CHUNKER,
  embedderVersion,
  readVectorIndex,
  type KbStore,
  type VectorIndex,
  type VectorTarget,
  quoteAnchorOf,
  readChunks,
  readDocText,
  tokenize,
  type ChunkRecord,
  type ChunkerConfig,
  type KbEntryId,
  type KbRedline,
} from '@clue-harness/kb'
import { buildVectorIndex } from './index-pipeline.ts'
import { searchVectors } from './vector-search.ts'
import { DEFAULT_RRF_K, rrfFuse } from './fuse.ts'
import type { Embedder } from './embedder.ts'

/** One ranked chunk hit (an anchor plus the excerpt that earned the rank). */
export interface ChunkHit {
  docId: string
  seq: number
  headingPath: string
  lines: { start: number; end: number }
  quoteAnchor: string
  chars: number
  score: number
  /** The query tokens this chunk matched. */
  matched: string[]
  /** The excerpt (budgeted), with redlined lines marked when partially cut. */
  excerpt: string
  /** True when part of this chunk is redlined; those lines show as ✂. */
  partialRedline: boolean
  /** The redlines that touch this chunk (audit trail for the reader). */
  redlines: KbRedline[]
}

export interface QueryChunksOptions {
  /** Query text; empty returns the document's chunks in order (browsing). */
  query?: string
  /** Maximum hits (default 5). */
  limit?: number
  /** Maximum characters of each excerpt (default 600). */
  maxChars?: number
  /** Include chunks with zero token matches (default false). */
  includeUnmatched?: boolean
  /**
   * V4 (原规划 §12): the optional vector channel for二级检索. Absent = today's
   * lexical behavior, unchanged. Present = 词法与向量并联召回 → RRF 融合,
   * which is what closes the "长文局部命中" gap that keyword matching alone
   * cannot (a段 that answers a question in different words is invisible to
   * bigrams).
   */
  vector?: ChunkVectorConfig
}

/** The chunk-level vector channel's configuration (V4). */
export interface ChunkVectorConfig {
  /** The embedder in effect (the caller owns its configuration). */
  embedder: Embedder
  /** ClueHarness home (the shared embed cache + rebuild writes live under it). */
  home: string
  /** Fusion weight of the heading/body lexical channel. Default 1. */
  lexicalWeight?: number
  /** Fusion weight of the vector channel. Default 1. */
  semanticWeight?: number
  /** RRF constant. Default 60. */
  rrfK?: number
  /** How many chunks each channel recalls before fusion. Default 20. */
  recallDepth?: number
  /** Rebuild a missing/stale chunk index during the query (原规划 §5.3). Default true. */
  rebuildOnRead?: boolean
  /** The rebuild budget per call. Default 2000. */
  maxUnitsPerBuild?: number
  /**
   * Where the honest channel state goes (未配置/待建/过期/partial/失败).
   * A callback rather than a return value so `queryChunks` keeps its shape for
   * every existing caller (不变量 9's discipline: additive, never disruptive).
   */
  onState?: (state: ChunkVectorState) => void
}

/** Why the chunk vector channel did or did not participate (不变量 5). */
export interface ChunkVectorState {
  status: 'used' | 'index-missing' | 'index-stale' | 'partial' | 'error' | 'disabled'
  note: string
  count?: number
  missing?: number
}

/** Where the second level can be addressed. */
export interface ChunkSource {
  store: KbStore
  docId: string
}

/** The chunker + weights knobs of二级检索. */
export interface ChunkRetrievalConfig {
  /** headingPath weight (拍板: heading ×2, body ×1). Default 2. */
  headingWeight: number
  /** Body weight. Default 1. */
  bodyWeight: number
  /** The chunker config used when a rebuild is needed. */
  chunker?: Partial<ChunkerConfig>
}

/** The shipped weights (proposal §4). */
export const DEFAULT_CHUNK_WEIGHTS: ChunkRetrievalConfig = { headingWeight: 2, bodyWeight: 1 }

/**
 * Resolve the documents one call addresses: an explicit entry's mounted doc,
 * and/or explicit docIds. Missing docs are simply absent (the caller answers
 * honestly — "该知识无原文层,正文即全部").
 * @param store - the tier store.
 * @param options - entryId and/or docIds.
 * @returns the addressed sources.
 */
export async function resolveChunkSources(
  store: KbStore,
  options: { entryId?: string; docIds?: readonly string[] },
): Promise<ChunkSource[]> {
  const sources: ChunkSource[] = []
  const seen = new Set<string>()
  if (options.entryId !== undefined && options.entryId !== '') {
    const entry = await store.get(options.entryId as KbEntryId)
    if (entry?.doc !== undefined) {
      sources.push({ store, docId: String(entry.doc.docId) })
      seen.add(String(entry.doc.docId))
    }
  }
  for (const docId of options.docIds ?? []) {
    if (docId === '' || seen.has(docId)) continue
    sources.push({ store, docId })
    seen.add(docId)
  }
  return sources
}

/**
 * Read (and when necessary REBUILD) one document's derived chunks.
 *
 * The rebuild is the whole "派生可重建" contract: the ledger is a cache of a
 * pure function over the immutable snapshot, so a missing ledger or a foreign
 * `chunkerVersion` is repaired by recomputing — never by patching rows.
 * @param source - the store + docId.
 * @param chunker - the chunker config (defaults = 拍板 2's numbers).
 * @returns the chunk rows in document order.
 */
export async function loadChunks(source: ChunkSource, chunker?: Partial<ChunkerConfig>): Promise<ChunkRecord[]> {
  const { store, docId } = source
  const version = store.config.chunkerVersion
  const rows = await readChunks(store.dir, docId)
  if (rows.length > 0 && rows.every((row) => row.chunkerVersion === version)) return rows
  const text = await readDocText(store.dir, docId)
  if (text === null) return []
  const rebuilt = chunkDocument(text, { ...DEFAULT_CHUNKER, ...chunker, version })
  await store.saveChunks(docId, rebuilt)
  return rebuilt
}

/** The lines of the snapshot, split once per call. */
function snapshotLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Whether a line range intersects one redline's line range (inclusive). */
function overlapsRedline(chunk: { startLine: number; endLine: number }, redline: KbRedline, docId: string): boolean {
  if (redline.target !== 'doc' || redline.lines === undefined) return false
  if (redline.docId !== undefined && String(redline.docId) !== docId) return false
  const [from, to] = redline.lines
  return chunk.startLine <= to && from <= chunk.endLine
}

/** Whether a line is INSIDE a redline (marked ✂ in the excerpt). */
function lineRedlined(line: number, redlines: readonly KbRedline[], docId: string): boolean {
  return redlines.some((redline) => {
    if (redline.target !== 'doc' || redline.lines === undefined) return false
    if (redline.docId !== undefined && String(redline.docId) !== docId) return false
    return line >= redline.lines[0] && line <= redline.lines[1]
  })
}

/**
 * Build one chunk's excerpt within a character budget.
 *
 * The window starts at the chunk's head — an anchor is only useful if the
 * reader can see where in the document it begins — and redlined lines are
 * marked rather than hidden, because "part of this段 was retracted" is
 * information the reader MUST have (proposal §4: partial-redline 标记).
 * @param lines - the snapshot's lines.
 * @param chunk - the chunk to excerpt.
 * @param maxChars - the excerpt budget.
 * @param redlines - the redlines applying to this doc.
 * @param docId - the doc id (redline scoping).
 * @returns the excerpt text.
 */
export function buildExcerpt(
  lines: readonly string[],
  chunk: { startLine: number; endLine: number },
  maxChars: number,
  redlines: readonly KbRedline[],
  docId: string,
): string {
  const parts: string[] = []
  let used = 0
  for (let line = chunk.startLine; line <= chunk.endLine; line += 1) {
    const body = lines[line - 1] ?? ''
    const marker = lineRedlined(line, redlines, docId) ? '✂ ' : ''
    let text = `${marker}${body}`.trimEnd()
    if (text === '' && parts.length === 0) continue
    if (used + text.length + 1 > maxChars) {
      if (parts.length === 0) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`
      else break
    }
    parts.push(text)
    used += text.length + 1
  }
  const excerpt = parts.join('\n')
  return chunk.endLine > chunk.startLine && used >= maxChars ? `${excerpt}\n…` : excerpt
}

/**
 * Score ONE chunk against a query, from text already in hand.
 *
 * EXPORTED because it is the ranking law of二级检索 and must have exactly one
 * implementation: `queryChunks` calls it per query, and an offline evaluation
 * harness — which cannot afford one ledger read per document per query — calls
 * it over a preloaded corpus. A second copy of these weights would make every
 * reported recall number a statement about the copy, not about the product.
 *
 * Two decisions worth stating, both learned from the acceptance classes:
 *
 * - **Heading ×2 / body ×1** (proposal §4), and the body is the chunk's FULL
 *   text after redlines — never the truncated excerpt. Scoring a budgeted
 *   excerpt would hide a hit sitting deeper in a long段, which is exactly the
 *   "长文局部命中" case二级检索 exists for.
 * - **Specificity as a multiplier** (`matched / queryTokens`): bigram
 *   tokenization makes partial matches cheap ("移入抽屉内部" shares 内部 with
 *   an unrelated段), so a chunk that answers the WHOLE query must outrank one
 *   that answers a fragment of it. Same-token-count ties keep the raw weights
 *   meaningful.
 * @param headingPath - the chunk's heading path (part of its score).
 * @param body - the chunk's text with redlines applied.
 * @param queryTokens - the query's tokens.
 * @param config - field weights.
 * @returns the score plus the matched tokens.
 */
export function scoreChunkText(
  headingPath: string,
  body: string,
  queryTokens: readonly string[],
  config: ChunkRetrievalConfig,
): { score: number; matched: string[] } {
  if (queryTokens.length === 0) return { score: 0, matched: [] }
  const headingTokens = new Set(tokenize(headingPath))
  const bodyTokens = new Set(tokenize(body))
  let score = 0
  const matched: string[] = []
  for (const token of queryTokens) {
    let hit = 0
    if (headingTokens.has(token)) hit += config.headingWeight
    if (bodyTokens.has(token)) hit += config.bodyWeight
    if (hit > 0) {
      score += hit
      matched.push(token)
    }
  }
  if (matched.length === 0) return { score: 0, matched: [] }
  const specificity = matched.length / queryTokens.length
  return { score: Math.round(score * specificity * 100) / 100, matched }
}

/** The chunk-row form of {@link scoreChunkText}. */
function scoreChunk(
  chunk: ChunkRecord,
  body: string,
  queryTokens: readonly string[],
  config: ChunkRetrievalConfig,
): { score: number; matched: string[] } {
  return scoreChunkText(chunk.headingPath, body, queryTokens, config)
}

/**
 * Query the SECOND level: rank the chunks of one or more documents and return
 * anchors + excerpts (proposal §4).
 *
 * Dedup follows 拍板 2: a chunk whose `overlapWith` predecessor was already
 * returned is skipped, so sliding-window overlap never shows the same sentence
 * twice.
 * @param source - the store + docId to search.
 * @param options - query, limits and excerpt budget.
 * @param config - field weights.
 * @returns ranked chunk hits (pure read — nothing is written but a rebuild).
 */
export async function queryChunks(
  source: ChunkSource,
  options: QueryChunksOptions = {},
  config: ChunkRetrievalConfig = DEFAULT_CHUNK_WEIGHTS,
): Promise<ChunkHit[]> {
  const { store, docId } = source
  const limit = options.limit ?? 5
  const maxChars = options.maxChars ?? 600
  const text = await readDocText(store.dir, docId)
  if (text === null) return []
  const chunks = await loadChunks(source, config.chunker)
  if (chunks.length === 0) return []
  const lines = snapshotLines(text)
  const redlines = await redlinesForDoc(store, docId)
  const queryTokens = tokenize(options.query ?? '')
  const hits: ChunkHit[] = []

  /**
   * Build one hit from a chunk row (shared by both channels in V4).
   * @param chunk - the derived row.
   * @param matched - the tokens that earned it (empty for a vector-only recall).
   * @param score - the score to display (the fusion score when fused).
   * @returns the hit, or null when the chunk is fully redlined.
   */
  const makeHit = (chunk: ChunkRecord, matched: string[], score: number): ChunkHit | null => {
    const fullRedline = redlines.some((redline) => {
      if (!overlapsRedline(chunk, redline, docId)) return false
      const [from, to] = redline.lines ?? [0, 0]
      return chunk.startLine >= from && chunk.endLine <= to
    })
    if (fullRedline) return null
    const excerpt = buildExcerpt(lines, chunk, maxChars, redlines, docId)
    const touching = redlines.filter((redline) => overlapsRedline(chunk, redline, docId))
    return {
      docId,
      seq: chunk.seq,
      headingPath: chunk.headingPath,
      lines: { start: chunk.startLine, end: chunk.endLine },
      quoteAnchor: chunk.quoteAnchor,
      chars: chunk.chars,
      score,
      matched,
      excerpt,
      partialRedline: touching.length > 0,
      redlines: touching,
    }
  }

  for (const chunk of chunks) {
    // A chunk ENTIRELY inside a redline is out of the corpus, not merely
    // annotated: the retracted part must not be retrievable (proposal §4).
    const fullRedline = redlines.some((redline) => {
      if (!overlapsRedline(chunk, redline, docId)) return false
      const [from, to] = redline.lines ?? [0, 0]
      return chunk.startLine >= from && chunk.endLine <= to
    })
    // Scoring reads the FULL chunk body (minus redlined lines), so a match
    // deeper than the excerpt budget still ranks — the excerpt is presentation.
    const body = lines.slice(chunk.startLine - 1, chunk.endLine)
      .filter((_, index) => !lineRedlined(chunk.startLine + index, redlines, docId))
      .join('\n')
    const { score, matched } = scoreChunk(chunk, body, queryTokens, config)
    // With the vector channel on, a零重叠 chunk is still a candidate (the vector
    // channel is what recalls it) — the hard-zero gate belongs to the lexical
    // channel, not to the fused answer.
    if (options.vector === undefined && queryTokens.length > 0 && score === 0 && options.includeUnmatched !== true) continue
    if (options.vector !== undefined && score > 0) {
      const built = makeHit(chunk, matched, score)
      if (built !== null) hits.push(built)
      continue
    }
    if (options.vector !== undefined && score === 0) continue
    const built = makeHit(chunk, matched, score)
    if (built !== null) hits.push(built)
  }

  // ── V4: the vector channel + RRF fusion ────────────────────────────────
  if (options.vector !== undefined && queryTokens.length > 0) {
    const fused = await fuseChunkChannels(source, chunks, hits, makeHit, queryTokens, options.vector)
    if (fused !== null) return fused.slice(0, limit)
  }

  // Dedup by overlapWith FIRST (cheap, deterministic), then rank.
  const bySeq = new Map(hits.map((hit) => [hit.seq, hit]))
  const dropped = new Set<number>()
  for (const chunk of chunks) {
    if (chunk.overlapWith === undefined) continue
    if (bySeq.has(chunk.overlapWith) && bySeq.has(chunk.seq)) dropped.add(chunk.seq)
  }
  const kept = hits.filter((hit) => !dropped.has(hit.seq))

  // A RANKED answer merges nothing: two chunks that happen to be neighbours in
  // the document are two different pieces of evidence, and merging them would
  // both inflate the score and swallow the more relevant one (measured: 表单
  // 7.2 absorbed 抽屉 7.0). Merging is for BROWSING (an empty query), where the
  // reader wants continuous text rather than a row per chunk.
  const ranked = [...kept].sort((a, b) =>
    b.score - a.score
    || a.seq - b.seq
    || a.docId.localeCompare(b.docId))
  if (queryTokens.length > 0) return ranked.slice(0, limit)

  const merged: ChunkHit[] = []
  for (const hit of ranked) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && hit.seq === previous.seq + 1) {
      previous.lines.end = hit.lines.end
      previous.chars += hit.chars
      previous.excerpt = `${previous.excerpt}\n${hit.excerpt}`
      previous.partialRedline = previous.partialRedline || hit.partialRedline
      previous.redlines = [...previous.redlines, ...hit.redlines]
      continue
    }
    merged.push({ ...hit })
  }
  return merged.slice(0, limit)
}

/**
 * Fuse the chunk-level lexical and vector channels with RRF (V4, 原规划 §7/§12).
 *
 * The two channels are ranked SEPARATELY and merged by rank, exactly like the
 * entry-level pipeline: a chunk that answers the query in different words is
 * invisible to bigrams, and a chunk that repeats the query's words is invisible
 * to an embedding — fusing ranks is what lets either one win.
 *
 * Degradation is a named state (不变量 5): a missing/stale/partial index, a
 * failed embed call, or a query with nothing to embed all fall back to the
 * lexical order and SAY SO through `onState`, never silently.
 *
 * @param source - the store + docId.
 * @param chunks - the derived rows.
 * @param lexical - the hits the lexical channel produced (in its own order).
 * @param makeHit - the shared hit builder (so a vector-only recall still gets an excerpt).
 * @param queryTokens - the query's tokens.
 * @param vector - the channel configuration.
 * @returns the fused hits, or null when the channel could not participate (caller keeps lexical).
 */
async function fuseChunkChannels(
  source: ChunkSource,
  chunks: readonly ChunkRecord[],
  lexical: readonly ChunkHit[],
  makeHit: (chunk: ChunkRecord, matched: string[], score: number) => ChunkHit | null,
  queryTokens: readonly string[],
  vector: ChunkVectorConfig,
): Promise<ChunkHit[] | null> {
  const { store, docId } = source
  const target: VectorTarget = { kind: 'chunks', docId }
  const version = embedderVersion({ modelId: vector.embedder.id, dim: vector.embedder.dim })
  const say = (state: ChunkVectorState): void => { vector.onState?.(state) }
  try {
    const index = await ensureChunkIndex(store, target, version, vector)
    if (index === null) {
      say({ status: 'index-missing', note: '分段向量层待建(本次为纯词法结果)' })
      return null
    }
    const [queryVector] = await vector.embedder.embed([queryTokens.join(' ')])
    if (queryVector === undefined) throw new Error('chunks: embedder returned no query vector')
    const depth = vector.recallDepth ?? 20
    const vectorHits = searchVectors(index, queryVector, { limit: depth })
    const bySeq = new Map(chunks.map((chunk) => [chunk.seq, chunk]))

    const lexicalRanked = lexical.map((hit) => String(hit.seq))
    const vectorRanked: string[] = []
    const vectorScore = new Map<string, number>()
    for (const hit of vectorHits) {
      const at = hit.key.lastIndexOf('#')
      const seq = at === -1 ? hit.key : hit.key.slice(at + 1)
      if (!bySeq.has(Number(seq))) continue
      if (vectorScore.has(seq)) continue
      vectorScore.set(seq, hit.score)
      vectorRanked.push(seq)
    }
    const fused = rrfFuse([
      { name: 'lexical', weight: vector.lexicalWeight ?? 1, ranked: lexicalRanked },
      { name: 'vector', weight: vector.semanticWeight ?? 1, ranked: vectorRanked },
    ], vector.rrfK ?? DEFAULT_RRF_K)

    const out: ChunkHit[] = []
    const lexicalBySeq = new Map(lexical.map((hit) => [String(hit.seq), hit]))
    for (const row of fused) {
      const seq = Number(row.key)
      const chunk = bySeq.get(seq)
      if (chunk === undefined) continue
      const existing = lexicalBySeq.get(row.key)
      if (existing !== undefined) {
        // Fused score replaces the lexical score (it is what ordered this list),
        // and the channel ranks are appended to the audit trail so a reader can
        // see WHY a chunk moved.
        const ranks = Object.entries(row.ranks).map(([name, rank]) => `${name} #${rank}`).join(' / ')
        out.push({
          ...existing,
          score: Math.round(row.score * 10000) / 10000,
          matched: [...existing.matched, `融合:${ranks}`],
        })
        continue
      }
      const built = makeHit(chunk, [`融合:vector #${row.ranks.vector ?? '-'}`], Math.round(row.score * 10000) / 10000)
      if (built !== null) out.push(built)
    }
    const missing = index.meta.partial?.missing ?? 0
    say({
      status: missing > 0 ? 'partial' : 'used',
      note: missing > 0 ? `分段向量层不完整(缺 ${missing} 段)` : '分段向量通道已参与',
      count: index.meta.count,
      ...(missing > 0 ? { missing } : {}),
    })
    return out
  } catch (error) {
    say({ status: 'error', note: `分段向量通道本次失败(${error instanceof Error ? error.message : String(error)})` })
    return null
  }
}

/**
 * Read a document's chunk-level vector index, rebuilding it when needed.
 *
 * Same contract as the entry-level index: the ledger is a pure function of the
 * snapshot plus the embedder version, so a missing or foreign-stamped index is
 * repaired by recomputing — and a repair failure degrades the retrieval instead
 * of throwing through it (原规划 §5.3 护栏 2).
 * @param store - the tier store.
 * @param target - the chunk index target.
 * @param version - the embedder version in effect.
 * @param vector - the channel configuration.
 * @returns the index, or null when it is absent and could not be built.
 */
async function ensureChunkIndex(
  store: KbStore,
  target: VectorTarget,
  version: string,
  vector: ChunkVectorConfig,
): Promise<VectorIndex | null> {
  const existing = await readVectorIndex(store.dir, target)
  if (existing !== null && existing.meta.embedderVersion === version && existing.meta.partial === undefined) return existing
  if (vector.rebuildOnRead === false) return null
  const stale = existing !== null
  try {
    await buildVectorIndex(store, {
      home: vector.home,
      embedder: vector.embedder,
      target,
      ...(vector.maxUnitsPerBuild !== undefined ? { maxUnitsPerBuild: vector.maxUnitsPerBuild } : {}),
    })
    const rebuilt = await readVectorIndex(store.dir, target)
    if (rebuilt !== null) return rebuilt
    vector.onState?.({ status: stale ? 'index-stale' : 'index-missing', note: stale ? '分段向量层版本过期,重建未成功(本次为纯词法结果)' : '分段向量层待建(本次为纯词法结果)' })
    return null
  } catch (error) {
    vector.onState?.({ status: 'error', note: `分段向量层重建失败(${error instanceof Error ? error.message : String(error)})` })
    return null
  }
}

/**
 * Every `doc`-target redline any entry in the tier holds against one doc.
 * Redlines live on ENTRIES (宪法 1): the document layer has no opinion, so the
 * query gathers them from the governance side.
 * @param store - the tier store.
 * @param docId - the doc being read.
 * @returns the redlines applying to it.
 */
export async function redlinesForDoc(store: KbStore, docId: string): Promise<KbRedline[]> {
  const out: KbRedline[] = []
  for (const entry of await store.list()) {
    for (const redline of entry.redlines ?? []) {
      if (redline.target !== 'doc') continue
      if (redline.docId !== undefined && String(redline.docId) !== docId) continue
      out.push(redline)
    }
  }
  return out
}

/**
 * The anchor string every二级 answer carries (`docId 行 a-b · heading`).
 *
 * `lang` is the shared-renderer doctrine again: the model blocks and the web
 * panel read Chinese, the console reads English, and the default keeps every
 * existing caller byte-identical.
 * @param hit - the chunk identity.
 * @param lang - `zh` (default) or `en`.
 * @returns the anchor line fragment.
 */
export function anchorLabel(
  hit: Pick<ChunkHit, 'docId' | 'lines' | 'headingPath' | 'quoteAnchor'>,
  lang: 'zh' | 'en' = 'zh',
): string {
  const en = lang === 'en'
  const heading = hit.headingPath === '' ? (en ? '(untitled)' : '(无标题)') : hit.headingPath
  const quote = `${quoteAnchorOf(hit.quoteAnchor, 40)}`
  return en
    ? `${hit.docId} lines ${hit.lines.start}-${hit.lines.end} · ${heading} · “${quote}”`
    : `${hit.docId} 行 ${hit.lines.start}-${hit.lines.end} · ${heading} · “${quote}”`
}

/** The honest receipt when an entry has no document at all (proposal §4). */
export const NO_DOC_NOTICE = '该知识无原文层(entry 未挂载 doc),正文即全部内容。'

/** The same receipt for the console (English). */
export const NO_DOC_NOTICE_EN = 'this entry has no document layer (nothing mounted), the body is all there is.'

/**
 * The tier query text for a "pure read" caller: the same tokenizer retrieval
 * uses, exposed here so previews and tests can explain a rank.
 * @param text - the query.
 * @returns the sorted tokens.
 */
export function chunkQueryTokens(text: string): string[] {
  return tokenize(text)
}
