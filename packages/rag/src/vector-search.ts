/**
 * Brute-force vector search (V0, 原规划 §5.4).
 *
 * The corpus is 29 entries and one 28-段 document today, and the plan is
 * explicit that ANN (HNSW/IVF) is a NON-goal until ~5万 vectors: at 512
 * dimensions an exhaustive cosine scan over a flat `Float32Array` costs
 * 10–30 ms, which is cheaper than the machinery that would avoid it. So this
 * module is deliberately one loop.
 *
 * What it does not do is just as deliberate: it never reorders by anything but
 * similarity, never looks at an entry's status, and never treats a similarity
 * as a statement about trust. Filtering is the first level's job (status/tier/
 * review/redline), and it happens BEFORE this scan — the scan only sees rows
 * whose owner already passed the gate (原规划 §8.1 原则 2).
 *
 * @module @clue-harness/rag/vector-search
 */
import { cosineSimilarity, type VectorIndex } from '@clue-harness/kb'

/** One similarity hit. */
export interface VectorHit {
  /** The row key: an entryId, or `<docId>#<seq>` for a chunk index. */
  key: string
  /** Cosine similarity, roughly [-1, 1]. */
  score: number
  /** The row it came from (for callers that need the vector itself). */
  row: number
}

/** Search knobs. */
export interface VectorSearchOptions {
  /** Maximum hits to return. */
  limit?: number
  /**
   * Drop hits at or below this cosine. Default 0: a stored vector always has
   * SOMETHING in common with a query vector by chance, and returning a long
   * tail of near-zero similarities would let the fusion stage promote noise.
   */
  minScore?: number
}

/**
 * Rank every row of an index against one query vector.
 *
 * Dimension mismatch answers `[]` rather than throwing: a query embedded by a
 * different model than the stored matrix is a state the settings page can be
 * in for a moment, and the honest response is "this channel recalled nothing"
 * — which the fusion stage already handles — not a crashed retrieval.
 * @param index - the loaded index.
 * @param query - the query vector.
 * @param options - limit and floor.
 * @returns hits, best first (deterministic: score desc, then key).
 */
export function searchVectors(index: VectorIndex, query: Float32Array, options: VectorSearchOptions = {}): VectorHit[] {
  const { meta, vectors } = index
  if (query.length !== meta.dim) return []
  const minScore = options.minScore ?? 0
  const hits: VectorHit[] = []
  for (let row = 0; row < meta.count; row += 1) {
    const offset = row * meta.dim
    const score = cosineSimilarity(query, vectors.subarray(offset, offset + meta.dim))
    if (score <= minScore) continue
    hits.push({ key: meta.idOrder[row] as string, score, row })
  }
  hits.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  return options.limit === undefined ? hits : hits.slice(0, options.limit)
}

/**
 * The chunk half of a row key (`<docId>#<seq>` → `docId`), for V4's roll-up.
 * @param key - a row key from a chunk index.
 * @returns the docId, or null when the key is not a chunk key.
 */
export function docIdOfChunkKey(key: string): string | null {
  const at = key.lastIndexOf('#')
  return at <= 0 ? null : key.slice(0, at)
}
