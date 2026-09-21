/**
 * RRF fusion — Reciprocal Rank Fusion over the recall channels (V2, 规划 §7.2).
 *
 * Why rank fusion instead of a weighted score sum: the lexical channel's score
 * is a bare sum of field weights (its magnitude drifts with query length and
 * corpus size) while cosine lives in [-1, 1]. Adding them requires calibrating
 * weights per corpus, and that calibration is stale the moment the corpus
 * changes. RRF consumes only ORDER:
 *
 *     score(d) = Σ_c  w_c / (k + rank_c(d))
 *
 * with `k = 60` (the literature default, insensitive at the head) and
 * per-channel weights from the profile table (规划 §7.3).
 *
 * The property that makes it the right choice here is the one the plan calls
 * out: **it tolerates a missing channel by construction**. With no vector
 * layer the fused order IS the lexical order — degradation is honest because
 * it is arithmetically identical to the single-channel case, not because
 * somebody remembered to write a fallback branch (不变量 5).
 *
 * @module @clue-harness/rag/fuse
 */
import { normalizePath } from './retrieve.ts'

/** The shipped RRF constant (规划 §9.3 `rrfK` default 60). */
export const DEFAULT_RRF_K = 60

/** One recall channel's ranked output. */
export interface RankedChannel {
  /** 'lexical' | 'vector' | any profile-declared name. */
  name: string
  /** The channel's weight for this query profile. */
  weight: number
  /** Keys best-first. Duplicates are ignored after the first occurrence. */
  ranked: readonly string[]
}

/** One fused candidate with the arithmetic that produced its score. */
export interface FusedCandidate {
  key: string
  score: number
  /** channel → 1-based rank (absent when the channel did not recall it). */
  ranks: Record<string, number>
  /** channel → `w / (k + rank)`, i.e. what each channel contributed. */
  contributions: Record<string, number>
}

/**
 * Fuse channels by rank.
 *
 * Deterministic tie-break: score desc, then the best (smallest) rank across
 * channels, then the key — so equal-score candidates do not shuffle between
 * runs (不变量 7).
 * @param channels - the channels to fuse (zero-weight channels are skipped).
 * @param k - the RRF constant.
 * @returns the fused candidates, best first.
 */
export function rrfFuse(channels: readonly RankedChannel[], k: number = DEFAULT_RRF_K): FusedCandidate[] {
  const fused = new Map<string, FusedCandidate>()
  for (const channel of channels) {
    if (channel.weight === 0) continue
    const seen = new Set<string>()
    let rank = 0
    for (const key of channel.ranked) {
      // A channel that lists a key twice must not be able to pay itself twice.
      if (seen.has(key)) continue
      seen.add(key)
      rank += 1
      const contribution = channel.weight / (k + rank)
      const candidate = fused.get(key) ?? { key, score: 0, ranks: {}, contributions: {} }
      candidate.score += contribution
      candidate.ranks[channel.name] = rank
      candidate.contributions[channel.name] = contribution
      fused.set(key, candidate)
    }
  }
  return [...fused.values()].sort((a, b) =>
    b.score - a.score
    || bestRank(a) - bestRank(b)
    || a.key.localeCompare(b.key))
}

/** The best (smallest) rank one candidate received anywhere. */
function bestRank(candidate: FusedCandidate): number {
  const ranks = Object.values(candidate.ranks)
  return ranks.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...ranks)
}

/**
 * Reduce a ranked list of ACTIONS to a ranked list of entry keys, keeping the
 * best position of each.
 *
 * The lexical channel is entry-level and the vector channel is entry-level in
 * V0–V2, so this is the identity today. It exists for V4, where chunk-level
 * vector hits must roll up to the entry that owns the evidence — and rolling
 * up by BEST position (not by summing) is the only rule that does not reward
 * an entry merely for having more text.
 * @param items - ranked `[key, actionKey]` pairs (best first).
 * @returns the deduped keys, best position first.
 */
export function rollUpToKeys(items: ReadonlyArray<{ key: string }>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (seen.has(item.key)) continue
    seen.add(item.key)
    out.push(item.key)
  }
  return out
}

/**
 * Normalize a ranked path list for the binding channel (shared with the
 * binding-recall logic that has used this spelling since M4).
 * @param paths - raw paths.
 * @returns the normalized set.
 */
export function normalizedPathSet(paths: readonly string[]): Set<string> {
  return new Set(paths.map(normalizePath))
}
