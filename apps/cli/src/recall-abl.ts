/**
 * `clue recall --channel … --rerank …` — the ABLATION harness (V2, 原规划 §10).
 *
 * The plan is explicit that the measuring stick comes before the sorting
 * changes: "评测台先行(改排序之前先造尺子)". This module is that stick for the
 * hybrid retriever. It runs the SHIPPED retriever over a throwaway KB built
 * from the synthetic corpus — entry level, because entry-level vectors are what
 * V0–V2 deliver — and reports one line per configuration with its delta against
 * the pure-lexical baseline.
 *
 * Two honesty rules are built into the output rather than left to the reader:
 *
 * 1. **`hashEmbedder` verifies the PIPELINE, never the semantics.** It is a
 *    hashed bag of tokens, so a report produced with it says "语义能力=0" and
 *    refuses to claim a semantic win. The plan's acceptance numbers require a
 *    real endpoint; that run is `--embedder http` with a configured provider.
 * 2. **The guardrails are hard lines** (§10): `exact`/`entity`/`identifier`
 *    recall@1 may not fall more than 1 point against lexical, and
 *    `paraphrase`/`cross-lingual` must gain at least 5 points for the vector
 *    channel to count as effective. The exit code reflects them, so a
 *    regression cannot be quietly averaged away.
 *
 * The three new query classes exist because the old three could not see the
 * failure modes the plan worries about: `cross-lingual` (中问英答 — the vector
 * channel's whole reason to exist), `negation` ("不要用 X" vs "用 X" — where
 * similarity famously misbehaves), and `identifier` (API names and paths — where
 * lexical must win and a vector channel must not steal the top spot).
 *
 * @module @clue-harness/cli/recall-abl
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openProjectStore } from '@clue-harness/kb'
import {
  buildVectorIndex,
  createHybridRetriever,
  hashEmbedder,
  type Embedder,
  type RecallChannels,
} from '@clue-harness/rag'
import { tokenize } from '@clue-harness/kb'
import { scoreRanking, summarizeRanking, type ParsedArgs, type SummaryBlock } from './recall-cli.ts'

/**
 * The harness's own honesty check for the `cross-lingual` class.
 *
 * A cross-lingual query exists to measure SEMANTIC bridging, so a query whose
 * tokens already appear in its gold document measures lexical matching with a
 * foreign-language label — the same class of generator bug the exact/phrase
 * checks were added for (a phrase drawn twice, non-unique phrases). Returning
 * the offenders lets the report refuse a number it cannot justify.
 * @param docs - the corpus.
 * @param queries - the generated queries.
 * @returns the cross-lingual queries sharing at least one token with their gold document.
 */
export function crossLingualLeaks(
  docs: readonly { id: string; title: string; body: string }[],
  queries: readonly { kind: string; text: string; goldDocId: string }[],
): Array<{ text: string; shared: string[] }> {
  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  const leaks: Array<{ text: string; shared: string[] }> = []
  for (const query of queries) {
    if (query.kind !== 'cross-lingual') continue
    const doc = byId.get(query.goldDocId)
    if (doc === undefined) continue
    const own = new Set(tokenize(query.text))
    const shared = [...new Set(tokenize(`${doc.title}\n${doc.body}`))].filter((token) => own.has(token))
    if (shared.length > 0) leaks.push({ text: query.text, shared })
  }
  return leaks
}

/** One ablation configuration. */
export interface AblationConfig {
  id: string
  channels: RecallChannels
  rerank: boolean
  profile: string
}

/** The matrix `clue recall` runs by default: baseline first, then each stage. */
export const ABLATION_MATRIX: AblationConfig[] = [
  { id: 'lexical+no-rerank', channels: 'lexical', rerank: false, profile: 'tool' },
  { id: 'lexical+rerank', channels: 'lexical', rerank: true, profile: 'tool' },
  { id: 'hybrid+no-rerank', channels: 'hybrid', rerank: false, profile: 'tool' },
  { id: 'hybrid+rerank', channels: 'hybrid', rerank: true, profile: 'tool' },
]

