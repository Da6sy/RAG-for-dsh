/**
 * `clue bench` — the command surface of the public-benchmark evaluation
 * (規劃 E1/E5; design in `docs/设计.md`).
 *
 * One place to answer "what has been measured", which is the question that makes
 * an evaluation usable months later:
 *
 *   clue bench index          # 汇总 evals/runs/*.json → evals/runs/INDEX.json（时间序列）
 *   clue bench list           # 打印索引里每份报告的关键数字
 *   clue bench diff <a> <b>   # 两次运行逐指标对比（回答"上次是多少、这次变了吗"）
 *   clue bench clean [--datasets|--runs|--all]   # 清理:数据与报告可整体删,金标集保留
 *
 * `fetch`/`run` stay as the dedicated scripts (`scripts/bench-beir.mjs`,
 * `scripts/fetch-coir.mjs`, `scripts/bench-rag.mjs`): they carry dataset-specific
 * readers and are long-running, so hiding them behind a dispatcher would only add
 * a layer between the reader and the data. This file owns the REPORTS.
 *
 * Every report in the index keeps its own `dataset`, so a public-benchmark number
 * can never be silently averaged with an internal one (規劃 纪律 3).
 *
 * @module @clue-harness/cli/bench
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { clueHome } from '@clue-harness/util'

const REPO = path.resolve(new URL('../../..', import.meta.url).pathname)
const RUNS = path.join(REPO, 'evals', 'runs')
const DATASETS = path.join(REPO, 'evals', 'datasets')
const GOLDENS = path.join(REPO, 'evals', 'goldens')
const CACHE = path.join(REPO, 'evals', 'cache')
const INDEX = path.join(RUNS, 'INDEX.json')

/** One report as the index stores it (flat, comparable, no nested rows). */
export interface IndexEntry {
  id: string
  generatedAt: string
  file: string
  dataset: string
  split: string
  queries: number
  documents: number
  embedder: string | null
  judge: string | null
  judgeVersion: string | null
  /** config → metrics, flattened for a terminal table. */
  rows: Record<string, Record<string, number>>
  /**
   * F0's cross-config verdict, straight from the report: `hybrid+rerank`'s
   * nDCG@10 minus `lexical+rerank`'s (null when a report lacks either row).
   */
  hybridMinusLexical?: number | null
  /**
   * P4 of the D-plan: the second hard line — `hybrid+rerank` vs `hybrid+no-rerank`
   * (the reranker may not lose to the fusion it reorders). Absent in reports
   * written before that column existed.
   */
  rerankMinusFusion?: number | null
  okRerankVsFusion?: boolean
  okHybridVsLexical?: boolean
  ok: boolean
  caveats: string[]
  /**
   * Provenance, for the "same experiment?" check (§7.2 of
   * `docs/评测结果.md`).
   *
   * A diff between a 50-query report and a 10-query one used to print
   * "✓ 提升 / ✗ 回退" and hand back an exit code as if the two numbers were
   * comparable. They are not: the sample changed, so the difference may be the
   * sample rather than the change. These fields let the tool say so.
   */
  embedderId: string | null
  embedderSemantics: string | null
  ks: number[]
  knobs: Record<string, unknown>
}

/**
 * Read every report in `evals/runs` into index entries.
 * @returns the entries, newest first.
 */
