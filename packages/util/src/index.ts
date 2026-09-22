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
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'

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
 * The canonical form of a workspace root: its realpath when the directory
 * exists, else the absolute given path. Every central path below funnels
 * through this, so the KB, the baselines and the registry can never disagree
 * about WHICH root a key names.
 * @param projectRoot - any path spelling of the workspace.
 * @returns the canonical absolute root.
 */
export function canonicalRoot(projectRoot: string): string {
  try {
    return realpathSync(projectRoot)
  } catch {
    return path.resolve(projectRoot)
  }
}

/**
 * The central key of one workspace (M9: 集中式存储,一工作区一本库).
 * Base form is `encodeSegment(canonicalRoot)` — human-browsable in the file
 * manager — and a directory already anchored to a DIFFERENT root pushes the
 * next candidate to `<base>-2`, `-3`, … (the M2-era anchor walk, revived
 * because the storage is central again and two same-name projects must not
 * share one ledger).
 * @param projectRoot - any path spelling of the workspace.
 * @param home - ClueHarness home override (default {@link clueHome}).
 * @returns the key that this root owns (or may create).
 * @throws when a candidate directory exists without a readable anchor — a
 *   hand-made directory must not be adopted silently (fail loud).
 */
export async function workspaceKey(projectRoot: string, home: string = clueHome()): Promise<string> {
  const root = canonicalRoot(projectRoot)
  const base = encodeSegment(root)
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const key = attempt === 1 ? base : `${base}-${String(attempt)}`
    const dir = path.join(home, 'kb', key)
    const metaFile = path.join(dir, 'meta.json')
    const meta = await readJsonOrNull<{ projectRoot?: unknown }>(metaFile)
    if (meta === null) {
      if ((await stat(dir).catch(() => null)) === null) return key
      if ((await readdir(dir).catch(() => ['?'])).length === 0) return key
      throw new Error(`workspace directory exists but has no readable anchor: ${metaFile} — fix it before opening (never take over foreign data silently)`)
    }
    if (meta.projectRoot === root) return key
  }
  throw new Error(`workspace key still collides after 1000 probes: ${root}`)
}

/**
 * The central project-tier KB directory of one workspace: `<home>/kb/<key>`.
 * @param projectRoot - any path spelling of the workspace.
 * @param home - ClueHarness home override.
 * @returns absolute directory path (not created here).
 */
export async function workspaceKbDir(projectRoot: string, home: string = clueHome()): Promise<string> {
  return path.join(home, 'kb', await workspaceKey(projectRoot, home))
}

/**
 * The central render-baseline directory of one workspace: `<home>/baselines/<key>`.
 * Same key as the KB, so one workspace's evidence and its knowledge sit side
 * by side in the home (nothing of clue's is written inside the workspace).
 * @param projectRoot - any path spelling of the workspace.
 * @param home - ClueHarness home override.
 * @returns absolute directory path (not created here).
 */
export async function workspaceBaselinesDir(projectRoot: string, home: string = clueHome()): Promise<string> {
  return path.join(home, 'baselines', await workspaceKey(projectRoot, home))
}

/**
 * Where session logs live for every ClueHarness surface (M9: `./.sessions` and
 * `./.clue-sessions` inside the workspace are retired).
 * @param surface - which launcher owns the log.
 * @param home - ClueHarness home override.
 * @returns an absolute directory path.
 */
export function clueSessionsDir(surface: 'cli' | 'web' = 'cli', home: string = clueHome()): string {
  return path.join(home, 'sessions', surface)
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
