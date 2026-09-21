/**
 * The chunker (M9-2, proposal §4/§6): the ONLY place where knowledge text is
 * ever sliced. Chunking is an ingestion/indexing concern, never a query-time
 * concern — queryChunks reads what this file produced and nothing else.
 *
 * Zero dependencies on purpose (not even the kb package's types): the record
 * shape is declared here and structurally identical to `ChunkRecord`, so the
 * algorithm stays trivially testable and the dependency arrow keeps pointing
 * kb → (nothing) instead of turning into a cycle.
 *
 * Two strategies, fixed by 拍板 2:
 *
 * - **结构优先** (structure first): markdown headings close a段, and an
 *   over-long section is windowed INSIDE itself. `headingPath` is the
 *   `## A > ### B` chain, which is also what二级 retrieval weights ×2.
 * - **无结构滑窗** (window): 窗口 800 / 步长 600 ⇒ 重叠 200 字符, enough to
 *   keep a sentence from being cut in half while staying far from the ~500
 *   overlap that would manufacture near-duplicate段 and pollute二级检索.
 *   Windowed rows carry `overlapWith`, which queryChunks dedupes on.
 *
 * Anchors are line numbers plus a `quoteAnchor` (the first 40 characters of
 * the段): the snapshot is immutable, so lines never drift, and the quote is
 * what lets a human align摘要↔原文 across document versions (拍板 1).
 *
 * @module @clue-harness/kb/chunker
 */
import {
  DEFAULT_CHUNK_CHARS,
  DEFAULT_CHUNKER_VERSION,
  DEFAULT_QUOTE_ANCHOR_CHARS,
  DEFAULT_WINDOW_STEP,
} from './types.ts'

/** One derived chunk (structurally identical to the kb package's ChunkRecord). */
export interface ChunkDraft {
  seq: number
  headingPath: string
  startLine: number
  endLine: number
  chars: number
  quoteAnchor: string
  overlapWith?: number
  chunkerVersion: string
}

/** The chunker's tunables (the numbers 拍板 2 fixed). */
export interface ChunkerConfig {
  /** Maximum characters of one chunk. Default 800. */
  chunkChars: number
  /** Step between two window starts. Default 600 (⇒ 200 characters of overlap). */
  windowStep: number
  /** Characters of a段 quoted into the anchor (为人和跨版本对齐服务). Default 40. */
  quoteAnchorChars: number
  /** The stamp written into every row; a mismatch triggers a rebuild. */
  version: string
}

/**
 * The shipped configuration: 结构优先段≤800; 无结构滑窗 800/600(重叠200).
 *
 * The numbers and the stamp come from types.ts on purpose: the store compares
 * a ledger's `chunkerVersion` against `config.chunkerVersion`, so a default
 * that drifted from the config's default would make every freshly written
 * ledger look stale — one source of truth, or the self-healing rebuild fights
 * itself.
 */
export const DEFAULT_CHUNKER: ChunkerConfig = {
  chunkChars: DEFAULT_CHUNK_CHARS,
  windowStep: DEFAULT_WINDOW_STEP,
  quoteAnchorChars: DEFAULT_QUOTE_ANCHOR_CHARS,
  version: DEFAULT_CHUNKER_VERSION,
}

/** One markdown heading with its line and level. */
interface HeadingLine {
  line: number
  level: number
  text: string
}

/** ATX headings only (`# … ######`); fences are tracked separately. */
const HEADING = /^(#{1,6})\s+(.*\S)\s*$/

/**
 * Find every markdown heading, skipping fenced code blocks (a `# comment`
 * inside ``` must not open a section).
 * @param lines - the document's lines (no terminators).
 * @returns headings in document order.
 */
export function findHeadings(lines: readonly string[]): HeadingLine[] {
  const found: HeadingLine[] = []
  let fence: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fenceMatch !== null) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const match = HEADING.exec(line)
    if (match !== null) found.push({ line: index + 1, level: match[1].length, text: match[2].trim() })
  }
  return found
}

/**
 * The `A > B` heading chain in effect at one line.
 * @param headings - the document's headings.
 * @param line - 1-based line number.
 * @returns the chain ('' when the line sits before any heading).
 */
export function headingPathAt(headings: readonly HeadingLine[], line: number): string {
  const stack: HeadingLine[] = []
  for (const heading of headings) {
    if (heading.line > line) break
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop()
    stack.push(heading)
  }
  return stack.map((heading) => heading.text).join(' > ')
}

