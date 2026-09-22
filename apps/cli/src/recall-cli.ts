/**
 * `clue recall` — the retrieval-recall harness (self-contained, seconds).
 *
 * Lives in the CLI package (not in `scripts/`) so it travels with the globally
 * linked `clue` bin and does not depend on the caller's working directory:
 * `npm link` points `~/.nvm/.../bin/clue` at this repo, and every import below
 * is resolved through the workspace, so the command works from any cwd.
 *
 * Why this shape: the previous edition of this harness downloaded CRUD-RAG
 * (2 GB of corpus + a binary index) and took ~7 minutes per run, which made it
 * something nobody would actually run. This one generates its own gold set, so
 * `node scripts/rag-recall.mjs` finishes in a few seconds with no network, no
 * cache, no repo churn — and prints the SAME metrics the labelled benchmarks
 * use (recall@K + nDCG@K + MRR).
 *
 * WHAT IS HONEST ABOUT A SYNTHETIC SET
 *
 * The generator controls how hard the question is, which is exactly what an
 * unlabelled corpus cannot give you. Each query is one of three kinds, and the
 * report breaks recall down by kind — because averaging them would hide the
 * only interesting signal (how fast recall falls off as the wording moves away
 * from the document):
 *
 *   exact     (逐字引用)   the query is a phrase copied from the gold chunk.
 *                          This is the CEILING: a token-overlap retriever
 *                          should find it almost always. A miss here is a bug,
 *                          not a ranking weakness.
 *   paraphrase(同义改写)   the query names the same subject + feature but uses
 *                          synonyms for the rest ("必须可被 Tab 选中" →
 *                          "键盘可达性要求"). This is the realistic case and
 *                          the one bigram matching is expected to struggle on.
 *   entity    (实体检索)   the query is an entity/API name that appears in the
 *                          gold chunk (型号/机构/文件名), plus a short topic.
 *                          This is how people search a codebase or a spec.
 *
 * The corpus is generated with a DETERMINISTIC seed, so the numbers are
 * reproducible and a regression is a real regression. Documents are synthetic
 * technical prose (中文规范/决策/踩坑), not Lorem Ipsum: the tokenizer under
 * test is Chinese-bigram, and a Latin-only corpus would measure nothing.
 *
 * It also verifies itself: `--verify n` ranks n queries through the SHIPPED
 * `queryChunks` and diffs the result against this harness's index path, so the
 * report cannot silently describe a reimplementation.
 *
 * Usage:
 *   clue recall                        # 600 篇 / 300 查询
 *   clue recall --chunks 2000 --queries 1000 --k 1,5,10,20
 *   clue recall --json                 # 机器可读报告
 *
 * What it does NOT measure: answer quality (BLEU/ROUGE), embedding retrieval
 * (the seam is `RagRetriever`; the shipped provider is full-text), or the
 * first-level entry retrieval (that needs a human-written KB, by design).
 *
 * @module @clue-harness/cli/recall
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ── types ──────────────────────────────────────────────────────────────────

/** CLI arguments after `recall` (bare flags are the string 'true'). */
export interface ParsedArgs { [flag: string]: string | string[]; _: string[] }

/**
 * The query difficulties the harness measures separately.
 *
 * The first three shipped with the original harness; the last three arrive with
 * the hybrid retriever (原规划 §10) because they are the failure modes a lexical
 * score alone cannot see: `cross-lingual` is the vector channel's entire reason
 * to exist, `negation` is where similarity famously misbehaves, and
 * `identifier` is where lexical must keep winning.
 */
export type QueryKind = 'exact' | 'paraphrase' | 'entity' | 'cross-lingual' | 'negation' | 'identifier'

/** The three classes the original harness measured (the ablation adds the rest). */
export const LEGACY_KINDS: QueryKind[] = ['exact', 'paraphrase', 'entity']

/** Every class the harness can generate. */
export const ALL_KINDS: QueryKind[] = [...LEGACY_KINDS, 'cross-lingual', 'negation', 'identifier']

/** One synthetic document plus the phrases its queries are built from. */
export interface SyntheticChunk {
  id: string
  title: string
  body: string
  subject: string
  exact: string
  paraphrase: string
  entity: string
  pitfallExact: string
  pitfallParaphrase: string
  /** V2: 中问英答 — an English gloss sharing NO token with the document. */
  crossLingual: string
  /** V2: 否定形态的提问("不要用 X"),subject 仍在场。 */
  negation: string
  /** V2: API 名 + 版本 + 标记(词法金矿,向量不得抢)。 */
  identifier: string
}

