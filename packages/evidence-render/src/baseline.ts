/**
 * Baseline store (design doc §4.5, decision #6 REVISED 2026-09-09).
 *
 * Baselines live WITH the workspace (the KB-binding decision applies to
 * verification evidence too: `<projectRoot>/.clue/render-baselines/`, excluded
 * from git by the kb layer's `.clue/` exclude on first store open) — copy the
 * folder, take your evidence. Central-home storage was retired; legacy files
 * migrate via `clue kb migrate`.
 *
 * Lifecycle: first capture saves a PENDING baseline → the human confirms it
 * once (`confirmBaseline`) → later runs compare against the confirmed
 * baseline. If the bound source file's content hash changed, the baseline is
 * flagged stale ("待复核") and comparisons say so — never silently judge new
 * code against an old truth.
 *
 * @module @clue-harness/evidence-render/baseline
 */
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { RENDER_SNAPSHOT_VERSION, type LayoutSnapshot } from './types.ts'
import { parseSnapshotJson, serializeSnapshotJson, stableStringify } from './serialize.ts'
// Path discipline has exactly one home since M2: @clue-harness/util. The
// re-exports below keep this package's public API stable.
import { clueHome, encodeSegment, sha256File } from '@clue-harness/util'

export { clueHome, encodeSegment }

/** Baseline record format version (independent of the snapshot version). */
export const BASELINE_RECORD_VERSION = 1

export interface BaselineRecord {
  version: typeof BASELINE_RECORD_VERSION
  snapshotVersion: typeof RENDER_SNAPSHOT_VERSION
  /** Project-relative page path this baseline belongs to. */
  target: string
  /** Source bindings: project-relative path → sha256 (decision #7: relative). */
  sourceHashes: Record<string, string>
  /** Human confirmed "yes, this is the correct look" — comparisons trust only confirmed baselines. */
  confirmed: boolean
  /** ISO timestamps live HERE, never inside the snapshot (determinism). */
  savedAt: string
  confirmedAt: string | null
  /** The canonical JSON bytes of the snapshot. */
  snapshotJson: string
}

/** Baselines directory for one project (workspace-bound, decision #6 revised). */
export function baselinesDir(projectRoot: string): string {
  return path.join(projectRoot, '.clue', 'render-baselines')
}

/** Baseline file path for one page. */
export function baselinePath(projectRoot: string, pageRel: string): string {
  return path.join(baselinesDir(projectRoot), `${encodeSegment(pageRel)}.json`)
}

/** sha256 of a file's bytes (delegates to the shared util since M2). */
export async function sourceHash(filePath: string): Promise<string> {
  return sha256File(filePath)
}

/**
 * Load a baseline record, refusing foreign record versions.
 * @returns the record, or null when none exists yet.
 */
export async function loadBaseline(projectRoot: string, pageRel: string): Promise<BaselineRecord | null> {
  const file = baselinePath(projectRoot, pageRel)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  const record = JSON.parse(text) as BaselineRecord
  if (record.version !== BASELINE_RECORD_VERSION) {
    throw new Error(`基准记录版本不匹配: 文件 v${String(record.version)}, 当前 v${BASELINE_RECORD_VERSION} — 拒绝读取, 请重新采集`)
  }
  return record
}

/** Save a snapshot as the page's baseline (pending confirmation). */
export async function saveBaseline(
  projectRoot: string,
  snapshot: LayoutSnapshot,
  sourceHashes: Record<string, string>,
): Promise<{ path: string; record: BaselineRecord }> {
  const record: BaselineRecord = {
    version: BASELINE_RECORD_VERSION,
    snapshotVersion: RENDER_SNAPSHOT_VERSION,
    target: snapshot.target,
    sourceHashes,
    confirmed: false,
    savedAt: new Date().toISOString(),
    confirmedAt: null,
    snapshotJson: serializeSnapshotJson(snapshot),
  }
  const file = baselinePath(projectRoot, snapshot.target)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${stableStringify(record)}\n`, 'utf8')
  return { path: file, record }
}

/** Mark the stored baseline as human-confirmed (the one manual act §4.5 requires). */
export async function confirmBaseline(projectRoot: string, pageRel: string): Promise<BaselineRecord> {
  const record = await loadBaseline(projectRoot, pageRel)
  if (record === null) throw new Error(`没有可确认的基准: ${pageRel}(先运行 --record)`)
  record.confirmed = true
  record.confirmedAt = new Date().toISOString()
  const file = baselinePath(projectRoot, pageRel)
  await writeFile(file, `${stableStringify(record)}\n`, 'utf8')
  return record
}

/** True when any bound source file's hash no longer matches the record. */
export function isStale(record: BaselineRecord, currentHashes: Record<string, string>): boolean {
  for (const [file, hash] of Object.entries(record.sourceHashes)) {
    if (currentHashes[file] !== hash) return true
  }
  for (const file of Object.keys(currentHashes)) {
    if (!(file in record.sourceHashes)) return true
  }
  return false
}

/** Parse the snapshot back out of a record (version-checked). */
export function baselineSnapshot(record: BaselineRecord): LayoutSnapshot {
  return parseSnapshotJson(record.snapshotJson)
}