async function collect(): Promise<IndexEntry[]> {
  const names = (await readdir(RUNS).catch(() => [] as string[])).filter((name) => name.endsWith('.json') && name !== 'INDEX.json')
  const entries: IndexEntry[] = []
  for (const name of names) {
    const report = JSON.parse(await readFile(path.join(RUNS, name), 'utf8')) as {
      generatedAt: string
      dataset: string
      split?: string
      corpus?: { documents?: number; queries?: number }
      embedder?: { id: string; dim: number; semantics?: string }
      judge?: { id: string; promptVersion: string }
      rows?: Array<{ config: string; metrics?: Record<string, number> } & Record<string, unknown>>
      ok?: boolean
      ks?: number[]
      retrieval?: { knobs?: Record<string, unknown> }
      /** F0's cross-config verdict, when the report carries it. */
      hybridMinusLexical?: number | null
      /** P4 of the D-plan: the second hard line and its two halves. */
      rerankMinusFusion?: number | null
      okHybridVsLexical?: boolean
      okRerankVsFusion?: boolean
      caveats?: string[]
    }
    const rows: Record<string, Record<string, number>> = {}
    for (const row of report.rows ?? []) {
      // Two report shapes exist: the engine's `{config, metrics}` and the BEIR
      // runner's flat `{config, 'nDCG@10': …}`. Both normalize into metrics.
      const metrics: Record<string, number> = {}
      for (const [key, value] of Object.entries(row)) {
        if (key === 'config' || typeof value !== 'number') continue
        metrics[key] = value
      }
      Object.assign(metrics, row.metrics ?? {})
      rows[row.config] = metrics
    }
    entries.push({
      id: name.replace(/\.json$/, ''),
      generatedAt: report.generatedAt,
      file: name,
      dataset: report.dataset,
      split: report.split ?? 'test',
      queries: report.corpus?.queries ?? 0,
      documents: report.corpus?.documents ?? 0,
      embedder: report.embedder === undefined ? null : `${report.embedder.id}(dim=${report.embedder.dim},${report.embedder.semantics})`,
      judge: report.judge?.id ?? null,
      judgeVersion: report.judge?.promptVersion ?? null,
      rows,
      ...(report.hybridMinusLexical !== undefined ? { hybridMinusLexical: report.hybridMinusLexical } : {}),
      ...(report.rerankMinusFusion !== undefined ? { rerankMinusFusion: report.rerankMinusFusion } : {}),
      ...(report.okHybridVsLexical !== undefined ? { okHybridVsLexical: report.okHybridVsLexical } : {}),
      ...(report.okRerankVsFusion !== undefined ? { okRerankVsFusion: report.okRerankVsFusion } : {}),
      ok: report.ok ?? true,
      caveats: report.caveats ?? [],
      embedderId: report.embedder?.id ?? null,
      embedderSemantics: report.embedder?.semantics ?? null,
      ks: report.ks ?? [],
      knobs: report.retrieval?.knobs ?? {},
    })
  }
  return entries.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
}

/** Write `INDEX.json` (the time series every "上次是多少" question reads). */
async function index(): Promise<number> {
  const entries = await collect()
  await mkdir(RUNS, { recursive: true })
  await writeFile(INDEX, `${JSON.stringify({ generatedAt: new Date().toISOString(), reports: entries }, null, 2)}\n`, 'utf8')
  console.log(`indexed ${entries.length} reports → ${path.relative(REPO, INDEX)}`)
  const byDataset: Record<string, number> = {}
  for (const entry of entries) byDataset[entry.dataset] = (byDataset[entry.dataset] ?? 0) + 1
  for (const [dataset, count] of Object.entries(byDataset)) console.log(`  ${dataset}: ${count} reports`)
  return 0
}

/** Print the index as a table (dataset / queries / embedder / judge / ok). */
async function list(): Promise<number> {
  if ((await stat(INDEX).catch(() => null)) === null) await index()
  const entries = (JSON.parse(await readFile(INDEX, 'utf8')) as { reports: IndexEntry[] }).reports
  for (const entry of entries) {
    console.log(`${entry.dataset.padEnd(14)} ${entry.generatedAt.slice(0, 19)}  ${String(entry.queries).padStart(3)}q  ${entry.embedder ?? '-'}  judge=${entry.judgeVersion ?? '-'}  ${entry.ok ? 'ok' : 'fail'}`)
  }
  console.log(`${entries.length} reports in total (index ${path.relative(REPO, INDEX)})`)
  return 0
}

/**
 * One reason two reports are not the same experiment.
 *
 * Deliberately NOT checked: the retrieval knobs. Changing a knob is the *point*
 * of an A/B; the sample and the embedder are what must hold still.
 */
export interface ProvenanceMismatch {
  field: string
  left: string
  right: string
}

/** Same-experiment check for a diff (see {@link ProvenanceMismatch}). */
export function provenanceMismatches(left: IndexEntry, right: IndexEntry): ProvenanceMismatch[] {
  const out: ProvenanceMismatch[] = []
  const add = (field: string, a: unknown, b: unknown): void => {
    const show = (value: unknown): string => (value === null || value === undefined ? '-' : String(value))
    if (show(a) !== show(b)) out.push({ field, left: show(a), right: show(b) })
  }
  // Defensive about half-populated entries: an INDEX.json written by an older
  // build lacks `ks` / `embedderId` / `knobs`, and a missing field must read as
  // "unknown", not crash the comparison.
  const ks = (entry: IndexEntry): string => (entry.ks ?? []).join(',')
  add('dataset', left.dataset, right.dataset)
  add('split', left.split, right.split)
  add('queries', left.queries, right.queries)
  add('corpus size', left.documents, right.documents)
  add('k cutoff', ks(left), ks(right))
  add('embedder', left.embedderId, right.embedderId)
  add('semantics', left.embedderSemantics, right.embedderSemantics)
  add('judge version', left.judgeVersion, right.judgeVersion)
  return out
}

