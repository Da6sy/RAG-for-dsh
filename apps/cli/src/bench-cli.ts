/**
 * `clue bench` — the command surface of the public-benchmark evaluation
 * (規劃 E1/E5; design in `docs/设计_公开基准测评-BEIR-CoIR-RGB.md`).
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
      embedder?: { id: string; dim: number; semantics: string }
      judge?: { id: string; promptVersion: string }
      rows?: Array<{ config: string; metrics?: Record<string, number> } & Record<string, unknown>>
      ok?: boolean
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
    })
  }
  return entries.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
}

/** Write `INDEX.json` (the time series every "上次是多少" question reads). */
async function index(): Promise<number> {
  const entries = await collect()
  await mkdir(RUNS, { recursive: true })
  await writeFile(INDEX, `${JSON.stringify({ generatedAt: new Date().toISOString(), reports: entries }, null, 2)}\n`, 'utf8')
  console.log(`已汇总 ${entries.length} 份报告 → ${path.relative(REPO, INDEX)}`)
  const byDataset: Record<string, number> = {}
  for (const entry of entries) byDataset[entry.dataset] = (byDataset[entry.dataset] ?? 0) + 1
  for (const [dataset, count] of Object.entries(byDataset)) console.log(`  ${dataset}: ${count} 份`)
  return 0
}

/** Print the index as a table (dataset / queries / embedder / judge / ok). */
async function list(): Promise<number> {
  if ((await stat(INDEX).catch(() => null)) === null) await index()
  const entries = (JSON.parse(await readFile(INDEX, 'utf8')) as { reports: IndexEntry[] }).reports
  for (const entry of entries) {
    console.log(`${entry.dataset.padEnd(14)} ${entry.generatedAt.slice(0, 19)}  ${String(entry.queries).padStart(3)}q  ${entry.embedder ?? '-'}  judge=${entry.judgeVersion ?? '-'}  ${entry.ok ? 'ok' : '未通过'}`)
  }
  console.log(`共 ${entries.length} 份(索引 ${path.relative(REPO, INDEX)})`)
  return 0
}

/**
 * Compare two reports metric by metric.
 * @param a - file name or id of the baseline report.
 * @param b - file name or id of the newer report.
 * @returns exit code 0 when every shared metric is >= the baseline, 1 otherwise.
 */
