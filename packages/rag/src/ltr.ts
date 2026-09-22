/**
 * Offline LTR — the experiment the plan allows and the deployment it does not
 * (V5, 原规划 §8.4).
 *
 * 拍板 2 chose hand-built features and left learning-to-rank as "攒够标注再说".
 * This module is the "再说" half: it reads the `ranklog.jsonl` the retrievals
 * have been writing, joins it against the signal ledger for LABELS, and fits a
 * small logistic ranker in pure JavaScript — no new dependency, no runtime, no
 * deployment. Its output is a comparison against the shipped hand weights, which
 * a human reads before deciding whether to change anything.
 *
 * Three boundaries the plan draws, and this file keeps:
 *
 * 1. **Nothing here runs at retrieval time.** A trained weight vector would be
 *    another thing to explain, version and roll back; until it beats the hand
 *    weights on held-out queries, it stays a report.
 * 2. **Labels come from the ledger, never from the model.** A positive is a
 *    `kb_cite` / human confirmation / evidence pass recorded shortly after the
 *    retrieval; a negative is a rejection or an attributed failure. "The model
 *    liked it" is not a label (宪法 4: 查询不改变知识,也不产生"评价").
 * 3. **Refusing to train is a valid answer.** Below the plan's ≥500 labeled
 *    queries the honest output is "not yet", with the numbers that say why.
 *
 * @module @clue-harness/rag/ltr
 */
import type { SignalRecord } from '@clue-harness/kb'
import type { RankLogRow } from './ranklog.ts'
import { DEFAULT_FEATURE_WEIGHTS, type RerankFeatureWeights } from './rerank.ts'

/** One labeled candidate: the feature vector and whether it was used as basis. */
export interface TrainingRow {
  /** Retrieval it came from (for grouped train/test splits later). */
  query: string
  entryId: string
  features: Record<string, number>
  label: 0 | 1
}

/** How long after a retrieval a signal still counts as a label for it. */
export const DEFAULT_LABEL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Turn the ranklog + signal ledger into a training set.
 *
 * Positives only, deliberately: the negatives in a retrieval are the candidates
 * that were NOT cited, and treating "not cited" as "wrong" would teach the
 * ranker that everything except the winner is bad — which is a statement about
 * the query, not about the knowledge. A rejected/failed signal for a candidate
 * IS a real negative and is taken as one.
 * @param rows - the ranklog rows.
 * @param signals - the tier's signal ledger.
 * @param options - the label window.
 * @returns the labeled rows.
 */
export function buildTrainingSet(
  rows: readonly RankLogRow[],
  signals: readonly SignalRecord[],
  options: { windowMs?: number } = {},
): TrainingRow[] {
  const windowMs = options.windowMs ?? DEFAULT_LABEL_WINDOW_MS
  const out: TrainingRow[] = []
  for (const row of rows) {
    const at = Date.parse(row.at)
    if (Number.isNaN(at)) continue
    const positive = new Set<string>()
    const negative = new Set<string>()
    for (const signal of signals) {
      const signalAt = Date.parse(signal.at)
      if (Number.isNaN(signalAt) || signalAt < at || signalAt - at > windowMs) continue
      const id = String(signal.entryId)
      if (signal.polarity === 'positive') positive.add(id)
      else negative.add(id)
    }
    for (const candidate of row.candidates) {
      const label = positive.has(candidate.id) ? 1 : negative.has(candidate.id) ? 0 : null
      if (label === null) continue
      out.push({ query: row.query, entryId: candidate.id, features: { ...candidate.features }, label })
    }
  }
  return out
}

/** Whether the corpus is big enough to bother (原规划 §8.4: ≥500 有标注查询). */
export const LTR_MIN_QUERIES = 500

/** The readiness verdict the CLI prints. */
export interface LtrReadiness {
  ready: boolean
  queries: number
  rows: number
  positives: number
  negatives: number
  reason: string
}

/** Assess the training data (never throws; "not yet" is an answer). */
export function ltrReadiness(training: readonly TrainingRow[]): LtrReadiness {
  const queries = new Set(training.map((row) => row.query)).size
  const positives = training.filter((row) => row.label === 1).length
  const negatives = training.length - positives
  if (queries < LTR_MIN_QUERIES) {
    return { ready: false, queries, rows: training.length, positives, negatives, reason: `有标注查询 ${queries} < ${LTR_MIN_QUERIES}(${positives} 正 / ${negatives} 负)——继续攒 ranklog 与信号` }
  }
  if (positives === 0 || negatives === 0) {
    return { ready: false, queries, rows: training.length, positives, negatives, reason: '标注只有单一极性,无法拟合(正负样本都需要)' }
  }
  return { ready: true, queries, rows: training.length, positives, negatives, reason: '数据量达标,可以离线拟合' }
}