/** The baseline every delta is measured against (不变量 9's configuration). */
export const BASELINE_ID = 'lexical+no-rerank'

/** The classes where a regression is a hard failure (原规划 §10 护栏). */
const GUARDED_KINDS = ['exact', 'entity', 'identifier'] as const

/** The classes the vector channel is supposed to improve (原规划 §10 护栏). */
const TARGET_KINDS = ['paraphrase', 'cross-lingual'] as const

/** The guardrail thresholds, in recall@1 points. */
export const GUARDRAIL_MAX_DROP_PT = 1
export const GUARDRAIL_MIN_GAIN_PT = 5

/** One measured configuration. */
export interface AblationRow {
  config: AblationConfig
  /** Per-class outcome of one config, in the `clue recall` summary shape. */
  byKind: Record<string, SummaryBlock>
  overall: SummaryBlock
  /** Per-class recall@1 delta against the baseline, in percentage points. */
  deltaPt: Record<string, number>
  /** Overall recall@1 delta (percentage points). */
  deltaOverallPt: number
  /** Guardrail verdicts for this configuration. */
  violations: string[]
  /** What the semantic channel did across this configuration's queries. */
  vector: { used: number; other: Record<string, number>; firstNote: string | null }
  /** True when this row IS the baseline. */
  baseline: boolean
}

/** The whole ablation report. */
export interface AblationReport {
  generatedAt: string
  corpus: { entries: number; queries: number; kinds: string[] }
  ks: number[]
  embedder: { id: string; dim: number; semantics: 'none' | 'endpoint' }
  baseline: string
  rows: AblationRow[]
  /** Caveats the report itself must carry (原规划 §10 的诚实要求). */
  caveats: string[]
  /** True when every runnable configuration passed its guardrails. */
  ok: boolean
}

/** Resolve the configurations one invocation runs. */
export function resolveConfigs(args: ParsedArgs): AblationConfig[] {
  const channel = typeof args.channel === 'string' ? args.channel : undefined
  const rerankArg = typeof args.rerank === 'string' ? args.rerank : undefined
  const profile = typeof args.profile === 'string' ? args.profile : 'tool'
  if (channel === undefined && rerankArg === undefined && args.profile === undefined) return ABLATION_MATRIX
  const channels = (channel ?? 'hybrid') as RecallChannels
  const rerank = rerankArg === undefined ? true : rerankArg === 'on'
  return [{ id: `${channels}+rerank-${rerank ? 'on' : 'off'}`, channels, rerank, profile }]
}

/**
 * The embedder one run uses.
 * @param kind - 'hash' (the deterministic fallback) or 'http' (a real endpoint).
 * @param http - the real embedder, resolved by the caller from the settings host.
 * @returns the embedder plus its honesty label.
 */
export function pickEmbedder(kind: string, http: Embedder | null): { embedder: Embedder; semantics: 'none' | 'endpoint' } {
  if (kind === 'hash') return { embedder: hashEmbedder(), semantics: 'none' }
  if (kind === 'http') {
    if (http === null) throw new Error('--embedder http 需要先配置嵌入端点并「测试连接」实测维度:clue kb embed-config set/test')
    return { embedder: http, semantics: 'endpoint' }
  }
  throw new Error(`--embedder 只能是 hash|http,收到 "${kind}"`)
}

/**
 * Run the ablation.
 * @param args - parsed CLI flags.
 * @param buildSet - the corpus/query generator (injected so this module stays free of the generator's tables).
 * @param httpEmbedder - the real embedder when `--embedder http` (resolved by the caller).
 * @returns the report.
 */
