/**
 * The Embedder PORT and its deterministic fallback (V0, 原规划 §4).
 *
 * **Dependency inversion, not a wrapper.** The engine (`kb`/`rag`) may never
 * import a dsh package and may never open a socket, so the thing that actually
 * talks to an embedding endpoint lives in the integration layer
 * (`@clue-harness/kb-face`'s `HttpEmbedder`). This file defines the seam both
 * sides agree on — three members, no options bag, no transport vocabulary.
 * The batch size, timeout and retry policy belong to the adapter, because they
 * are properties of the transport, not of retrieval.
 *
 * **The fallback is a first-class citizen, not a mock.** `hashEmbedder` is
 * deterministic, dependency-free and always available, which is what lets V0
 * be accepted end-to-end with no endpoint, no key and no network (不变量 7),
 * and what the test suite pins ordering with. It is honest about its own
 * limits: it is a hashed bag-of-tokens, so its semantic ability is ≈0 —
 * a report produced with it verifies the PIPELINE, never the SEMANTICS, and
 * every surface that reports metrics must say so.
 *
 * @module @clue-harness/rag/embedder
 */
import { l2Normalize, tokenize } from '@clue-harness/kb'

/**
 * The embedding seam. One implementation talks HTTP, one is pure computation;
 * retrieval cannot tell them apart, which is the whole point.
 */
export interface Embedder {
  /** Stable identifier — the model name when there is a model. Enters `embedderVersion`. */
  readonly id: string
  /**
   * The REAL dimension. For `HttpEmbedder` this is measured by the connection
   * test, never hand-typed (原规划 §9.6): a wrong dimension silently poisons
   * the version stamp and every cosine after it.
   */
  readonly dim: number
  /**
   * What the embedder can actually do, SELF-REPORTED (F1 of
   * `docs/开发记录.md`).
   *
   * `none` means "this is a deterministic fallback, not a semantic model" —
   * `hashEmbedder` is a hashed bag of tokens, so its ranking carries no meaning
   * beyond the tokens the lexical channel already has. Measured consequence of
   * ignoring that: fusion let a no-ability channel REPLACE half the lexical
   * results (cosqa hybrid+rerank 0.2558 vs lexical 0.3003), and the one change
   * that fixed it was switching the semantic contribution off.
   *
   * Absent = "unknown, treat as a real embedder" (third-party ports and test
   * doubles keep working without declaring anything).
   */
  readonly semantics?: 'none' | 'endpoint'
  /**
   * Batch-embed texts, in order. The returned array has exactly one vector per
   * input, each `dim` long and L2-normalized.
   * @param texts - the units to embed.
   * @returns one vector per input, order-preserving.
   */
  embed(texts: readonly string[]): Promise<Float32Array[]>
}

/** The shipped fallback's id; it enters `embedderVersion` like any model name. */
export const HASH_EMBEDDER_ID = 'hash-v1'

/** The fallback's default dimension (small on purpose: it is a pipeline probe). */
export const DEFAULT_HASH_DIM = 256

/** FNV-1a over a token, plus a sign bit from a second mixing pass. */
function hashToken(token: string): { index: number; sign: number } {
  let hash = 0x811c9dc5
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  // A second, differently-seeded pass decides the sign — one hash reused for
  // both choices would correlate position with polarity.
  let sign = 0x9e3779b9
  for (let i = 0; i < token.length; i += 1) {
    sign ^= token.charCodeAt(i) + i
    sign = Math.imul(sign, 0x85ebca6b) >>> 0
  }
  return { index: hash, sign: (sign & 1) === 0 ? 1 : -1 }
}

/**
 * The deterministic fallback embedder (原规划 §3 决策 1 / §4).
 *
 * Hashed bag-of-tokens: every token from the product's own {@link tokenize}
 * (ASCII words + CJK bigrams) lands in one bucket with a fixed sign. Two texts
 * sharing tokens get a positive cosine, which is exactly enough to exercise
 * the vector path — recall, fusion, storage, rebuild, cache — while making NO
 * semantic claim. Different processes, machines and runs produce bit-identical
 * vectors, so ordering is pinnable in tests.
 *
 * @param options - dimension override (tests use a small one; the id follows
 *   the dimension so two different dimensions can never share a version stamp).
 * @returns the embedder.
 */
export function hashEmbedder(options: { dim?: number } = {}): Embedder {
  const dim = options.dim ?? DEFAULT_HASH_DIM
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`hashEmbedder: dim must be a positive integer, got ${dim}`)
  return {
    id: `${HASH_EMBEDDER_ID}${options.dim === undefined ? '' : `-${dim}`}`,
    dim,
    // Declares itself honestly: it has NO semantic ability, and the retrieval
    // layer uses that to keep it out of fusion (F1).
    semantics: 'none' as const,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        const vector = new Float32Array(dim)
        for (const token of tokenize(text)) {
          const { index, sign } = hashToken(token)
          const slot = index % dim
          vector[slot] = (vector[slot] as number) + sign
        }
        return l2Normalize(vector)
      })
    },
  }
}