/** Whether an entry carries the provenance fields this build needs. */
export function hasProvenance(entry: IndexEntry): boolean {
  return Array.isArray(entry.ks) && entry.embedderId !== undefined
}

/** What one report's hard lines say. `unproven` means "this report cannot decide it". */
export interface HardLineVerdict {
  /** The measured quantity, e.g. `hybrid−lexical nDCG@10`. */
  line: string
  /** The number behind it (null when the report does not carry it). */
  delta: number | null
  state: 'pass' | 'fail' | 'unproven'
  /** Why it is unproven (empty for pass/fail). */
  reason: string
}

/**
 * The two hard lines, evaluated for ONE report, with the two ways a verdict can
 * legitimately not exist spelled out.
 *
 * 1. **No semantic ability** (`semantics: 'none'`, e.g. `hashEmbedder`): F1's
 *    ability gate forces `hybrid ≡ lexical`, so a "✓ 通过" here is a property of
 *    the gate, not a measurement. Reporting it as a PASS is how a meaningless
 *    green CI gets built, so it is reported as UNPROVEN instead.
 * 2. **A single-config report** (`--only …`): the cross-config deltas do not
 *    exist in the file at all.
 * @param entry - one report's index entry.
 * @returns one verdict per hard line (missing lines are omitted).
 */
export function hardLineVerdicts(entry: IndexEntry): HardLineVerdict[] {
  const out: HardLineVerdict[] = []
  const noAbility = entry.embedderSemantics === 'none'
    ? 'embedder self-reports semantics=0 (a deterministic fallback like hashEmbedder): under the F1 ability gate hybrid is identical to lexical, so this hard line cannot be proven in this configuration'
    : null
  // A report can lack the delta for two very different reasons, and saying
  // "you only ran one config" about a full-matrix report from an older schema
  // would send the reader looking in the wrong place.
  const matrix = ['lexical+rerank', 'hybrid+no-rerank', 'hybrid+rerank'].every((config) => entry.rows[config] !== undefined)
  const missingReason = matrix
    ? 'report was written before this hard-line column existed (old schema lacks the field): rerun once to get a verdict'
    : 'report lacks the 4-row config matrix (a single-config --only run), so cross-config hard lines cannot be computed'
  const verdict = (line: string, delta: number | null | undefined, ok: boolean | undefined): HardLineVerdict => {
    if (delta === undefined || delta === null) return { line, delta: null, state: 'unproven', reason: missingReason }
    if (noAbility !== null) return { line, delta, state: 'unproven', reason: noAbility }
    return { line, delta, state: ok === false ? 'fail' : 'pass', reason: '' }
  }
  out.push(verdict(
    'hybrid−lexical nDCG@10',
    entry.hybridMinusLexical,
    entry.okHybridVsLexical ?? (entry.hybridMinusLexical === undefined ? undefined : entry.ok),
  ))
  out.push(verdict(
    'hybrid+rerank − hybrid+no-rerank',
    entry.rerankMinusFusion,
    entry.okRerankVsFusion ?? (entry.rerankMinusFusion === undefined ? undefined : entry.ok),
  ))
  return out.filter((row) => row.delta !== null || row.reason === missingReason)
}

/** One metric row of the diff. */
export interface DiffRow {
  config: string
  metric: string
  previous: number
  value: number
  delta: number
  kind: 'quality' | 'cost' | 'observe'
  flag: string
  /** Whether this row alone fails the command (quality-only, and only when comparable). */
  regresses: boolean
}

/** Everything `clue bench diff` prints, as data. */
export interface DiffReport {
  mismatches: ProvenanceMismatch[]
  comparable: boolean
  rows: DiffRow[]
  before: HardLineVerdict[]
  after: HardLineVerdict[]
  /** Why nothing could be decided (values are human-readable reasons). */
  unproven: string[]
  /** Whether the command should exit non-zero. */
  regressed: boolean
}

/** Metric classes (P0 of the D-plan; see {@link DiffRow.kind}). */
const LOWER_IS_BETTER = new Set(['seconds'])
const OBSERVATION = new Set([
  'vectorUsed',
  'goldInWindow',
  'semanticSpread',
  'vectorStatus',
  // P0 of the D-plan: the forensic columns. `goldDemotedOutOfTop10` and
  // `bm25ishSaturatedQueries` are *diagnoses*, not quality — a run that demotes
  // more gold may still score higher, and the report must not call that a
  // regression on the diagnosis itself.
  'goldDemotedOutOfTop10',
  'goldInWindowTop10',
  'semanticTop1Gold',
  'semanticTop1Survived',
  'bm25ishTopMean',
  'bm25ishSaturatedQueries',
])

