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
 * Split text into deterministic match tokens (ASCII words ≥2 chars + CJK bigrams).
 * @param text - the text to tokenize.
 * @returns the sorted, de-duplicated tokens.
 */
export function tokenize(text: string): string[] {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()
  for (const match of lower.matchAll(/[a-z0-9_]{2,}/g)) tokens.add(match[0])
  for (const run of lower.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.add(run)
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.add(run.slice(i, i + 2))
  }
  return [...tokens].sort()
}
