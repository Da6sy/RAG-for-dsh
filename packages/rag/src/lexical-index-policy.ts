/**
 * Who builds and repairs the inverted index (R1 of `docs/落地计划-剩余工程.md`).
 *
 * The engine (`packages/kb/src/lexical-index.ts`) owns the files, the guards and
 * the honest status vocabulary; this module owns the POLICY a live retrieval
 * follows, and it is deliberately here (the rag layer) rather than in a surface:
 *
 * 1. **A derived layer may be rebuilt silently** (宪法 4). A missing, stale or
 *    corrupt index is rebuilt on the query path, once, and the query proceeds.
 * 2. **Its failure must never become a retrieval failure.** If the index cannot
 *    be built (over budget, unreadable corpus) the caller gets an empty list,
 *    the scan path runs, and the reason travels in `note` so every surface can
 *    print it (不变量 5: 降级要说出原因).
 * 3. **A bad corpus must not be re-listed on every question.** Rebuilding is
 *    expensive (it reads every entry), so failed attempts are remembered for a
 *    cooldown — otherwise a library over the size budget would pay the full
 *    scan TWICE per query for the rest of the session.
 *
 * @module @clue-harness/rag/lexical-index-policy
 */
import {
  buildLexicalIndex,
  loadLexicalIndex,
  type KbStore,
  type LexicalIndex,
  type LexicalIndexStatus,
} from '@clue-harness/kb'

/** What one retrieval should use. */
export interface LexicalIndexSelection {
  /** The indexes to hand to the retriever (empty = scan path). */
  indexes: LexicalIndex[]
  /** `current` when every participating tier is indexed, else the worst status seen. */
  status: LexicalIndexStatus | 'partial'
  /** A sentence a surface may print verbatim. */
  note: string
}

/** How long a failed attempt is remembered (milliseconds). */
export const LEXICAL_INDEX_RETRY_COOLDOWN_MS = 30_000

/** Attempt stamps per store dir (process-local: it only guards repeated work). */
const LAST_ATTEMPT = new Map<string, number>()

/** Forget the cooldown bookkeeping (tests, and an explicit「重建」action). */
export function forgetLexicalIndexPolicy(storeDir?: string): void {
  if (storeDir === undefined) LAST_ATTEMPT.clear()
  else LAST_ATTEMPT.delete(storeDir)
}

/**
 * Make sure every tier has a usable index, rebuilding it when it is merely
 * missing/stale/corrupt — and giving up quietly (with a reason) when it is not
 * worth building.
 * @param stores - the tiers a retrieval may use (nulls are skipped).
 * @param options - budget, clock and cooldown overrides.
 * @returns the indexes plus the status and note the caller should surface.
 */
export async function ensureLexicalIndexes(
  stores: readonly (KbStore | null)[],
  options: {
    maxEntries?: number
    maxMillis?: number
    cooldownMs?: number
    now?: () => number
    /** Skip the rebuild step (read-only surfaces, and the A/B harness). */
    noBuild?: boolean
  } = {},
): Promise<LexicalIndexSelection> {
  const now = options.now ?? (() => Date.now())
  const cooldown = options.cooldownMs ?? LEXICAL_INDEX_RETRY_COOLDOWN_MS
  const indexes: LexicalIndex[] = []
  const notes: string[] = []
  let worst: LexicalIndexStatus | 'partial' | null = null
  const tiers = stores.filter((store): store is KbStore => store !== null)
  if (tiers.length === 0) return { indexes: [], status: 'missing', note: '没有可索引的库' }

  for (const store of tiers) {
    const loaded = await loadLexicalIndex(store.dir, {
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
      ...(options.maxMillis !== undefined ? { budget: { maxMillis: options.maxMillis } } : {}),
    })
    if (loaded.index !== null) {
      indexes.push(loaded.index)
      continue
    }
    const repairable = loaded.status === 'missing' || loaded.status === 'stale' || loaded.status === 'corrupt'
    const last = LAST_ATTEMPT.get(store.dir) ?? 0
    if (repairable && options.noBuild !== true && now() - last >= cooldown) {
      LAST_ATTEMPT.set(store.dir, now())
      const built = await buildLexicalIndex({
        storeDir: store.dir,
        entries: await store.list(),
        ...(options.maxEntries !== undefined ? { budget: { maxEntries: options.maxEntries } } : {}),
      })
      if (!built.report.overBudget && built.index.meta.entryCount > 0) {
        indexes.push(built.index)
        notes.push(`索引已重建(${built.report.entries} 条 / ${built.report.postings} 条 posting)`)
        continue
      }
      notes.push(built.report.reason)
      worst = 'over-budget'
      continue
    }
    notes.push(loaded.note)
    // The worst status wins the summary: a caller that prints one line must see
    // the reason the corpus was scanned, not the cheerful half.
    if (worst === null || loaded.status !== 'current') worst = loaded.status
  }

  const allIndexed = indexes.length === tiers.length && indexes.length > 0
  return {
    indexes,
    status: allIndexed ? (worst === null ? 'current' : worst) : indexes.length > 0 ? 'partial' : (worst ?? 'missing'),
    note: allIndexed
      ? (notes.length === 0 ? '词法索引可用(本次未扫描全库)' : notes.join(';'))
      : notes.length === 0
        ? '词法索引不可用,本次退回全库扫描'
        : notes.join(';'),
  }
}