/**
 * Compare two reports and decide.
 *
 * Three rules, each fixing a measured way this tool used to lie
 * (`docs/评测结果.md` §7):
 * - the BASELINE being red is context, never a regression: otherwise the very
 *   change that repairs a failure is rejected by the command that measures it;
 * - a provenance mismatch (sample size, embedder, k) makes every verdict
 *   UNPROVEN instead of silently comparing two different experiments;
 * - a no-ability embedder cannot prove the hard lines at all.
 * @param left - the baseline report.
 * @param right - the newer report.
 * @returns the report to print, plus the exit-code decision.
 */
export function evaluateDiff(left: IndexEntry, right: IndexEntry): DiffReport {
  const mismatches = provenanceMismatches(left, right)
  const comparable = mismatches.length === 0
  const unproven: string[] = []
  if (!comparable) {
    unproven.push(`provenance differs (${mismatches.map((row) => row.field).join(', ')}): this run only lists the numbers, no pass/regress verdict`)
  }
  if (right.embedderSemantics === 'none') {
    unproven.push('no-ability embedder: neither hard line can be proven in this configuration (needs --embedder http)')
  }
  const direction = (metric: string): 'quality' | 'cost' | 'observe' =>
    OBSERVATION.has(metric) ? 'observe' : LOWER_IS_BETTER.has(metric) ? 'cost' : 'quality'
  const rows: DiffRow[] = []
  for (const config of Object.keys(right.rows)) {
    const before = left.rows[config]
    const after = right.rows[config]
    if (before === undefined || after === undefined) continue
    for (const [metric, value] of Object.entries(after)) {
      const previous = before[metric]
      if (previous === undefined) continue
      const delta = value - previous
      const kind = direction(metric)
      const worse = kind === 'cost' ? delta > 0.005 : delta < -0.005
      const better = kind === 'cost' ? delta < -0.005 : delta > 0.005
      const flag = !comparable ? ' · provenance differs, no verdict'
        : kind === 'observe' ? ' · observe'
          : worse ? (kind === 'cost' ? ' ✗ slower' : ' ✗ regress')
            : better ? (kind === 'cost' ? ' ✓ faster' : ' ✓ improve') : ''
      rows.push({
        config, metric, previous, value, delta, kind, flag,
        regresses: comparable && kind === 'quality' && worse,
      })
    }
  }
  const before = hardLineVerdicts(left)
  const after = hardLineVerdicts(right)
  // ONLY the newer report decides: a red baseline is the reason to run a diff,
  // not a reason for the diff to fail.
  const failedLine = comparable && after.some((row) => row.state === 'fail')
  const regressed = failedLine || rows.some((row) => row.regresses)
  // With a provenance mismatch NOTHING is decided, including a line that would
  // otherwise read as failed: the difference may be the sample.
  if (!comparable) {
    for (const row of after) {
      if (row.state === 'unproven') continue
      row.state = 'unproven'
      row.reason = 'provenance differs, this comparison yields no verdict'
    }
  }
  return { mismatches, comparable, rows, before, after, unproven, regressed }
}

/**
 * Compare two reports metric by metric.
 * @param a - file name or id of the baseline report.
 * @param b - file name or id of the newer report.
 * @returns exit code 0 when nothing regressed and nothing was disproved, 1 otherwise.
 */
