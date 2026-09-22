/**
 * The retrieval tokenizer — ASCII words + CJK bigrams.
 *
 * Extracted from `query.ts` in R1 of `docs/开发记录.md` so that
 * `bm25.ts` and `query.ts` can both use it WITHOUT importing each other
 * (a cycle between two engine modules would work in ESM only by accident of
 * call timing, which is not a foundation worth building on).
 *
 * Bigrams are the reason this project does not use FTS5's trigram tokenizer: a
 * two-character Chinese query must be able to match something.
 *
 * @module @clue-harness/kb/tokenize
 */

/**
 * Tokenizer options (F4① of `docs/落地计划-剩余工程.md` §2-3).
 *
 * `identifierSubtokens` is one switch that applies to BOTH sides of a match —
 * the index/score side and the query side — because a subtoken that exists only
 * on one side can never match anything. It is not the same knob as the
 * profiles' `splitIdentifiers` (which removes identifiers from the SEMANTIC text
 * before embedding); that one is about what gets embedded, this one is about
 * what gets matched.
 */
export interface TokenizeOptions {
  /** Also emit an identifier's parts (`_process_and_sort` → `process`/`and`/`sort`). */
  identifierSubtokens?: boolean
}

/**
 * The parts of one identifier-like token, for subword matching (F4①).
 *
 * The whole token is NEVER replaced by its parts: code retrieval must still be
 * able to match `_process_and_sort` as one thing (the plan's explicit rule), so
 * callers add these ALONGSIDE the whole token. Boundaries: `_` separators,
 * camelCase/PascalCase, an acronym followed by a word (`HTTPServer` → `HTTP`,
 * `Server`) and letter↔digit transitions (`utf8` → `utf`, `8`… below the floor).
 * @param token - one ASCII-ish token, original case.
 * @returns the parts, lowercased, de-duplicated, WITHOUT the whole token.
 */
export function identifierSubtokens(token: string): string[] {
  const parts = new Set<string>()
  const push = (value: string): void => {
    const lowered = value.toLowerCase()
    if (lowered.length >= 2 && lowered !== token.toLowerCase()) parts.add(lowered)
  }
  for (const chunk of token.split(/_+/)) {
    if (chunk === '') continue
    // camelCase / PascalCase, keeping acronym runs together
    for (const match of chunk.matchAll(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g)) {
      const piece = match[0]
      push(piece)
      // letter ↔ digit transitions inside one piece (`utf8`, `v2point`)
      for (const sub of piece.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/i)) push(sub)
    }
  }
  return [...parts].sort()
}

/**
 * Split text into deterministic match tokens (ASCII words ≥2 chars + CJK bigrams).
 * @param text - the text to tokenize.
 * @param options - F4① subword expansion (off by default = today).
 * @returns the sorted, de-duplicated tokens.
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  return [...tokenizeCounts(text, options).keys()].sort()
}

/**
 * The same tokens, WITH their occurrence counts (R1 of the 落地计划).
 *
 * `tokenize` is now a thin projection of this function, so "which tokens" and
 * "how many times" can never disagree — the inverted index stores the counts
 * (so F4② can switch on real term frequency without a rebuild) while today's
 * scoring keeps asking the presence question.
 * @param text - the text to tokenize.
 * @returns token → occurrence count.
 */
export function tokenizeCounts(text: string, options: TokenizeOptions = {}): Map<string, number> {
  const counts = new Map<string, number>()
  const bump = (token: string): void => {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  const lower = text.toLowerCase()
  // The ASCII loop runs on the ORIGINAL case (camelCase needs it) and stores the
  // lowercased token, which is what the previous `lower.matchAll` produced.
  for (const match of text.matchAll(/[A-Za-z0-9_]{2,}/g)) {
    const raw = match[0]
    bump(raw.toLowerCase())
    if (options.identifierSubtokens !== true) continue
    for (const part of identifierSubtokens(raw)) bump(part)
  }
  for (const run of lower.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) bump(run)
    for (let i = 0; i + 2 <= run.length; i += 1) bump(run.slice(i, i + 2))
  }
  return counts
}