/** The quote anchor of one slice of text (first N non-empty characters). */
export function quoteAnchorOf(text: string, chars: number = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.slice(0, chars)
}

/** The lines consumed by a window that starts at `start` (0-based) and ends at `end`. */
function advance(start: number, end: number, lines: readonly string[], overlap: number): number {
  // Step far enough that the lines carried into the NEXT window are worth
  // exactly `overlap` characters: 步长 = 窗口 − 重叠 (拍板 2: 800 − 200 = 600).
  // Expressing it as "trim the tail down to the overlap" is what keeps the
  // overlap true for variable line lengths — a fixed character step would let
  // a window start past the previous end and silently lose the overlap.
  let moved = 0
  let tail = lines.slice(start, end).reduce((sum, line) => sum + line.length + 1, 0)
  while (start + moved < end && tail > overlap) {
    tail -= lines[start + moved].length + 1
    moved += 1
  }
  return start + Math.max(1, moved)
}

/**
 * Chunk one document (the write-time slicing of proposal §6).
 *
 * Deterministic by construction: same text + same config ⇒ byte-identical
 * rows, which is what makes "delete the ledger, rebuild, compare" a valid
 * acceptance test.
 *
 * @param text - the snapshot's text (any line endings).
 * @param config - the chunker tunables (defaults = 拍板 2's numbers).
 * @returns the chunk drafts in document order, `seq` numbered from 1.
 */
export function chunkDocument(text: string, config: ChunkerConfig = DEFAULT_CHUNKER): ChunkDraft[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  // A trailing newline produces one empty last line; it belongs to no chunk.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return []
  const headings = findHeadings(lines)
  const overlap = Math.max(1, config.chunkChars - config.windowStep)
  const drafts: ChunkDraft[] = []
  let seq = 0

  /** Build one draft from an inclusive 1-based line range. */
  const push = (startLine: number, endLine: number, overlapWith?: number): void => {
    const body = lines.slice(startLine - 1, endLine).join('\n')
    if (body.trim() === '') return
    seq += 1
    drafts.push({
      seq,
      headingPath: headingPathAt(headings, startLine),
      startLine,
      endLine,
      chars: body.length,
      quoteAnchor: quoteAnchorOf(body, config.quoteAnchorChars),
      ...(overlapWith !== undefined ? { overlapWith } : {}),
      chunkerVersion: config.version,
    })
  }

  if (headings.length === 0) {
    // 无结构滑窗: 窗口 chunkChars / 步长 windowStep, tracked in lines.
    let start = 0
    let previousSeq: number | undefined
    while (start < lines.length) {
      let end = start
      let size = 0
      while (end < lines.length && (size === 0 || size + lines[end].length + 1 <= config.chunkChars)) {
        size += lines[end].length + 1
        end += 1
      }
      // `previousSeq` marks a window that starts INSIDE what the previous
      // window already delivered — exactly the duplicate queryChunks dedupes.
      push(start + 1, end, previousSeq)
      previousSeq = seq
      if (end >= lines.length) break
      start = advance(start, end, lines, overlap)
    }
    return drafts
  }

  // 结构优先: a section runs from its heading to the next heading of ANY level
  // (a parent's intro paragraph belongs to the parent, not to its first child),
  // and an over-long run is windowed inside itself.
  const starts = headings.map((heading) => heading.line)
  if (starts[0] > 1) starts.unshift(1) // the preamble before the first heading
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const end = index + 1 < starts.length ? starts[index + 1] - 1 : lines.length
    if (start > end) continue
    let cursor = start
    let previousSeq: number | undefined
    while (cursor <= end) {
      let stop = cursor
      let size = 0
      while (stop <= end && (size === 0 || size + lines[stop - 1].length + 1 <= config.chunkChars)) {
        size += lines[stop - 1].length + 1
        stop += 1
      }
      push(cursor, stop - 1, previousSeq)
      previousSeq = seq
      if (stop > end) break
      cursor = advance(cursor - 1, stop - 1, lines, overlap) + 1
    }
  }
  return drafts
}

/**
 * Whether a chunk ledger produced by `version` is still current.
 * @param rows - the ledger rows (any order).
 * @param version - the store's current chunker stamp.
 * @returns true when the ledger is absent or carries a foreign stamp.
 */
export function needsRebuild(rows: readonly { chunkerVersion?: string }[], version: string): boolean {
  if (rows.length === 0) return true
  return rows.some((row) => row.chunkerVersion !== version)
}
