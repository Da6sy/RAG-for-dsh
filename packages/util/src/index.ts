/**
 * `@clue-harness/util` — zero-dependency internal utilities.
 *
 * Before M2, `clueHome()` and `encodeSegment()` lived inside
 * evidence-render/baseline.ts; the KB needs the exact same path discipline
 * (one home, one injective-ish encoder), so they moved here — a fact gets
 * exactly one home. Not a Cordis plugin (pure library, same rationale as
 * compat, design doc §2.1).
 *
 * @module @clue-harness/util
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'

/**
 * The ClueHarness home directory.
 * `CLUE_HOME` overrides (tests/demos); default `~/.clue`.
 * @returns absolute home path (not created on demand here).
 */
export function clueHome(): string {
  return process.env.CLUE_HOME ?? path.join(homedir(), '.clue')
}

/**
 * The host home the web surface (and any dsh-stack services `clue` boots)
 * uses — ClueHarness's own counterpart of dsh's `~/.dsh`: profiles, the
 * healed module fallback, settings, credentials, storages, sessions.
 * Living under the clue home keeps every ClueHarness byte out of dsh's
 * directory. The clue launchers ASSIGN `DSH_HOME` to this path (never
 * inherit an exported `DSH_HOME` — that would re-share everything);
 * `CLUE_HOST_HOME` is the supported override for tests and deliberate
 * sharing.
 * @returns absolute host path (not created on demand here).
 */
export function clueHostHome(): string {
  return process.env.CLUE_HOST_HOME ?? path.join(clueHome(), 'host')
}

/**
 * Encode an arbitrary path/name into a single filesystem-safe segment
 * (every non-alphanumeric run collapses to '-'). Same scheme dsh uses for
 * session project keys; injective enough for our scale, and collisions are
 * caught by the meta.json anchor check in KbStore.open.
 * @param value - raw path or name.
 * @returns the encoded segment.
 */
export function encodeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '-')
}

/**
 * sha256 hex of a file's bytes — the content-hash used by source bindings
 * (kb) and render baselines alike.
 * @param file - absolute path.
 * @returns lowercase hex digest.
 */
export async function sha256File(file: string): Promise<string> {
  const data = await readFile(file)
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Atomically write JSON (pretty, trailing newline): tmp file + rename, so a
 * crash never leaves a half-written record. Creates parent directories.
 * @param file - absolute target path.
 * @param data - JSON-serializable value.
 */
export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/**
 * Read a JSON file, returning null when absent.
 * @param file - absolute path.
 * @returns parsed value or null.
 * @throws on malformed JSON (a corrupt record must fail loud, not vanish).
 */
export async function readJsonOrNull<T>(file: string): Promise<T | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  return JSON.parse(text) as T
}

/**
 * Append one line to a JSONL ledger (append-only record, lesson 8 discipline).
 * @param file - absolute path (created with parent dirs on first append).
 * @param record - JSON-serializable value; serialized on ONE line.
 */
export async function appendJsonl(file: string, record: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * Read a JSONL ledger, skipping blank lines.
 * @param file - absolute path; a missing file reads as empty.
 * @returns records in file order.
 * @throws on a malformed line (corrupt ledgers fail loud; never silently skip
 *   records — that is how histories get rewritten).
 */
export async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as T)
}
