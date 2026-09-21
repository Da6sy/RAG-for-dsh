/**
 * `clue recall --prompt-ab` — the query-doctrine A/B (V3, 规划 §11).
 *
 * §11 calls the prompt change "零代码成本、收益最高的一处改动,但必须评测后再改".
 * This module is the "评测" half. It asks the CONFIGURED CHAT MODEL to write
 * retrieval queries for a sample of synthetic documents under two doctrines:
 *
 *   `keywords` — the prompt that shipped through M9 ("检索词,建议带上关键名词")
 *   `intent`   — the V3 target ("一句意图句,15–40 字,主谓宾完整")
 *
 * then measures the resulting queries with the SHIPPED retriever over the same
 * corpus and reports the difference per doctrine. The model writes the queries;
 * the product does the retrieving — neither half is simulated.
 *
 * What this run can and cannot show, stated up front because the report prints
 * it too:
 *
 * - It CAN show whether the intent sentence HURTS lexical matching. That is a
 *   real risk: a 30-character sentence carries more bigram noise than a
 *   4-keyword pile, and the lexical channel is still the one that finds exact
 *   identifiers.
 * - It CANNOT show the semantic benefit, unless a real embedding endpoint is
 *   configured. With `hashEmbedder` the vector channel has no semantics, so a
 *   win for `intent` here would be a lexical accident and a loss would be
 *   real. The report labels the embedder accordingly.
 *
 * Cost control: documents are batched (several per model call) and the sample
 * is bounded by `--samples`, so the default run is a dozen short calls.
 *
 * @module @clue-harness/cli/prompt-ab
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openProjectStore } from '@clue-harness/kb'
import { buildVectorIndex, createHybridRetriever, hashEmbedder, type Embedder } from '@clue-harness/rag'
import type { ChatHost } from '@clue-harness/kb-face/chat-host'
import { parseArgs, scoreRanking, summarizeRanking, type ParsedArgs, type SummaryBlock } from './recall-cli.ts'

/** The two query doctrines under test. */
export type QueryDoctrine = 'keywords' | 'intent'

/** The shipped prompt for each doctrine (the strings the product ships matter). */
export const DOCTRINE_PROMPTS: Record<QueryDoctrine, string> = {
  keywords:
    '你是编码助手。为下面每个文档写一条检索查询,风格要求:**只给关键词堆**——2 到 5 个关键名词,空格分隔,不要写成句子。'
    + '查询必须能唯一定位到该文档(必要时带上其中的标识符或编号)。',
  intent:
    '你是编码助手。为下面每个文档写一条检索查询,风格要求:**一句自然语言意图句**——主谓宾完整,15 到 40 字,'
    + '像人在提问,不要拆成关键词堆;必要时在句末追加关键标识符。查询必须能唯一定位到该文档。',
}

/** One generated query with the doctrine that produced it. */
export interface AbGeneratedQuery {
  doctrine: QueryDoctrine
  /** The document the model was shown. */
  goldDocId: string
  text: string
}

/** One doctrine's measured outcome. */
export interface AbDoctrineResult {
  doctrine: QueryDoctrine
  queries: number
  /** Empty when the model produced nothing usable. */
  overall: SummaryBlock | null
  /** Averaged query length in characters (the doctrines should differ here). */
  avgChars: number
  /** Samples for the human to eyeball (the qualitative half of the report). */
  samples: string[]
}

/** The A/B report. */
export interface PromptAbReport {
  generatedAt: string
  model: { provider: string; model: string }
  samples: number
  /** Documents where BOTH doctrines produced a query (the compared set). */
  pairedPairs: number
  /** Documents one doctrine skipped (excluded from the comparison). */
  droppedPairs: number
  calls: number
  embedder: { id: string; semantics: 'none' | 'endpoint' }
  results: AbDoctrineResult[]
  /** recall@1 points gained by `intent` over `keywords` (null when unmeasurable). */
  deltaPt: number | null
  caveats: string[]
}

/** Extract the JSON object from a model answer that may be wrapped in prose or fences. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error(`模型没有返回 JSON 对象: ${candidate.slice(0, 120)}`)
  return JSON.parse(candidate.slice(start, end + 1))
}

/**
 * Pull one query per document out of a model answer.
 *
 * Tolerant on purpose: a model that answers with a bare array, with `queries`,
 * or with extra keys is doing the task, not failing it — only a missing/blank
 * query for a document counts as a miss.
 * @param raw - the model's answer text.
 * @param expected - how many documents were sent.
 * @returns the queries in input order (empty strings when the model skipped one).
 */