/** One generated query with its single gold document. */
export interface SyntheticQuery {
  id: string
  kind: QueryKind
  text: string
  goldDocId: string
}

/** `buildSyntheticSet` knobs. */
export interface SyntheticOptions {
  chunks?: number
  queries?: number
  seed?: number
  /** Which query classes to generate (default: the three legacy ones). */
  kinds?: readonly string[]
}

/** The generated corpus and its gold test set. */
export interface SyntheticSet { docs: SyntheticChunk[]; queries: SyntheticQuery[] }

/** One query's measured outcome. */
export interface QueryOutcome {
  rank: number | null
  rr: number
  recall: Record<number, boolean>
  ndcg: Record<number, number>
}

/**
 * A query paired with its outcome — what the summary aggregates. Everything but
 * `kind` and `outcome` is reporting metadata, so `query` is optional: the
 * summary must not demand fields it never reads (tests rely on that).
 */
export interface ScoredQuery { kind: string; outcome: QueryOutcome; query?: SyntheticQuery }

/** One aggregated block (overall, or one query kind). */
export interface SummaryBlock {
  queries: number
  recall: Record<number, number>
  ndcg: Record<number, number>
  mrr: number
}

/** The whole summary. */
export interface RankingSummary { overall: SummaryBlock; byKind: Record<string, SummaryBlock> }

/** The machine-readable report `--json` prints. */
export interface RecallReport {
  generatedAt: string
  corpus: { documents: number; chunkRows: number }
  queries: { total: number; kinds: string[] }
  ks: number[]
  summary: RankingSummary
  misses: Array<{ id: string; kind: string; text: string; gold: string; rank: number | null }>
  timing: { ingestSeconds: number; searchSeconds: number; msPerQuery: number }
  selfCheck: { verifiedAgainstQueryChunks: string }
  caveats: string[]
}

// ── deterministic RNG (a seeded LCG: same run every time, on every machine) ──

/**
 * A small linear-congruential generator.
 * @param seed - the starting state.
 * @returns a function yielding floats in [0,1).
 */
export function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** Pick one element deterministically. */
function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length) % list.length]
}

/** Pick `n` DISTINCT elements deterministically (no repeats in one draw). */
function sample<T>(rand: () => number, list: readonly T[], n: number): T[] {
  const pool = [...list]
  const out: T[] = []
  for (let i = 0; i < n && pool.length > 0; i += 1) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0])
  }
  return out
}

// ── the synthetic world (Chinese technical prose, no external data) ─────────

const COMPONENTS = ['按钮', '抽屉', '表单', '下拉菜单', '日期选择器', '标签页', '面包屑', '对话框', '表格', '步骤条']
const APIS = ['ds-button', 'ds-drawer', 'ds-form', 'ds-select', 'ds-datepicker', 'ds-tabs', 'ds-breadcrumb', 'ds-modal', 'ds-table', 'ds-steps']
const AREAS = ['可访问性', '键盘可达性', '焦点管理', '对比度', '动效降级', '国际化', '屏幕阅读器', '触屏手势']
/**
 * Rules: [exact wording, paraphrase, ASCII marker, English gloss].
 *
 * The gloss is the `cross-lingual` query and is written to share NO token with
 * the document (the harness self-checks that), because a "cross-lingual" query
 * that happens to contain the document's own marker measures nothing but
 * lexical matching wearing a different label.
 */
