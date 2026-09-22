/**
 * The worklog — one work unit's record of "what changed, what knowledge was
 * used as basis". In M3a a human (or script) writes it; from M3b the Cordis
 * face generates it automatically from tools/result observations and
 * retrieval-injection records. The shape is the contract between the two.
 *
 * @module @clue-harness/kb-loop/worklog
 */
import { atomicWriteJson, readJsonOrNull } from '@clue-harness/util'

export interface WorkLog {
  createdAt: string
  /** Absolute project root the unit worked in. */
  projectRoot: string
  /** Project-relative paths written/edited during the unit. */
  changedFiles: string[]
  /** KB entry ids actually USED AS BASIS (not merely retrieved — decision #9). */
  referencedEntryIds: string[]
  /**
   * How referencedEntryIds was gathered (M5): 'cited' = the model declared
   * them via kb_cite (precise); 'surfaced' = exposure-set fallback (the M3b
   * approximation). Failure attribution for GLOBAL entries (which carry no
   * project bindings to gate on) trusts ONLY the precise mode. Absent is
   * read as 'surfaced' (older worklogs keep the conservative semantics).
   */
  attributionMode?: 'cited' | 'surfaced'
  /** Page to inspect when renderable changes exist (project-relative). */
  page?: string
  note?: string
}

/**
 * Build a worklog value (createdAt stamped here).
 * @param input - the unit facts.
 * @returns the worklog.
 */
export function buildWorkLog(input: Omit<WorkLog, 'createdAt'> & { createdAt?: string }): WorkLog {
  return { createdAt: input.createdAt ?? new Date().toISOString(), ...input }
}

/** Persist a worklog (atomic JSON). */
export async function saveWorkLog(file: string, log: WorkLog): Promise<void> {
  await atomicWriteJson(file, log)
}

/**
 * Load a worklog, validating the minimum contract.
 * @param file - path to the JSON file.
 * @returns the worklog.
 * @throws on missing file or malformed shape (fail loud, never guess).
 */
export async function loadWorkLog(file: string): Promise<WorkLog> {
  const log = await readJsonOrNull<WorkLog>(file)
  if (log === null) throw new Error(`worklog does not exist: ${file}`)
  if (typeof log.projectRoot !== 'string' || !Array.isArray(log.changedFiles) || !Array.isArray(log.referencedEntryIds)) {
    throw new Error(`worklog malformed (needs projectRoot/changedFiles/referencedEntryIds): ${file}`)
  }
  return log
}
