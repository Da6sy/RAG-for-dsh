/**
 * `ranklog.jsonl` — the annotation ledger the plan collects instead of
 * training a ranker (V2, 规划 §8.4).
 *
 * The decision (拍板 2) was hand-built features, and the LTR road stays closed
 * this round: what ships is the DATA a future ranker would need, recorded at
 * the moment the ranking existed and nowhere else.
 *
 * Three disciplines:
 *
 * - **No secret ever lands here** (规划 §9.4-1 / 不变量 10). A row contains the
 *   query text, entry ids, feature values and channel ranks — no header, no
 *   url, no key. The append path is the only writer, and it writes a fixed
 *   shape, so there is no field a credential could arrive in.
 * - **Append-only** (lesson 8): a row is never rewritten. A later `kb_cite` or
 *   a human confirmation does not edit the row; it becomes a LABEL during
 *   summarization, joined from the signal ledger — the same "history is the
 *   ledger" shape the signals have had since M2.
 * - **A retrieval never fails because of it.** The retriever calls the sink in
 *   a try/catch; a full disk degrades the log, never the search.
 *
 * @module @clue-harness/rag/ranklog
 */
import path from 'node:path'
import { appendJsonl, readJsonl } from '@clue-harness/util'
import type { SignalRecord } from '@clue-harness/kb'
import type { RankLogLine } from './hybrid.ts'

/** The ranklog row format version. */
export const RANKLOG_VERSION = 1

/** One recorded retrieval. */
export interface RankLogRow extends RankLogLine {
  v: number
  /** Entry ids this retrieval actually cited (filled by the caller when known). */
  cited?: string[]
}

/** `<kbDir>/ranklog.jsonl` — the workspace's own annotation ledger. */
export function ranklogFile(kbDir: string): string {
  return path.join(kbDir, 'ranklog.jsonl')
}

/**
 * Append one retrieval to the log.
 * @param kbDir - the tier directory the retrieval addressed.
 * @param line - the retrieval's facts (no secret, by construction).
 */
export async function appendRankLog(kbDir: string, line: RankLogLine): Promise<void> {
  const row: RankLogRow = { v: RANKLOG_VERSION, ...line }
  await appendJsonl(ranklogFile(kbDir), row)
}

/**
 * Read the log (optionally only its tail).
 * @param kbDir - the tier directory.
 * @param limit - keep the last N rows.
 * @returns the rows in file order.
 */
export async function readRankLog(kbDir: string, limit?: number): Promise<RankLogRow[]> {
  const rows = await readJsonl<RankLogRow>(ranklogFile(kbDir))
  return limit === undefined ? rows : rows.slice(Math.max(0, rows.length - limit))
}

/** What a ranklog holds, and how much of it is LABELED (规划 §8.4). */
export interface RankLogSummary {
  /** Rows in the ledger. */
  rows: number
  /** Distinct queries (the plan's ≥500 baseline counts these). */
  queries: number
  /** Rows per channel profile. */
  perProfile: Record<string, number>
  /** Rows where at least one candidate carries a positive signal label. */
  labeledRows: number
  /** Candidate-level labels available (positives). */
  positiveLabels: number
  /** Candidate-level labels available (negatives). */
  negativeLabels: number
  lastAt: string | null
}

/** How long after a retrieval a signal may still be "about" it. */
const LABEL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Summarize the ledger and join it against the signal ledger for labels.
 *
 * A candidate is labeled POSITIVE when a positive signal for that entry was
 * recorded within {@link LABEL_WINDOW_MS} after the retrieval — `kb_cite`,
 * `human-confirm` and `evidence-pass` all land in the signals ledger, which is
 * exactly why the plan calls the signal ledger "天然的标注源". Anything
 * outside that window is not attributable to this retrieval and is not counted:
 * an over-eager join would manufacture training data that says nothing.
 *
 * @param kbDir - the tier directory.
 * @param signals - the tier's signal ledger (absent = no labels, counts only).
 * @returns the summary.
 */
export async function summarizeRankLog(kbDir: string, signals: readonly SignalRecord[] = []): Promise<RankLogSummary> {
  const rows = await readRankLog(kbDir)
  const perProfile: Record<string, number> = {}
  const queries = new Set<string>()
  let labeledRows = 0
  let positiveLabels = 0
  let negativeLabels = 0
  for (const row of rows) {
    perProfile[row.profile] = (perProfile[row.profile] ?? 0) + 1
    queries.add(row.query)
    const at = Date.parse(row.at)
    const positives = new Set<string>()
    const negatives = new Set<string>()
    for (const signal of signals) {
      const signalAt = Date.parse(signal.at)
      if (Number.isNaN(signalAt) || Number.isNaN(at)) continue
      if (signalAt < at || signalAt - at > LABEL_WINDOW_MS) continue
      const key = String(signal.entryId)
      if (signal.polarity === 'positive') positives.add(key)
      else negatives.add(key)
    }
    const candidates = row.candidates.map((candidate) => candidate.id)
    const hitsPositive = candidates.filter((id) => positives.has(id))
    const hitsNegative = candidates.filter((id) => negatives.has(id))
    if (hitsPositive.length > 0 || hitsNegative.length > 0) labeledRows += 1
    positiveLabels += hitsPositive.length
    negativeLabels += hitsNegative.length
  }
  return {
    rows: rows.length,
    queries: queries.size,
    perProfile,
    labeledRows,
    positiveLabels,
    negativeLabels,
    lastAt: rows.length === 0 ? null : rows[rows.length - 1]?.at ?? null,
  }
}
