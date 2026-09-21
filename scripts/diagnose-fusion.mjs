/**
 * 诊断：BM25 进一级之后，为什么 hybrid 反而不如纯词法（R3 的取证工具）。
 *
 * 这份脚本不改产品代码，只做三件事，把"感觉"换成数字：
 *
 * **A. 教科书 BM25 的变体对照**（不需要嵌入，秒级）
 *    tf 是否存在性 / 是否按 title 3 : tag 2 : body 1 分字段 + 分字段长度归一。
 *    我们的一级是"存在性 + 分字段"，这一组用来量出：我们离教科书 BM25 还差的那一点点，
 *    有多少只是 tf 选择造成的（即"是公式的实现细节，不是架构错了"）。
 *
 * **B. 通道权重扫描**（需要向量层）
 *    lexical / hybrid / vector-only × 精排开关，外加 hybrid 的语义通道权重 1→0.5→0.25→0。
 *    语义通道若真的只是噪声，指标应当随权重单调回到 lexical 档；权重 0 时 RRF 会跳过该通道
 *    （`rrfFuse` 里 `weight === 0 → continue`），所以 w=0 必须与 lexical 档逐位相同——那是校验项。
 *
 * **C. 精排窗口的候选饥饿**（同一批运行顺带统计）
 *    精排只看得见 `fused.slice(0, rerankCandidates)`（默认 30）。统计每查询：
 *    金标在"词法 top-30"与"融合 top-30"里各有多少个，以及多少条从词法 top-10 被挤出融合 top-10。
 *    这一项回答"融合是把排序搞乱了，还是把金标挤出了精排窗口"。
 *
 * 用法：
 *   node scripts/diagnose-fusion.mjs [--dataset coir-cosqa] [--queries 20] [--depth 30] [--random-baseline 200]
 */
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const datasetRoot = path.join(repoRoot, 'evals', 'datasets', 'beir')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[token.slice(2)] = next; i += 1 } else out[token.slice(2)] = 'true'
  }
  return out
}

async function readJsonl(file, onRow) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.trim() === '') continue
    onRow(JSON.parse(line))
  }
}

async function readQrels(file) {
  const qrels = new Map()
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (line.trim() === '' || line.startsWith('query-id')) continue
    const [qid, docId, score] = line.split('\t')
    if (qid === undefined || docId === undefined) continue
    const list = qrels.get(qid) ?? new Map()
    list.set(docId, Number(score) || 1)
    qrels.set(qid, list)
  }
  return qrels
}