export function parseQueries(raw: string, expected: number): string[] {
  const parsed = extractJson(raw) as { queries?: unknown } | unknown[]
  const list = Array.isArray(parsed) ? parsed : (parsed as { queries?: unknown }).queries
  if (!Array.isArray(list)) throw new Error('模型返回里没有 queries 数组')
  const out = new Array<string>(expected).fill('')
  for (const item of list) {
    if (typeof item === 'string') continue
    const row = item as { index?: unknown; query?: unknown; i?: unknown }
    const index = Number(row.index ?? row.i)
    const query = typeof row.query === 'string' ? row.query.trim() : ''
    if (!Number.isInteger(index) || index < 0 || index >= expected || query === '') continue
    out[index] = query
  }
  return out
}

/** The prompt one batch of documents is shown under. */
function batchPrompt(doctrine: QueryDoctrine, docs: Array<{ id: string; title: string; body: string }>): string {
  const items = docs.map((doc, index) => {
    const excerpt = doc.body.replace(/\s+/g, ' ').slice(0, 500)
    return `[${index}] 标题: ${doc.title}\n正文: ${excerpt}`
  }).join('\n\n')
  return `${DOCTRINE_PROMPTS[doctrine]}\n\n`
    + `只输出 JSON,形如 {"queries":[{"index":0,"query":"…"}]},每个文档恰好一条,不要解释。\n\n`
    + `文档:\n${items}`
}

/**
 * Run the A/B.
 * @param args - parsed CLI flags (`--samples`, `--batch`, `--chunks`, `--queries`, `--seed`, `--embedder`, `--rerank`).
 * @param host - the opened chat host (the model that writes the queries).
 * @param deps - the corpus generator and the optional real embedder.
 * @returns the report.
 */
export async function runPromptAb(
  args: ParsedArgs,
  host: ChatHost,
  deps: {
    buildSet: (options: { chunks: number; queries: number; seed: number; kinds: string[] }) => {
      docs: Array<{ id: string; title: string; body: string; subject: string }>
      queries: Array<{ id: string; kind: string; text: string; goldDocId: string }>
    }
    httpEmbedder: Embedder | null
  },
): Promise<PromptAbReport> {
  const samples = Number(args.samples ?? 24)
  const batchSize = Number(args.batch ?? 4)
  const set = deps.buildSet({
    chunks: Number(args.chunks ?? 200),
    queries: 0,
    seed: Number(args.seed ?? 20260913),
    kinds: ['exact'],
  })
  const sampledDocs = set.docs.slice(0, samples)
  const embedderKind = typeof args.embedder === 'string' ? args.embedder : 'hash'
  const embedder = embedderKind === 'http'
    ? deps.httpEmbedder ?? (() => { throw new Error('--embedder http 需要已配置并实测维度的嵌入端点') })()
    : hashEmbedder()
  const semantics: 'none' | 'endpoint' = embedderKind === 'http' ? 'endpoint' : 'none'

  // ── 1) the model writes the queries ─────────────────────────────────────
  const generated: AbGeneratedQuery[] = []
  let calls = 0
  for (const doctrine of ['keywords', 'intent'] as QueryDoctrine[]) {
    for (let offset = 0; offset < sampledDocs.length; offset += batchSize) {
      const batch = sampledDocs.slice(offset, offset + batchSize)
      calls += 1
      const answer = await host.ask({
        prompt: batchPrompt(doctrine, batch),
        // Writing four queries is not a reasoning task: thinking would only
        // consume the token budget and can leave the visible answer empty.
        reasoningEffort: 'off',
        maxTokens: 4000,
        timeoutMs: 120_000,
      })
      if (answer.text.trim() === '') {
        throw new Error(`模型没有返回可见文本(思考 ${answer.reasoningChars} 字)——提高 --max-tokens 或换模型`)
      }
      const queries = parseQueries(answer.text, batch.length)
      batch.forEach((doc, index) => {
        const text = queries[index] ?? ''
        if (text !== '') generated.push({ doctrine, goldDocId: doc.id, text })
      })
    }
  }

  // ── 2) the product retrieves with them ──────────────────────────────────
  const workdir = await mkdtemp(path.join(tmpdir(), 'clue-promptab-'))
  const project = path.join(workdir, 'project')
  const home = path.join(workdir, 'home')
  const ks = String(args.k ?? '1,5').split(',').map((value) => Number(value.trim())).filter(Number.isFinite)
  const maxK = Math.max(...ks)
  const store = await openProjectStore(project, home)
  const results: AbDoctrineResult[] = []
  let pairedPairs = 0
  let droppedPairs = 0
  try {
    const goldOf = new Map<string, string>()
    for (const doc of set.docs) {
      const entry = await store.add({ kind: 'decision', title: doc.title, text: doc.body, tags: [doc.subject], createdBy: 'test:prompt-ab' })
      goldOf.set(String(entry.id), doc.id)
    }
    await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, maxUnitsPerBuild: 100_000 })
    const retriever = createHybridRetriever(store, null, {
      channels: semantics === 'endpoint' ? 'hybrid' : 'lexical',
      rerank: args.rerank === undefined ? true : args.rerank === 'on',
      profile: 'tool',
      topK: maxK,
      embedder,
      home,
      rebuildOnRead: false,
    })
    // PAIRED evaluation: a model that skips a document in one doctrine would
    // otherwise make the two sides answer on different questions. Keeping only
    // the documents both doctrines covered is what makes the delta a statement
    // about the PROMPT rather than about which docs got dropped.
    const keywordDocs = new Set(generated.filter((row) => row.doctrine === 'keywords').map((row) => row.goldDocId))
    const intentDocs = new Set(generated.filter((row) => row.doctrine === 'intent').map((row) => row.goldDocId))
    const paired = new Set([...keywordDocs].filter((id) => intentDocs.has(id)))
    pairedPairs = paired.size
    droppedPairs = sampledDocs.length - paired.size
    for (const doctrine of ['keywords', 'intent'] as QueryDoctrine[]) {
      const mine = generated.filter((row) => row.doctrine === doctrine && paired.has(row.goldDocId))
      const rows = []
      for (const row of mine) {
        const detailed = await retriever.retrieveDetailed(row.text, { limit: maxK, noTouch: true })
        const ranked = detailed.hits.map((hit) => goldOf.get(String(hit.entry.id)) ?? String(hit.entry.id))
        rows.push({ kind: doctrine, outcome: scoreRanking(ranked, row.goldDocId, ks) })
      }
      results.push({
        doctrine,
        queries: mine.length,
        overall: mine.length === 0 ? null : summarizeRanking(rows, ks).overall,
        avgChars: mine.length === 0 ? 0 : Math.round(mine.reduce((sum, row) => sum + row.text.length, 0) / mine.length),
        samples: mine.slice(0, 3).map((row) => row.text),
      })
    }
  } finally {
    await rm(workdir, { recursive: true, force: true })
  }

  const keywords = results.find((row) => row.doctrine === 'keywords')?.overall ?? null
  const intent = results.find((row) => row.doctrine === 'intent')?.overall ?? null
  const deltaPt = keywords === null || intent === null
    ? null
    : Math.round((intent.recall[1] - keywords.recall[1]) * 1000) / 10
  const caveats = [
    '查询由真模型按两种提示词写出,检索由产品自己的检索器执行 —— 两半都是真的',
    'recall@1 才是这一页要看的数;@5 在合成集上通常饱和',
  ]
  if (semantics === 'none') {
    caveats.push('嵌入为 hashEmbedder(语义能力=0):本次只测"意图句是否伤害词法匹配",语义收益必须用真端点重跑')
  }
  return {
    generatedAt: new Date().toISOString(),
    model: { provider: host.route.provider, model: host.route.model },
    samples: sampledDocs.length,
    pairedPairs,
    droppedPairs,
    calls,
    embedder: { id: embedder.id, semantics },
    results,
    deltaPt,
    caveats,
  }
}

