/**
 * 诊断：精排为什么会让**召回率**下降（recall@10 下降），以及 D1/D2 是否把它救回来。
 *
 * 起因：真端点 cosqa 上 `hybrid+no-rerank` recall@10 0.75、`hybrid+rerank` 0.65 —— 金标 95% 都在精排窗口里，
 * 精排却把其中一部分挤出了前 10。本脚本把"谁掉出去了、被谁挤掉、两边的特征各是多少"逐条打出来，
 * 让结论建立在数字上而不是机制想象上。
 *
 * P0（`docs/开发记录.md`）把它扩成**矩阵**：
 *   · 数据集可以给多个（cosqa 默认**全量查询**，nfcorpus/scifact 默认抽 50 条，取子集只为时间）；
 *   · 同一份语料上并排跑四个档位：不精排 / 旧尺度精排(candidates+raw) / 新尺度精排(absolute+calibrated)；
 *   · 每档都报 `goldDemotedOutOfTop10`、语义第 1 名金标存活率、`bm25ish` 的**绝对水平**（有几条被拉满）。
 *
 * 「语义第 1 名金标存活率」的分母是"语义通道第 1 名恰好是金标"的查询数 —— 这正是缺陷 1 的受害者：
 * 语义通道自己排第一、词法通道没召回，于是 bm25ish=0 而别人被拉满到 1.0。
 *
 * 用法：
 *   node scripts/diagnose-rerank-recall.mjs [--datasets coir-cosqa,nfcorpus,scifact]
 *        [--queries 500|50] [--depth 30] [--embedder http|hash] [--detail 2]
 */
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
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
  for await (const line of rl) { if (line.trim() !== '') onRow(JSON.parse(line)) }
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

const args = parseArgs(process.argv.slice(2))
/** 每个数据集的查询预算；cosqa 给 'all' 就是全量（它的语料只有 1700 篇，跑得动）。 */
const budgetArg = args.queries ?? null
const datasets = String(args.datasets ?? args.dataset ?? 'coir-cosqa').split(',').map((name) => name.trim()).filter((name) => name !== '')
const depth = Number(args.depth ?? 30)
const embedderKind = args.embedder ?? 'http'
const detailBudget = Number(args.detail ?? 2)
const k = 10

const { openProjectStore } = await import('@clue-harness/kb')
const { buildVectorIndex, createHybridRetriever, hashEmbedder } = await import('@clue-harness/rag')

let embedder = hashEmbedder()
let closeHost = null
let semantics = 'none'
if (embedderKind === 'http') {
  const { openEmbeddingHost } = await import('@clue-harness/kb-face/embedding-host')
  const { createHttpEmbedder } = await import('@clue-harness/kb-face/http-embedder')
  const { embeddingReady, readEmbeddingConfig, resolveEmbeddingKey } = await import('@clue-harness/kb-face/embedding')
  const host = await openEmbeddingHost()
  closeHost = () => host.close()
  const config = readEmbeddingConfig(host.ctx)
  if (!embeddingReady(config)) throw new Error('嵌入未就绪')
  embedder = createHttpEmbedder({
    getConfig: () => ({ baseUrl: config.baseUrl, model: config.model, dim: config.dim, headers: config.headers, timeoutMs: config.timeoutMs, batchSize: config.batchSize }),
    resolveKey: () => resolveEmbeddingKey(host.ctx, readEmbeddingConfig(host.ctx)),
  })
  semantics = 'endpoint'
}

/**
 * 四个档位。
 *
 * `channels` 与 D1/D2 的旋钮是**唯一的差别**：同一份语料、同一次索引、同一个嵌入器，
 * 这样"精排把金标挤出去"和"D1/D2 把它救回来"才是可比的（A/B 协议：一次只改一个变量）。
 */
const VARIANTS = [
  { id: 'lexical+no-rerank', channels: 'lexical', rerank: false },
  { id: 'hybrid+no-rerank', channels: 'hybrid', rerank: false },
  { id: 'hybrid+rerank(candidates/raw)', channels: 'hybrid', rerank: true },
  {
    id: 'hybrid+rerank(absolute/calibrated)',
    channels: 'hybrid',
    rerank: true,
    knobs: { lexicalNormalization: 'absolute', semanticScale: 'calibrated' },
  },
]