const dcg = (gains) => gains.reduce((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0)

/** nDCG@k / recall@k / MRR@k for one ranked id list (`k` = cutoff, default 10). */
function scoreQuery(ranked, gold, k = 10) {
  const top = ranked.slice(0, k)
  const ideal = [...gold.values()].sort((a, b) => b - a).slice(0, k)
  const ndcg = dcg(ideal) === 0 ? 0 : dcg(top.map((id) => gold.get(id) ?? 0)) / dcg(ideal)
  const found = top.filter((id) => gold.has(id)).length
  return { ndcg, recall: gold.size === 0 ? 0 : found / gold.size, rr: (() => { const i = top.findIndex((id) => gold.has(id)); return i === -1 ? 0 : 1 / (i + 1) })() }
}

const args = parseArgs(process.argv.slice(2))
const dataset = args.dataset ?? 'coir-cosqa'
const label = args.label ?? dataset
const maxQueries = Number(args.queries ?? 20)
const depth = Number(args.depth ?? 30)
const k = 10
const K_INV = `depth=${depth} · 指标 @${k}`
/**
 * What the ENTRY's title field holds when the corpus row has no title.
 *
 * `id` mirrors `bench-beir.mjs` (which substitutes the doc id). That substitution is not
 * harmless: the title field carries weight 3 in BM25F, so a corpus without titles silently
 * gets a 3×-weighted field of doc ids. `neutral` uses a constant instead, which is the
 * apples-to-apples comparison against the textbook variants below.
 */
const titleMode = args['entry-title'] ?? 'id'
/**
 * Which tokenizer the textbook variants use for the CORPUS and the QUERY.
 *
 * `textbook` = `/ [a-z0-9]{2,} /` (splits `_process_and_sort` into three words).
 * `ours` = the product's `tokenize()` (keeps `_process_and_sort` as ONE token, adds CJK bigrams).
 * This switch exists because it turned out to be the whole residual gap on code corpora: the
 * product's tokenizer deliberately preserves identifiers, so a query word like `sort` does NOT
 * match `_process_and_sort`, while textbook BM25 counts that match.
 */
const tokenizerMode = args.tokenizer ?? 'textbook'

/** The title the entry AND the textbook variants both see (see {@link titleMode}). */
const titleOf = (doc) => (doc.title !== '' ? doc.title : titleMode === 'id' ? doc.id : 'untitled')

const dataDir = path.join(datasetRoot, dataset)
const corpus = []
await readJsonl(path.join(dataDir, 'corpus.jsonl'), (row) => corpus.push({ id: String(row._id), title: String(row.title ?? ''), text: String(row.text ?? '') }))
const queries = new Map()
await readJsonl(path.join(dataDir, 'queries.jsonl'), (row) => queries.set(String(row._id), String(row.text)))
const qrels = await readQrels(path.join(dataDir, 'qrels', 'test.tsv'))
const evaluated = [...qrels.keys()].filter((qid) => queries.has(qid)).slice(0, maxQueries)
console.log(`[diagnose] A 段分词器: ${tokenizerMode === 'ours' ? '产品 tokenize()(保留下划线标识符)' : '教科书 [a-z0-9]{2,}'}`)
console.log(`[diagnose] ${label}: 语料 ${corpus.length} 篇 · 评 ${evaluated.length} 条查询 · ${K_INV} · 空标题的条目用 ${titleMode === 'id' ? 'docId(同 bench-beir)' : '常量 untitled'}`)

// ── A. textbook BM25 variants (no embedder, milliseconds) ──────────────────
const WORDS = (text) => text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
const { tokenize: kbTokenize } = await import('@clue-harness/kb')
/** One tokenizer for both corpus and query, chosen by {@link tokenizerMode}. */
const TOK = (text) => (tokenizerMode === 'ours' ? kbTokenize(text) : WORDS(text))

/**
 * Textbook BM25 over one corpus with switchable choices.
 * @param options.tf - 'raw' (real term frequency) or 'presence' (∈{0,1}, what our first level does).
 * @param options.fields - 'concat' (title+body as one field) or 'weighted' (3/2/1 with per-field length norm).
 * @param options.lengths - 'total' (all tokens, textbook) or 'distinct' (unique tokens — what OUR
 *   `bm25Fields` does, because it builds token SETS before measuring them).
 */
function textbookBm25({ tf, fields, lengths = 'total' }) {
  const k1 = 1.2
  const b = 0.75
  const fieldOf = (doc) => fields === 'concat'
    ? { all: TOK(`${titleOf(doc)} ${doc.text}`) }
    : { title: TOK(titleOf(doc)), text: TOK(doc.text) }
  const FIELD_WEIGHT = { all: 1, title: 3, text: 1 }
  const docs = corpus.map((doc) => {
    const raw = fieldOf(doc)
    const counts = {}
    for (const [name, tokens] of Object.entries(raw)) {
      const map = new Map()
      for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1)
      counts[name] = tf === 'presence' ? new Map([...map.keys()].map((token) => [token, 1])) : map
    }
    return {
      id: doc.id,
      counts,
      lengths: Object.fromEntries(Object.entries(raw).map(([name, tokens]) => [
        name,
        lengths === 'distinct' ? new Set(tokens).size : tokens.length,
      ])),
    }
  })
  const df = new Map()
  for (const doc of docs) {
    const seen = new Set()
    for (const map of Object.values(doc.counts)) for (const token of map.keys()) seen.add(token)
    for (const token of seen) df.set(token, (df.get(token) ?? 0) + 1)
  }
  const avg = {}
  for (const name of Object.keys(docs[0]?.lengths ?? {})) avg[name] = docs.reduce((sum, doc) => sum + doc.lengths[name], 0) / (docs.length || 1)
  const idf = (token) => Math.log(1 + (docs.length - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5))
  return (query) => {
    const terms = [...new Set(TOK(query))]
    const scored = []
    for (const doc of docs) {
      let score = 0
      for (const term of terms) {
        const weight = idf(term)
        for (const [name, counts] of Object.entries(doc.counts)) {
          const freq = counts.get(term) ?? 0
          if (freq === 0) continue
          const norm = 1 - b + b * (doc.lengths[name] / (avg[name] || 1))
          score += weight * FIELD_WEIGHT[name] * (freq * (k1 + 1)) / (freq + k1 * norm)
        }
      }
      if (score > 0) scored.push([doc.id, score])
    }
    return scored.sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0])).slice(0, depth).map(([id]) => id)
  }
}

