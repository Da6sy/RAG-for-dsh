/**
 * CoIR fetcher (D2): HF rows API → BEIR-shaped files.
 *
 * CoIR ships parquet; parsing parquet would need a new dependency, so this
 * pages the public `datasets-server` rows API instead and writes the standard
 * three files (corpus.jsonl / queries.jsonl / qrels/test.tsv) into
 * `evals/datasets/beir/coir-<task>/` — which means the EXISTING BEIR runner can
 * score it unchanged (`--dataset coir-cosqa --label coir/cosqa`).
 *
 * Corpus cap: the retriever under test scans every entry per query, so a
 * 20k-passage corpus × dozens of queries is hours. `--cap N` keeps every gold
 * document plus the first N distractors; the reduction is RECORDED in the
 * report caveat, and such numbers are NOT comparable to the official board.
 *
 * Usage: node scripts/fetch-coir.mjs --task cosqa [--cap 3000]
 */
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, token, index, list) => {
  if (token.startsWith('--')) acc.push([token.slice(2), list[index + 1]?.startsWith('--') === false ? list[index + 1] : 'true'])
  return acc
}, []))
const task = args.task ?? 'cosqa'
const cap = Number(args.cap ?? 3000)
const base = `https://datasets-server.huggingface.co/rows?dataset=CoIR-Retrieval/${task}-queries-corpus&config=default&split=`
const qrelsBase = `https://datasets-server.huggingface.co/rows?dataset=CoIR-Retrieval/${task}-qrels&config=default&split=test&`

const run = promisify(execFile)

/**
 * Fetch one URL through `curl`.
 *
 * Node's global `fetch` (undici) does NOT read `HTTP_PROXY`/`HTTPS_PROXY`,
 * while this host reaches huggingface.co only through a proxy — measured: curl
 * answers the same URL in 0.7s with HTTP 200 while fetch fails with
 * UND_ERR_CONNECT_TIMEOUT. Shelling out to curl keeps the script
 * dependency-free and working behind the proxy.
 * @param url - the absolute URL.
 * @returns the response body.
 */
async function getJson(url) {
  const { stdout } = await run('curl', ['-s', '--max-time', '60', url], { maxBuffer: 64 * 1024 * 1024 })
  // The shared rows API answers with an HTML error page under load; that must
  // trigger the retry path rather than surface as a JSON parse crash.
  if (stdout.trimStart().startsWith('<')) throw new Error(`rows API 返回 HTML(限流或过载): ${stdout.slice(0, 80)}`)
  return JSON.parse(stdout)
}

/** Page the rows API until exhausted (100 rows per call). */
async function page(url, onRows) {
  let offset = 0
  let total = Number.POSITIVE_INFINITY
  while (offset < total) {
    let body = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        body = await getJson(`${url}offset=${offset}&length=100`)
        break
      } catch (error) {
        if (attempt === 4) throw error
        // 429 是"打太密了"，不是"没网":退避要按秒级起步(2/8/30/60s)
        const wait = [2000, 8000, 30000, 60000][attempt] ?? 60000
        process.stdout.write(`\n  (限流,等 ${wait / 1000}s 重试 offset=${offset})\n`)
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
    if (body.error !== undefined) throw new Error(`rows API: ${body.error}`)
    total = body.num_rows_total
    for (const row of body.rows ?? []) onRows(row.row)
    offset += (body.rows ?? []).length
    if ((body.rows ?? []).length === 0) break
    process.stdout.write(`\r  ${offset}/${total}`)
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
  process.stdout.write('\n')
}

const qrels = []
await page(qrelsBase, (row) => qrels.push({ q: String(row.query_id), d: String(row.corpus_id), score: Number(row.score) || 1 }))
const goldIds = new Set(qrels.map((row) => row.d))
console.log(`[coir] ${task}: qrels ${qrels.length} 条(金标语料 ${goldIds.size} 篇)`)

const corpus = []
const queries = []
for (const split of ['corpus', 'queries']) {
  await page(`${base}${split}&`, (row) => {
    const id = String(row._id)
    if (split === 'queries' || id.startsWith('q')) queries.push({ _id: id, title: String(row.title ?? ''), text: String(row.text ?? '') })
    else corpus.push({ _id: id, title: String(row.title ?? ''), text: String(row.text ?? '') })
  })
}
console.log(`[coir] 下载: 语料 ${corpus.length} 篇 · 查询 ${queries.length} 条`)

const kept = []
let distractors = 0
for (const doc of corpus) {
  if (goldIds.has(doc._id)) { kept.push(doc); continue }
  if (distractors < cap) { kept.push(doc); distractors += 1 }
}
const keptIds = new Set(kept.map((doc) => doc._id))
const keptQueries = new Set(qrels.filter((row) => keptIds.has(row.d)).map((row) => row.q))
const keptQrels = qrels.filter((row) => keptIds.has(row.d))

const dir = path.join(repoRoot, 'evals', 'datasets', 'beir', `coir-${task}`)
await mkdir(path.join(dir, 'qrels'), { recursive: true })
await writeFile(path.join(dir, 'corpus.jsonl'), kept.map((doc) => JSON.stringify(doc)).join('\n') + '\n', 'utf8')
await writeFile(path.join(dir, 'queries.jsonl'), queries.filter((q) => keptQueries.has(q._id)).map((q) => JSON.stringify(q)).join('\n') + '\n', 'utf8')
await writeFile(path.join(dir, 'qrels', 'test.tsv'), 'query-id\tcorpus-id\tscore\n' + keptQrels.map((row) => `${row.q}\t${row.d}\t${row.score}`).join('\n') + '\n', 'utf8')
console.log(`[coir] 落盘 ${path.relative(repoRoot, dir)}: 语料 ${kept.length}(含全部金标 + ${distractors} 干扰) · 可评查询 ${keptQueries.size}`)
console.log(`[coir] 下次运行: node scripts/bench-beir.mjs --dataset coir-${task} --label coir/${task} --queries 20 --only lexical+rerank`)
