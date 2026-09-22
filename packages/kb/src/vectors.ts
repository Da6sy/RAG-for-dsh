/**
 * The VECTOR layer (V0, 原规划 §5): a derived index that lives beside `chunks/`
 * and obeys exactly the same constitution.
 *
 * Four rules, all inherited from the M9 chunk ledger rather than invented here:
 *
 * 1. **Derived and rebuildable** (宪法 2): `vectors/<stem>.bin` + `.meta.json`
 *    are a pure function of (facts, embedderVersion). Deleting the whole
 *    `vectors/` directory must change nothing but the next build's timing —
 *    that is the acceptance test for invariant 1, and it is why nothing here
 *    is ever patched in place.
 * 2. **No governance** (宪法 3): the meta record carries a row→key mapping,
 *    a dimension, a version stamp and a `builtAt`. It carries NO status, NO
 *    signal, NO approval, NO tier: those live on the Entry and only there. A
 *    similarity is an explanation of rank, never a claim about trust.
 * 3. **Version is a single source** (不变量 8): the stamp comes from
 *    {@link embedderVersion} in `types.ts`; a mismatch means REBUILD, silently,
 *    exactly like `chunkerVersion` does for chunks.
 * 4. **The cache is content-addressed** (原规划 §5.1): `<home>/embed-cache/
 *    <embedderVersion>/<sha256(normalized text)>.bin` is shared across
 *    workspaces and across tiers, so the same text is never paid for twice.
 *    No credential, url or model ever lands in this tree — they live in the
 *    settings document and the credential store (原规划 §9).
 *
 * The binary format is deliberately the dumbest thing that works at this
 * scale: a flat little-endian `Float32Array` of `count × dim`, row-major,
 * `idOrder[row]` naming the row. Brute-force cosine over ≤5万 vectors costs
 * 10–30 ms at 512 dims (原规划 §5.4), and ANN is an explicit non-goal.
 *
 * @module @clue-harness/kb/vectors
 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { atomicWriteJson, readJsonOrNull } from '@clue-harness/util'
import { embedderVersion } from './types.ts'

/** The vector meta format version; refuse-on-mismatch, never migrate. */
export const VECTOR_FORMAT_VERSION = 1

/** Which derived index an operation addresses. */
export type VectorTarget = { kind: 'entries' } | { kind: 'chunks'; docId: string }

/** The storage precision of a vector file. Only fp32 ships (原规划 §9.3 `quant`). */
export type VectorQuant = 'fp32'

/**
 * One vector file's meta record. Written whole, never patched.
 *
 * `idOrder[row]` is the ONLY mapping from a row to what it represents: an
 * entryId for the `entries` index, `<docId>#<seq>` for a chunk index. Keeping
 * the key OUT of the binary is what makes the matrix a pure numeric artifact
 * and keeps governance data structurally unable to leak into it.
 */
export interface VectorIndexMeta {
  version: typeof VECTOR_FORMAT_VERSION
  /** The stamp from {@link embedderVersion}; a mismatch ⇒ rebuild. */
  embedderVersion: string
  /** The embedder's real dimension (what the matrix rows actually are). */
  dim: number
  quant: VectorQuant
  /** Row count; `idOrder.length` must equal it. */
  count: number
  /** row index → key (entryId, or `<docId>#<seq>`). */
  idOrder: string[]
  /**
   * The fingerprint of the units this index was built FROM (see
   * {@link unitsFingerprint}). It is what makes "条目文本改了" detectable
   * without storing any entry text: a matching key set with changed bodies
   * would otherwise look up to date, and the index would keep serving a vector
   * of the old text (原规划 §5.2: text/title/tags/redline 变化 ⇒ 该条目向量作废).
   */
  unitsHash: string
  builtAt: string
  /**
   * Set when some units could not be embedded (endpoint down, budget hit):
   * the index is still usable, and the retrieval layer must SAY SO instead of
   * pretending the missing units scored zero (不变量 5 降级诚实).
   */
  partial?: { missing: number }
}

/** A loaded index: its meta plus the flat matrix the meta describes. */
export interface VectorIndex {
  meta: VectorIndexMeta
  /** Row-major `count × dim` little-endian fp32. */
  vectors: Float32Array
}

/** `vectors/` under one KB tier. */
export function vectorsDir(kbDir: string): string {
  return path.join(kbDir, 'vectors')
}

/** The shared file stem of one target (`entries` | `chunks-<docId>`). */
export function vectorFileStem(target: VectorTarget): string {
  return target.kind === 'entries' ? 'entries' : `chunks-${target.docId}`
}

