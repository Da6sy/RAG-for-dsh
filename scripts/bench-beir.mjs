/**
 * BEIR retrieval benchmark runner (D1) — measures the SHIPPED retriever on a
 * public IR dataset.
 *
 * Why a separate runner instead of reusing `clue recall`: `clue recall` speaks
 * the synthetic generator's format, BEIR speaks `corpus.jsonl` + `queries.jsonl`
 * + `qrels/test.tsv`. What must NOT differ is the RETRIEVER: this file builds a
 * throwaway KB out of the BEIR corpus and calls the product's own
 * `createHybridRetriever`, so a number here is a statement about the product.
 *
 * Isolation: reads only from `evals/datasets/`, writes only to `evals/runs/`.
 * Both directories are git-ignored and removable (`rm -rf evals/datasets evals/runs`).
 *
 * Usage:
 *   node scripts/bench-beir.mjs --dataset nfcorpus [--queries 300] [--embedder hash|http]
 *   node scripts/bench-beir.mjs --dataset scifact --queries 300 --embedder http
 *
 * @module @clue-harness/scripts/bench-beir
 */
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..')
const datasetRoot = path.join(repoRoot, 'evals', 'datasets', 'beir')
const runsRoot = path.join(repoRoot, 'evals', 'runs')

/** Parse `--flag value` pairs (bare flags become 'true'). */
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

/** Read a JSONL file line by line (BEIR corpora are big; do not slurp blindly). */
async function readJsonl(file, onRow) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const line of rl) {
    if (line.trim() === '') continue
    onRow(JSON.parse(line))
  }
}

/** Read BEIR qrels (`query-id \t corpus-id \t score`). */
async function readQrels(file) {
  const qrels = new Map()
  const text = await readFile(file, 'utf8')
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('query-id')) continue
    const [qid, docId, score] = line.split('\t')
    if (qid === undefined || docId === undefined) continue
    const list = qrels.get(qid) ?? new Map()
    list.set(docId, Number(score) || 1)
    qrels.set(qid, list)
  }
  return qrels
}

