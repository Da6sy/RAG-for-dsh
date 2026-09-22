/**
 * Redline filtering — "the text" as retrieval and display must see it.
 *
 * Extracted from `query.ts` in R1 so that `lexical-index.ts` (which must index
 * exactly what scoring reads) can use it without importing the query module,
 * which in turn imports the index. Same precedent as `tokenize.ts`: one
 * implementation, two consumers, no cycle.
 *
 * @module @clue-harness/kb/redline
 */
import type { KbEntry, KbRedline } from './types.ts'

/**
 * Whether one character index falls inside any of the entry's `text`-target
 * redlines (M9-4). A redline is a HALF-OPEN [from, to) 1-based character
 * range, so `12-30` removes exactly characters 12…30.
 * @param index - 0-based character index in the entry text.
 * @param redlines - the entry's redlines.
 * @returns true when the character is redlined away.
 */
export function isRedlinedChar(index: number, redlines: readonly KbRedline[]): boolean {
  for (const line of redlines) {
    if (line.target !== 'text' || line.chars === undefined) continue
    const [from, to] = line.chars
    if (index + 1 >= from && index + 1 <= to) return true
  }
  return false
}

/**
 * The entry text as retrieval and display must see it: redlined characters
 * removed, with an honest gap so the remainder still reads (proposal §4/§5a —
 * 划除先把错的段拿掉,再评分;invariant 3: filter first, score second).
 * @param entry - the entry whose text to filter.
 * @returns the text with every redlined range replaced by `[…]`.
 */
export function entryTextAfterRedlines(entry: KbEntry): string {
  const redlines = (entry.redlines ?? []).filter((line) => line.target === 'text' && line.chars !== undefined)
  if (redlines.length === 0) return entry.text
  const ranges = redlines
    .map((line) => line.chars as [number, number])
    .sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = 0 // 0-based exclusive end of what has been kept
  for (const [from, to] of ranges) {
    const start = Math.max(0, from - 1)
    const end = Math.min(entry.text.length, to)
    if (end <= cursor || start >= entry.text.length) continue
    if (start > cursor) out += entry.text.slice(cursor, start)
    out += '[…]'
    cursor = Math.max(cursor, end)
  }
  return out + entry.text.slice(cursor)
}

/**
 * The share of the entry text removed by redlines (0…1). The M9-4 threshold
 * act hangs off this: > {@link REDLINE_PROPOSAL_RATIO} queues a split/discard
 * PROPOSAL (系统提议,人执行 — never an automatic act).
 * @param entry - the entry to measure.
 * @returns the removed fraction of the original text.
 */
export function redlinedRatio(entry: KbEntry): number {
  if (entry.text.length === 0) return 0
  let chars = 0
  for (const line of entry.redlines ?? []) {
    if (line.target !== 'text' || line.chars === undefined) continue
    const [from, to] = line.chars
    chars += Math.max(0, Math.min(entry.text.length, to) - Math.max(0, from - 1))
  }
  return chars / entry.text.length
}