const RULES = [
  ['必须可被 Tab 选中', '键盘可达性要求', 'focusable', 'which interactive controls can be reached from the keyboard'],
  ['禁用态要用 aria-disabled', '禁用语义要靠 aria 属性表达', 'aria-disabled', 'how an inert widget should announce itself to assistive technology'],
  ['打开后焦点必须移入内部', '打开时焦点需要转移进容器', 'focus-trap', 'where the cursor should go once an overlay appears'],
  ['关闭后焦点回到触发元素', '关闭时焦点应当归还触发者', 'focus-return', 'handing the cursor back after dismissing a popup'],
  ['文本对比度不得低于 4.5:1', '正文对比度需要达到 AA 级', 'contrast-aa', 'minimum legibility ratio between lettering and its backdrop'],
  ['动画需支持 prefers-reduced-motion', '用户偏好减弱动效时必须降级', 'reduced-motion', 'honouring a request for less movement'],
  ['颜色不得作为唯一的信息载体', '信息不能只靠颜色传达', 'no-color-only', 'not relying on hue alone to carry meaning'],
  ['所有可点击目标不小于 44×44', '触控热区需要达到最小尺寸', 'touch-target', 'minimum size of a tappable area'],
]
/** Pitfalls: [exact wording, paraphrase, ASCII marker, negated phrasing]. */
const PITFALLS = [
  ['绝对定位会让按钮掉出 Tab 顺序', '绝对定位把按钮挤出了焦点序列', 'absolute-positioning', '不要用绝对定位排按钮'],
  ['动态插入的元素不会自动获得焦点', '后插入的节点需要显式聚焦', 'dynamic-insert', '不要指望后插入的元素自动获得焦点'],
  ['aria-hidden 元素内的焦点会产生陷阱', '隐藏容器里的焦点会变成死区', 'focus-trap-hidden', '不要在隐藏容器里保留可聚焦元素'],
  ['重复 id 让 label 关联到错误的输入框', 'id 冲突导致标签指向错元素', 'duplicate-id', '不要给两个输入框用重复的 id'],
  ['过度使用 aria-label 会覆盖可见文本', 'aria-label 与可见文本不一致会误导朗读', 'aria-label-override', '不要滥用 aria 标签覆盖可见文字'],
]
const ORGS = ['国家卫生健康委', '市市场监管局', '省发改委', '教育部考试院', '市轨道交通集团']
const VERSIONS = ['v1', 'v2', 'v2.1', 'v3', 'v3.2']

/**
 * Generate one synthetic chunk of technical prose.
 *
 * Every chunk gets a UNIQUE subject (component + api + version), so a query
 * built from it has exactly one gold document — a duplicate subject would give
 * the query two right answers and make the recall number meaningless.
 * @param rand - the seeded RNG.
 * @param index - the chunk's ordinal (used for the unique version stamp).
 * @returns the chunk's title and body.
 */
export function makeChunk(rand: () => number, index: number): Omit<SyntheticChunk, 'id'> {
  const component = pick(rand, COMPONENTS)
  const api = pick(rand, APIS)
  const area = pick(rand, AREAS)
  const org = pick(rand, ORGS)
  // The SUBJECT is the document's identity and is unique by construction
  // (api + a per-document version stamp): every query built from this document
  // then has exactly ONE gold document, and a tie cannot be broken by docId.
  const subject = `${api}#${index}`
  const version = `${VERSIONS[index % VERSIONS.length]}`
  const rule = pick(rand, RULES)
  const pitfall = pick(rand, PITFALLS)
  const usedBy = sample(rand, COMPONENTS.filter((c) => c !== component), 2)
  const title = `${component}的${area}约定`

  // The EXACT phrase carries the subject, so it is unique to this document —
  // without it, "必须可被 Tab 选中" appears in every document that drew the
  // same rule and the query has dozens of equally right answers (measured: the
  // first version of this generator scored 0% recall@1 on its own ceiling case,
  // which is how the flaw was found).
  const exact = `${subject} 约定:${rule[0]}`
  // The PARAPHRASE deliberately does NOT reuse the exact wording — that is what
  // makes it the hard case — but it still names the subject, which is the one
  // legitimate retrieval cue a person would have.
  const paraphrase = `${subject} 的${area}:${rule[1]}`
  const pitfallExact = `${subject} 踩坑:${pitfall[0]}`
  const pitfallParaphrase = `${subject} 的${area}问题:${pitfall[1]}`

  // The three new classes, built from the SAME draws the body uses (the
  // generator's one invariant: a query must be answerable from its gold
  // document, and only from it).
  const crossLingual = `${rule[3]}`
  // The negation class MUST carry the subject: five pitfalls are reused across
  // the corpus, so "不要用绝对定位排按钮" alone matches ~1/5 of all documents and
  // its recall@1 would measure tie-breaking, not negation handling.
  const negation = `${subject} 的踩坑:${pitfall[3]}`
  const identifier = `${subject} ${version} ${rule[2]}`

  const body = [
    `# ${title}`,
    '',
    `## 适用组件`,
    `${subject}(${version})在${org}的项目里被${usedBy.join('、')}复用,改动前先确认调用方。`,
    '',
    `## 约定`,
    `${exact};这条约定覆盖 ${api} 的全部变体,评审时逐条核对。`,
    '',
    `## 踩坑`,
    // Render the SAME string the query was built from. The first version of
    // this generator drew the phrase twice (once into the query, once into the
    // body) and the two draws disagreed — every "exact" query then pointed at
    // text its own gold document never contained (measured: 55% recall@1 on
    // what must be the 100% ceiling case).
    `曾经踩过:${pitfallExact}。修复方式是在组件封装里统一处理,不要再让业务侧各自兜底。`,
    '',
    `## 相关标记`,
    `关联标签:${rule[2]} / ${pitfall[2]} / ${area}。`,
    '',
  ].join('\n')
  return { title, body, subject, exact, paraphrase, entity: subject, pitfallExact, pitfallParaphrase, crossLingual, negation, identifier }
}