/** Discounted cumulative gain with graded relevance. */
function dcg(gains) {
  return gains.reduce((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0)
}

/**
 * nDCG@k / recall@k / MRR@k for one query, over a ranked id list.
 * @param ranked - retrieved doc ids, best first.
 * @param gold - docId → relevance grade (the qrels row).
 * @param k - cutoff.
 * @returns the three metrics.
 */
function scoreQuery(ranked, gold, k) {
  const top = ranked.slice(0, k)
  const ideal = [...gold.values()].sort((a, b) => b - a).slice(0, k)
  const ndcg = dcg(ideal) === 0 ? 0 : dcg(top.map((id) => gold.get(id) ?? 0)) / dcg(ideal)
  const found = top.filter((id) => gold.has(id)).length
  const recall = gold.size === 0 ? 0 : found / gold.size
  const first = top.findIndex((id) => gold.has(id))
  return { ndcg, recall, rr: first === -1 ? 0 : 1 / (first + 1) }
}

const args = parseArgs(process.argv.slice(2))
// Loaded BEFORE the defaults below are read: the engine's single defaults table is
// what those lines reference (a top-level `await import` is evaluated in order).
const { buildVectorIndex, createHybridRetriever, hashEmbedder, CHANNEL_PROFILES, RETRIEVAL_DEFAULTS } = await import('@clue-harness/rag')
/**
 * Which first-level formula to measure (R2 of `docs/修复规划-一级检索BM25化.md`).
 *
 * Default is the product default (`bm25`). `weights` exists so the rollback
 * switch can be verified AT THIS LEVEL: the archived pre-R2 numbers were
 * produced by the weight-sum formula, and re-running them must reproduce the
 * archived values exactly — otherwise "same dataset, new numbers" would be two
 * different experiments wearing one name.
 */
const scorer = args.scorer ?? RETRIEVAL_DEFAULTS.lexicalScorer
if (scorer !== 'bm25' && scorer !== 'weights') throw new Error(`--scorer 只接受 bm25|weights,收到 ${scorer}`)

/**
 * F0 of `docs/修改规划-混合检索反超单BM25.md`: the fusion/rerank knobs must be
 * reachable FROM HERE.
 *
 * Why this is F0 rather than a nicety: the harness used to pass none of these,
 * so it silently measured the library's fallback values. Changing the settings
 * default moved nothing, and three runs with materially different settings
 * produced byte-identical numbers — a measurement of the wrong configuration
 * that looked like a result. Every knob the plan asks about now has a flag.
 */
const knobs = {
  ...(args['rerank-candidates'] !== undefined ? { rerankCandidates: Number(args['rerank-candidates']) } : {}),
  ...(args['recall-depth'] !== undefined ? { recallDepth: Number(args['recall-depth']) } : {}),
  ...(args['max-vector-only'] !== undefined ? { maxVectorOnly: Number(args['max-vector-only']) } : {}),
  // P0 of the D-plan: the report may only record switches the ENGINE actually
  // supports. `--semantic-normalization` / `--semantic-gate` were recorded here
  // while no such option existed (a "phantom knob"), so they are gone; the real
  // ones are D1's `lexicalNormalization` and D2's `semanticScale`.
  ...(args['lexical-normalization'] !== undefined ? { lexicalNormalization: String(args['lexical-normalization']) } : {}),
  ...(args['semantic-scale'] !== undefined ? { semanticScale: String(args['semantic-scale']) } : {}),
  // D3/D4: the tri-state switch and the two rank features (weights 0 by default).
  ...(args['missing-mode'] !== undefined ? { missingFeatureMode: String(args['missing-mode']) } : {}),
  ...(args['semantic-floor'] !== undefined ? { semanticFloor: Number(args['semantic-floor']) } : {}),
  ...(args['semantic-ceil'] !== undefined ? { semanticCeil: Number(args['semantic-ceil']) } : {}),
  // D4's weights are the two rank features; they ship at 0, so an A/B has to be
  // able to move exactly one of them at a time.
  ...(args['semantic-rank-weight'] !== undefined || args['fused-rank-weight'] !== undefined
    ? {
      featureWeights: {
        ...(args['semantic-rank-weight'] !== undefined ? { semanticRank: Number(args['semantic-rank-weight']) } : {}),
        ...(args['fused-rank-weight'] !== undefined ? { fusedRank: Number(args['fused-rank-weight']) } : {}),
      },
    }
    : {}),
  ...(args['channel-weight-vector'] !== undefined
    ? { channelWeights: { lexical: Number(args['channel-weight-lexical'] ?? 1), vector: Number(args['channel-weight-vector']) } }
    : {}),
}
if (Object.keys(knobs).length > 0) console.log(`[beir] 旋钮: ${JSON.stringify(knobs)}`)
const dataset = args.dataset ?? 'nfcorpus'
const maxQueries = Number(args.queries ?? 300)
const embedderKind = args.embedder ?? 'hash'
const depth = Number(args.depth ?? 100)
const label = args.label ?? `beir/${dataset}`
const extraCaveat = args.caveat ?? null
const only = args.only ?? null
const dataDir = path.join(datasetRoot, dataset)
const k = 10

const corpus = []
await readJsonl(path.join(dataDir, 'corpus.jsonl'), (row) => {
  corpus.push({ id: String(row._id), title: String(row.title ?? ''), text: String(row.text ?? '') })
})
const queries = new Map()
await readJsonl(path.join(dataDir, 'queries.jsonl'), (row) => { queries.set(String(row._id), String(row.text)) })
const qrels = await readQrels(path.join(dataDir, 'qrels', 'test.tsv'))
const evaluated = [...qrels.keys()].filter((qid) => queries.has(qid)).slice(0, maxQueries)
console.log(`[beir] ${dataset}: 语料 ${corpus.length} 篇 · qrels 查询 ${qrels.size} · 本次评 ${evaluated.length} 条 · embedder=${embedderKind}`)

// ── the retriever, exactly as the product wires it ────────────────────────
const { openProjectStore } = await import('@clue-harness/kb')

const workdir = await mkdtemp(path.join(tmpdir(), 'clue-beir-'))
const store = await openProjectStore(path.join(workdir, 'p'), path.join(workdir, 'h'))
const home = path.join(workdir, 'h')
try {
  const goldToEntry = new Map()
  const entryToGold = new Map()
  for (const doc of corpus) {
    const entry = await store.add({
      kind: 'fact',
      title: doc.title === '' ? doc.id : doc.title,
      text: doc.text,
      createdBy: 'bench:beir',
    })
    goldToEntry.set(doc.id, String(entry.id))
    entryToGold.set(String(entry.id), doc.id)
  }

  let embedder = hashEmbedder()
  let semantics = 'none'
  let closeHost = null
  if (embedderKind === 'http') {
    const { openEmbeddingHost } = await import('@clue-harness/kb-face/embedding-host')
    const { embeddingReady, readEmbeddingConfig, resolveEmbeddingKey } = await import('@clue-harness/kb-face/embedding')
    const { createHttpEmbedder } = await import('@clue-harness/kb-face/http-embedder')
    const host = await openEmbeddingHost()
    closeHost = () => host.close()
    const config = readEmbeddingConfig(host.ctx)
    if (!embeddingReady(config)) throw new Error('嵌入未就绪:先跑 clue kb embed-config auto')
    embedder = createHttpEmbedder({
      getConfig: () => ({ baseUrl: config.baseUrl, model: config.model, dim: config.dim, headers: config.headers, timeoutMs: config.timeoutMs, batchSize: config.batchSize }),
      resolveKey: () => resolveEmbeddingKey(host.ctx, readEmbeddingConfig(host.ctx)),
    })
    semantics = 'endpoint'
  }

  const t0 = Date.now()
  const build = only === 'bm25'
    ? { rows: 0, calls: 0, cacheHits: 0 }
    : await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, maxUnitsPerBuild: 100_000 })
  const indexSeconds = (Date.now() - t0) / 1000
  console.log(`[beir] 向量层: ${build.rows} 行 · 调用 ${build.calls} 次 · ${indexSeconds.toFixed(1)}s(缓存命中 ${build.cacheHits})`)

  const matrix = [
    { id: 'lexical+no-rerank', channels: 'lexical', rerank: false },
    { id: 'lexical+rerank', channels: 'lexical', rerank: true },
    { id: 'hybrid+no-rerank', channels: 'hybrid', rerank: false },
    { id: 'hybrid+rerank', channels: 'hybrid', rerank: true },
  ]
  const rows = []
  /**
   * A textbook BM25 row, over the same corpus and qrels.
   *
   * Without it our nDCG is uninterpretable: the published BEIR baselines are
   * BM25, and our first level is a bare sum of field weights (no IDF, no length
   * normalization). Measuring both on the SAME data is what turns "0.15" into
   * "0.15 vs BM25's 0.32".
   */
  const bm25 = (() => {
    const k1 = 1.2
    const b = 0.75
    const docs = corpus.map((doc) => {
      const tokens = (doc.title + ' ' + doc.text).toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
      return { id: doc.id, tokens, tf: tokens.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map()) }
    })
    const df = new Map()
    for (const doc of docs) for (const token of doc.tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)
    const avgdl = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / (docs.length || 1)
    const idf = (token) => Math.log(1 + (docs.length - (df.get(token) ?? 0) + 0.5) / ((df.get(token) ?? 0) + 0.5))
    return (query) => {
      const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])]
      const scored = []
      for (const doc of docs) {
        let score = 0
        for (const term of terms) {
          const tf = doc.tf.get(term) ?? 0
          if (tf === 0) continue
          score += idf(term) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.tokens.length) / avgdl))
        }
        if (score > 0) scored.push([doc.id, score])
      }
      return scored.sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0])).slice(0, depth).map(([id]) => id)
    }
  })()
  if (only === null || only === 'bm25') {
    const t = Date.now()
    let ndcg = 0, recall = 0, rr = 0
    for (const qid of evaluated) {
      const gold = qrels.get(qid) ?? new Map()
      const scored = scoreQuery(bm25(queries.get(qid) ?? ''), gold, k)
      ndcg += scored.ndcg; recall += scored.recall; rr += scored.rr
    }
    const n = evaluated.length || 1
    rows.push({
      config: 'bm25 (参考基线)', channels: 'bm25', rerank: false,
      'nDCG@10': Math.round((ndcg / n) * 10000) / 10000,
      'recall@10': Math.round((recall / n) * 10000) / 10000,
      'MRR@10': Math.round((rr / n) * 10000) / 10000,
      vectorUsed: 0, seconds: Math.round((Date.now() - t) / 100) / 10,
    })
    console.log(`[beir] bm25               nDCG@10 ${(ndcg / n).toFixed(4)} · recall@10 ${(recall / n).toFixed(4)} · MRR@10 ${(rr / n).toFixed(4)} · ${((Date.now() - t) / 1000).toFixed(1)}s`)
  }

  // NOTE: `only === null` means "run the whole matrix". An earlier version of
  // this line treated null as "skip everything" — scifact then produced a
  // report with the BM25 row and no configurations at all, which looked like a
  // successful run. The condition is spelled out here so it cannot regress.
  const configs = only === null ? matrix : only === 'bm25' ? [] : matrix.filter((row) => row.id === only)
  for (const config of configs) {
    const retriever = createHybridRetriever(store, null, {
      channels: config.channels,
      rerank: config.rerank,
      profile: 'tool',
      lexicalScorer: scorer,
      topK: depth,
      ...knobs,
      embedder,
      home,
      rebuildOnRead: false,
      ...(CHANNEL_PROFILES.tool === undefined ? {} : {}),
    })
    const t1 = Date.now()
    let ndcg = 0
    let recall = 0
    let rr = 0
    let vectorUsed = 0
    // F0 diagnostics: how much of the gold set even REACHES the rerank window,
    // and how much the semantic scores actually separate. The plan's measured
    // damage was a candidate-window effect (1.10 gold documents per query
    // pushed out), which recall@10 cannot show — a document that never entered
    // the window is indistinguishable from one that ranked badly.
    let goldInWindow = 0
    let goldTotal = 0
    /**
     * P0 of the D-plan: the headline forensic numbers.
     *
     * `goldDemotedOutOfTop10` is the defect in one integer — gold documents that
     * the FUSION had inside the top 10 and the RERANKER pushed out. The plan's
     * measured cosqa damage was exactly this (gold demoted while a lexical
     * distractor took its place), and recall@10 alone cannot separate "never
     * recalled" from "recalled then demoted".
     */
    let windowTop10Gold = 0
    let goldDemoted = 0
    /** Queries whose semantic-channel #1 candidate is a gold document … */
    let semanticTop1Gold = 0
    /** … and how many of those survived into the final top 10. */
    let semanticTop1Survived = 0
    /** `bm25ish`'s absolute level: max per query, and how often someone hits 1.0. */
    const bm25Top = []
    let bm25Saturated = 0
    const statusCounts = {}
    const spreads = []
    /**
     * The window is measured with rerank OFF: that order IS the fusion result,
     * i.e. exactly what the reranker is handed (`rerankCandidates` deep).
     */
    const windowRetriever = config.rerank ? createHybridRetriever(store, null, {
      channels: config.channels,
      rerank: false,
      profile: 'tool',
      lexicalScorer: scorer,
      topK: knobs.rerankCandidates ?? RETRIEVAL_DEFAULTS.rerankCandidates,
      embedder,
      home,
      rebuildOnRead: false,
      ...knobs,
    }) : null
    for (const qid of evaluated) {
      const gold = qrels.get(qid) ?? new Map()
      const query = queries.get(qid) ?? ''
      const detailed = await retriever.retrieveDetailed(query, { limit: depth, noTouch: true })
      if (detailed.vector.status === 'used') vectorUsed += 1
      statusCounts[detailed.vector.status] = (statusCounts[detailed.vector.status] ?? 0) + 1
      const sem = detailed.hits.map((hit) => hit.explain?.semantic).filter((value) => typeof value === 'number')
      if (sem.length > 1) {
        const sorted = [...sem].sort((a, b) => b - a)
        spreads.push(sorted[0] - sorted[Math.floor(sorted.length / 2)])
      }
      let windowHits = []
      /** The gold ids inside the window's top 10 (the demotion denominator). */
      const windowTop10GoldSet = new Set()
      if (windowRetriever !== null) {
        const window = await windowRetriever.retrieveDetailed(query, {
          limit: knobs.rerankCandidates ?? RETRIEVAL_DEFAULTS.rerankCandidates,
          noTouch: true,
        })
        windowHits = window.hits
        const windowGold = new Set(window.hits.map((hit) => entryToGold.get(String(hit.entry.id)) ?? String(hit.entry.id)))
        for (const goldId of gold.keys()) {
          if (!gold.has(goldId)) continue
          goldTotal += 1
          if (windowGold.has(goldId)) goldInWindow += 1
        }
        for (const key of windowGold) {
          // Only the gold ids, and only those the window put in its top 10.
          if (!gold.has(key)) continue
          if (window.hits.slice(0, 10).some((hit) => (entryToGold.get(String(hit.entry.id)) ?? String(hit.entry.id)) === key)) {
            windowTop10GoldSet.add(key)
          }
        }
      }
      const ranked = detailed.hits.map((hit) => entryToGold.get(String(hit.entry.id)) ?? String(hit.entry.id))
      if (windowRetriever !== null) {
        // The window's own top 10 (fusion order) vs the reranked top 10.
        const finalTop10 = new Set(ranked.slice(0, 10))
        for (const goldId of gold.keys()) {
          if (!windowTop10GoldSet.has(goldId)) continue
          windowTop10Gold += 1
          if (!finalTop10.has(goldId)) goldDemoted += 1
        }
      }
      // The semantic channel's own #1: `channels.vector === 1` is the rank the
      // fusion assigned, so no second ranking is computed here.
      const semanticTop1 = (windowHits.length > 0 ? windowHits : detailed.hits)
        .find((hit) => hit.explain?.channels?.vector === 1)
      if (semanticTop1 !== undefined) {
        const goldId = entryToGold.get(String(semanticTop1.entry.id)) ?? String(semanticTop1.entry.id)
        if (gold.has(goldId)) {
          semanticTop1Gold += 1
          if (ranked.slice(0, 10).includes(goldId)) semanticTop1Survived += 1
        }
      }
      const bm25Values = detailed.hits.map((hit) => hit.explain?.features?.bm25ish).filter((value) => typeof value === 'number')
      if (bm25Values.length > 0) {
        const top = Math.max(...bm25Values)
        bm25Top.push(top)
        if (top >= 0.999) bm25Saturated += 1
      }
      const scored = scoreQuery(ranked, gold, k)
      ndcg += scored.ndcg
      recall += scored.recall
      rr += scored.rr
    }
    const n = evaluated.length || 1
    rows.push({
      config: config.id,
      channels: config.channels,
      rerank: config.rerank,
      'nDCG@10': Math.round((ndcg / n) * 10000) / 10000,
      'recall@10': Math.round((recall / n) * 10000) / 10000,
      'MRR@10': Math.round((rr / n) * 10000) / 10000,
      vectorUsed,
      /** F0: gold documents that entered the rerank window (the candidate gate). */
      goldInWindow: goldTotal === 0 ? null : Math.round((goldInWindow / goldTotal) * 10000) / 10000,
      /** F0: which vector-channel states the queries saw. */
      vectorStatus: statusCounts,
      /** F0: mean spread (top − median) of the returned hits' cosine scores. */
      semanticSpread: spreads.length === 0 ? null : Math.round((spreads.reduce((a, b) => a + b, 0) / spreads.length) * 10000) / 10000,
      /** P0: gold in the window's top 10 that the reranker demoted out of its own top 10. */
      goldDemotedOutOfTop10: windowRetriever === null ? null : goldDemoted,
      /** P0: the denominator behind it (gold documents the window ranked in its top 10). */
      goldInWindowTop10: windowRetriever === null ? null : windowTop10Gold,
      /** P0: queries whose semantic #1 was gold / of those, how many survived the rerank. */
      semanticTop1Gold,
      semanticTop1Survived,
      /** P0: `bm25ish`'s absolute level (mean of the per-query maximum) + saturation count. */
      bm25ishTopMean: bm25Top.length === 0 ? null : Math.round((bm25Top.reduce((a, b) => a + b, 0) / bm25Top.length) * 10000) / 10000,
      bm25ishSaturatedQueries: bm25Top.length === 0 ? null : bm25Saturated,
      seconds: Math.round((Date.now() - t1) / 100) / 10,
    })
    console.log(`[beir] ${config.id.padEnd(18)} nDCG@10 ${(ndcg / n).toFixed(4)} · recall@10 ${(recall / n).toFixed(4)} · MRR@10 ${(rr / n).toFixed(4)} · ${((Date.now() - t1) / 1000).toFixed(1)}s`)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dataset: label,
    split: 'test',
    corpus: { documents: corpus.length, queries: evaluated.length, qrelsQueries: qrels.size },
    ks: [k],
    embedder: { id: embedder.id, dim: embedder.dim, semantics },
    retrieval: { lexicalScorer: scorer, knobs },
    index: { rows: build.rows, calls: build.calls, cacheHits: build.cacheHits, seconds: Math.round(indexSeconds * 10) / 10 },
    rows,
    baseline: 'lexical+no-rerank',
    /** F0: the plan's headline number, computed where both rows exist. */
    hybridMinusLexical: (() => {
      const lexical = rows.find((row) => row.config === 'lexical+rerank')?.['nDCG@10']
      const hybrid = rows.find((row) => row.config === 'hybrid+rerank')?.['nDCG@10']
      if (lexical === undefined || hybrid === undefined) return null
      return Math.round((hybrid - lexical) * 10000) / 10000
    })(),
    caveats: [
      '公开基准(BEIR):语料与 qrels 都不是本项目的,结论**不得**与内部合成集/金标集的数字混算',
      `本次只评 ${evaluated.length} 条查询(qrels 全量 ${qrels.size});取子集是为了时间,不做调参依据`,
      `嵌入为 ${embedder.id}(语义能力=${semantics === 'none' ? '0,只验管线' : '真端点'})`,
      '判分:数据集自带 qrels(分级相关度),nDCG@10 用 2^rel-1 增益,不需要判分器',
      `一级评分 = ${scorer === 'bm25' ? 'BM25F(R2 新默认)' : '旧字段权重裸和(lexicalScorer=weights 回滚档)'}`,
      'weights 档对四条配置行都生效:lexical-only 行经 fulltext 委派,该路径已在 R2 重测时补上 lexicalScorer 转发(packages/rag/src/retrieve.ts)',
      ...(extraCaveat === null ? [] : [extraCaveat]),
    ],
    /**
     * The hard lines, each with ZERO tolerance (both plans say so in those words).
     *
     * 1. F0 (规划 §5 不变量 2): with reranking on, hybrid may not lose to lexical.
     * 2. P4 of `docs/修复方案-精排量纲与语义名次.md`: on a REAL endpoint, the
     *    reranker may not lose to the fusion it is reordering. That is the defect
     *    the D-plan exists for (0.4265 vs 0.4829), and it is checked separately
     *    from line 1 because it is the one the D1/D2 switches are supposed to fix.
     */
    ...(() => {
      const lexical = rows.find((row) => row.config === 'lexical+rerank')?.['nDCG@10']
      const hybrid = rows.find((row) => row.config === 'hybrid+rerank')?.['nDCG@10']
      const hybridNoRerank = rows.find((row) => row.config === 'hybrid+no-rerank')?.['nDCG@10']
      const vsLexical = lexical === undefined || hybrid === undefined ? true : hybrid >= lexical
      const vsFusion = hybridNoRerank === undefined || hybrid === undefined ? true : hybrid >= hybridNoRerank
      return {
        ok: vsLexical && vsFusion,
        okHybridVsLexical: vsLexical,
        okRerankVsFusion: vsFusion,
        /** How much the reranker cost (or gained) against the fusion order. */
        rerankMinusFusion: hybridNoRerank === undefined || hybrid === undefined
          ? null
          : Math.round((hybrid - hybridNoRerank) * 10000) / 10000,
      }
    })(),
  }
  await mkdir(runsRoot, { recursive: true })
  const stamp = report.generatedAt.replace(/[:.]/g, '-')
  const out = path.join(runsRoot, `${stamp}_${label.replace(/\//g, '-')}_${embedderKind}${only === null ? '' : `_${only}`}${scorer === 'bm25' ? '' : `_${scorer}`}.json`)
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`[beir] 报告: ${path.relative(repoRoot, out)}`)
  if (closeHost !== null) await closeHost()
} finally {
  await rm(workdir, { recursive: true, force: true })
}