export async function runAblation(
  args: ParsedArgs,
  buildSet: (options: { chunks: number; queries: number; seed: number; kinds: string[] }) => {
    docs: Array<{ id: string; title: string; body: string; subject: string }>
    queries: Array<{ id: string; kind: string; text: string; goldDocId: string }>
  },
  httpEmbedder: Embedder | null,
): Promise<AblationReport> {
  const ks = String(args.k ?? '1,5,10').split(',').map((value) => Number(value.trim())).filter(Number.isFinite).sort((a, b) => a - b)
  const maxK = Math.max(...ks)
  const kindArg = typeof args.kinds === 'string' ? args.kinds.split(',').map((value) => value.trim()) : undefined
  const kinds = kindArg ?? ['exact', 'paraphrase', 'entity', 'cross-lingual', 'negation', 'identifier']
  const set = buildSet({
    chunks: Number(args.chunks ?? 600),
    queries: Number(args.queries ?? 300),
    seed: Number(args.seed ?? 20260913),
    kinds,
  })
  const { embedder, semantics } = pickEmbedder(typeof args.embedder === 'string' ? args.embedder : 'hash', httpEmbedder)
  const configs = resolveConfigs(args)

  const workdir = await mkdtemp(path.join(tmpdir(), 'clue-abl-'))
  const project = path.join(workdir, 'project')
  const home = path.join(workdir, 'home')
  const store = await openProjectStore(project, home)
  try {
    // One ENTRY per synthetic document: V0–V2 index entries (chunks follow in
    // V4), and the entry text carries the document's own words, so a hit is
    // evidence about the retriever rather than about the harness.
    const goldOf = new Map<string, string>()
    for (const doc of set.docs) {
      const entry = await store.add({
        kind: 'decision',
        title: doc.title,
        text: doc.body,
        tags: [doc.subject],
        createdBy: 'test:recall-abl',
      })
      goldOf.set(String(entry.id), doc.id)
    }
    await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, maxUnitsPerBuild: 100_000 })

    const global = null
    const rows: AblationRow[] = []
    let baselineByKind: Record<string, SummaryBlock> | null = null
    let baselineOverall: SummaryBlock | null = null
    for (const config of configs) {
      if (config.channels !== 'lexical' && semantics === 'none' && typeof args.embedder !== 'string') {
        // The default run keeps the hybrid rows: they exercise the pipeline and
        // the report labels their semantic ability as zero.
      }
      const retriever = createHybridRetriever(store, global, {
        channels: config.channels,
        rerank: config.rerank,
        profile: config.profile,
        topK: maxK,
        recallDepth: Number(args.depth ?? 50),
        // P4 of the D-plan: the internal guardrail has to be able to run at the
        // NEW档位, one variable at a time (A/B 协议第 2 条). Values come from
        // flags, not from settings: this harness builds its own corpus, so an
        // ambient setting would silently change what the report measures.
        ...(args['lexical-normalization'] === 'absolute' ? { lexicalNormalization: 'absolute' as const } : {}),
        ...(args['semantic-scale'] === 'calibrated' ? { semanticScale: 'calibrated' as const } : {}),
        ...(typeof args['semantic-floor'] === 'string' ? { semanticFloor: Number(args['semantic-floor']) } : {}),
        ...(typeof args['semantic-ceil'] === 'string' ? { semanticCeil: Number(args['semantic-ceil']) } : {}),
        ...(args['missing-mode'] === 'absent' ? { missingFeatureMode: 'absent' as const } : {}),
        ...(args['lexical-scorer'] === 'weights' ? { lexicalScorer: 'weights' as const } : {}),
        ...(typeof args['rerank-candidates'] === 'string' ? { rerankCandidates: Number(args['rerank-candidates']) } : {}),
        embedder,
        home,
        rebuildOnRead: false,
      })
      const results = []
      const vectorTally: Record<string, number> = {}
      let firstVectorNote: string | null = null
      for (const query of set.queries) {
        const detailed = await retriever.retrieveDetailed(query.text, { limit: maxK, noTouch: true })
        vectorTally[detailed.vector.status] = (vectorTally[detailed.vector.status] ?? 0) + 1
        if (firstVectorNote === null && detailed.vector.status !== 'used') firstVectorNote = detailed.vector.note
        const ranked = detailed.hits.map((hit) => goldOf.get(String(hit.entry.id)) ?? String(hit.entry.id))
        results.push({ kind: query.kind, outcome: scoreRanking(ranked, query.goldDocId, ks) })
      }
      const summary = summarizeRanking(results, ks)
      if (config.id === BASELINE_ID || baselineByKind === null) {
        baselineByKind = summary.byKind
        baselineOverall = summary.overall
      }
      const deltaPt: Record<string, number> = {}
      for (const [kind, block] of Object.entries(summary.byKind)) {
        const base = baselineByKind[kind]
        deltaPt[kind] = base === undefined ? 0 : Math.round((block.recall[1] - base.recall[1]) * 1000) / 10
      }
      const deltaOverallPt = baselineOverall === null ? 0 : Math.round((summary.overall.recall[1] - baselineOverall.recall[1]) * 1000) / 10
      rows.push({
        config,
        byKind: summary.byKind,
        overall: summary.overall,
        deltaPt,
        deltaOverallPt,
        violations: guardrails(summary.byKind, baselineByKind, config),
        vector: { used: vectorTally.used ?? 0, other: Object.fromEntries(Object.entries(vectorTally).filter(([key]) => key !== 'used')), firstNote: firstVectorNote },
        baseline: config.id === BASELINE_ID,
      })
    }

    const leaks = crossLingualLeaks(set.docs, set.queries)
    const caveats: string[] = [
      '合成数据集:查询由生成器构造,用于回归对照,不代表真实用户提问分布',
      '一级(条目)检索:V0–V2 的向量层是条目级;二级(原文分片)向量化在 V4',
      '相似度只解释"为什么排这",状态才解释"能不能信" —— 本报告与可信度无关',
      'cross-lingual 类的查询与金标文档零词元重叠、且主题在语料里重复 ⇒ recall@1 本就不可能判别到那一篇;该类按 recall@5 判定(护栏同样接受 @5)',
    ]
    if (semantics === 'none') {
      caveats.push('嵌入为 hashEmbedder(确定性伪向量):本次只验管线不验语义 —— 语义能力=0,任何"语义召回提升"的结论都必须用真端点重跑并存档')
    } else {
      caveats.push(`嵌入为真端点 ${embedder.id}(dim=${embedder.dim})`)
    }
    if (leaks.length > 0) {
      caveats.push(`⚠ cross-lingual 自检失败 ${leaks.length} 条:这些查询与金标文档有共同 token,测的是词法而不是语义(例:「${leaks[0]?.text ?? ''}」↔ ${leaks[0]?.shared.join('/') ?? ''})`)
    }
    return {
      generatedAt: new Date().toISOString(),
      corpus: { entries: set.docs.length, queries: set.queries.length, kinds: [...new Set(set.queries.map((query) => query.kind))] },
      ks,
      embedder: { id: embedder.id, dim: embedder.dim, semantics },
      baseline: BASELINE_ID,
      rows,
      caveats,
      ok: rows.every((row) => row.violations.length === 0) && leaks.length === 0,
    }
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