async function diff(a: string, b: string): Promise<number> {
  const entries = (JSON.parse(await readFile(INDEX, 'utf8')) as { reports: IndexEntry[] }).reports
  const find = (needle: string): IndexEntry | undefined => entries.find((entry) => entry.id === needle || entry.file === needle || entry.id.includes(needle))
  const left = find(a)
  const right = find(b)
  if (left === undefined || right === undefined) {
    console.error(`report not found: ${left === undefined ? a : ''} ${right === undefined ? b : ''} (see ids via clue bench list)`)
    return 2
  }
  const report = evaluateDiff(left, right)
  console.log(`${left.dataset}(${left.generatedAt.slice(0, 19)}) → ${right.dataset}(${right.generatedAt.slice(0, 19)})`)
  if (!hasProvenance(left) || !hasProvenance(right)) {
    console.log('  ⚠ the index was written by an older version (missing k cutoff/embedder fields), so the provenance check is incomplete — run `clue bench index` first to rebuild it')
  }
  if (!report.comparable) {
    console.log('  ⚠ provenance differs, this comparison yields no verdict:')
    for (const row of report.mismatches) console.log(`      ${row.field}: before ${row.left} · after ${row.right}`)
  }
  const printLine = (label: string, verdict: HardLineVerdict, decisive: boolean): void => {
    const delta = verdict.delta === null ? '    -    ' : `${verdict.delta >= 0 ? '+' : ''}${verdict.delta.toFixed(4)}`
    const mark = verdict.state === 'pass' ? '✓ pass'
      : verdict.state === 'fail' ? '✗ fail'
        : `? unproven — ${verdict.reason}`
    const note = !decisive && verdict.state === 'fail' ? ' (baseline failed — for reference only, not counted toward the exit code)' : ''
    console.log(`  [hard line] ${label} ${verdict.line} = ${delta}  ${mark}${note}`)
  }
  for (const verdict of report.before) printLine('before', verdict, false)
  for (const verdict of report.after) printLine('after', verdict, true)
  for (const row of report.rows) {
    console.log(`  ${row.config.padEnd(24)} ${row.metric.padEnd(12)} ${row.previous} → ${row.value} (${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(4)})${row.flag}`)
  }
  for (const reason of report.unproven) console.log(`  ⚠ unproven: ${reason}`)
  console.log(`  verdict: ${report.regressed ? '✗ fail (see the ✗ rows above)' : report.unproven.length === 0 ? '✓ pass' : '? unproven (see the ⚠ rows above; the exit code does not change because of this)'}`)
  return report.regressed ? 1 : 0
}

/**
 * Delete evaluation artifacts (the user-facing cleanup).
 * @param scope - which directories to remove.
 * @returns exit code.
 */
async function clean(scope: 'datasets' | 'runs' | 'cache' | 'all'): Promise<number> {
  const targets: Array<[string, string]> = []
  if (scope === 'datasets' || scope === 'all') targets.push(['datasets', DATASETS])
  if (scope === 'runs' || scope === 'all') targets.push(['runs', RUNS])
  if (scope === 'cache' || scope === 'all') targets.push(['cache', CACHE])
  for (const [label, dir] of targets) {
    const before = await stat(dir).then((info) => info.size).catch(() => 0)
    await rm(dir, { recursive: true, force: true })
    console.log(`removed evals/${label}${before === 0 ? ' (did not exist)' : ''}`)
  }
  const kept = await stat(GOLDENS).catch(() => null)
  console.log(`kept evals/goldens (${kept === null ? 'not created yet' : 'human-written golden set, keep it versioned'}) · if the cache dir ${path.relative(REPO, CACHE)} was removed as well, the next judging run will call the model again`)
  console.log(`note: durable copies of the report numbers live in docs/评测结果.md — cleanup does not lose any conclusions`)
  return 0
}

/** The `clue bench` entry point. */
export async function benchMain(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv
  const scope = rest.includes('--all') ? 'all'
    : rest.includes('--datasets') ? 'datasets'
      : rest.includes('--runs') ? 'runs'
        : rest.includes('--cache') ? 'cache' : null
  switch (verb) {
    case undefined:
    case 'help':
    case '--help':
      console.log(`usage: clue bench <command>

  index                     summarize evals/runs/*.json → evals/runs/INDEX.json (time series)
  list                      list every report in the index (dataset/queries/embedder/judge version/pass)
  diff <a> <b>              compare two reports metric by metric (a regression exits 1)
  clean --datasets|--runs|--cache|--all
                            remove evaluation artifacts (datasets/reports/judge cache; goldens and doc conclusions are kept)

fetching and scoring stay dedicated scripts (their data formats and runtimes differ; not hidden behind a dispatcher):
  node scripts/bench-beir.mjs --dataset <nfcorpus|scifact|coir-cosqa> …
  node scripts/fetch-coir.mjs --task cosqa --cap 1200
  node scripts/bench-rag.mjs --records 3 [--judge-provider qwen --judge-model qwen3.8-max]

artifacts all live under evals/ (gitignored) and can be removed wholesale; durable numbers and conclusions are in docs/评测结果.md`)
      return 0
    case 'index': return index()
    case 'list': return list()
    case 'diff': {
      const [a, b] = rest
      if (a === undefined || b === undefined) { console.error('diff needs two reports (id or file name, see clue bench list)'); return 2 }
      return diff(a, b)
    }
    case 'clean': {
      if (scope === null) { console.error('clean needs one of --datasets | --runs | --cache | --all'); return 2 }
      return clean(scope)
    }
    default:
      console.error(`unknown bench subcommand: ${verb} (index|list|diff|clean)`)
      return 2
  }
}

/** Where the eval home lives (kept for the design's `<home>/eval-cache` variant). */
export function evalCacheDir(): string {
  return path.join(clueHome(), 'eval-cache')
}
