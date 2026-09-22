/**
 * `@clue-harness/eval` — the evaluation engine (規劃 `docs/设计.md` E1/E2).
 *
 * Three jobs, and nothing else:
 *
 * 1. **Read a dataset** — BEIR's three-file shape (`corpus.jsonl` + `queries.jsonl`
 *    + `qrels/<split>.tsv`), which is also what CoIR is converted INTO (so one
 *    reader serves both), plus our own golden-set JSON.
 * 2. **Score a ranking** — nDCG@k (graded gains), recall@k, MRR@k. Deterministic,
 *    no model involved: a retrieval number must never depend on a judge.
 * 3. **Describe an evaluation** — the report shape both the CLI and the runner
 *    write, so a report from BEIR, CoIR and RGB can sit in one index without
 *    anyone having to guess what was measured.
 *
 * What is deliberately NOT here: the model calls. Judging and answering go
 * through {@link JudgePort}/{@link AnswerPort} (see `./judge.ts`), injected by
 * the face layer — the same dependency inversion that keeps the engine free of
 * dsh and keeps a judge's cost visible at the seam.
 *
 * @module @clue-harness/eval
 */
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'

/** One document of an evaluation corpus. */
export interface EvalDoc {
  id: string
  title: string
  text: string
}

/** One query with its judged relevance (`docId` → grade). */
export interface EvalQuery {
  id: string
  text: string
  /** Relevant documents with graded relevance (1 = relevant, 2 = highly relevant). */
  gold: Map<string, number>
  /** Optional per-query label (`kind`, difficulty, source file…). */
  kind?: string
}

/** One loaded evaluation set. */
export interface EvalDataset {
  /** `beir/nfcorpus` · `coir/cosqa` · `golden-v1` … (never mixed in one table). */
  name: string
  split: string
  docs: EvalDoc[]
  queries: EvalQuery[]
}

/** Read a JSONL file line by line (corpora can be large; never slurp blindly). */
export async function readJsonl<T>(file: string): Promise<T[]> {
  const rows: T[] = []
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.trim() === '') continue
    rows.push(JSON.parse(line) as T)
  }
  return rows
}

/** Parse BEIR's `qrels/<split>.tsv` (`query-id \t corpus-id \t score`). */
export function parseQrels(text: string): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('query-id')) continue
    const [qid, docId, score] = line.split('\t')
    if (qid === undefined || docId === undefined) continue
    const list = out.get(qid) ?? new Map<string, number>()
    list.set(docId, Number(score) || 1)
    out.set(qid, list)
  }
  return out
}

/**
 * Load a BEIR-shaped dataset from a directory.
 *
 * Only queries that HAVE qrels in the requested split are returned: BEIR ships
 * a pool of queries and a judged subset, and scoring an unjudged query would
 * count every retrieval as wrong.
 * @param dir - directory holding `corpus.jsonl`, `queries.jsonl`, `qrels/<split>.tsv`.
 * @param options - dataset name, split, and a query cap.
 * @returns the dataset.
 */
export async function readBeirDataset(
  dir: string,
  options: { name: string; split?: string; maxQueries?: number } = { name: path.basename(dir) },
): Promise<EvalDataset> {
  const split = options.split ?? 'test'
  const corpus = await readJsonl<{ _id: string; title?: string; text?: string }>(path.join(dir, 'corpus.jsonl'))
  const queries = new Map((await readJsonl<{ _id: string; text?: string }>(path.join(dir, 'queries.jsonl'))).map((row) => [String(row._id), String(row.text ?? '')]))
  const qrels = parseQrels(await readFile(path.join(dir, 'qrels', `${split}.tsv`), 'utf8'))
  const evaluated: EvalQuery[] = []
  for (const [qid, gold] of qrels) {
    if (!queries.has(qid)) continue
    evaluated.push({ id: qid, text: queries.get(qid) as string, gold })
    if (options.maxQueries !== undefined && evaluated.length >= options.maxQueries) break
  }
  return {
    name: options.name,
    split,
    docs: corpus.map((row) => ({ id: String(row._id), title: String(row.title ?? ''), text: String(row.text ?? '') })),
    queries: evaluated,
  }
}