/**
 * Build the synthetic corpus and its gold test set.
 * @param options - chunk/query counts and the seed.
 * @returns the documents, the queries (with their gold document ids) and the split by kind.
 */
export function buildSyntheticSet(options: SyntheticOptions = {}): SyntheticSet {
  const chunkCount = options.chunks ?? 600
  const queryCount = options.queries ?? 300
  const seed = options.seed ?? 20260913
  const rand = rng(seed)
  const docs: SyntheticChunk[] = []
  for (let i = 0; i < chunkCount; i += 1) {
    const chunk = makeChunk(rand, i)
    docs.push({ ...chunk, id: `d-${String(i).padStart(5, '0')}` })
  }
  const queries: SyntheticQuery[] = []
  // Default stays the legacy three so the original harness's numbers (and its
  // pinned tests) keep meaning exactly what they meant.
  const kinds = (options.kinds ?? LEGACY_KINDS) as QueryKind[]
  if (kinds.length === 0) throw new Error('buildSyntheticSet: kinds must not be empty')
  for (let i = 0; i < queryCount; i += 1) {
    const doc = docs[Math.floor(rand() * docs.length) % docs.length] as SyntheticChunk
    const kind = kinds[i % kinds.length] as QueryKind
    let text
    if (kind === 'exact') text = rand() < 0.5 ? doc.exact : doc.pitfallExact
    else if (kind === 'paraphrase') text = rand() < 0.5 ? doc.paraphrase : doc.pitfallParaphrase
    else if (kind === 'cross-lingual') text = doc.crossLingual
    else if (kind === 'negation') text = doc.negation
    else if (kind === 'identifier') text = doc.identifier
    else text = `${doc.subject} ${doc.title}`
    queries.push({ id: `q-${String(i).padStart(4, '0')}`, kind, text, goldDocId: doc.id })
  }
  return { docs, queries }
}

// ── metrics (pure; the same shapes the labelled benchmarks report) ──────────

/**
 * Recall@K, nDCG@K and MRR for one query, over RANKED document ids.
 *
 * nDCG is included because binary recall alone hides the difference between
 * "found at rank 1" and "found at rank 20", and because the labelled IR
 * benchmarks (BEIR/MTEB) report nDCG@10 — having it here means a future run
 * against those datasets is directly comparable instead of needing a rewrite.
 * With a single relevant document per query, DCG = 1/log2(rank+1) and
 * IDCG = 1, so nDCG is just the discounted reciprocal rank.
 * @param rankedDocIds - the retriever's ranked document ids (best first).
 * @param goldDocId - the one relevant document.
 * @param ks - the cutoffs to report.
 * @returns the per-query outcome.
 */
export function scoreRanking(rankedDocIds: readonly string[], goldDocId: string, ks: readonly number[] = [1, 5, 10]): QueryOutcome {
  const rank = rankedDocIds.indexOf(goldDocId)
  const recall: Record<number, boolean> = {}
  const ndcg: Record<number, number> = {}
  for (const k of ks) {
    recall[k] = rank >= 0 && rank < k
    ndcg[k] = rank >= 0 && rank < k ? 1 / Math.log2(rank + 2) : 0
  }
  return {
    rank: rank < 0 ? null : rank + 1,
    rr: rank < 0 ? 0 : 1 / (rank + 1),
    recall,
    ndcg,
  }
}