function measure(rank, kk = k) {
  let ndcg = 0, recall = 0, rr = 0
  for (const qid of evaluated) {
    const got = scoreQuery(rank(queries.get(qid) ?? ''), qrels.get(qid) ?? new Map(), kk)
    ndcg += got.ndcg; recall += got.recall; rr += got.rr
  }
  const n = evaluated.length || 1
  return { ndcg: ndcg / n, recall: recall / n, rr: rr / n }
}

console.log('\n── A. 教科书 BM25 的变体（同一语料/查询，秒级）')
const bm25Rows = []
const variants = [
  { tf: 'raw', fields: 'concat', lengths: 'total' },
  { tf: 'raw', fields: 'weighted', lengths: 'total' },
  { tf: 'presence', fields: 'concat', lengths: 'total' },
  { tf: 'presence', fields: 'weighted', lengths: 'total' },
  // 我们的实现在测长度之前先把字段变成 token SET ⇒ 长度是"不同 token 数"而非总 token 数。
  { tf: 'presence', fields: 'weighted', lengths: 'distinct' },
  { tf: 'raw', fields: 'weighted', lengths: 'distinct' },
]
for (const variant of variants) {
  const m = measure(textbookBm25(variant))
  bm25Rows.push({ ...variant, ...m })
  console.log(`   tf=${variant.tf.padEnd(8)} fields=${variant.fields.padEnd(8)} lengths=${variant.lengths.padEnd(8)} nDCG@10 ${m.ndcg.toFixed(4)} · recall@10 ${m.recall.toFixed(4)} · MRR@10 ${m.rr.toFixed(4)}`)
}
// Random-order reference, for calibrating "the vector channel is noise".
const randomRuns = Number(args['random-baseline'] ?? 200)
if (randomRuns > 0) {
  let ndcg = 0, recall = 0
  const ids = corpus.map((doc) => doc.id)
  for (const qid of evaluated) {
    const gold = qrels.get(qid) ?? new Map()
    for (let run = 0; run < randomRuns; run += 1) {
      const shuffled = ids.slice()
      for (let i = shuffled.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); const t = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = t }
      const got = scoreQuery(shuffled, gold, k)
      ndcg += got.ndcg; recall += got.recall
    }
  }
  const n = evaluated.length * randomRuns || 1
  console.log(`   随机排序参考(${randomRuns} 次/查询)      nDCG@10 ${(ndcg / n).toFixed(4)} · recall@10 ${(recall / n).toFixed(4)}`)
}

if (args['only-a'] === 'true') {
  console.log('\n[diagnose] --only-a: 跳过检索器部分')
  process.exit(0)
}

// ── B/C. our retriever: channel weights + candidate window ────────────────
const { openProjectStore } = await import('@clue-harness/kb')
const { buildVectorIndex, createHybridRetriever, hashEmbedder } = await import('@clue-harness/rag')