/** Discounted cumulative gain over graded gains. */
export function dcg(gains: readonly number[]): number {
  return gains.reduce((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0)
}

/** The three ranking metrics of one query. */
export interface QueryScore {
  ndcg: number
  recall: number
  rr: number
}

/**
 * Score one ranking against one query's gold.
 *
 * The ideal DCG is computed from the gold list itself, so a query with one
 * relevant document and a query with five are each measured against their own
 * ceiling (comparing to a fixed ceiling would silently punish the easy query).
 * @param ranked - retrieved doc ids, best first.
 * @param gold - docId → relevance grade.
 * @param k - cutoff.
 * @returns the three metrics.
 */
export function scoreRanking(ranked: readonly string[], gold: ReadonlyMap<string, number>, k: number): QueryScore {
  const top = ranked.slice(0, k)
  const ideal = [...gold.values()].sort((a, b) => b - a).slice(0, k)
  const idealDcg = dcg(ideal)
  const ndcg = idealDcg === 0 ? 0 : dcg(top.map((id) => gold.get(id) ?? 0)) / idealDcg
  const found = top.filter((id) => gold.has(id)).length
  const recall = gold.size === 0 ? 0 : found / gold.size
  const first = top.findIndex((id) => gold.has(id))
  return { ndcg, recall, rr: first === -1 ? 0 : 1 / (first + 1) }
}

/** Mean of one metric across queries, plus its standard deviation (sample noise is reported, never hidden). */
export interface MetricSummary {
  n: number
  ndcg: number
  recall: number
  mrr: number
  /** Standard deviation of nDCG across queries — the "how much would this move on another sample" signal. */
  ndcgStdDev: number
}

/** Aggregate per-query scores. */
export function summarizeScores(scores: readonly QueryScore[]): MetricSummary {
  const n = scores.length
  if (n === 0) return { n: 0, ndcg: 0, recall: 0, mrr: 0, ndcgStdDev: 0 }
  const mean = (pick: (score: QueryScore) => number): number => scores.reduce((sum, score) => sum + pick(score), 0) / n
  const ndcg = mean((score) => score.ndcg)
  const variance = scores.reduce((sum, score) => sum + (score.ndcg - ndcg) ** 2, 0) / n
  return { n, ndcg, recall: mean((score) => score.recall), mrr: mean((score) => score.rr), ndcgStdDev: Math.sqrt(variance) }
}

/** One configuration's row in a report. */
export interface EvalRow {
  config: string
  /** Metric name → value (names are strings so a report can carry `nDCG@10` and `faithfulness` alike). */
  metrics: Record<string, number>
  /** Extra per-row facts (vector channel usage, seconds, judge version…). */
  notes?: Record<string, string | number | boolean>
}

/** The report every runner writes (the shape `clue bench index` consumes). */
export interface EvalReport {
  generatedAt: string
  /** Dataset identity — public benchmarks and internal sets are NEVER mixed in one table. */
  dataset: string
  split: string
  corpus: { documents: number; queries: number }
  ks: number[]
  embedder?: { id: string; dim: number; semantics: 'none' | 'endpoint' }
  judge?: { id: string; promptVersion: string }
  answer?: { id: string }
  rows: EvalRow[]
  baseline?: string
  /** Cost visibility (規劃 纪律 4): failures count too. */
  cost?: { calls: number; chars: number; seconds: number; failedCalls?: number }
  caveats: string[]
  ok: boolean
}

/**
 * Assemble a report with the fields every evaluation must carry.
 *
 * Kept in the engine so a new runner cannot forget the disclosure: the caveats
 * list always leads with the dataset-independence rule and the sample size.
 * @param input - the assembled values.
 * @returns the report.
 */
export function buildReport(input: Omit<EvalReport, 'caveats' | 'ok'> & { caveats?: string[]; ok?: boolean }): EvalReport {
  return {
    ...input,
    caveats: [
      `数据集 ${input.dataset}(${input.split}):语料与 qrels 都不是本项目的,结论不得与内部合成集/金标集混算`,
      `样本量:${input.corpus.queries} 条查询 / ${input.corpus.documents} 篇语料`,
      ...(input.caveats ?? []),
    ],
    ok: input.ok ?? true,
  }
}