/** The `.bin` path of one target. */
export function vectorBinPath(kbDir: string, target: VectorTarget): string {
  return path.join(vectorsDir(kbDir), `${vectorFileStem(target)}.bin`)
}

/** The `.meta.json` path of one target. */
export function vectorMetaPath(kbDir: string, target: VectorTarget): string {
  return path.join(vectorsDir(kbDir), `${vectorFileStem(target)}.meta.json`)
}

/** Parse a meta file name back into the target it addresses. */
function targetFromStem(stem: string): VectorTarget | null {
  if (stem === 'entries') return { kind: 'entries' }
  if (stem.startsWith('chunks-') && stem.length > 'chunks-'.length) {
    return { kind: 'chunks', docId: stem.slice('chunks-'.length) }
  }
  return null
}

/**
 * Encode a matrix into bytes (row-major little-endian fp32).
 *
 * `Buffer.from(view.buffer)` would alias the caller's memory, so the copy is
 * explicit: a caller that reuses its buffer must not be able to rewrite a
 * file that has already been written.
 * @param vectors - the flat matrix.
 * @returns the bytes to write.
 */
export function encodeVectorMatrix(vectors: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(vectors.length * 4)
  for (let i = 0; i < vectors.length; i += 1) out.writeFloatLE(vectors[i] as number, i * 4)
  return out
}

/**
 * Decode a matrix from bytes.
 *
 * Node's Buffer pool is NOT guaranteed 4-byte aligned, so the bytes are copied
 * rather than viewed: `new Float32Array(buffer.buffer, offset, n)` throws
 * RangeError on an unaligned offset, which is a real, load-dependent crash.
 * @param bytes - the file's bytes.
 * @returns the flat matrix.
 */
export function decodeVectorMatrix(bytes: Buffer): Float32Array {
  const count = Math.floor(bytes.length / 4)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i += 1) out[i] = bytes.readFloatLE(i * 4)
  return out
}

/**
 * Read one derived index.
 *
 * Every inconsistency answers `null` rather than throwing: a foreign version,
 * a truncated file or a meta/matrix size disagreement means "this index must
 * be rebuilt", which is a normal state on the read path, not an error.
 * @param kbDir - the KB tier directory.
 * @param target - which index to read.
 * @returns the index, or null when absent/unusable.
 */
export async function readVectorIndex(kbDir: string, target: VectorTarget): Promise<VectorIndex | null> {
  const meta = await readJsonOrNull<VectorIndexMeta>(vectorMetaPath(kbDir, target))
  if (meta === null || meta.version !== VECTOR_FORMAT_VERSION) return null
  if (meta.quant !== 'fp32' || meta.dim <= 0) return null
  if (meta.idOrder.length !== meta.count) return null
  let bytes: Buffer
  try {
    bytes = await readFile(vectorBinPath(kbDir, target))
  } catch {
    return null
  }
  if (bytes.length !== meta.count * meta.dim * 4) return null
  return { meta, vectors: decodeVectorMatrix(bytes) }
}

/**
 * Write one derived index (tmp + rename, so a crash never leaves a half file
 * that would later be decoded as a shorter matrix).
 * @param kbDir - the KB tier directory.
 * @param target - which index to write.
 * @param meta - the meta record (its `count`/`dim` must match the matrix).
 * @param vectors - the flat row-major matrix.
 * @throws when the meta and the matrix disagree — a corrupt index must fail
 *   at write time, not at the next read.
 */
export async function writeVectorIndex(
  kbDir: string,
  target: VectorTarget,
  meta: VectorIndexMeta,
  vectors: Float32Array,
): Promise<void> {
  if (meta.idOrder.length !== meta.count) {
    throw new Error(`向量索引非法: count=${meta.count} 与 idOrder=${meta.idOrder.length} 不一致`)
  }
  if (vectors.length !== meta.count * meta.dim) {
    throw new Error(`向量索引非法: 矩阵 ${vectors.length} 个 float ≠ count ${meta.count} × dim ${meta.dim}`)
  }
  await mkdir(vectorsDir(kbDir), { recursive: true })
  const bin = vectorBinPath(kbDir, target)
  const tmp = `${bin}.tmp-${process.pid}`
  await writeFile(tmp, encodeVectorMatrix(vectors))
  await rename(tmp, bin)
  await atomicWriteJson(vectorMetaPath(kbDir, target), meta)
}

