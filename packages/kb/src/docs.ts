/**
 * The DOCUMENT layer (M9, proposal §3/§6): immutable原文 snapshots, their
 * drift detection, and the derived chunk ledger.
 *
 * Three facts drive every line here:
 *
 * 1. **Evidence is immutable.** `docs/<docId>.md` is written once and never
 *    rewritten. A changed upstream file produces a NEW docId (with
 *    `supersedes`), never an overwrite — invariant 7: history must stay
 *    readable from the snapshot the knowledge was founded on.
 * 2. **Reads go through the snapshot, never the source path.** `sourcePath`
 *    exists for ONE purpose: hashing the live file to detect drift. Reading
 *    the live file would create two truths (the "双真相" this layer removes).
 * 3. **Chunks are pure derivation.** `chunks/<docId>.jsonl` carries no state,
 *    is rebuilt whenever its `chunkerVersion` stamp no longer matches the
 *    store's config, and can be deleted at any time without touching any
 *    Entry's governance data (宪法 2/5).
 *
 * Nothing in this module ever touches an Entry: mounting a doc, redlining it
 * and splitting it are STORE operations, because they are governance. This
 * file is storage and hashing only.
 *
 * @module @clue-harness/kb/docs
 */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { atomicWriteJson, readJsonl, readJsonOrNull, sha256File } from '@clue-harness/util'
import {
  KB_FORMAT_VERSION,
  KbDocId,
  type ChunkRecord,
  type DocRecord,
} from './types.ts'

/** The docId of one snapshot: short, human-greppable, content-derived. */
export function docIdFrom(sourceHash: string): KbDocId {
  return KbDocId(`d-${sourceHash.slice(0, 12)}`)
}

/** `docs/` under one KB tier. */
export function docsDir(kbDir: string): string {
  return path.join(kbDir, 'docs')
}

/** `chunks/` under one KB tier. */
export function chunksDir(kbDir: string): string {
  return path.join(kbDir, 'chunks')
}

/** The snapshot file of one doc. */
export function docSnapshotPath(kbDir: string, docId: KbDocId | string): string {
  return path.join(docsDir(kbDir), `${String(docId)}.md`)
}

/** The meta record file of one doc. */
export function docRecordPath(kbDir: string, docId: KbDocId | string): string {
  return path.join(docsDir(kbDir), `${String(docId)}.meta.json`)
}

/** The chunk ledger of one doc. */
export function docChunksPath(kbDir: string, docId: KbDocId | string): string {
  return path.join(chunksDir(kbDir), `${String(docId)}.jsonl`)
}

/**
 * Read one doc's meta record.
 * @param kbDir - the KB tier directory.
 * @param docId - the snapshot id.
 * @returns the record, or null when absent.
 */
export async function readDocRecord(kbDir: string, docId: KbDocId | string): Promise<DocRecord | null> {
  return readJsonOrNull<DocRecord>(docRecordPath(kbDir, docId))
}

/**
 * Read one doc's immutable text. This is THE read path — the source file is
 * never consulted for content (see the module doc).
 * @param kbDir - the KB tier directory.
 * @param docId - the snapshot id.
 * @returns the snapshot text, or null when the snapshot is gone.
 */
export async function readDocText(kbDir: string, docId: KbDocId | string): Promise<string | null> {
  try {
    return await readFile(docSnapshotPath(kbDir, docId), 'utf8')
  } catch {
    return null
  }
}

/**
 * Read one doc's derived chunk ledger (empty when never built / deleted).
 * @param kbDir - the KB tier directory.
 * @param docId - the snapshot id.
 * @returns the chunk rows in file order.
 */
export async function readChunks(kbDir: string, docId: KbDocId | string): Promise<ChunkRecord[]> {
  return readJsonl<ChunkRecord>(docChunksPath(kbDir, docId))
}

/**
 * Replace one doc's chunk ledger (the derivation is written whole, never
 * appended — a rebuild must not stack rows).
 * @param kbDir - the KB tier directory.
 * @param docId - the snapshot id.
 * @param chunks - the freshly derived rows.
 */
export async function writeChunks(kbDir: string, docId: KbDocId | string, chunks: readonly ChunkRecord[]): Promise<void> {
  const file = docChunksPath(kbDir, docId)
  await mkdir(path.dirname(file), { recursive: true })
  const body = chunks.length === 0 ? '' : `${chunks.map((chunk) => JSON.stringify(chunk)).join('\n')}\n`
  await writeFile(file, body, 'utf8')
}

/** Delete one doc's derived chunk ledger (the "chunk 删除后可重建" path). */
export async function removeChunks(kbDir: string, docId: KbDocId | string): Promise<void> {
  await rm(docChunksPath(kbDir, docId), { force: true })
}

/** Every doc id known to one tier (directory listing, sorted). */
export async function listDocIds(kbDir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(docsDir(kbDir))
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.meta.json'))
    .map((name) => name.slice(0, -'.meta.json'.length))
    .sort()
}

/**
 * Every doc record of one tier, newest first (deterministic: ingestedAt desc,
 * then docId) — the `clue kb doc list` and panel order.
 * @param kbDir - the KB tier directory.
 * @returns the records (unreadable ones are skipped, never invented).
 */
export async function listDocs(kbDir: string): Promise<DocRecord[]> {
  const records: DocRecord[] = []
  for (const docId of await listDocIds(kbDir)) {
    const record = await readDocRecord(kbDir, docId)
    if (record !== null) records.push(record)
  }
  return records.sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt) || a.docId.localeCompare(b.docId))
}

