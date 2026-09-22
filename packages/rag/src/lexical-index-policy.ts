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

/**
 * How long a failed attempt is remembered (milliseconds).
 *
 * Short on purpose: the cooldown stops a store that is rewritten between every
 * query from rebuilding the whole index each time, and a blocked rebuild costs
 * only PERFORMANCE (the caller scans instead) — never correctness. A long window
 * would keep a healthy library on the slow path for no reason.
 */
export const LEXICAL_INDEX_RETRY_COOLDOWN_MS = 2_000

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
    /** F4①: the tokenizer mode the caller will query with. */
    identifierSubtokens?: boolean
  } = {},
): Promise<LexicalIndexSelection> {
  const now = options.now ?? (() => Date.now())
  const cooldown = options.cooldownMs ?? LEXICAL_INDEX_RETRY_COOLDOWN_MS
  const indexes: LexicalIndex[] = []
  const notes: string[] = []
  const tiers = stores.filter((store): store is KbStore => store !== null)
  if (tiers.length === 0) return { indexes: [], status: 'missing', note: '没有可索引的库' }
  /**
   * ALL OR NOTHING, and that is the whole safety argument.
   *
   * An index that covers only some of the participating tiers would change the
   * corpus the query sees — `df`, the averages, and the candidate set all shrink
   * with it — so "partial" is not a slower answer, it is a WRONG one. (Measured:
   * a stale project index plus no global index silently turned a gate retrieval
   * into zero hits.) So the moment one tier cannot be indexed, NO index is
   * handed over and the scan path runs for the whole query.
   */
  let blocked: LexicalIndexStatus | null = null
  let blockedNote = ''

  for (const store of tiers) {
    const loaded = await loadLexicalIndex(store.dir, {
      ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
      ...(options.maxMillis !== undefined ? { budget: { maxMillis: options.maxMillis } } : {}),
      ...(options.identifierSubtokens !== undefined ? { identifierSubtokens: options.identifierSubtokens } : {}),
    })
    if (loaded.index !== null) {
      indexes.push(loaded.index)
      continue
    }
    // An EMPTY tier owes nothing: it contributes no statistics and no
    // candidates, so "no index file" is not a gap for it.
    if (loaded.status === 'missing' && (await emptyStore(store))) continue
    if (loaded.status === 'over-budget') {
      blocked = 'over-budget'
      blockedNote = loaded.note
      break
    }
    const repairable = loaded.status === 'missing' || loaded.status === 'stale' || loaded.status === 'corrupt'
    const last = LAST_ATTEMPT.get(store.dir) ?? 0
    if (repairable && options.noBuild !== true && now() - last >= cooldown) {
      LAST_ATTEMPT.set(store.dir, now())
      const built = await buildLexicalIndex({
        storeDir: store.dir,
        entries: await store.list(),
        ...(options.maxEntries !== undefined ? { budget: { maxEntries: options.maxEntries } } : {}),
        ...(options.identifierSubtokens === true ? { identifierSubtokens: true } : {}),
      })
      if (!built.report.overBudget && built.index.meta.entryCount > 0) {
        indexes.push(built.index)
        notes.push(`索引已重建(${built.report.entries} 条 / ${built.report.postings} 条 posting)`)
        continue
      }
      blocked = built.report.overBudget ? 'over-budget' : 'stale'
      blockedNote = built.report.reason
      break
    }
    blocked = loaded.status
    blockedNote = repairable && options.noBuild !== true && now() - last < cooldown
      ? `${loaded.note}(重建冷却中,${Math.ceil((cooldown - (now() - last)) / 1000)}s 后重试)`
      : loaded.note
    break
  }

  if (blocked !== null) {
    return {
      indexes: [],
      status: blocked,
      note: `${blockedNote};本次整条查询退回全库扫描(索引只覆盖部分库会让结果变错,不只是变慢)`,
    }
  }
  return {
    indexes,
    status: 'current',
    note: notes.length === 0 ? '词法索引可用(本次未扫描全库)' : notes.join(';'),
  }
}

/** Whether a store holds no entries at all (then it needs no index). */
async function emptyStore(store: KbStore): Promise<boolean> {
  try {
    const entries = await store.list()
    return entries.length === 0
  } catch {
    return false
  }
}