/** Delete one derived index (the "删了能长回来" path, 不变量 1). */
export async function removeVectorIndex(kbDir: string, target: VectorTarget): Promise<void> {
  await rm(vectorBinPath(kbDir, target), { force: true })
  await rm(vectorMetaPath(kbDir, target), { force: true })
}

/** Every derived index this tier holds (meta files present, sorted). */
export async function listVectorTargets(kbDir: string): Promise<VectorTarget[]> {
  let names: string[]
  try {
    names = await readdir(vectorsDir(kbDir))
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.meta.json'))
    .map((name) => targetFromStem(name.slice(0, -'.meta.json'.length)))
    .filter((target): target is VectorTarget => target !== null)
    .sort((a, b) => vectorFileStem(a).localeCompare(vectorFileStem(b)))
}

/** One index's health, as `clue kb doctor` and the settings page report it. */
export interface VectorIndexStatus {
  target: VectorTarget
  stem: string
  /** The stamp the file was built under. */
  embedderVersion: string
  dim: number
  count: number
  builtAt: string
  missing: number
  /** True when the stamp no longer matches the embedder in effect. */
  stale: boolean
  /** True when the .bin is absent/unreadable while the meta exists. */
  unreadable: boolean
}

/**
 * Report every index's health against the embedder currently in effect.
 * Pure read: this never rebuilds, so a doctor run cannot silently spend money.
 * @param kbDir - the KB tier directory.
 * @param currentVersion - the `embedderVersion` in effect (null = not configured).
 * @returns one row per index, in stable order.
 */
export async function vectorIndexStatuses(kbDir: string, currentVersion: string | null): Promise<VectorIndexStatus[]> {
  const out: VectorIndexStatus[] = []
  for (const target of await listVectorTargets(kbDir)) {
    const meta = await readJsonOrNull<VectorIndexMeta>(vectorMetaPath(kbDir, target))
    if (meta === null) continue
    const bin = await stat(vectorBinPath(kbDir, target)).catch(() => null)
    out.push({
      target,
      stem: vectorFileStem(target),
      embedderVersion: meta.embedderVersion,
      dim: meta.dim,
      count: meta.count,
      builtAt: meta.builtAt,
      missing: meta.partial?.missing ?? 0,
      stale: currentVersion === null || meta.embedderVersion !== currentVersion,
      unreadable: bin === null || bin.size !== meta.count * meta.dim * 4,
    })
  }
  return out
}

/**
 * L2-normalize a vector IN PLACE and return it (the shipped normalization,
 * `EMBED_NORM_VERSION = 'l2-v1'`).
 *
 * Both adapters (the HTTP one and the deterministic fallback) call THIS
 * function rather than normalizing for themselves: cosine similarity is only
 * a dot product because of it, and a second implementation would be a second
 * definition of what a stored vector means. A zero vector stays zero — an
 * empty unit has no direction, and the reader must see that as a non-match
 * rather than as a NaN that silently poisons every score it touches.
 * @param vector - the vector to normalize.
 * @returns the same array, normalized.
 */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < vector.length; i += 1) sum += (vector[i] as number) ** 2
  if (sum === 0) return vector
  const norm = Math.sqrt(sum)
  for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] as number) / norm
  return vector
}

/**
 * Cosine similarity between two vectors of equal length.
 *
 * Length mismatch answers 0 instead of reading out of bounds: a query vector
 * from a DIFFERENT model than the stored matrix is a real state (the settings
 * page can be half-configured), and it must degrade to "no vector hit" rather
 * than crash a retrieval.
 * @param a - one vector.
 * @param b - the other vector.
 * @returns cosine in [-1, 1], or 0 when the lengths differ / a vector is zero.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// ── the cross-workspace text cache (原规划 §5.1) ──────────────────────────────
/**
 * Normalize text for the cache key.
 *
 * Normalization is per line and whitespace-only — indentation, trailing
 * spaces and blank-line runs are collapsed, because an embedded unit is text
 * a person wrote, and re-indenting a snippet must not cost a second call.
 * It stops there on purpose: case, punctuation and word order are preserved,
 * since those change what an embedding MEANS, and a cache that let two
 * different texts share one vector would answer with a silently wrong score.
 * @param text - the raw unit text.
 * @returns the canonical form whose sha256 is the cache key.
 */
export function normalizeEmbedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The cache key of one text unit: sha256 of its normalized form. */
export function embedCacheKey(text: string): string {
  return createHash('sha256').update(normalizeEmbedText(text), 'utf8').digest('hex')
}

