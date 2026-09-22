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
import { tokenizeCounts, type TokenizeOptions } from './tokenize.ts'

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

/**
 * The three fields WITH their occurrence counts (F4② of `docs/落地计划-剩余工程.md`).
 *
 * `Bm25Fields` (token arrays) stays the plain form callers already speak; this is
 * what the scorer actually consumes, because a real term frequency needs counts
 * and the same tokenizer now produces them for free.
 */
export interface Bm25CountFields {
  title: ReadonlyMap<string, number>
  tag: ReadonlyMap<string, number>
  text: ReadonlyMap<string, number>
}

/**
 * How a field's term frequency is read (F4②: ONE switch for tf AND the length
 * basis — the plan measured them as a single variable, since switching to counts
 * while still dividing by the distinct-token length mixes two conventions).
 */
export type TermFrequency = 'presence' | 'count'

/** Sum of a field's occurrence counts (the "total tokens" length notion). */
export function totalCount(counts: ReadonlyMap<string, number>): number {
  let sum = 0
  for (const value of counts.values()) sum += value
  return sum
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
export function bm25Fields(
  entry: { title: string; tags: readonly string[]; text: string },
  options: TokenizeOptions = {},
): Bm25Fields {
  return {
    title: [...tokenizeCounts(entry.title, options).keys()],
    tag: [...tokenizeCounts(entry.tags.join(' '), options).keys()],
    text: [...tokenizeCounts(entry.text, options).keys()],
  }
}

/**
 * The same fields, with counts (F4②'s input).
 * @param entry - title/tags plus the already-redline-filtered body.
 * @returns one token → count map per field.
 */
export function bm25CountFields(
  entry: { title: string; tags: readonly string[]; text: string },
  options: TokenizeOptions = {},
): Bm25CountFields {
  return {
    title: tokenizeCounts(entry.title, options),
    tag: tokenizeCounts(entry.tags.join(' '), options),
    text: tokenizeCounts(entry.text, options),
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
export function buildLexicalStats(
  docs: readonly StatsDoc[],
  termFrequency: TermFrequency = 'presence',
  tokenizeOptions: TokenizeOptions = {},
): LexicalStats {
  const df = new Map<string, number>()
  let titleSum = 0
  let tagSum = 0
  let textSum = 0
  for (const doc of docs) {
    const fields = bm25CountFields(doc, tokenizeOptions)
    // The averages must use the SAME length notion the scorer divides by —
    // otherwise the length norm compares a distinct-token length against a
    // total-token average (the plan's "长度口径要一起定").
    const lengthOf = (counts: ReadonlyMap<string, number>): number =>
      termFrequency === 'count' ? totalCount(counts) : counts.size
    titleSum += lengthOf(fields.title)
    tagSum += lengthOf(fields.tag)
    textSum += lengthOf(fields.text)
    for (const token of new Set([...fields.title.keys(), ...fields.tag.keys(), ...fields.text.keys()])) {
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
 * A document's fields as an INDEX already knows them (落地计划 §2-1).
 *
 * Why this exists: with an inverted index, the query path must not tokenize a
 * document to score it — the postings already say which query tokens occur in
 * which field, and the meta table already carries the field lengths. Passing
 * those in lets the SAME arithmetic serve both a scan and a lookup; a second
 * scoring function for the indexed path is exactly the "two copies of the
 * formula" the module header forbids.
 */
export interface PrecomputedFields {
  /**
   * The length the normalizer divides by — the index's `dl` (distinct tokens)
   * under `presence`, its `tl` (total tokens) under `count`.
   */
  lengths: { title: number; tag: number; text: number }
  /** Query tokens that occur in each field, with their counts (0 is impossible). */
  counts: Bm25CountFields
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
  termFrequency: TermFrequency = 'presence',
): Bm25Score {
  // The plain form carries only presence, so its counts are 1s; callers that
  // want real term frequencies pass `bm25CountFields` straight to
  // {@link bm25fScoreFrom} (the index path does).
  const toCounts = (tokens: readonly string[]): ReadonlyMap<string, number> =>
    new Map(tokens.map((token) => [token, 1]))
  const counts: Bm25CountFields = {
    title: toCounts(fields.title),
    tag: toCounts(fields.tag),
    text: toCounts(fields.text),
  }
  const lengthOf = (map: ReadonlyMap<string, number>): number =>
    termFrequency === 'count' ? totalCount(map) : map.size
  return bm25fScoreFrom({
    lengths: { title: lengthOf(counts.title), tag: lengthOf(counts.tag), text: lengthOf(counts.text) },
    counts,
  }, queryTokens, stats, weights, termFrequency)
}

/**
 * The SAME BM25F arithmetic, over fields an inverted index already knows.
 *
 * {@link bm25fScore} is a thin adapter over this function — the formula is
 * written once, so a scan and a lookup can never drift apart.
 * @param fields - per-field lengths plus the query tokens present in each field.
 * @param queryTokens - the query's tokens.
 * @param stats - the corpus statistics (from the index, when there is one).
 * @param weights - field weights.
 * @returns the raw BM25 score (unrounded) and the matched tokens.
 */
/**
 * A document's fields in the form the scorer consumes, under one mode.
 *
 * The SCAN path uses this so that `presence` and `count` differ only in the mode
 * argument: under `count` the frequencies are real AND the lengths are total
 * token counts, which is the pair the plan measured as one variable.
 * @param entry - title/tags plus the already-redline-filtered body.
 * @param termFrequency - `presence` (shipped) or `count`.
 * @returns the lengths (basis per mode) and the counts.
 */
export function precomputedFrom(
  entry: { title: string; tags: readonly string[]; text: string },
  termFrequency: TermFrequency = 'presence',
  tokenizeOptions: TokenizeOptions = {},
): PrecomputedFields {
  const counts = bm25CountFields(entry, tokenizeOptions)
  const lengthOf = (map: ReadonlyMap<string, number>): number =>
    termFrequency === 'count' ? totalCount(map) : map.size
  return {
    lengths: { title: lengthOf(counts.title), tag: lengthOf(counts.tag), text: lengthOf(counts.text) },
    counts,
  }
}

export function bm25fScoreFrom(
  fields: PrecomputedFields,
  queryTokens: readonly string[],
  stats: LexicalStats,
  weights: Bm25FieldWeights,
  termFrequency: TermFrequency = 'presence',
): Bm25Score {
  const title = fields.counts.title
  const tag = fields.counts.tag
  const text = fields.counts.text
  // `presence` clamps every count to 1 (today's shipped behavior); `count` uses
  // the real frequency — ONE switch, and the stats' averages moved with it.
  const tf = (count: number | undefined): number => {
    if (count === undefined || count <= 0) return 0
    return termFrequency === 'count' ? count : 1
  }
  const norm = (length: number, average: number): number =>
    1 - BM25_B + BM25_B * (average <= 0 ? 1 : length / average)
  const titleNorm = norm(fields.lengths.title, stats.avgTitle)
  const tagNorm = norm(fields.lengths.tag, stats.avgTag)
  const textNorm = norm(fields.lengths.text, stats.avgText)
  const saturation = (weight: number, normalizedLength: number): number =>
    weight * ((BM25_K1 + 1) / (1 + BM25_K1 * normalizedLength))

  let score = 0
  const matched: string[] = []
  for (const token of queryTokens) {
    let hit = 0
    // BM25F's real shape: the field frequencies are summed BEFORE saturation
    // (that is what makes it "F" and not "three BM25s added together"). Under
    // `presence` this reduces to the sum of the fields' saturations, which is
    // exactly what shipped.
    if (termFrequency === 'count') {
      const combined = weights.title * tf(title.get(token))
        + weights.tag * tf(tag.get(token))
        + weights.text * tf(text.get(token))
      if (combined > 0) hit = (BM25_K1 + 1) * combined / (BM25_K1 + combined)
    } else {
      if (tf(title.get(token)) > 0) hit += saturation(weights.title, titleNorm)
      if (tf(tag.get(token)) > 0) hit += saturation(weights.tag, tagNorm)
      if (tf(text.get(token)) > 0) hit += saturation(weights.text, textNorm)
    }
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
