/**
 * 诊断：精排为什么会让**召回率**下降（recall@10 下降）。
 *
 * 起因：真端点 cosqa 上 `hybrid+no-rerank` recall@10 0.75、`hybrid+rerank` 0.65 —— 金标 95% 都在精排窗口里，
 * 精排却把其中一部分挤出了前 10。本脚本把"谁掉出去了、被谁挤掉、两边的特征各是多少"逐条打出来，
 * 让结论建立在数字上而不是机制想象上。
 *
 * 用法：
 *   node scripts/diagnose-rerank-recall.mjs [--dataset coir-cosqa] [--queries 20] [--depth 30] [--embedder http|hash]
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
const dataset = args.dataset ?? 'coir-cosqa'
const label = args.label ?? dataset
const maxQueries = Number(args.queries ?? 20)
const depth = Number(args.depth ?? 30)
const embedderKind = args.embedder ?? 'http'
const k = 10

const dataDir = path.join(datasetRoot, dataset)
const corpus = []
await readJsonl(path.join(dataDir, 'corpus.jsonl'), (row) => corpus.push({ id: String(row._id), title: String(row.title ?? ''), text: String(row.text ?? '') }))
const queries = new Map()
await readJsonl(path.join(dataDir, 'queries.jsonl'), (row) => queries.set(String(row._id), String(row.text)))
const qrels = await readQrels(path.join(dataDir, 'qrels', 'test.tsv'))
const evaluated = [...qrels.keys()].filter((qid) => queries.has(qid)).slice(0, maxQueries)

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
console.log(`[诊断] ${label} · ${evaluated.length} 查询 · 语料 ${corpus.length} · embedder=${embedder.id}(${semantics}) · 窗口 ${depth} · 指标 @${k}`)

const workdir = await mkdtemp(path.join(tmpdir(), 'clue-recall-'))
const store = await openProjectStore(path.join(workdir, 'p'), path.join(workdir, 'h'))
const home = path.join(workdir, 'h')
try {
  const entryToGold = new Map()
  for (const doc of corpus) {
    const entry = await store.add({ kind: 'fact', title: doc.title === '' ? doc.id : doc.title, text: doc.text, createdBy: 'diag:rerank-recall' })
    entryToGold.set(String(entry.id), doc.id)
  }
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, maxUnitsPerBuild: 100_000 })

  const make = (rerank) => createHybridRetriever(store, null, {
    channels: 'hybrid', rerank, profile: 'tool', topK: depth, embedder, home, rebuildOnRead: false,
  })

  const fusedRun = make(false)
  const rerankRun = make(true)

  /** Feature snapshot of one hit, for the tables below. */
  const snapshot = (hit, rank) => ({
    gold: entryToGold.get(String(hit.entry.id)) ?? String(hit.entry.id),
    rank,
    score: hit.score,
    lexicalRank: hit.explain?.channels?.lexical ?? null,
    vectorRank: hit.explain?.channels?.vector ?? null,
    bm25ish: hit.explain?.features?.bm25ish ?? null,
    semantic: hit.explain?.features?.semantic ?? null,
    exactPhrase: hit.explain?.features?.exactPhrase ?? null,
    specificity: hit.explain?.features?.specificity ?? null,
  })

  const mean = (rows, key) => {
    const values = rows.map((row) => row[key]).filter((value) => typeof value === 'number')
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
  }

  const fallen = []      // gold in fused top-k but NOT in reranked top-k
  const displaced = []   // the non-gold docs that took their place
  let fusedGold = 0
  let rerankGold = 0
  let fusedNdcg = 0
  let rerankNdcg = 0
  const dcg = (gains) => gains.reduce((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0)

  for (const qid of evaluated) {
    const gold = qrels.get(qid) ?? new Map()
    const query = queries.get(qid) ?? ''
    const fused = await fusedRun.retrieveDetailed(query, { limit: depth, noTouch: true })
    const reranked = await rerankRun.retrieveDetailed(query, { limit: depth, noTouch: true })
    const fusedSnaps = fused.hits.map(snapshot)
    const rerankSnaps = reranked.hits.map(snapshot)
    const fusedTop = fusedSnaps.slice(0, k)
    const rerankTop = rerankSnaps.slice(0, k)
    const fusedGoldIds = fusedTop.filter((row) => gold.has(row.gold)).map((row) => row.gold)
    const rerankGoldIds = rerankTop.filter((row) => gold.has(row.gold)).map((row) => row.gold)
    fusedGold += fusedGoldIds.length
    rerankGold += rerankGoldIds.length
    const ideal = [...gold.values()].sort((a, b) => b - a).slice(0, k)
    const idealDcg = dcg(ideal)
    if (idealDcg > 0) {
      fusedNdcg += dcg(fusedTop.map((row) => gold.get(row.gold) ?? 0)) / idealDcg
      rerankNdcg += dcg(rerankTop.map((row) => gold.get(row.gold) ?? 0)) / idealDcg
    }
    for (const row of fusedTop) {
      if (!gold.has(row.gold)) continue
      if (rerankGoldIds.includes(row.gold)) continue
      // Features come from the RERANKED run: the fused run has no feature vector
      // (it never ran the reranker), and the point is what the reranker SAW.
      const inRerank = rerankSnaps.find((candidate) => candidate.gold === row.gold)
      fallen.push({ qid, ...row, ...(inRerank ?? {}), fusedRank: row.rank })
      // Whoever took the slot: a non-gold document that was NOT in the fused top-k.
      for (const candidate of rerankTop) {
        if (gold.has(candidate.gold)) continue
        if (fusedTop.some((row) => row.gold === candidate.gold)) continue
        displaced.push({ qid, ...candidate })
      }
    }
    // Show the two most interesting queries in full. The feature values of the lost
    // gold docs come from the RERANKED run — the fused run carries no feature vector.
    const lost = fusedTop
      .filter((row) => gold.has(row.gold) && !rerankGoldIds.includes(row.gold))
      .map((row) => ({ ...row, ...(rerankSnaps.find((candidate) => candidate.gold === row.gold) ?? {}) }))
    if (lost.length > 0 && fallen.filter((row) => row.qid === qid).length <= 2) {
      console.log(`\n查询 ${qid}: ${JSON.stringify(query)}`)
      for (const row of lost) {
        console.log(`  掉出前 ${k} 的金标 ${row.gold}  [融合第 ${row.rank} 名]  词法名次 ${row.lexicalRank ?? '-'} 语义名次 ${row.vectorRank ?? '-'}`)
        console.log(`     特征: bm25ish=${row.bm25ish?.toFixed(3)} 语义=${row.semantic?.toFixed(3)} 精确短语=${row.exactPhrase?.toFixed(2)} 覆盖率=${row.specificity?.toFixed(2)}`)
      }
      for (const row of rerankTop.slice(0, 3)) {
        console.log(`  精排前 3 名 ${row.gold}${gold.has(row.gold) ? '(金标)' : '(非金标)'}  词法名次 ${row.lexicalRank ?? '-'} 语义名次 ${row.vectorRank ?? '-'}`)
        console.log(`     特征: bm25ish=${row.bm25ish?.toFixed(3)} 语义=${row.semantic?.toFixed(3)} 精确短语=${row.exactPhrase?.toFixed(2)} 覆盖率=${row.specificity?.toFixed(2)}`)
      }
    }
  }

  const n = evaluated.length || 1
  console.log('\n── 总览')
  console.log(`   recall@10: 不精排 ${(fusedGold / n).toFixed(4)}（${fusedGold} 条金标命中）→ 精排 ${(rerankGold / n).toFixed(4)}（${rerankGold} 条），共 ${n} 查询`)
  console.log(`   nDCG@10:   不精排 ${(fusedNdcg / n).toFixed(4)} → 精排 ${(rerankNdcg / n).toFixed(4)}`)
  console.log('\n── 掉出前 10 的金标（各查询合计）')
  console.log(`   条数 ${fallen.length}`)
  console.log(`   平均: bm25ish=${mean(fallen, 'bm25ish')?.toFixed(3)} 语义=${mean(fallen, 'semantic')?.toFixed(3)} 精确短语=${mean(fallen, 'exactPhrase')?.toFixed(2)} 覆盖率=${mean(fallen, 'specificity')?.toFixed(2)}`)
  console.log(`   词法名次中位/缺失: ${fallen.filter((row) => row.lexicalRank === null).length} 条从未被词法召回；被词法召回的平均名次 ${mean(fallen.filter((r) => r.lexicalRank !== null), 'lexicalRank')?.toFixed(1) ?? '-'}`)
  console.log(`   语义名次平均: ${mean(fallen.filter((r) => r.vectorRank !== null), 'vectorRank')?.toFixed(1) ?? '-'}`)
  console.log('\n── 挤上来的非金标')
  console.log(`   条数 ${displaced.length}`)
  console.log(`   平均: bm25ish=${mean(displaced, 'bm25ish')?.toFixed(3)} 语义=${mean(displaced, 'semantic')?.toFixed(3)} 精确短语=${mean(displaced, 'exactPhrase')?.toFixed(2)} 覆盖率=${mean(displaced, 'specificity')?.toFixed(2)}`)
} finally {
  await rm(workdir, { recursive: true, force: true })
  if (closeHost !== null) await closeHost()
}