/**
 * The fingerprint of a unit list: `key` and text together, in order.
 *
 * Deliberately built from the same normalization the cache key uses, so the
 * two can never disagree about whether a unit's text changed.
 * @param units - the units in canonical order.
 * @returns a stable sha256 hex digest.
 */
export function unitsFingerprint(units: ReadonlyArray<{ key: string; text: string }>): string {
  const hash = createHash('sha256')
  for (const unit of units) hash.update(`${unit.key}\u0000${normalizeEmbedText(unit.text)}\u0000`)
  return hash.digest('hex')
}

/** `<home>/embed-cache/<embedderVersion>` — partitioned so a model swap is additive. */
export function embedCacheDir(home: string, version: string): string {
  return path.join(home, 'embed-cache', version.replace(/[^A-Za-z0-9._@=-]/g, '_'))
}

/** The cache file of one key. */
export function embedCacheFile(home: string, version: string, key: string): string {
  return path.join(embedCacheDir(home, version), `${key}.bin`)
}

/**
 * Read one cached vector.
 * @param home - the ClueHarness home (cache lives beside `kb/`, shared).
 * @param version - the embedder version the cache partition belongs to.
 * @param key - the text key from {@link embedCacheKey}.
 * @param dim - the expected dimension (a mismatch reads as a miss).
 * @returns the vector, or null on a miss.
 */
export async function readCachedVector(home: string, version: string, key: string, dim: number): Promise<Float32Array | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(embedCacheFile(home, version, key))
  } catch {
    return null
  }
  if (bytes.length !== dim * 4) return null
  return decodeVectorMatrix(bytes)
}

/**
 * Write one cached vector (atomic; the cache is shared, so a torn file would
 * poison every workspace that reads it later).
 * @param home - the ClueHarness home.
 * @param version - the embedder version partition.
 * @param key - the text key.
 * @param vector - the embedded vector (L2-normalized by the embedder).
 */
export async function writeCachedVector(home: string, version: string, key: string, vector: Float32Array): Promise<void> {
  const dir = embedCacheDir(home, version)
  await mkdir(dir, { recursive: true })
  const file = embedCacheFile(home, version, key)
  const tmp = `${file}.tmp-${process.pid}-${key.slice(0, 8)}`
  await writeFile(tmp, encodeVectorMatrix(vector))
  await rename(tmp, file)
}

/**
 * Delete one cache partition, or every partition when no version is named.
 *
 * A diagnostic action (原规划 §9.5 诊断区), never an automatic one: clearing the
 * cache costs real money on the next build, so the caller must confirm it. The
 * vector indexes themselves are untouched — they are already-built artifacts,
 * and deleting them is a different (also explicit) act.
 * @param home - the ClueHarness home.
 * @param version - the partition to clear (absent = every partition).
 * @returns the partitions that were removed.
 */
export async function clearEmbedCache(home: string, version?: string): Promise<string[]> {
  const root = path.join(home, 'embed-cache')
  if (version !== undefined) {
    const dir = embedCacheDir(home, version)
    await rm(dir, { recursive: true, force: true })
    return [path.basename(dir)]
  }
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  await rm(root, { recursive: true, force: true })
  return names.sort()
}

/**
 * How many vectors one cache partition holds (the "缓存命中率" denominator in
 * the settings page's 现状卡片).
 * @param home - the ClueHarness home.
 * @param version - the embedder version partition.
 * @returns the number of cached vectors (0 when the partition does not exist).
 */
export async function countCachedVectors(home: string, version: string): Promise<number> {
  try {
    const names = await readdir(embedCacheDir(home, version))
    return names.filter((name) => name.endsWith('.bin')).length
  } catch {
    return 0
  }
}

/** The stamp of a freshly built index (one helper, so no call site hand-rolls it). */
export function vectorMetaFor(input: {
  embedderVersion: string
  dim: number
  idOrder: readonly string[]
  unitsHash: string
  builtAt: string
  missing?: number
}): VectorIndexMeta {
  return {
    version: VECTOR_FORMAT_VERSION,
    embedderVersion: input.embedderVersion,
    dim: input.dim,
    quant: 'fp32',
    count: input.idOrder.length,
    idOrder: [...input.idOrder],
    unitsHash: input.unitsHash,
    builtAt: input.builtAt,
    ...(input.missing !== undefined && input.missing > 0 ? { partial: { missing: input.missing } } : {}),
  }
}

/** Re-export so a consumer never re-derives the stamp by hand. */
export { embedderVersion }