/** The features the linear model learns over (the §8.2 additive terms). */
export const LTR_FEATURES = [
  'bm25ish', 'exactPhrase', 'semantic', 'specificity', 'bindingOverlap',
  'redlineRatio', 'freshness', 'signalScore', 'docMountBonus',
] as const

/** A fitted linear model. */
export interface LtrModel {
  weights: Record<string, number>
  /** Training epochs performed. */
  epochs: number
  /** Logistic loss of the last epoch (the fitting diagnostic). */
  loss: number
}

/**
 * Fit a logistic model by gradient descent (no dependency, deterministic).
 *
 * @param training - the labeled rows.
 * @param options - learning rate and epochs.
 * @returns the fitted weights.
 * @throws when there is nothing to fit (single polarity) — fail loud rather
 *   than return weights that predict a constant.
 */
export function trainLogistic(training: readonly TrainingRow[], options: { epochs?: number; learningRate?: number } = {}): LtrModel {
  const labels = new Set(training.map((row) => row.label))
  if (labels.size < 2) throw new Error('LTR: 标注只有单一极性,无法拟合')
  const epochs = options.epochs ?? 400
  const lr = options.learningRate ?? 0.1
  const weights: Record<string, number> = {}
  for (const feature of LTR_FEATURES) weights[feature] = 0
  let bias = 0
  let loss = 0
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const grad: Record<string, number> = {}
    for (const feature of LTR_FEATURES) grad[feature] = 0
    let gradBias = 0
    loss = 0
    for (const row of training) {
      let score = bias
      for (const feature of LTR_FEATURES) score += (weights[feature] as number) * (row.features[feature] ?? 0)
      const p = 1 / (1 + Math.exp(-score))
      const error = p - row.label
      loss += -(row.label === 1 ? Math.log(Math.max(p, 1e-12)) : Math.log(Math.max(1 - p, 1e-12)))
      for (const feature of LTR_FEATURES) grad[feature] = (grad[feature] as number) + error * (row.features[feature] ?? 0)
      gradBias += error
    }
    const scale = lr / training.length
    for (const feature of LTR_FEATURES) weights[feature] = (weights[feature] as number) - scale * (grad[feature] as number)
    bias -= scale * gradBias
  }
  return { weights: { ...weights, bias }, epochs, loss: loss / training.length }
}

/** How a weight vector ranks: the fraction of queries whose best candidate is a positive. */
export interface LtrEvaluation {
  queries: number
  /** Fraction of queries where the top-scored candidate carries label 1. */
  precisionAt1: number
  /** Mean reciprocal rank of the first positive. */
  mrr: number
}

/**
 * Evaluate one weight vector on labeled rows (grouped by query).
 * @param training - the labeled rows.
 * @param weights - the weights to score with (missing features count 0).
 * @returns the ranking metrics.
 */
export function evaluateWeights(training: readonly TrainingRow[], weights: Record<string, number>): LtrEvaluation {
  const byQuery = new Map<string, TrainingRow[]>()
  for (const row of training) {
    const list = byQuery.get(row.query) ?? []
    list.push(row)
    byQuery.set(row.query, list)
  }
  let top1 = 0
  let rrSum = 0
  let counted = 0
  for (const rows of byQuery.values()) {
    if (!rows.some((row) => row.label === 1)) continue
    counted += 1
    const ordered = [...rows].sort((a, b) => score(b, weights) - score(a, weights) || a.entryId.localeCompare(b.entryId))
    if (ordered[0]?.label === 1) top1 += 1
    const rank = ordered.findIndex((row) => row.label === 1) + 1
    rrSum += rank === 0 ? 0 : 1 / rank
  }
  return { queries: counted, precisionAt1: counted === 0 ? 0 : top1 / counted, mrr: counted === 0 ? 0 : rrSum / counted }
}

/** Score one row with a weight vector. */
function score(row: TrainingRow, weights: Record<string, number>): number {
  let total = weights.bias ?? 0
  for (const feature of LTR_FEATURES) total += (weights[feature] ?? 0) * (row.features[feature] ?? 0)
  return total
}

/** The shipped hand weights as a comparable vector. */
export function handWeights(): Record<string, number> {
  const w: RerankFeatureWeights = DEFAULT_FEATURE_WEIGHTS
  return { ...w, redlineRatio: w.redlinePenalty, bias: 0 }
}