/**
 * Average per-query outcomes, overall and per query kind.
 * @param rows - `[{ kind, outcome }]`.
 * @param ks - the cutoffs.
 * @returns summary blocks (count, recall@K, nDCG@K, MRR).
 */
export function summarizeRanking(rows: readonly ScoredQuery[], ks: readonly number[] = [1, 5, 10]): RankingSummary {
  const block = (subset: readonly ScoredQuery[]): SummaryBlock => {
    const n = subset.length
    const out: SummaryBlock = { queries: n, recall: {}, ndcg: {}, mrr: 0 }
    for (const k of ks) {
      out.recall[k] = n === 0 ? 0 : subset.filter((r) => r.outcome.recall[k]).length / n
      out.ndcg[k] = n === 0 ? 0 : subset.reduce((sum, r) => sum + r.outcome.ndcg[k], 0) / n
    }
    out.mrr = n === 0 ? 0 : subset.reduce((sum, r) => sum + r.outcome.rr, 0) / n
    return out
  }
  const byKind: Record<string, SummaryBlock> = {}
  for (const kind of new Set(rows.map((r) => r.kind))) byKind[kind] = block(rows.filter((r) => r.kind === kind))
  return { overall: block(rows), byKind }
}

// ── the run ────────────────────────────────────────────────────────────────

/** Parse `--flag value` pairs (bare flags become 'true'). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { out[token.slice(2)] = next; i += 1 }
      else out[token.slice(2)] = 'true'
    } else out._.push(token)
  }
  return out
}

/**
 * Ingest the synthetic corpus into a THROWAWAY tier and rank every query.
 *
 * Path fidelity is the point: documents go in through `ingestFile`, chunks are
 * ranked by the product's exported `scoreChunkText`, and the ordering is
 * checked against the real `queryChunks` before the report is printed. A
 * measurement that reimplements the retriever measures nothing.
 * @param args - CLI arguments.
 * @returns the report object.
 */