const dcg = (gains) => gains.reduce((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0)
const mean = (rows, key) => {
  const values = rows.map((row) => row[key]).filter((value) => typeof value === 'number')
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
}
const round = (value) => (value === null ? null : Math.round(value * 10000) / 10000)

/** Feature snapshot of one hit, for the tables below. */
const snapshot = (entryToGold) => (hit, index) => ({
  gold: entryToGold.get(String(hit.entry.id)) ?? String(hit.entry.id),
  rank: index + 1,
  score: hit.score,
  lexicalRank: hit.explain?.channels?.lexical ?? null,
  vectorRank: hit.explain?.channels?.vector ?? null,
  bm25ish: hit.explain?.features?.bm25ish ?? null,
  semantic: hit.explain?.features?.semantic ?? null,
  exactPhrase: hit.explain?.features?.exactPhrase ?? null,
  specificity: hit.explain?.features?.specificity ?? null,
})

/** 一个数据集跑一遍全部档位，返回总览 + 取证明细。 */
async function diagnose(dataset) {
  const dataDir = path.join(datasetRoot, dataset)
  const corpus = []
  await readJsonl(path.join(dataDir, 'corpus.jsonl'), (row) => corpus.push({ id: String(row._id), title: String(row.title ?? ''), text: String(row.text ?? '') }))
  const queries = new Map()
  await readJsonl(path.join(dataDir, 'queries.jsonl'), (row) => queries.set(String(row._id), String(row.text)))
  const qrels = await readQrels(path.join(dataDir, 'qrels', 'test.tsv'))
  const all = [...qrels.keys()].filter((qid) => queries.has(qid))
  const budget = budgetArg === null ? (dataset === 'coir-cosqa' ? all.length : 50) : Number(budgetArg)
  const evaluated = all.slice(0, budget)

  const workdir = await mkdtemp(path.join(tmpdir(), 'clue-recall-'))
  const home = path.join(workdir, 'h')
  const store = await openProjectStore(path.join(workdir, 'p'), home)
  try {
    const entryToGold = new Map()
    for (const doc of corpus) {
      const entry = await store.add({ kind: 'fact', title: doc.title === '' ? doc.id : doc.title, text: doc.text, createdBy: 'diag:rerank-recall' })
      entryToGold.set(String(entry.id), doc.id)
    }
    const indexStart = Date.now()
    await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, maxUnitsPerBuild: 100_000 })
    const indexSeconds = Math.round((Date.now() - indexStart) / 100) / 10

    const runs = VARIANTS.map((variant) => ({
      variant,
      retriever: createHybridRetriever(store, null, {
        channels: variant.channels,
        rerank: variant.rerank,
        profile: 'tool',
        topK: depth,
        ...(variant.channels === 'hybrid' ? { embedder } : {}),
        home,
        rebuildOnRead: false,
        ...(variant.knobs ?? {}),
      }),
    }))
    // 窗口用"不精排"的次序度量：那正是精排收到的融合序。
    const windowRun = runs.find((run) => run.variant.id === 'hybrid+no-rerank') ?? runs[0]

    const summary = new Map(runs.map((run) => [run.variant.id, {
      ndcg: 0, recall: 0, gold: 0, demoted: 0, windowTop10Gold: 0,
      semanticTop1Gold: 0, semanticTop1Survived: 0, saturated: 0, bm25Tops: [], scored: 0, vectorUsed: 0,
    }]))
    const fallen = []
    const displaced = []
    let detailed = 0

    for (const qid of evaluated) {
      const gold = qrels.get(qid) ?? new Map()
      const query = queries.get(qid) ?? ''
      const window = await windowRun.retriever.retrieveDetailed(query, { limit: Math.max(depth, 30), noTouch: true })
      const windowSnaps = window.hits.map(snapshot(entryToGold))
      const windowTop10 = windowSnaps.slice(0, k)
      const windowTop10Gold = new Set(windowTop10.filter((row) => gold.has(row.gold)).map((row) => row.gold))
      const semanticTop1 = windowSnaps.find((row) => row.vectorRank === 1)

      for (const run of runs) {
        const stats = summary.get(run.variant.id)
        const result = await run.retriever.retrieveDetailed(query, { limit: depth, noTouch: true })
        if (result.vector.status === 'used') stats.vectorUsed += 1
        const snaps = result.hits.map(snapshot(entryToGold))
        const top = snaps.slice(0, k)
        const goldIds = top.filter((row) => gold.has(row.gold)).map((row) => row.gold)
        stats.gold += goldIds.length
        // BEIR 的 recall@10 是"召回的金标 / 全部金标"，不是命中条数。
        stats.recall += goldIds.length / Math.max(1, gold.size)
        stats.scored += 1
        const ideal = [...gold.values()].sort((a, b) => b - a).slice(0, k)
        const idealDcg = dcg(ideal)
        if (idealDcg > 0) stats.ndcg += dcg(top.map((row) => gold.get(row.gold) ?? 0)) / idealDcg
        // 只有在"精排开启"的档位里才有"被挤出去"这回事；不精排的档位就是窗口本身，天然 0。
        if (run.variant.rerank) {
          for (const goldId of windowTop10Gold) {
            stats.windowTop10Gold += 1
            if (!goldIds.includes(goldId)) stats.demoted += 1
          }
          const bm25Values = snaps.map((row) => row.bm25ish).filter((value) => typeof value === 'number')
          if (bm25Values.length > 0) {
            const top1 = Math.max(...bm25Values)
            stats.bm25Tops.push(top1)
            if (top1 >= 0.999) stats.saturated += 1
          }
        }
        if (semanticTop1 !== undefined && gold.has(semanticTop1.gold) && run.variant.rerank) {
          stats.semanticTop1Gold += 1
          if (goldIds.includes(semanticTop1.gold)) stats.semanticTop1Survived += 1
        }
        if (run.variant.id === 'hybrid+rerank(candidates/raw)') {
          for (const row of windowTop10) {
            if (!gold.has(row.gold)) continue
            if (goldIds.includes(row.gold)) continue
            // 特征取精排那一遍看到的（不精排的档位没有特征向量），要点是"精排看到了什么"。
            const inRerank = snaps.find((candidate) => candidate.gold === row.gold) ?? {}
            fallen.push({ qid, dataset, ...row, ...inRerank, fusedRank: row.rank, query })
            for (const candidate of top) {
              if (gold.has(candidate.gold)) continue
              if (windowTop10.some((row) => row.gold === candidate.gold)) continue
              displaced.push({ qid, dataset, ...candidate })
            }
          }
          if (detailed < detailBudget && fallen.some((row) => row.qid === qid)) {
            detailed += 1
            console.log(`\n  [${dataset}] 查询 ${qid}: ${JSON.stringify(query)}`)
            for (const row of fallen.filter((item) => item.qid === qid)) {
              console.log(`    掉出前 ${k} 的金标 ${row.gold}  [融合第 ${row.fusedRank} 名]  词法名次 ${row.lexicalRank ?? '-'} 语义名次 ${row.vectorRank ?? '-'}`)
              console.log(`       特征: bm25ish=${row.bm25ish?.toFixed(3)} 语义=${row.semantic?.toFixed(3)} 精确短语=${row.exactPhrase?.toFixed(2)} 覆盖率=${row.specificity?.toFixed(2)}`)
            }
            for (const row of top.slice(0, 3)) {
              console.log(`    精排前 3 名 ${row.gold}${gold.has(row.gold) ? '(金标)' : '(非金标)'}  词法名次 ${row.lexicalRank ?? '-'} 语义名次 ${row.vectorRank ?? '-'}`)
              console.log(`       特征: bm25ish=${row.bm25ish?.toFixed(3)} 语义=${row.semantic?.toFixed(3)} 精确短语=${row.exactPhrase?.toFixed(2)} 覆盖率=${row.specificity?.toFixed(2)}`)
            }
          }
        }
      }
    }
    return { dataset, corpus: corpus.length, queries: evaluated.length, qrelsQueries: qrels.size, indexSeconds, summary, fallen, displaced }
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }
}