export interface IngestSnapshotInput {
  /** The KB tier directory (`KbStore.dir`). */
  kbDir: string
  /** Project-relative path the text came from (drift detection anchor). */
  sourcePath: string
  /** The EXTRACTED text to snapshot (HTML already normalized to markdown-ish). */
  text: string
  /** Absolute path of the source file to hash (default: resolve sourcePath under projectRoot). */
  sourceFile?: string
  /** Injectable clock (tests). */
  at?: string
}

/** What one ingest produced (the CLI prints this verbatim). */
export interface IngestResult {
  record: DocRecord
  /** True when this content was already snapshotted (no new docId created). */
  reused: boolean
  /** The line count of the (possibly reused) snapshot. */
  lineCount: number
}

/**
 * Snapshot one document AFTER its text has been extracted. Writing is
 * content-addressed: the same bytes never produce a second docId, so
 * re-ingesting an unchanged file is a no-op rather than a duplicate.
 *
 * The docId derives from the SOURCE file's hash, not the extracted text: when
 * the source changes at all (even whitespace the extractor would swallow) the
 * next ingest produces a new docId and links it with `supersedes`, which is
 * exactly the "new version, old redlines stay on the old doc" rule (§4).
 * @param input - the extraction result and its anchors.
 * @returns the record, whether it was reused, and the line count.
 * @throws when the source file cannot be hashed (fail loud: no hash, no evidence).
 */
export async function ingestSnapshot(input: IngestSnapshotInput): Promise<IngestResult> {
  const at = input.at ?? new Date().toISOString()
  // The caller hands over the absolute file to hash; a bare sourcePath resolves
  // against cwd, which is the project root for every CLI call site.
  const sourceFile = input.sourceFile ?? path.resolve(input.sourcePath)
  const sourceHash = await sha256File(sourceFile)
  const docId = docIdFrom(sourceHash)
  const existing = await readDocRecord(input.kbDir, docId)
  const text = input.text.endsWith('\n') ? input.text : `${input.text}\n`
  const lineCount = text.split('\n').length - 1
  if (existing !== null) {
    // Same source bytes ⇒ same snapshot. Refresh nothing: an immutable record
    // is not "updated", it is either there or it is not.
    return { record: existing, reused: true, lineCount: existing.lineCount }
  }
  const previous = await latestDocIdFor(input.kbDir, input.sourcePath)
  const record: DocRecord = {
    version: KB_FORMAT_VERSION,
    docId,
    sourcePath: normalizeSourcePath(input.sourcePath),
    contentHash: sha256FromString(text),
    sourceHash,
    sizeChars: text.length,
    lineCount,
    ingestedAt: at,
    ...(previous !== null && previous !== docId ? { supersedes: previous } : {}),
  }
  await mkdir(docsDir(input.kbDir), { recursive: true })
  await writeFile(docSnapshotPath(input.kbDir, docId), text, 'utf8')
  await atomicWriteJson(docRecordPath(input.kbDir, docId), record)
  return { record, reused: false, lineCount }
}

/**
 * The most recent snapshot of one source path (the `supersedes` link's source).
 * @param kbDir - the KB tier directory.
 * @param sourcePath - the project-relative source path.
 * @returns the newest docId for that path, or null.
 */
export async function latestDocIdFor(kbDir: string, sourcePath: string): Promise<KbDocId | null> {
  const normalized = sourcePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const matches = (await listDocs(kbDir)).filter((record) => record.sourcePath === normalized)
  return matches.length === 0 ? null : matches[0].docId
}

/** sha256 hex of a string (the snapshot's own immutability stamp). */
export function sha256FromString(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** One drift finding for a mounted doc (the checkDocs observable). */
export interface DocDrift {
  docId: KbDocId
  sourcePath: string
  /** 'changed' | 'missing' — both mean "the snapshot no longer matches现场". */
  kind: 'changed' | 'missing'
  /** First 8 chars of the hash recorded at ingest time. */
  recordedHash: string
}

/**
 * Compare one doc's source file against the recorded hash (M9-1/§4 漂移质疑).
 * The live file is READ but never adopted: drift raises a review flag on the
 * entries mounted on this doc; it never rewrites the snapshot.
 * @param record - the doc record.
 * @param resolve - maps a project-relative source path to an absolute path.
 * @returns the drift, or null when the live file still matches.
 */
export async function detectDrift(
  record: DocRecord,
  resolve: (relative: string) => string,
): Promise<DocDrift | null> {
  let current: string
  try {
    current = await sha256File(resolve(record.sourcePath))
  } catch {
    return { docId: record.docId, sourcePath: record.sourcePath, kind: 'missing', recordedHash: record.sourceHash.slice(0, 8) }
  }
  if (current === record.sourceHash) return null
  return { docId: record.docId, sourcePath: record.sourcePath, kind: 'changed', recordedHash: record.sourceHash.slice(0, 8) }
}

/** Whether a doc snapshot exists on disk (used by attach/panel honesty checks). */
export async function docExists(kbDir: string, docId: KbDocId | string): Promise<boolean> {
  return (await stat(docSnapshotPath(kbDir, docId)).catch(() => null)) !== null
}

/**
 * Normalize a project-relative source path for storage and comparison (the
 * same discipline bindings use: posix separators, no leading slash). Exported
 * so the CLI and the store agree on ONE spelling.
 * @param value - the raw path.
 * @returns the normalized comparison form.
 */
export function normalizeSourcePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}