async function diff(a: string, b: string): Promise<number> {
  const entries = (JSON.parse(await readFile(INDEX, 'utf8')) as { reports: IndexEntry[] }).reports
  const find = (needle: string): IndexEntry | undefined => entries.find((entry) => entry.id === needle || entry.file === needle || entry.id.includes(needle))
  const left = find(a)
  const right = find(b)
  if (left === undefined || right === undefined) {
    console.error(`找不到报告:${left === undefined ? a : ''} ${right === undefined ? b : ''}(用 clue bench list 看 id)`)
    return 2
  }
  console.log(`${left.dataset}(${left.generatedAt.slice(0, 19)}) → ${right.dataset}(${right.generatedAt.slice(0, 19)})`)
  let regressed = false
  /**
   * P0 of `docs/修复方案-精排量纲与语义名次.md` §10: the comparison used to treat
   * EVERY numeric field as a quality metric, so a run that got FASTER was
   * reported as a regression and the command exited 1 — a measurement defect
   * that would have masked real ones.
   *
   * Three classes now: quality (higher is better), cost (lower is better), and
   * observation (no verdict either way — counts, coverage, spread).
   */
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
  const direction = (metric: string): 'quality' | 'cost' | 'observe' =>
    OBSERVATION.has(metric) ? 'observe' : LOWER_IS_BETTER.has(metric) ? 'cost' : 'quality'
  /**
   * F0 of `docs/修改规划-混合检索反超单BM25.md`: the plan's hard line is a
   * CROSS-CONFIG one — with reranking on, `hybrid` may not lose to `lexical`
   * (tolerance 0). The bench writes that verdict into each report as
   * `ok` / `hybridMinusLexical`; this is where a human sees it and where CI
   * would fail on it.
   */
  const verdict = (label: string, entry: IndexEntry): void => {
    const delta = entry.hybridMinusLexical
    if (delta !== undefined && delta !== null) {
      const failed = entry.okHybridVsLexical === false || (entry.okHybridVsLexical === undefined && entry.ok === false)
      if (failed) regressed = true
      console.log(`  [硬线] ${label} hybrid−lexical nDCG@10 = ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}${failed ? '  ✗ 混合劣于单词法' : '  ✓ 通过'}`)
    }
    // The D-plan's line: the reranker may not lose to the fusion order it
    // reorders. On a real endpoint this is the defect being fixed (0.4265 vs
    // 0.4829), so it gets its own verdict rather than hiding inside line 1.
    const vsFusion = entry.rerankMinusFusion
    if (vsFusion !== undefined && vsFusion !== null) {
      const failed = entry.okRerankVsFusion === false
      if (failed) regressed = true
      console.log(`  [硬线] ${label} hybrid+rerank − hybrid+no-rerank = ${vsFusion >= 0 ? '+' : ''}${vsFusion.toFixed(4)}${failed ? '  ✗ 精排劣于融合序' : '  ✓ 通过'}`)
    }
  }
  verdict('之前', left)
  verdict('之后', right)
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
      const flag = kind === 'observe' ? ' · 观察'
        : worse ? (kind === 'cost' ? ' ✗ 变慢' : ' ✗ 回退')
          : better ? (kind === 'cost' ? ' ✓ 更快' : ' ✓ 提升') : ''
      // Only a QUALITY regression fails the command: cost and observation
      // numbers are context, never verdicts.
      if (kind === 'quality' && worse) regressed = true
      console.log(`  ${config.padEnd(24)} ${metric.padEnd(12)} ${previous} → ${value} (${delta >= 0 ? '+' : ''}${delta.toFixed(4)})${flag}`)
    }
  }
  return regressed ? 1 : 0
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
    console.log(`已删除 evals/${label}${before === 0 ? '(本来就不存在)' : ''}`)
  }
  const kept = await stat(GOLDENS).catch(() => null)
  console.log(`保留 evals/goldens(${kept === null ? '尚未创建' : '人写的金标集,要版本化'}) · 缓存目录 ${path.relative(REPO, CACHE)} 也清了的话下次判分会重新调用模型`)
  console.log(`提示:报告里的耐久数字副本在 docs/设计_公开基准测评-BEIR-CoIR-RGB.md,清理不会丢结论`)
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
      console.log(`用法: clue bench <命令>

  index                     汇总 evals/runs/*.json → evals/runs/INDEX.json
  list                     列出索引里的报告(数据集/查询数/嵌入/判分版本/是否通过)
  diff <a> <b>             两份报告逐指标对比(回退即 exit 1)
  clean --datasets|--runs|--cache|--all
                           清理评测产物(数据/报告/判分缓存;金标集与文档结论保留)

取数与跑分仍是专用脚本(数据格式与长耗时都不同,不藏在 dispatcher 后面):
  node scripts/bench-beir.mjs --dataset <nfcorpus|scifact|coir-cosqa> …
  node scripts/fetch-coir.mjs --task cosqa --cap 1200
  node scripts/bench-rag.mjs --records 3 [--judge-provider qwen --judge-model qwen3.8-max]

产物都在 evals/(已 gitignore),可整体删除;耐久数字与结论在 docs/设计_公开基准测评-BEIR-CoIR-RGB.md`)
      return 0
    case 'index': return index()
    case 'list': return list()
    case 'diff': {
      const [a, b] = rest
      if (a === undefined || b === undefined) { console.error('diff 需要两份报告(id 或文件名,见 clue bench list)'); return 2 }
      return diff(a, b)
    }
    case 'clean': {
      if (scope === null) { console.error('clean 需要 --datasets | --runs | --cache | --all'); return 2 }
      return clean(scope)
    }
    default:
      console.error(`未知 bench 子命令:${verb}(index|list|diff|clean)`)
      return 2
  }
}

/** Where the eval home lives (kept for the design's `<home>/eval-cache` variant). */
export function evalCacheDir(): string {
  return path.join(clueHome(), 'eval-cache')
}
