/**
 * The weighted signal ledger (design doc §3.4, decisions #8/#9).
 *
 * Doctrine:
 * - signals are an APPEND-ONLY JSONL ledger (lesson 8 discipline): history is
 *   never rewritten, weights are copied in at record time so later config
 *   changes never retro-reprice old evidence;
 * - score = sum of weights inside a sliding window (default 30 days);
 * - "retrieved but not used" is NEVER recorded (decision #9: no penalty for
 *   irrelevance — the M3 loop only records `implicit` when the knowledge was
 *   actually used and uncorrected);
 * - promotion is eligibility, not action: crossing `trustThreshold` creates
 *   an approval REQUEST; the state machine's only promote edge is
 *   `approve-promote` (models propose, evidence scores, humans dispose).
 *
 * @module @clue-harness/kb/signals
 */
import { appendJsonl, readJsonl } from '@clue-harness/util'
import {
  DEFAULT_KB_CONFIG,
  type KbConfig,
  type KbEntryId,
  type SignalRecord,
} from './types.ts'

/** The signal sources a caller may record, mapped onto ledger vocabulary. */
export type SignalInput =
  | 'human-confirm'    // you said "this is right"        → positive/human
  | 'evidence-pass'    // attributed objective pass       → positive/evidence
  | 'implicit-use'     // used, uncorrected (M3 loop)     → positive/implicit
  | 'evidence-fail'    // attributed objective failure    → negative/evidence
  | 'user-reject'      // you said "不对"                  → negative/human

const SIGNAL_MAP: Record<SignalInput, { polarity: 'positive' | 'negative'; source: 'human' | 'evidence' | 'implicit'; weightKey: keyof KbConfig['weights'] }> = {
  'human-confirm': { polarity: 'positive', source: 'human', weightKey: 'human' },
  'evidence-pass': { polarity: 'positive', source: 'evidence', weightKey: 'evidence' },
  'implicit-use': { polarity: 'positive', source: 'implicit', weightKey: 'implicit' },
  'evidence-fail': { polarity: 'negative', source: 'evidence', weightKey: 'evidenceFail' },
  'user-reject': { polarity: 'negative', source: 'human', weightKey: 'userReject' },
}

/**
 * Build one ledger record (the store appends it).
 * @param entryId - target entry.
 * @param input - which signal occurred.
 * @param note - free context ("render_assert: tab-order passed", …).
 * @param config - weights source.
 * @param at - ISO timestamp (injectable for tests).
 * @returns the record to append.
 */
export function buildSignal(
  entryId: KbEntryId,
  input: SignalInput,
  note: string,
  config: KbConfig = DEFAULT_KB_CONFIG,
  at: string = new Date().toISOString(),
): SignalRecord {
  const mapped = SIGNAL_MAP[input]
  return {
    at,
    entryId,
    polarity: mapped.polarity,
    source: mapped.source,
    weight: config.weights[mapped.weightKey],
    note: `${input}${note === '' ? '' : `: ${note}`}`,
  }
}

/** Append one record to a ledger file. */
export async function appendSignal(ledgerFile: string, record: SignalRecord): Promise<void> {
  await appendJsonl(ledgerFile, record)
}

/** Read a whole ledger (empty when the file does not exist yet). */
export async function readSignals(ledgerFile: string): Promise<SignalRecord[]> {
  return readJsonl<SignalRecord>(ledgerFile)
}

/**
 * Sliding-window score for one entry.
 * @param signals - ledger records (any entry mix; filtered here).
 * @param entryId - whose score.
 * @param now - reference time (injectable for tests).
 * @param windowDays - window length.
 * @returns score plus breakdown for display.
 */
export function windowScore(
  signals: readonly SignalRecord[],
  entryId: KbEntryId,
  now: Date,
  windowDays: number = DEFAULT_KB_CONFIG.windowDays,
): { score: number; counted: number; positive: number; negative: number; lastSignalAt: string | null } {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000
  let score = 0
  let counted = 0
  let positive = 0
  let negative = 0
  let lastSignalAt: string | null = null
  for (const record of signals) {
    if (record.entryId !== entryId) continue
    const at = Date.parse(record.at)
    if (Number.isNaN(at) || at < cutoff) continue
    score += record.weight
    counted += 1
    if (record.weight >= 0) positive += record.weight
    else negative += record.weight
    if (lastSignalAt === null || record.at > lastSignalAt) lastSignalAt = record.at
  }
  return { score, counted, positive, negative, lastSignalAt }
}

/**
 * The negative bound that trips `strong-negative` discard eligibility.
 * Defaults to the symmetric -trustThreshold on both tiers (at ±20 a single
 * user rejection (-6) no longer discards; sustained negativity does — the
 * M3a decision, reaffirmed for the global tier in the M5 review). An
 * explicit `config.discardThreshold` wins for deployments that want a
 * different bound.
 * @param config - weights source.
 * @returns the (negative) threshold.
 */
export function discardThreshold(config: KbConfig = DEFAULT_KB_CONFIG): number {
  return config.discardThreshold ?? -config.trustThreshold
}
