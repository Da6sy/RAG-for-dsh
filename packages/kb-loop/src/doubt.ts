/**
 * The doubt ledgers (M6, design §4.7) — "怀疑计数器分开记".
 *
 * TWO logical ledgers in one append-only JSONL beside the project store's
 * other ledgers (entries history / signals / approvals):
 *
 * - `module` — a module's structured checks keep getting rejected by the
 *   human. Consequence at threshold: L3 screenshot escalation + a candidate
 *   knowledge "该模块光看结构化数据判断不了,需要视觉确认" (the expensive
 *   action itself becomes learnable — next gate run captures it directly).
 * - `entry` — a knowledge entry keeps being cited by answers the human
 *   rejects. Consequence at threshold: one user-reject signal (the heaviest
 *   negative, decision #9) — 扣知识分, not a screenshot.
 *
 * Counts are DERIVED from the ledger (doubts since the key's last escalation
 * marker), never stored as mutable counters — the M5 lesson: history is the
 * state, replay is the audit. Escalation is a caller action; the ledger only
 * records that it happened (with what effect), which resets the open count.
 *
 * Zero dsh imports (engine discipline); the face layer owns browsers,
 * attachments, and stores.
 *
 * @module @clue-harness/kb-loop/doubt
 */
import path from 'node:path'
import { appendJsonl, readJsonl } from '@clue-harness/util'

/** Which ledger a doubt belongs to (处理方式不同的两本账). */
export type DoubtKind = 'module' | 'entry'

/** One human rejection counted against a key. */
export interface DoubtEvent {
  at: string
  type: 'doubt'
  kind: DoubtKind
  /** Module id or KB entry id. */
  key: string
  sessionId: string
  turn: number
  /** Audit text (the feedback note when one was given). */
  reason: string
}

/** One threshold trip and what the escalation did. */
export interface EscalationEvent {
  at: string
  type: 'escalated'
  kind: DoubtKind
  key: string
  /** Open doubt count at escalation time. */
  count: number
  /** What the face did (screenshot hash, knowledge id, signal…) — audit. */
  action: string
}

export type DoubtRecord = DoubtEvent | EscalationEvent

/** The ledger file's location for one project store directory. */
export function doubtLedgerPath(storeDir: string): string {
  return path.join(storeDir, 'doubt.jsonl')
}

/**
 * Read the whole ledger (both kinds, chronological).
 * @param storeDir - the project store directory.
 * @returns every record (missing file reads empty).
 */
export async function readDoubtLedger(storeDir: string): Promise<DoubtRecord[]> {
  return readJsonl<DoubtRecord>(doubtLedgerPath(storeDir))
}

/**
 * Count OPEN doubts per key: doubts since the key's last escalation marker.
 * @param storeDir - the project store directory.
 * @param kind - which ledger to count.
 * @returns key → open count.
 */
export async function openDoubtCounts(storeDir: string, kind: DoubtKind): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const record of await readDoubtLedger(storeDir)) {
    if (record.kind !== kind) continue
    if (record.type === 'escalated') {
      counts.delete(record.key)
      continue
    }
    counts.set(record.key, (counts.get(record.key) ?? 0) + 1)
  }
  return counts
}

/**
 * Append one doubt and report the key's resulting open count.
 * @param storeDir - the project store directory.
 * @param event - the doubt facts (timestamp stamped here).
 * @returns the open count after this doubt (compare against the threshold).
 */
export async function recordDoubt(
  storeDir: string,
  event: Omit<DoubtEvent, 'at' | 'type'>,
  at: string = new Date().toISOString(),
): Promise<number> {
  await appendJsonl(doubtLedgerPath(storeDir), { ...event, at, type: 'doubt' } satisfies DoubtEvent)
  const counts = await openDoubtCounts(storeDir, event.kind)
  return counts.get(event.key) ?? 0
}

/**
 * Record that the threshold tripped and the face acted (resets the open
 * count for this key — fresh doubts after an escalation start from zero).
 * @param storeDir - the project store directory.
 * @param kind - which ledger.
 * @param key - module or entry id.
 * @param count - open count at escalation time (audit).
 * @param action - what the escalation did (audit text).
 * @param at - ISO timestamp.
 */
export async function markEscalated(
  storeDir: string,
  kind: DoubtKind,
  key: string,
  count: number,
  action: string,
  at: string = new Date().toISOString(),
): Promise<void> {
  const record: EscalationEvent = { at, type: 'escalated', kind, key, count, action }
  await appendJsonl(doubtLedgerPath(storeDir), record)
}

/**
 * Modules that ever escalated — the gate's "下次遇到它直接截图" roster
 * (design §4.7: 升级沉淀之后,该模块的每次验证都带像素证据)。
 * @param storeDir - the project store directory.
 * @returns the escalated module ids.
 */
export async function escalatedModules(storeDir: string): Promise<Set<string>> {
  const modules = new Set<string>()
  for (const record of await readDoubtLedger(storeDir)) {
    if (record.type === 'escalated' && record.kind === 'module') modules.add(record.key)
  }
  return modules
}
