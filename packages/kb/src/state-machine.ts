/**
 * The four-state lifecycle machine (design doc §3.3, decisions #8/#10/#11) —
 * the user's original design plus the four agreed patches:
 *
 * 1. trusted is NOT lifetime tenure: trusted → expired (idle) and
 *    trusted → discarded (strong negative) both exist;
 * 2. "source file changed" is the ORTHOGONAL needsReview flag, never a fifth
 *    state — status answers "how trusted", the flag answers "may be stale";
 * 3. expired knowledge stays readable WITH annotation; only write-basis use
 *    needs approval (that gate lives in the M3/M4 loop, the states here
 *    already carry everything it needs);
 * 4. every human decision flows through the batched approval queue — the
 *    machine itself never auto-promotes (models propose, evidence scores,
 *    humans dispose).
 *
 * Pure logic: the table, the guard, and an immutable apply that records
 * history. The store persists; the machine decides.
 *
 * @module @clue-harness/kb/state-machine
 */
import {
  type KbEntry,
  type KbHistoryEvent,
  type KbStatus,
} from './types.ts'

/** What caused a transition (each edge demands its own trigger). */
export type TransitionTrigger =
  | 'approve-promote'   // human approved a promotion (queue)
  | 'expire-idle'       // unreferenced beyond expireAfterDays
  | 'strong-negative'   // window score crossed the negative bound
  | 'reactivate'        // human reviewed an expired entry back to candidate
  | 'rescue'            // human rescued a discarded entry back to candidate

/**
 * The complete edge table. Anything absent here is ILLEGAL and throws —
 * an illegal transition is always a bug in a caller, never a user state.
 */
const ALLOWED: Record<KbStatus, Partial<Record<KbStatus, TransitionTrigger[]>>> = {
  candidate: {
    trusted: ['approve-promote'],
    expired: ['expire-idle'],
    discarded: ['strong-negative'],
  },
  trusted: {
    // Patch #1: trusted has exits.
    expired: ['expire-idle'],
    discarded: ['strong-negative'],
  },
  expired: {
    candidate: ['reactivate'],
    discarded: ['expire-idle', 'strong-negative'],
  },
  discarded: {
    // Rescue returns to CANDIDATE (must re-earn trust), never straight to trusted.
    candidate: ['rescue'],
  },
}

/**
 * Whether a transition is legal.
 * @param from - current status.
 * @param to - desired status.
 * @param trigger - what is causing it.
 * @returns true when the edge exists for this trigger.
 */
export function canTransition(from: KbStatus, to: KbStatus, trigger: TransitionTrigger): boolean {
  return (ALLOWED[from]?.[to] ?? []).includes(trigger)
}

/** Every legal (from, to, trigger) triple — used by tests and `clue kb status`. */
export function transitionTable(): Array<{ from: KbStatus; to: KbStatus; triggers: TransitionTrigger[] }> {
  const out: Array<{ from: KbStatus; to: KbStatus; triggers: TransitionTrigger[] }> = []
  for (const [from, targets] of Object.entries(ALLOWED) as Array<[KbStatus, Partial<Record<KbStatus, TransitionTrigger[]>>]>) {
    for (const [to, triggers] of Object.entries(targets) as Array<[KbStatus, TransitionTrigger[]]>) {
      out.push({ from, to, triggers })
    }
  }
  return out
}

/** One history line (also used for flag changes). */
export function historyEvent(
  at: string,
  change: KbHistoryEvent['change'],
  from: KbStatus | null,
  to: KbStatus | boolean | null,
  reason: string,
): KbHistoryEvent {
  return { at, change, from, to, reason }
}

/**
 * Apply a guarded transition, returning a NEW entry (entries are treated as
 * immutable values everywhere; the store writes the result atomically).
 * @param entry - the current entry.
 * @param to - target status.
 * @param trigger - cause; must match an allowed edge.
 * @param reason - human-readable why (lands in history verbatim).
 * @param at - ISO timestamp (injectable for tests).
 * @returns the updated entry.
 * @throws when the edge is illegal — fail loud, never coerce state.
 */
export function applyTransition(
  entry: KbEntry,
  to: KbStatus,
  trigger: TransitionTrigger,
  reason: string,
  at: string = new Date().toISOString(),
): KbEntry {
  if (!canTransition(entry.status, to, trigger)) {
    throw new Error(
      `非法状态迁移: ${entry.status} → ${to} (trigger=${trigger})。合法边: `
      + transitionTable().filter((e) => e.from === entry.status)
        .map((e) => `${e.from}→${e.to}[${e.triggers.join('|')}]`).join(', '),
    )
  }
  const next: KbEntry = {
    ...entry,
    status: to,
    history: [...entry.history, historyEvent(at, 'status', entry.status, to, `${trigger}: ${reason}`)],
    discardedAt: to === 'discarded' ? at : null,
  }
  return next
}

/**
 * Raise the orthogonal needs-review flag (patch #2). Idempotent: re-raising
 * with the same reason is a no-op (no duplicate history spam).
 * @param entry - the entry to flag.
 * @param reason - why review is needed (e.g. which file's hash drifted).
 * @param at - ISO timestamp.
 * @returns the flagged entry (unchanged instance when already flagged identically).
 */
export function raiseNeedsReview(entry: KbEntry, reason: string, at: string = new Date().toISOString()): KbEntry {
  if (entry.needsReview && entry.reviewReason === reason) return entry
  return {
    ...entry,
    needsReview: true,
    reviewReason: reason,
    history: [...entry.history, historyEvent(at, 'needsReview', entry.status, true, reason)],
  }
}

/**
 * Clear the needs-review flag (auto re-verify passed, or human accepted).
 * @param entry - the entry to clear.
 * @param reason - what cleared it.
 * @param at - ISO timestamp.
 * @returns the cleared entry (unchanged when not flagged).
 */
export function clearNeedsReview(entry: KbEntry, reason: string, at: string = new Date().toISOString()): KbEntry {
  if (!entry.needsReview) return entry
  return {
    ...entry,
    needsReview: false,
    reviewReason: null,
    history: [...entry.history, historyEvent(at, 'reviewCleared', entry.status, false, reason)],
  }
}