/** Render the A/B report. */
export function printPromptAb(report: PromptAbReport): void {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
  console.log('')
  console.log(`提示词 A/B:模型 ${report.model.provider}/${report.model.model} · 取样 ${report.samples} 篇 · 模型调用 ${report.calls} 次`)
  console.log(`配对样本 ${report.pairedPairs} 篇(两种提示词都写出了查询);另有 ${report.droppedPairs} 篇被模型漏写,已从对比中剔除`)
  console.log(`嵌入: ${report.embedder.id}(${report.embedder.semantics === 'none' ? '语义能力=0' : '真端点'})`)
  console.log('')
  console.log(`${'提示词风格'.padEnd(14)}${'查询数'.padEnd(8)}${'平均字数'.padEnd(10)}${'recall@1'.padEnd(12)}${'recall@5'.padEnd(12)}MRR`)
  for (const row of report.results) {
    const r1 = row.overall === null ? '—' : pct(row.overall.recall[1])
    const r5 = row.overall === null ? '—' : pct(row.overall.recall[5] ?? 0)
    const mrr = row.overall === null ? '—' : row.overall.mrr.toFixed(3)
    console.log(`${(row.doctrine === 'keywords' ? '关键词堆' : '意图句').padEnd(14)}${String(row.queries).padEnd(8)}${String(row.avgChars).padEnd(10)}${r1.padEnd(12)}${r5.padEnd(12)}${mrr}`)
  }
  console.log('')
  if (report.deltaPt !== null) {
    console.log(`意图句相对关键词堆:recall@1 ${report.deltaPt >= 0 ? '+' : ''}${report.deltaPt.toFixed(1)}pt`)
  }
  for (const row of report.results) {
    console.log('')
    console.log(`${row.doctrine === 'keywords' ? '关键词堆' : '意图句'} 样例:`)
    for (const sample of row.samples) console.log(`  · ${sample}`)
  }
  console.log('')
  for (const caveat of report.caveats) console.log(`注: ${caveat}`)
}
