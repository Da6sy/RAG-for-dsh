/**
 * The injected-line discipline (M9-0, proposal §4 G4) — ONE implementation of
 * the shape the pre-step `kb_context` block and the gate `kb_assist` block both
 * render, so the two faces can never drift apart.
 *
 * The rule the 配额制 encodes is "保广度弃深度", and it is TWO separate tests:
 *
 * 1. **Quota (per-entry cap)**: an entry's body is trimmed to `perEntryChars`.
 *    The tail is what kb_detail is for; the line that remains is complete
 *    enough to decide whether drilling down is worth it.
 * 2. **Fit (block budget)**: the line must fit in what is LEFT of the block
 *    with at least `minChars` of prose to spare. An entry that cannot get that
 *    much room YIELDS ENTIRELY and the next hit tries — that is what stops a
 *    1800-character hit from monopolizing the block and pushing the remaining
 *    hits out (债#5 预算治理).
 *
 * Identity is never trimmed: `[id|flags|kind] title` survives any quota, since
 * an unattributable line cannot be cited — and citation identity is the whole
 * point of injecting knowledge into a model's context.
 *
 * @module @clue-harness/kb/render
 */
import type { QueryHit } from './query.ts'

/** The shipped per-entry quota: ≤400 characters of body per injected line. */
export const DEFAULT_INJECT_PER_ENTRY_CHARS = 400

/**
 * The shipped fit floor: an entry needs at least this much room in the block
 * to keep its line. Deliberately 0 — the floor is a DEPLOYMENT knob (a demo
 * with a tiny budget raises it to keep the block legible), because a non-zero
 * default would silently drop short entries from a block with plenty of room,
 * and "the knowledge was retrieved but not shown" is indistinguishable from
 * "the knowledge does not exist" to the model reading it.
 */
export const DEFAULT_INJECT_MIN_ENTRY_CHARS = 0

/**
 * The document fact of one hit as an annotation (M9-1/§4 一级): "含原文 N 段,
 * 细节用 kb_detail 下钻". Entries without a doc add NOTHING — their pre-M9
 * output stays byte-identical.
 * @param hit - one retrieval hit.
 * @returns the annotation, or null when the entry carries no document.
 */
export function docAnnotation(hit: QueryHit): string | null {
  if (hit.entry.doc === undefined) return null
  const count = hit.docHeadingCount ?? 0
  return count > 0
    ? `含原文 ${count} 段,细节用 kb_detail 下钻`
    : `含原文快照,细节用 kb_detail 下钻`
}

/**
 * Render one injected line, or null when the entry yields its place.
 * @param hit - the ranked, annotated hit.
 * @param perEntryChars - per-entry body quota (0 = unlimited).
 * @param minChars - the prose floor the line must reach inside the block.
 * @param remainingChars - what is left of the block's budget (Infinity = fresh).
 * @returns the line text, or null when the entry yields.
 */
export function renderHitLine(
  hit: QueryHit,
  perEntryChars: number,
  minChars: number,
  remainingChars = Number.POSITIVE_INFINITY,
): string | null {
  const flags = [hit.entry.status, hit.entry.needsReview ? '⚠待复核' : ''].filter((f) => f !== '').join('|')
  let text = hit.entry.text.replace(/\s+/g, ' ')
  if (perEntryChars > 0 && text.length > perEntryChars) text = `${text.slice(0, perEntryChars - 1)}…`
  const head = `- [${hit.entry.id}|${flags}|${hit.entry.kind}] ${hit.entry.title}: `
  let line = `${head}${text}`
  for (const annotation of hit.annotations) line += ` (${annotation})`
  const docNote = docAnnotation(hit)
  if (docNote !== null) line += ` (${docNote})`
  // The fit test measures the PROSE (head + body), not the mandatory metadata:
  // a long id or a pile of annotations must not cost the block its breadth,
  // and must not drop an otherwise useful line either. `minChars` of 0 (the
  // default) turns the test off and leaves only the block's own budget.
  const prose = `${head}${text}`.length
  const needsTrim = line.length > remainingChars
  if (minChars > 0) {
    // With a floor set, an entry either gets `minChars` of prose or nothing at
    // all: a trimmed line here would be a stub, and 保广度弃深度 says the next
    // entry is the better use of the room.
    const roomFor = needsTrim ? Math.max(0, remainingChars - head.length) : prose
    if (prose < minChars || roomFor < minChars) return null
  }
  // A line that does not fit the REMAINING block is trimmed (the legacy
  // behavior when no floor is configured): the entry keeps its identity and
  // yields the tail.
  if (needsTrim) {
    if (remainingChars < 60) return null
    line = `${line.slice(0, Math.max(0, remainingChars - 1))}…`
  }
  return line
}