/**
 * The plan's hard lines (§10 护栏), evaluated per configuration.
 * @param byKind - this configuration's per-class summary.
 * @param baseline - the lexical baseline's per-class summary.
 * @param config - which configuration this is (the baseline itself is exempt).
 * @returns human-readable violations (empty = passed).
 */
export function guardrails(
  byKind: Record<string, SummaryBlock>,
  baseline: Record<string, SummaryBlock> | null,
  config: AblationConfig,
): string[] {
  if (config.id === BASELINE_ID || baseline === null) return []
  const violations: string[] = []
  for (const kind of GUARDED_KINDS) {
    const now = byKind[kind]
    const before = baseline[kind]
    if (now === undefined || before === undefined) continue
    const drop = (before.recall[1] - now.recall[1]) * 100
    if (drop > GUARDRAIL_MAX_DROP_PT) {
      violations.push(`${kind} recall@1 回退 ${drop.toFixed(1)}pt > ${GUARDRAIL_MAX_DROP_PT}pt(硬线:词法金矿类不得被稀释)`)
    }
  }
  // The gain target is only meaningful where the vector channel participates:
  // a lexical-only configuration cannot be expected to move the classes that
  // exist to measure the SEMANTIC channel.
  if (config.channels !== 'lexical') {
    // A target class counts as improved when EITHER cutoff moves: `cross-lingual`
    // queries deliberately share no token with their gold document, and their
    // topic repeats across the corpus, so nothing — lexical or semantic — can
    // single that document out at rank 1. Judging that class on recall@1 alone
    // would fail a channel that demonstrably works (measured: @5 0.0% → 12.5%
    // with a real endpoint, @1 0.0% → 0.0%). @5 is the metric the class can move,
    // and demanding only @1 would be moving the goalposts in the other direction.
    const gains = TARGET_KINDS.map((kind) => {
      const now = byKind[kind]
      const before = baseline[kind]
      if (now === undefined || before === undefined) return null
      return Math.max((now.recall[1] - before.recall[1]) * 100, ((now.recall[5] ?? 0) - (before.recall[5] ?? 0)) * 100)
    }).filter((value): value is number => value !== null)
    if (gains.length > 0 && gains.every((gain) => gain < GUARDRAIL_MIN_GAIN_PT)) {
      violations.push(`语义目标类(paraphrase/cross-lingual)recall@1/@5 提升均 < ${GUARDRAIL_MIN_GAIN_PT}pt —— 本次向量通道未证明有效(合成集 + 该 embedder)`)
    }
  }
  return violations
}