const results = []
for (const dataset of datasets) {
  console.log(`\n══ ${dataset} · embedder=${embedder.id}(${semantics}) · 窗口 ${depth} · 指标 @${k}`)
  const result = await diagnose(dataset)
  results.push(result)
  const n = result.queries || 1
  console.log(`   语料 ${result.corpus} 篇 · 本次评 ${result.queries}/${result.qrelsQueries} 条查询 · 索引 ${result.indexSeconds}s`)
  const header = ['档位', 'nDCG@10', 'recall@10', '金标命中', '掉出前10', '语义第1金标/存活', 'bm25ish 顶值', '被拉满查询']
  const widths = [34, 9, 10, 9, 9, 16, 13, 12]
  const line = (cells) => `   ${cells.map((cell, index) => String(cell).padEnd(widths[index] ?? 10)).join('')}`
  console.log(line(header))
  for (const [id, stats] of result.summary) {
    const cells = [
      id,
      (stats.ndcg / n).toFixed(4),
      (stats.recall / n).toFixed(4),
      String(stats.gold),
      stats.scored === 0 ? '-' : String(stats.demoted),
      stats.scored === 0 ? '-' : `${stats.semanticTop1Gold}/${stats.semanticTop1Survived}`,
      round(mean(stats.bm25Tops.map((value) => ({ value })), 'value'))?.toFixed(3) ?? '-',
      stats.bm25Tops.length === 0 ? '-' : `${stats.saturated}/${stats.bm25Tops.length}`,
    ]
    console.log(line(cells))
  }
  console.log(`   掉出前 10 的金标 ${result.fallen.length} 条；挤上来的非金标 ${result.displaced.length} 条`)
  if (result.fallen.length > 0) {
    console.log(`   掉队者平均: bm25ish=${mean(result.fallen, 'bm25ish')?.toFixed(3)} 语义=${mean(result.fallen, 'semantic')?.toFixed(3)} 精确短语=${mean(result.fallen, 'exactPhrase')?.toFixed(2)} 覆盖率=${mean(result.fallen, 'specificity')?.toFixed(2)}`)
    console.log(`      从未被词法召回 ${result.fallen.filter((row) => row.lexicalRank === null).length}/${result.fallen.length} 条；被召回者平均词法名次 ${mean(result.fallen.filter((row) => row.lexicalRank !== null), 'lexicalRank')?.toFixed(1) ?? '-'}`)
  }
  if (result.displaced.length > 0) {
    console.log(`   挤上来者平均: bm25ish=${mean(result.displaced, 'bm25ish')?.toFixed(3)} 语义=${mean(result.displaced, 'semantic')?.toFixed(3)} 精确短语=${mean(result.displaced, 'exactPhrase')?.toFixed(2)} 覆盖率=${mean(result.displaced, 'specificity')?.toFixed(2)}`)
  }
}

console.log('\n── 矩阵小结（金标存活是分母很小的比例，只写方向不写幅度）')
for (const result of results) {
  const baseline = result.summary.get('hybrid+no-rerank')
  const old = result.summary.get('hybrid+rerank(candidates/raw)')
  const fixed = result.summary.get('hybrid+rerank(absolute/calibrated)')
  const n = result.queries || 1
  console.log(`   ${result.dataset}: recall@10 不精排 ${(baseline.recall / n).toFixed(4)} → 旧尺度 ${(old.recall / n).toFixed(4)} → 新尺度 ${(fixed.recall / n).toFixed(4)}`)
  console.log(`      nDCG@10  不精排 ${(baseline.ndcg / n).toFixed(4)} → 旧尺度 ${(old.ndcg / n).toFixed(4)} → 新尺度 ${(fixed.ndcg / n).toFixed(4)}`)
}
if (closeHost !== null) await closeHost()
