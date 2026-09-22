/**
 * BM25F — the ONE implementation of the lexical ranking formula (R1/R2 of
 * `docs/开发记录.md`).
 *
 * Why this file exists at all: the formula was already written, in the wrong
 * layer. `packages/rag`'s reranker had `bm25ish` (IDF + a length norm) as a
 * FEATURE, while the first level — which decides what is even a candidate —
 * scored with a bare sum of field weights (title 3 / tag 2 / text 1, no IDF, no
 * length normalization). The public benchmarks measured the consequence: 32–54%
 * behind textbook BM25 on nDCG@10, and on CoIR cosqa **80% of gold documents
 * never entered the candidate set at all**, where no reranker or fusion change
 * could ever reach them.
 *
 * So the formula moves down here, beside the entries it scores, and the
 * reranker imports it rather than keeping a second copy. The project has been
 * bitten twice by "the same constant written in two places" (`chunkerVersion`
 * in three files; a comment disagreeing with `injectMinEntryChars`), and a
 * second `k1` would be the third.
 *
 * What is deliberately NOT here: no index, no I/O, no state. This module is
 * pure functions over plain data, so both a scan and a future inverted index
 * can call exactly the same arithmetic.
 *
 * @module @clue-harness/kb/bm25
 */
import { tokenize } from './tokenize.ts'

/**
 * The BM25 saturation constant. THE only literal of its kind in the repo
 * (an architecture test pins that).
 */
export const BM25_K1 = 1.2

/** The BM25 length-normalization constant (same single-source rule as {@link BM25_K1}). */
export const BM25_B = 0.75

/** The three weighted fields of an entry (title / tags / body-after-redlines). */
export interface Bm25Fields {
  title: readonly string[]
  tag: readonly string[]
  text: readonly string[]
}

/** Per-field corpus statistics BM25 needs (document frequency + average length). */
export interface LexicalStats {
  /** Documents in the corpus (the IDF denominator). */
  total: number
  /** token → number of documents containing it (any field). */
  df: Map<string, number>
  /** Mean token count per field. */
  avgTitle: number
  avgTag: number
  avgText: number
}

/** One document as the statistics builder sees it. */
export interface StatsDoc {
  title: string
  tags: readonly string[]
  text: string
}

/**
 * Split one entry's text into the three fields BM25F weights separately.
 *
 * The body comes from whatever the caller passes: retrieval passes the text
 * AFTER redlines, so a retracted paragraph cannot move IDF for every other
 * entry (invariant: filter first, score second).
 * @param entry - title/tags plus the already-filtered body.
 * @returns the three token SETS (presence, not term frequency — see {@link bm25fScore}).
 */
export function bm25Fields(entry: { title: string; tags: readonly string[]; text: string }): Bm25Fields {
  return {
    title: [...new Set(tokenize(entry.title))],
    tag: [...new Set(tokenize(entry.tags.join(' ')))],
    text: [...new Set(tokenize(entry.text))],
  }
}

/**
 * Build the corpus statistics (df + per-field average lengths).
 *
 * Built once per retrieval from the SAME redline-filtered text the scoring
 * uses, and never persisted: it is a pure function of the corpus, so a stale
 * copy could only ever be a bug.
 * @param docs - the corpus (both tiers).
 * @returns the statistics.
 */
export function buildLexicalStats(docs: readonly StatsDoc[]): LexicalStats {
  const df = new Map<string, number>()
  let titleSum = 0
  let tagSum = 0
  let textSum = 0
  for (const doc of docs) {
    const fields = bm25Fields(doc)
    titleSum += fields.title.length
    tagSum += fields.tag.length
    textSum += fields.text.length
    for (const token of new Set([...fields.title, ...fields.tag, ...fields.text])) {
      df.set(token, (df.get(token) ?? 0) + 1)
    }
  }
  const total = docs.length
  return {
    total,
    df,
    avgTitle: total === 0 ? 0 : titleSum / total,
    avgTag: total === 0 ? 0 : tagSum / total,
    avgText: total === 0 ? 0 : textSum / total,
  }
}

