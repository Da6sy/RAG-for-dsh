/**
 * Baseline store (design doc §4.5, decision #6 RE-Revised in M9).
 *
 * Baselines live in the CENTRAL home, under the same workspace key as the
 * knowledge base — `<home>/baselines/<workspace-key>/` — because ClueHarness
 * keeps no state inside a workspace directory any more (the M8 experiment of
 * `<projectRoot>/.clue/render-baselines/` is retired along with the git
 * bookkeeping it required; `clue kb migrate` imports it). Evidence and
 * knowledge for one workspace therefore sit side by side in the home, and the
 * page key inside the directory stays project-RELATIVE (decision #7), so a
 * moved workspace re-derives the same layout.
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
import { clueHome, encodeSegment, sha256File, workspaceBaselinesDir } from '@clue-harness/util'

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

/**
 * The central baselines directory of one workspace (`<home>/baselines/<key>`).
 * @param projectRoot - any path spelling of the workspace.
 * @param home - ClueHarness home override (tests/demos).
 * @returns absolute directory path (not created here).
 */
export function baselinesDir(projectRoot: string, home: string = clueHome()): Promise<string> {
  return workspaceBaselinesDir(projectRoot, home)
}

/**
 * Baseline file path for one page.
 * @param projectRoot - any path spelling of the workspace.
 * @param pageRel - project-relative page path (the record's `target`).
 * @param home - ClueHarness home override.
 * @returns the absolute JSON path the record lives (or would live) at.
 */
export async function baselinePath(projectRoot: string, pageRel: string, home?: string): Promise<string> {
  return path.join(await baselinesDir(projectRoot, home), `${encodeSegment(pageRel)}.json`)
}

/** sha256 of a file's bytes (delegates to the shared util since M2). */
export async function sourceHash(filePath: string): Promise<string> {
  return sha256File(filePath)
}

/**
 * Load a baseline record, refusing foreign record versions.
 * @param projectRoot - any path spelling of the workspace.
 * @param pageRel - project-relative page path.
 * @param home - ClueHarness home override.
 * @returns the record, or null when none exists yet.
 */
export async function loadBaseline(projectRoot: string, pageRel: string, home?: string): Promise<BaselineRecord | null> {
  const file = await baselinePath(projectRoot, pageRel, home)
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
  home?: string,
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
  const file = await baselinePath(projectRoot, snapshot.target, home)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${stableStringify(record)}\n`, 'utf8')
  return { path: file, record }
}

/** Mark the stored baseline as human-confirmed (the one manual act §4.5 requires). */
export async function confirmBaseline(projectRoot: string, pageRel: string, home?: string): Promise<BaselineRecord> {
  const record = await loadBaseline(projectRoot, pageRel, home)
  if (record === null) throw new Error(`没有可确认的基准: ${pageRel}(先运行 --record)`)
  record.confirmed = true
  record.confirmedAt = new Date().toISOString()
  const file = await baselinePath(projectRoot, pageRel, home)
  await writeFile(file, `${stableStringify(record)}\n`, 'utf8')
  return record
}

/**
 * The LOCAL files a page pulls in: stylesheets and scripts.
 *
 * §9 of `docs/落地计划-剩余工程.md` found the gap: the collector hashed only the
 * page itself, while `BaselineRecord.sourceHashes` and {@link isStale} were built
 * for many files — so editing an external CSS or JS file left the baseline
 * "fresh" and the comparison silently judged the new code against an old
 * baseline. Remote URLs are skipped on purpose: they are not files this project
 * can hash, and pretending to bind them would be a check that cannot fail.
 * @param html - the page's markup.
 * @returns project-root-relative-ish hrefs/srcs, de-duplicated and sorted.
 */
export function externalAssetsOf(html: string): string[] {
  const out = new Set<string>()
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const text = tag[0]
    if (!/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(text)) continue
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(text)?.[1]
    if (href !== undefined) out.add(href.trim())
  }
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1]
    if (src !== undefined) out.add(src.trim())
  }
  return [...out]
    .filter((value) => value !== '' && !/^[a-z]+:\/\//i.test(value) && !value.startsWith('//') && !value.startsWith('data:'))
    .sort()
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