const workdir = await mkdtemp(path.join(tmpdir(), 'clue-diagnose-'))
const store = await openProjectStore(path.join(workdir, 'p'), path.join(workdir, 'h'))
const home = path.join(workdir, 'h')
try {
  const goldToEntry = new Map()
  const entryToGold = new Map()
  for (const doc of corpus) {
    const entry = await store.add({ kind: 'fact', title: titleOf(doc), text: doc.text, createdBy: 'diagnose:fusion' })
    goldToEntry.set(doc.id, String(entry.id))
    entryToGold.set(String(entry.id), doc.id)
  }
  const embedder = hashEmbedder()
  const build = await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, maxUnitsPerBuild: 100_000 })
  console.log(`\n[diagnose] 向量层: ${build.rows} 行 · hashEmbedder dim=${embedder.dim}(语义能力=0,只验管线)`)

  /** Run one retriever configuration; returns per-query ranked GOLD ids (depth long) plus the raw hits. */
  async function run(config) {
    const retriever = createHybridRetriever(store, null, {
      channels: config.channels,
      rerank: config.rerank ?? false,
      profile: 'tool',
      topK: depth,
      embedder,
      home,
      rebuildOnRead: false,
      ...(config.channelWeights !== undefined ? { channelWeights: config.channelWeights } : {}),
      ...(config.featureWeights !== undefined ? { featureWeights: config.featureWeights } : {}),
      ...(config.rerankCandidates !== undefined ? { rerankCandidates: config.rerankCandidates } : {}),
      ...(config.recallDepth !== undefined ? { recallDepth: config.recallDepth } : {}),
    })
    const perQuery = []
    for (const qid of evaluated) {
      const detailed = await retriever.retrieveDetailed(queries.get(qid) ?? '', { limit: depth, noTouch: true })
      const ranked = detailed.hits.map((hit) => entryToGold.get(String(hit.entry.id)) ?? String(hit.entry.id))
      perQuery.push({ qid, ranked, hitIds: detailed.hits.map((hit) => entryToGold.get(String(hit.entry.id)) ?? null), vector: detailed.vector.status })
    }
    let ndcg = 0, recall = 0, rr = 0
    for (const row of perQuery) {
      const got = scoreQuery(row.ranked, qrels.get(row.qid) ?? new Map(), k)
      ndcg += got.ndcg; recall += got.recall; rr += got.rr
    }
    const n = perQuery.length || 1
    return { ndcg: ndcg / n, recall: recall / n, rr: rr / n, perQuery }
  }

  console.log('\n── B. 通道与权重（同一批查询）')
  const configs = [
    { id: 'lexical+no-rerank', channels: 'lexical', rerank: false },
    { id: 'lexical+rerank', channels: 'lexical', rerank: true },
    { id: 'vector-only+no-rerank', channels: 'vector', rerank: false },
    { id: 'vector-only+rerank', channels: 'vector', rerank: true },
    { id: 'hybrid+no-rerank w_v=1', channels: 'hybrid', rerank: false },
    { id: 'hybrid+rerank w_v=1', channels: 'hybrid', rerank: true },
    { id: 'hybrid+rerank w_v=0.5', channels: 'hybrid', rerank: true, channelWeights: { lexical: 1, vector: 0.5 } },
    { id: 'hybrid+rerank w_v=0.25', channels: 'hybrid', rerank: true, channelWeights: { lexical: 1, vector: 0.25 } },
    { id: 'hybrid+rerank w_v=0', channels: 'hybrid', rerank: true, channelWeights: { lexical: 1, vector: 0 } },
    // 语义通道的两条进入路径要分开量:① RRF 融合(候选集) ② 精排的 semantic 特征(打分)。
    { id: 'hybrid+rerank w_v=1 sem=0', channels: 'hybrid', rerank: true, featureWeights: { semantic: 0 } },
    { id: 'hybrid+rerank w_v=0 sem=0', channels: 'hybrid', rerank: true, channelWeights: { lexical: 1, vector: 0 }, featureWeights: { semantic: 0 } },
    { id: 'lexical+rerank sem=0(对照)', channels: 'lexical', rerank: true, featureWeights: { semantic: 0 } },
    // 融合把约一半的词法窗口换成向量候选 ⇒ 精排窗口实际被腰斩。把窗口放大是一行修法，先量它值多少。
    { id: 'lexical+rerank rc=60', channels: 'lexical', rerank: true, rerankCandidates: 60 },
    { id: 'hybrid+rerank w_v=1 rc=60', channels: 'hybrid', rerank: true, rerankCandidates: 60 },
    { id: 'hybrid+rerank w_v=1 sem=0 rc=60', channels: 'hybrid', rerank: true, rerankCandidates: 60, featureWeights: { semantic: 0 } },
  ]
  const results = new Map()
  for (const config of configs) {
    const got = await run(config)
    results.set(config.id, got)
    console.log(`   ${config.id.padEnd(24)} nDCG@10 ${got.ndcg.toFixed(4)} · recall@10 ${got.recall.toFixed(4)} · MRR@10 ${got.rr.toFixed(4)}`)
  }

  // Sanity: with the vector channel weight 0 (skipped by rrfFuse) AND the semantic feature
  // weight 0, the hybrid branch must reproduce the lexical branch exactly. If it does not,
  // the two branches disagree about something other than the semantic channel.
  const sane = results.get('hybrid+rerank w_v=0 sem=0')
  const lexRerank = results.get('lexical+rerank')
  const same = sane !== undefined && lexRerank !== undefined
    && Math.abs(sane.ndcg - lexRerank.ndcg) < 1e-9 && Math.abs(sane.recall - lexRerank.recall) < 1e-9
  console.log(`   校验(hybrid w_v=0 & sem=0 应等于 lexical+rerank): ${same ? '✓ 一致' : '✗ 不一致 — 融合/特征之外还有差异'}`)

  console.log('\n── C. 精排窗口的候选饥饿（lexical+rerank vs hybrid+rerank w_v=1）')
  const lexPer = lexRerank.perQuery
  const hybPer = new Map(results.get('hybrid+rerank w_v=1').perQuery.map((row) => [row.qid, row]))
  const hybNoRerank = new Map(results.get('hybrid+no-rerank w_v=1').perQuery.map((row) => [row.qid, row]))
  const lexNoRerank = new Map(results.get('lexical+no-rerank').perQuery.map((row) => [row.qid, row]))
  let goldLexWindow = 0, goldHybWindow = 0, demoted = 0, goldLex10 = 0, goldHyb10 = 0, queriesWithGold = 0
  let lexIdsInHybridWindow = 0, lexIdsTotal = 0
  for (const row of lexPer) {
    const gold = qrels.get(row.qid) ?? new Map()
    if (gold.size === 0) continue
    queriesWithGold += 1
    const hyb = hybPer.get(row.qid)
    const inWindow = (list) => list.filter((id) => id !== null && gold.has(id)).length
    goldLexWindow += inWindow(row.hitIds)
    goldHybWindow += hyb === undefined ? 0 : inWindow(hyb.hitIds)
    const lexTop10 = row.ranked.slice(0, k)
    const hybTop10 = (hyb?.ranked ?? []).slice(0, k)
    goldLex10 += lexTop10.filter((id) => gold.has(id)).length
    goldHyb10 += hybTop10.filter((id) => gold.has(id)).length
    demoted += lexTop10.filter((id) => gold.has(id) && !hybTop10.includes(id)).length
    // How much of the lexical candidate window survives the fusion at all?
    const lexWindow = new Set((lexNoRerank.get(row.qid)?.ranked ?? []).filter((id) => id !== null))
    const hybWindow = new Set((hybNoRerank.get(row.qid)?.ranked ?? []).filter((id) => id !== null))
    lexIdsTotal += lexWindow.size
    for (const id of lexWindow) if (hybWindow.has(id)) lexIdsInHybridWindow += 1
  }
  const per = (value) => (queriesWithGold === 0 ? 0 : value / queriesWithGold)
  console.log(`   有金标的查询: ${queriesWithGold}`)
  console.log(`   每查询金标数(前 ${depth} 精排窗口内): 词法档 ${per(goldLexWindow).toFixed(2)} · 融合档 ${per(goldHybWindow).toFixed(2)}`)
  console.log(`   每查询金标数(前 ${k} 名内):            词法档 ${per(goldLex10).toFixed(2)} · 融合档 ${per(goldHyb10).toFixed(2)}`)
  console.log(`   被融合挤出前 ${k} 名的金标(每查询):       ${per(demoted).toFixed(2)}`)
  console.log(`   词法窗口被融合保留下来的比例:          ${lexIdsTotal === 0 ? '-' : `${((lexIdsInHybridWindow / lexIdsTotal) * 100).toFixed(1)}%`}(窗口 ${depth} 条)`)
  console.log(`   被融合挤出精排窗口的金标(每查询):       ${per(goldLexWindow - goldHybWindow).toFixed(2)}`)

  const report = {
    generatedAt: new Date().toISOString(),
    dataset: label,
    queries: evaluated.length,
    documents: corpus.length,
    depth,
    bm25Variants: bm25Rows,
    retriever: [...results.entries()].map(([id, got]) => ({ id, 'nDCG@10': got.ndcg, 'recall@10': got.recall, 'MRR@10': got.rr })),
    rerankWindow: {
      queriesWithGold,
      goldInLexicalWindow: per(goldLexWindow),
      goldInHybridWindow: per(goldHybWindow),
      goldInLexicalTop10: per(goldLex10),
      goldInHybridTop10: per(goldHyb10),
      goldDemotedOutOfTop10: per(demoted),
    },
  }
  const out = path.join(repoRoot, 'evals', 'runs', `${report.generatedAt.replace(/[:.]/g, '-')}_diagnose-${label.replace(/\//g, '-')}.json`)
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`\n[diagnose] 报告: ${path.relative(repoRoot, out)}`)
} finally {
  await rm(workdir, { recursive: true, force: true })
}