/**
 * Robertson/Sparck-Jones IDF with the usual +0.5 smoothing.
 *
 * A token absent from the corpus gets the maximum weight rather than an error:
 * a query word nobody wrote is maximally informative, and `ln(1 + (N+0.5)/0.5)`
 * says exactly that.
 * @param token - the query token.
 * @param stats - the corpus statistics.
 * @returns the token's weight.
 */
export function idf(token: string, stats: LexicalStats): number {
  const df = stats.df.get(token) ?? 0
  return Math.log(1 + (stats.total - df + 0.5) / (df + 0.5))
}

/** The per-field weights of the formula (the shipped product intuition: 3 / 2 / 1). */
export interface Bm25FieldWeights {
  title: number
  tag: number
  text: number
}

/** One document's score plus the tokens that earned it. */
export interface Bm25Score {
  score: number
  matched: string[]
}

/**
 * Score one document with BM25F (field-weighted BM25).
 *
 * `score = Σ_t IDF(t) · Σ_f w_f · tf_f · (k1+1) / (tf_f + k1 · (1 − b + b · len_f/avgLen_f))`
 *
 * Term frequency is PRESENCE (`tf_f ∈ {0,1}`): the tokenizer already reduces a
 * field to a token set, the product's queries are short, and a real tf would
 * have to be threaded through both callers and the index at once. The plan
 * allows this explicitly (`tf 目前用存在性即可`); changing it means changing it
 * HERE, once.
 *
 * The length normalization is PER FIELD, which is the point of the F: a long
 * body must not dilute a title hit, and a two-word title must not be penalized
 * for being short.
 *
 * @param fields - the document's three token sets.
 * @param queryTokens - the query's tokens.
 * @param stats - the corpus statistics.
 * @param weights - field weights.
 * @returns the raw BM25 score (unrounded — see {@link rankableScore}) and the matched tokens.
 */
export function bm25fScore(
  fields: Bm25Fields,
  queryTokens: readonly string[],
  stats: LexicalStats,
  weights: Bm25FieldWeights,
): Bm25Score {
  const title = new Set(fields.title)
  const tag = new Set(fields.tag)
  const text = new Set(fields.text)
  const norm = (length: number, average: number): number =>
    1 - BM25_B + BM25_B * (average <= 0 ? 1 : length / average)
  const titleNorm = norm(fields.title.length, stats.avgTitle)
  const tagNorm = norm(fields.tag.length, stats.avgTag)
  const textNorm = norm(fields.text.length, stats.avgText)
  const saturation = (weight: number, normalizedLength: number): number =>
    weight * ((BM25_K1 + 1) / (1 + BM25_K1 * normalizedLength))

  let score = 0
  const matched: string[] = []
  for (const token of queryTokens) {
    let hit = 0
    if (title.has(token)) hit += saturation(weights.title, titleNorm)
    if (tag.has(token)) hit += saturation(weights.tag, tagNorm)
    if (text.has(token)) hit += saturation(weights.text, textNorm)
    if (hit === 0) continue
    score += idf(token, stats) * hit
    matched.push(token)
  }
  return { score, matched }
}

/**
 * The score a caller may ORDER BY.
 *
 * BM25's raw score is continuous; rounding it to two decimals (which the old
 * weight-sum could afford, being a small integer) would manufacture ties and
 * quietly degrade the ranking into "by entryId". So the ordering value stays
 * unrounded, and a rounded value is offered separately for display.
 * @param raw - the raw score.
 * @returns the value to sort by.
 */
export function rankableScore(raw: number): number {
  return raw
}

/**
 * Round a score for DISPLAY only (never for ordering).
 * @param raw - the raw score.
 * @returns the score with two decimals.
 */
export function displayScore(raw: number): number {
  return Math.round(raw * 100) / 100
}