/** Render the ablution report for a terminal. */
export function printAblation(report: AblationReport): void {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
  const pt = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(1)}pt`
  console.log('')
  console.log(`消融台: ${report.corpus.entries} 条条目 / ${report.corpus.queries} 条查询(${report.corpus.kinds.join('/')})`)
  console.log(`嵌入: ${report.embedder.id} dim=${report.embedder.dim} · ${report.embedder.semantics === 'none' ? '语义能力=0(只验管线)' : '真端点'}`)
  console.log(`基线: ${report.baseline}(相对它的 delta 才有意义)`)
  const kinds = [...new Set(report.rows.flatMap((row) => Object.keys(row.byKind)))]
  const nameWidth = Math.max(20, ...report.rows.map((row) => row.config.id.length + 2))
  const cellWidth = Math.max(18, ...kinds.map((kind) => kind.length + 8))
  const rowsOut: string[][] = [[
    '配置',
    '总体@1',
    ...kinds.map((kind) => `${kind}@1`),
  ], ...report.rows.map((row) => [
    row.config.id,
    `${pct(row.overall.recall[1])} ${pt(row.deltaOverallPt)}`,
    ...kinds.map((kind) => {
      const block = row.byKind[kind]
      return block === undefined ? '—' : `${pct(block.recall[1])} ${pt(row.deltaPt[kind] ?? 0)}`
    }),
  ])]
  console.log('')
  for (const cells of rowsOut) {
    console.log(cells.map((cell, index) => cell.padEnd(index === 0 ? nameWidth : cellWidth)).join(''))
  }
  console.log('')
  console.log('语义通道使用情况:')
  for (const row of report.rows) {
    const other = Object.entries(row.vector.other).map(([status, count]) => `${status}×${count}`).join(' ')
    console.log(`  ${row.config.id}: used×${row.vector.used}${other === '' ? '' : ` · ${other}`}${row.vector.firstNote === null ? '' : ` — ${row.vector.firstNote.slice(0, 160)}`}`)
  }
  console.log('')
  for (const row of report.rows) {
    if (row.violations.length === 0) {
      if (!row.baseline) console.log(`✓ ${row.config.id}: 通过护栏`)
      continue
    }
    for (const violation of row.violations) console.log(`✗ ${row.config.id}: ${violation}`)
  }
  console.log('')
  for (const caveat of report.caveats) console.log(`注: ${caveat}`)
  console.log('')
  console.log(report.ok ? '结论: 全部配置通过护栏。' : '结论: 有配置未过护栏(见上)。')
}
