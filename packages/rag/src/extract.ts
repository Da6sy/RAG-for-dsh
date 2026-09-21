/**
 * Source-text extraction (M9-3, proposal §6): what `clue kb ingest` snapshots.
 *
 * Two formats, deliberately simple and deterministic:
 *
 * - **markdown / plain text** is snapshotted as-is — the chunker's structure
 *   detection already understands ATX headings, so re-writing the text would
 *   only introduce a second truth about the document.
 * - **HTML** is reduced to markdown-ish text: heading tags become ATX headings
 *   (so `headingPath` anchors exist for html docs too), block-level tags and
 *   `<br>` become line breaks, lists become `- ` items, tables keep their cell
 *   text with column separators, and `script`/`style`/comments are dropped.
 *
 * No DOM, no dependency: a regex reducer is enough for the documents this
 * channel accepts (规范/说明/README 类), and it keeps the engine testable
 * without a browser. Anything it cannot parse degrades to text, never to a
 * thrown error — an unreadable document is a user problem, not a crash.
 *
 * @module @clue-harness/rag/extract
 */

/** The formats the ingest channel understands. */
export type SourceFormat = 'markdown' | 'html'

/** One extraction result. */
export interface ExtractedText {
  format: SourceFormat
  /** The text to snapshot (markdown-ish in both cases). */
  text: string
  /** Human-facing note about anything worth knowing (e.g. dropped elements). */
  notes: string[]
}

/**
 * Guess the format from a path.
 * @param file - the source path (any spelling).
 * @returns 'html' for .html/.htm, else 'markdown' (plain text is markdown enough).
 */
export function formatOf(file: string): SourceFormat {
  return /\.html?$/i.test(file.trim()) ? 'html' : 'markdown'
}

const BLOCK = /<\/?(?:p|div|section|article|header|footer|main|aside|nav|tr|table|thead|tbody|blockquote|figure|figcaption|pre|ul|ol|dl|dt|dd|form|fieldset|h[1-6]|li|br|hr)\b[^>]*>/gi

/**
 * Reduce one HTML document to markdown-ish text.
 * @param html - the raw document.
 * @returns the extracted text (never throws).
 */
export function htmlToMarkdown(html: string): { text: string; dropped: number } {
  let dropped = 0
  let out = html
  // Non-content elements go first, WITH their bodies.
  out = out.replace(/<!--[\s\S]*?-->/g, '')
  out = out.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, () => {
    dropped += 1
    return ''
  })
  // Headings → ATX (the anchor vocabulary of the chunker).
  for (let level = 1; level <= 6; level += 1) {
    const open = new RegExp(`<h${level}\\b[^>]*>`, 'gi')
    const close = new RegExp(`</h${level}\\s*>`, 'gi')
    out = out.replace(open, `\n\n${'#'.repeat(level)} `).replace(close, '\n')
  }
  // Lists keep their item boundaries.
  out = out.replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/li\s*>/gi, '')
  // Table cells get a separator so rows stay readable.
  out = out.replace(/<\/(?:td|th)\s*>/gi, ' | ')
  // Every other tag: a line break for block tags, nothing for inline ones.
  out = out.replace(BLOCK, '\n')
  out = out.replace(/<[^>]+>/g, '')
  // Entities: the handful that actually appear in specs.
  out = out
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
  // Collapse the whitespace the replacements produced, keeping paragraph gaps.
  const lines = out.split('\n').map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
  const text: string[] = []
  for (const line of lines) {
    if (line === '' && (text.length === 0 || text[text.length - 1] === '')) continue
    text.push(line)
  }
  while (text.length > 0 && text[text.length - 1] === '') text.pop()
  return { text: text.join('\n'), dropped }
}

/**
 * Extract the snapshot text of one source file.
 * @param content - the raw file content.
 * @param format - the source format.
 * @returns the text plus notes for the preview.
 */
export function extractText(content: string, format: SourceFormat): ExtractedText {
  const normalized = content.replace(/\r\n?/g, '\n')
  if (format !== 'html') return { format, text: normalized, notes: [] }
  const { text, dropped } = htmlToMarkdown(normalized)
  const notes: string[] = []
  if (dropped > 0) notes.push(`已丢弃 ${dropped} 个非正文元素(script/style/svg 等)`)
  if (!/^#{1,6}\s/m.test(text)) notes.push('未识别到标题标签,分片将走滑窗(800/600)')
  return { format, text, notes }
}