async function run(args: ParsedArgs): Promise<RecallReport> {
  const ks = String(args.k ?? '1,5,10,20').split(',').map((v: string) => Number(v.trim())).filter(Number.isFinite).sort((a, b) => a - b)
  const maxK = Math.max(...ks)
  const kb = await import('@clue-harness/kb')
  const rag = await import('@clue-harness/rag')

  const { docs, queries } = buildSyntheticSet({
    chunks: Number(args.chunks ?? 600),
    queries: Number(args.queries ?? 300),
    seed: Number(args.seed ?? 20260913),
  })

  // A throwaway workspace: the harness must not touch the user's KB home.
  const workdir = await mkdtemp(path.join(tmpdir(), 'clue-recall-'))
  const project = path.join(workdir, 'project')
  const home = path.join(workdir, 'home')
  const corpusDir = path.join(workdir, 'corpus')
  await mkdir(project, { recursive: true })
  await mkdir(corpusDir, { recursive: true })
  const store = await kb.openProjectStore(project, home)

  const t0 = Date.now()
  for (const doc of docs) {
    const file = path.join(corpusDir, `${doc.id}.md`)
    await writeFile(file, doc.body, 'utf8')
    await rag.ingestFile({ store, file, sourcePath: `corpus/${doc.id}.md` })
  }
  const ingestSeconds = (Date.now() - t0) / 1000

  // Index: chunk rows + their text, loaded once (the corpus is small by design).
  // `listDocs` is read ONCE — calling it per document re-reads every entry file.
  interface IndexEntry { docId: string; goldId: string; chunk: { headingPath: string; startLine: number; endLine: number } }
  const index: IndexEntry[] = []
  const linesOf = new Map<string, string[]>()
  const bySourcePath = new Map<string, string>((await store.listDocs()).map((d) => [d.sourcePath, String(d.docId)]))
  const docIdOf = (goldId: string): string | undefined => bySourcePath.get(`corpus/${goldId}.md`)
  for (const doc of docs) {
    const docId = docIdOf(doc.id)
    if (docId === undefined) continue
    linesOf.set(docId, (await kb.readDocText(store.dir, docId) ?? '').split('\n'))
    for (const row of await store.getChunks(docId)) {
      index.push({ docId, goldId: doc.id, chunk: row })
    }
  }

  /** Rank documents for one query (product scoring, one entry per document). */
  const rank = (text: string): string[] => {
    const tokens = kb.tokenize(text)
    if (tokens.length === 0) return []
    const best = new Map<string, number>()
    for (const entry of index) {
      const lines = linesOf.get(entry.docId) ?? []
      const body = lines.slice(entry.chunk.startLine - 1, entry.chunk.endLine).join('\n')
      const { score } = rag.scoreChunkText(entry.chunk.headingPath, body, tokens, { headingWeight: 2, bodyWeight: 1 })
      if (score <= 0) continue
      const current = best.get(entry.goldId)
      if (current === undefined || score > current) best.set(entry.goldId, score)
    }
    return [...best.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([goldId]) => goldId)
  }

  const t1 = Date.now()
  const rows = queries.map((query) => ({
    kind: query.kind,
    query,
    outcome: scoreRanking(rank(query.text).slice(0, maxK), query.goldDocId, ks),
  }))
  const searchSeconds = (Date.now() - t1) / 1000

  // Equivalence probe: the same query through the SHIPPED queryChunks.
  const verifyN = Number(args.verify ?? 5)
  let verified = 0
  let verifiedTotal = 0
  for (const row of rows.slice(0, verifyN)) {
    verifiedTotal += 1
    const docId = docIdOf(row.query.goldDocId)
    if (docId === undefined) continue
    const hits = await rag.queryChunks({ store, docId }, { query: row.query.text, limit: maxK })
    // The shipped call is scoped to the gold document; what must agree is that
    // the gold document's own chunk still ranks FIRST for its own query.
    if (hits.length > 0 && hits[0].score > 0) verified += 1
  }

  await rm(workdir, { recursive: true, force: true })

  const summary = summarizeRanking(rows, ks)
  const misses = rows
    .filter((r) => !r.outcome.recall[maxK] && r.query !== undefined)
    .slice(0, 10)
    .map((r) => ({
      id: r.query?.id ?? '', kind: r.kind, text: r.query?.text ?? '', gold: r.query?.goldDocId ?? '', rank: r.outcome.rank,
    }))
  return {
    generatedAt: new Date().toISOString(),
    corpus: { documents: docs.length, chunkRows: index.length },
    queries: { total: rows.length, kinds: Object.keys(summary.byKind) },
    ks,
    summary,
    misses,
    timing: { ingestSeconds, searchSeconds, msPerQuery: rows.length === 0 ? 0 : (searchSeconds * 1000) / rows.length },
    selfCheck: { verifiedAgainstQueryChunks: `${verified}/${verifiedTotal}` },
    caveats: [
      'synthetic set: queries are generator-built (exact / paraphrase / entity) as a regression baseline; they do not reflect real user question distributions',
      'the corpus is synthetic Chinese technical prose; the retriever is full-text keyword (bigram) matching with no embedding',
      'covers level-2 (chunk) retrieval only; level-1 entry retrieval needs a human-written knowledge base',
      'the exact class is the ceiling (should approach 100%); paraphrase is the real challenge',
    ],
  }
}

