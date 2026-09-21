/**
 * The ingest channel (M9-3, proposal §6): `clue kb ingest <file>`.
 *
 * The pipeline is deliberately boring and fully inspectable — it is the ONE
 * moment where knowledge text is sliced, and a human is meant to read the
 * preview before anything is mounted:
 *
 *   read source → extract text → sha256 → snapshot (immutable) → chunk →
 *   write the derived ledger → preview (heading path + quoteAnchor + chars)
 *
 * What it does NOT do (非目标): generate entries. Ingestion produces EVIDENCE;
 * mounting it on a knowledge entry is a human/model proposal that lands as a
 * candidate and needs approval like any other (`kb doc attach`). Automatic
 * summary drafting is a separate proposal (M10 ingest-copilot, 拍板 4) —
 * keeping it out is what preserves "预览质量" as an independent acceptance line.
 *
 * `--dry-run` stops before the first byte is written.
 *
 * @module @clue-harness/rag/ingest
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  chunkDocument,
  ingestSnapshot,
  normalizeSourcePath,
  type ChunkerConfig,
  type DocRecord,
  type KbStore,
} from '@clue-harness/kb'
import { extractText, formatOf, type SourceFormat } from './extract.ts'

/** One chunk of the preview (what a human reads before attaching). */
export interface IngestPreviewChunk {
  seq: number
  headingPath: string
  lines: { start: number; end: number }
  chars: number
  quoteAnchor: string
  overlapWith?: number
}

/** The ingest outcome — the CLI prints this verbatim (it is the user's evidence). */
export interface IngestReport {
  sourcePath: string
  format: SourceFormat
  bytes: number
  chars: number
  lineCount: number
  chunkerVersion: string
  chunks: IngestPreviewChunk[]
  notes: string[]
  /** Absent in dry-run (nothing was written). */
  doc?: DocRecord
  /** True when the same source bytes were already snapshotted. */
  reused: boolean
  dryRun: boolean
}

export interface IngestOptions {
  /** The KB tier store the snapshot lands in. */
  store: KbStore
  /** Absolute path of the file to ingest. */
  file: string
  /** Project-relative path to record as `sourcePath` (drift detection anchor). */
  sourcePath?: string
  /** Report only: read, extract and preview WITHOUT writing anything. */
  dryRun?: boolean
  /** Chunker overrides (tests); the store's stamp always wins the version. */
  chunker?: Partial<ChunkerConfig>
  /** Injectable clock (tests). */
  at?: string
}

/**
 * Run the ingest pipeline for one file.
 * @param options - store, file, dry-run and chunker knobs.
 * @returns the report (preview chunks always; the doc only when written).
 * @throws when the file cannot be read (fail loud — no silent empty snapshot).
 */
export async function ingestFile(options: IngestOptions): Promise<IngestReport> {
  const { store, file } = options
  const raw = await readFile(file, 'utf8')
  const format = formatOf(file)
  const extracted = extractText(raw, format)
  // ONE line-count rule for the whole channel: the preview, the snapshot's
  // record and the chunk ledger must agree, or a rebuilt ledger would differ
  // from the ingested one (a trailing newline terminates the last line; it is
  // not an extra empty line).
  const snapText = extracted.text.endsWith('\n') ? extracted.text : `${extracted.text}\n`
  const relSource = normalizeSourcePath(options.sourcePath ?? defaultSourcePath(store, file))
  const chunker: ChunkerConfig = {
    chunkChars: options.chunker?.chunkChars ?? 800,
    windowStep: options.chunker?.windowStep ?? 600,
    quoteAnchorChars: options.chunker?.quoteAnchorChars ?? 40,
    version: store.config.chunkerVersion,
  }
  const drafts = chunkDocument(snapText, chunker)
  const base: Omit<IngestReport, 'doc' | 'reused'> = {
    sourcePath: relSource,
    format,
    bytes: Buffer.byteLength(raw, 'utf8'),
    chars: extracted.text.length,
    lineCount: snapText.split('\n').length - 1,
    chunkerVersion: chunker.version,
    chunks: drafts.map((draft) => ({
      seq: draft.seq,
      headingPath: draft.headingPath,
      lines: { start: draft.startLine, end: draft.endLine },
      chars: draft.chars,
      quoteAnchor: draft.quoteAnchor,
      ...(draft.overlapWith !== undefined ? { overlapWith: draft.overlapWith } : {}),
    })),
    notes: extracted.notes,
    dryRun: options.dryRun === true,
  }
  if (options.dryRun === true) return { ...base, reused: false }

  const snapshot = await ingestSnapshot({
    kbDir: store.dir,
    sourcePath: relSource,
    text: snapText,
    ...(path.isAbsolute(file) ? { sourceFile: file } : {}),
    ...(options.at !== undefined ? { at: options.at } : {}),
  })
  // The derived ledger is always (re)written: it is a pure function of the
  // snapshot + the chunker stamp, so rewriting it is idempotent by definition
  // and it repairs a ledger that was deleted or produced by an older chunker.
  await store.saveChunks(snapshot.record.docId, drafts)
  return { ...base, doc: snapshot.record, reused: snapshot.reused }
}

/**
 * The project-relative source path of a file (what `DocRecord.sourcePath`
 * records and `checkDocs` re-hashes). Outside the project root the absolute
 * path is kept — an honest "this evidence lives outside the workspace" rather
 * than a path that resolves somewhere else.
 * @param store - the tier store (its `projectRoot` is the anchor).
 * @param file - the absolute file path.
 * @returns the path to record.
 */
export function defaultSourcePath(store: KbStore, file: string): string {
  if (store.projectRoot === null) return path.basename(file)
  const relative = path.relative(store.projectRoot, path.resolve(file))
  return relative.startsWith('..') ? path.resolve(file) : relative
}