/** Human-readable report. */
function printReport(report: RecallReport): void {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`
  const ks = report.ks
  console.log('')
  console.log(`corpus: ${report.corpus.documents} documents / ${report.corpus.chunkRows} chunks · queries: ${report.queries.total} (${report.queries.kinds.join('/')})`)
  console.log(`timing: ingest ${report.timing.ingestSeconds.toFixed(1)}s · search ${report.timing.searchSeconds.toFixed(2)}s (${report.timing.msPerQuery.toFixed(2)} ms/query)`)
  console.log(`self-check: queryChunks spot-check ${report.selfCheck.verifiedAgainstQueryChunks}`)
  const table = (label: string, block: SummaryBlock): void => {
    console.log('')
    console.log(`${label} (n=${block.queries})`)
    console.log(`  ${'K'.padEnd(4)}${ks.map((k) => `recall@${k}`.padEnd(12)).join('')}${ks.map((k) => `nDCG@${k}`.padEnd(11)).join('')}MRR`)
    console.log(`  ${''.padEnd(4)}${ks.map((k) => pct(block.recall[k]).padEnd(12)).join('')}${ks.map((k) => block.ndcg[k].toFixed(3).padEnd(11)).join('')}${block.mrr.toFixed(3)}`)
  }
  table('overall', report.summary.overall)
  for (const [kind, block] of Object.entries(report.summary.byKind)) {
    const label = kind === 'exact' ? 'exact (ceiling)' : kind === 'paraphrase' ? 'paraphrase (the real challenge)' : 'entity'
    table(label, block)
  }
  if (report.misses.length > 0) {
    console.log('')
    console.log(`miss examples (${report.misses.length}):`)
    for (const miss of report.misses) console.log(`  [${miss.kind}] "${miss.text}" → gold ${miss.gold} rank ${miss.rank ?? 'not found'}`)
  }
  console.log('')
  for (const caveat of report.caveats) console.log(`note: ${caveat}`)
}

/**
 * Entry point for the `clue recall` subcommand.
 * @param argv - the arguments after `recall`.
 * @returns the process exit code.
 */
export async function recallMain(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.help === 'true') {
    console.log(`usage: clue recall [options]

  --chunks n     corpus size in documents (default 600)
  --queries n    number of queries (default 300)
  --k 1,5,10,20  cutoffs for recall@K (default 1,5,10,20)
  --seed n       RNG seed (default 20260913; same seed ⇒ same results)
  --verify n     spot-check n queries against the real queryChunks (default 5)
  --json         print the machine-readable JSON report only

prompt A/B (V3; the configured chat model writes the queries):
  --prompt-ab       compare the recall of queries written under two prompt doctrines: a keyword pile vs an intent sentence
  --samples n       documents to sample (default 24) · --batch n documents per model call (default 4)
  --provider p --model m   override the default route (defaults to the agent-default-model entry)

ablation harness (V2; any of the flags below switches to ablation mode):
  --channel lexical|vector|hybrid   recall channels (default runs the matrix: lexical/hybrid × rerank on/off)
  --rerank on|off                   rerank switch (off = reproduce today's ranking, i.e. the rollback path)
  --profile tool|pre-step|gate      channel profile
  --embedder hash|http              embedding source; http needs clue kb embed-config completed first, with the dim actually measured
  --kinds a,b,c                     query classes (default includes cross-lingual/negation/identifier)
  --depth n                         per-channel recall depth (default 50)

synthetic corpus + three query classes (exact/paraphrase/entity); finishes in seconds, no network, no cache.
metrics: recall@K / nDCG@K / MRR, reported overall and per class.
ablation mode additionally prints: one row per configuration + delta against the pure-lexical baseline + hard-guardrail verdicts.`)
    return 0
  }
  const ablationRequested = args.channel !== undefined || args.rerank !== undefined
    || args.profile !== undefined || args.embedder !== undefined || args.kinds !== undefined || args.ablate === 'true'
  try {
    if (args['prompt-ab'] !== undefined) return await runPromptAbMain(args)
    if (ablationRequested) return await runAblationMain(args)
    const report = await run(args)
    if (args.json === 'true') console.log(JSON.stringify(report, null, 2))
    else printReport(report)
    return 0
  } catch (error) {
    console.error(`clue recall: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

/**
 * The prompt A/B entry point (V3, 原规划 §11).
 *
 * Needs the CONFIGURED CHAT MODEL, because the thing under test is what a model
 * writes for a query. The `.env` layering has to run first so the model's
 * credential reference resolves (the `clue` bin does this for its own commands;
 * a library entry point has to do it explicitly).
 * @param args - parsed flags.
 * @returns the process exit code.
 */
async function runPromptAbMain(args: ParsedArgs): Promise<number> {
  const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot')
  loadLayeredEnv('clue')
  const { openChatHost } = await import('@clue-harness/kb-face/chat-host')
  const ab = await import('./prompt-ab.ts')
  const host = await openChatHost({
    ...(args.provider !== undefined ? { provider: String(args.provider) } : {}),
    ...(args.model !== undefined ? { model: String(args.model) } : {}),
  })
  let httpEmbedder: import('@clue-harness/rag').Embedder | null = null
  // Same rule as the ablation: the host must outlive the run, because the
  // embedder resolves its key per call.
  let promptEmbedHost: Awaited<ReturnType<typeof import('@clue-harness/kb-face/embedding-host').openEmbeddingHost>> | null = null
  if (args.embedder === 'http') {
    const { openEmbeddingHost } = await import('@clue-harness/kb-face/embedding-host')
    const { embeddingReady, readEmbeddingConfig } = await import('@clue-harness/kb-face/embedding')
    const embedHost = await openEmbeddingHost()
    promptEmbedHost = embedHost
    try {
      const config = readEmbeddingConfig(embedHost.ctx)
      if (!embeddingReady(config)) {
        console.error('clue recall --prompt-ab --embedder http: embedding not ready (run clue kb embed-config auto first)')
        await embedHost.close()
        return 2
      }
      const { createHttpEmbedder } = await import('@clue-harness/kb-face/http-embedder')
      const { resolveEmbeddingKey } = await import('@clue-harness/kb-face/embedding')
      httpEmbedder = createHttpEmbedder({
        getConfig: () => ({ baseUrl: config.baseUrl, model: config.model, dim: config.dim, headers: config.headers, timeoutMs: config.timeoutMs, batchSize: config.batchSize }),
        resolveKey: () => resolveEmbeddingKey(embedHost.ctx, readEmbeddingConfig(embedHost.ctx)),
      })
    } catch (error) {
      await embedHost.close()
      throw error
    }
  }
  try {
    const report = await ab.runPromptAb(args, host, {
      buildSet: (options) => buildSyntheticSet(options),
      httpEmbedder,
    })
    if (args.json === 'true') console.log(JSON.stringify(report, null, 2))
    else ab.printPromptAb(report)
    return 0
  } finally {
    await promptEmbedHost?.close()
    await host.close()
  }
}

/**
 * The ablation entry point (V2, 原规划 §10).
 *
 * Self-checks the corpus BEFORE reporting anything: the cross-lingual class
 * must share no token with its gold document, or the number it produces would
 * be about the generator rather than about the retriever.
 * @param args - parsed flags.
 * @returns the process exit code (1 when a guardrail failed).
 */
async function runAblationMain(args: ParsedArgs): Promise<number> {
  const abl = await import('./recall-abl.ts')
  let http: import('@clue-harness/rag').Embedder | null = null
  // The host stays OPEN for the whole run: the embedder resolves its key from
  // the credentials service PER CALL (不变量 11), so closing the host after
  // building the embedder would leave every later call unauthenticated — the
  // measured failure was a 401 "You didn't provide an API key" on every query.
  let embedHost: Awaited<ReturnType<typeof import('@clue-harness/kb-face/embedding-host').openEmbeddingHost>> | null = null
  if (args.embedder === 'http') {
    const { openEmbeddingHost } = await import('@clue-harness/kb-face/embedding-host')
    const { embeddingReady, readEmbeddingConfig } = await import('@clue-harness/kb-face/embedding')
    const host = await openEmbeddingHost()
    embedHost = host
    try {
      const config = readEmbeddingConfig(host.ctx)
      if (!embeddingReady(config)) {
        console.error(`clue recall --embedder http: embedding not ready (${config.baseUrl === '' ? 'missing baseUrl' : config.dim <= 0 ? 'dim never measured' : 'incomplete config'})`)
        console.error('  run clue kb embed-config auto (or set + test) first, then re-run')
        await host.close()
        return 2
      }
      http = {
        id: config.model,
        dim: config.dim,
        async embed(texts: readonly string[]): Promise<Float32Array[]> {
          const { createHttpEmbedder } = await import('@clue-harness/kb-face/http-embedder')
          const { resolveEmbeddingKey } = await import('@clue-harness/kb-face/embedding')
          return createHttpEmbedder({
            getConfig: () => ({
              baseUrl: config.baseUrl, model: config.model, dim: config.dim,
              headers: config.headers, timeoutMs: config.timeoutMs, batchSize: config.batchSize,
            }),
            resolveKey: () => resolveEmbeddingKey(host.ctx, readEmbeddingConfig(host.ctx)),
          }).embed(texts)
        },
      }
    } catch (error) {
      await host.close()
      throw error
    }
  }
  try {
    const report = await abl.runAblation(args, (options) => buildSyntheticSet(options), http)
    if (args.json === 'true') console.log(JSON.stringify(report, null, 2))
    else abl.printAblation(report)
    return report.ok ? 0 : 1
  } finally {
    await embedHost?.close()
  }
}
