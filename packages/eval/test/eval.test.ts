/**
 * The evaluation engine's own invariants (規劃 E1/E2).
 *
 * A ruler that lies is worse than no ruler: these tests pin the metric math
 * against hand-computed values, the parsers against the shapes real models
 * actually return, and the negative controls against the requirement that they
 * really are broken in the direction they claim.
 *
 * @module @clue-harness/eval/test/eval
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dcg, readBeirDataset, scoreRanking, summarizeScores, buildReport, parseQrels } from '../src/index.ts'
import {
  contextPrecision,
  contextRecall,
  faithfulnessPrompt,
  negativeControls,
  parseContext,
  parseFaithfulness,
  parseRelevance,
} from '../src/judge.ts'

test('nDCG@k: 与手算一致(分级相关度,理想 DCG 由本条的金标决定)', () => {
  const gold = new Map([['a', 2], ['b', 1]])
  // 完美排序:a(2), b(1) → nDCG = 1
  assert.equal(scoreRanking(['a', 'b'], gold, 2).ndcg, 1)
  // 反序:b 先 → (2^1-1)/log2(2) + (2^2-1)/log2(3) = 1 + 3/1.58496…
  // 手算:反序 gain [1,2] → (1 + 3/log2(3)) / (3 + 1/log2(3)) = 2.893/3.631 ≈ 0.7967
  const reversed = scoreRanking(['b', 'a'], gold, 2).ndcg
  assert.ok(Math.abs(reversed - 0.7967) < 0.001, `反序 nDCG 应约 0.7967,实际 ${reversed}`)
  // 漏检:b 不在前 2 里
  const missed = scoreRanking(['a', 'x'], gold, 2)
  assert.equal(missed.recall, 0.5)
  assert.equal(missed.rr, 1)
  assert.ok(Math.abs(dcg([0, 0]) - 0) < 1e-12)
})

test('汇总: 均值 + 标准差(样本抖动必须能被看见)', () => {
  const summary = summarizeScores([
    { ndcg: 1, recall: 1, rr: 1 },
    { ndcg: 0, recall: 0, rr: 0 },
  ])
  assert.equal(summary.n, 2)
  assert.equal(summary.ndcg, 0.5)
  assert.equal(summary.ndcgStdDev, 0.5)
  assert.deepEqual(summarizeScores([]), { n: 0, ndcg: 0, recall: 0, mrr: 0, ndcgStdDev: 0 })
})

test('BEIR 读取器: 只保留有 qrels 的查询(未判定的查询不能算成"全错")', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'clue-eval-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(path.join(dir, 'qrels'), { recursive: true })
  await writeFile(path.join(dir, 'corpus.jsonl'), [
    JSON.stringify({ _id: 'd1', title: 't1', text: '正文一' }),
    JSON.stringify({ _id: 'd2', title: '', text: '正文二' }),
  ].join('\n') + '\n')
  await writeFile(path.join(dir, 'queries.jsonl'), [
    JSON.stringify({ _id: 'q1', text: '问题一' }),
    JSON.stringify({ _id: 'q2', text: '问题二(没有 qrels)' }),
  ].join('\n') + '\n')
  await writeFile(path.join(dir, 'qrels', 'test.tsv'), 'query-id\tcorpus-id\tscore\nq1\td1\t2\n')
  const dataset = await readBeirDataset(dir, { name: 'beir/toy' })
  assert.equal(dataset.docs.length, 2)
  assert.deepEqual(dataset.queries.map((q) => q.id), ['q1'])
  assert.equal(dataset.queries[0]?.gold.get('d1'), 2)
  assert.deepEqual([...parseQrels('query-id\tcorpus-id\tscore\nq9\td9\t1\n').keys()], ['q9'])
})

test('判分解析: 宽容(围栏/百分制/缺项),失败返回 null 而不是 0', () => {
  assert.equal(parseFaithfulness('```json\n{"claims":[{"supported":true},{"supported":false}]}\n```'), 0.5)
  assert.equal(parseFaithfulness('{"claims":[]}'), null)
  assert.throws(() => parseFaithfulness('我觉得还行'), /没有 JSON/)
  assert.equal(parseRelevance('{"relevance":0.8}'), 0.8)
  assert.equal(parseRelevance('{"relevance":80}'), 0.8, '百分制要归一化')
  assert.equal(parseRelevance('{"relevance":8}'), 0.8, '十分制要归一化')
  assert.equal(parseRelevance('{"score":1.4}'), 1, '1.4 是越界的 0–1 答案 → 裁剪,不能当成 1.4%')
  assert.equal(parseRelevance('{"score":0.65}'), 0.65)
})

test('context precision 只认"支持金标"的段: 主题对但说法错的段不得计分(judge-v2 的修正)', () => {
  // 这就是负对照抓出来的那个漏洞:judge-v1 只问"有用吗",于是"主题正确、事实错误"的段也满分。
  const withWrong = parseContext('{"passages":[{"index":1,"useful":true,"supportsGold":false},{"index":2,"useful":true,"supportsGold":true}],"points":[]}')
  // 支持段被排到第 2 位 ⇒ 1/log2(3) / 1 = 0.6309(理想值是把支持段排第 1)
  assert.ok(Math.abs(contextPrecision(withWrong, 2) - 0.6309) < 0.001, `实际 ${contextPrecision(withWrong, 2)}`)
  const onlyWrong = parseContext('{"passages":[{"index":1,"useful":true,"supportsGold":false}],"points":[]}')
  assert.equal(contextPrecision(onlyWrong, 1), 0, '主题对但支持为 false ⇒ 不计分(这正是 v1 漏掉的)')
  // 宽容:判分器没给 supportsGold 时退回"切题"判定,不能被算成 0
  const legacy = parseContext('{"passages":[{"index":1,"useful":true}],"points":[]}')
  assert.equal(contextPrecision(legacy, 1), 1)
})

test('context precision 按名次加权: 同一批有用段,排前面得分更高', () => {
  const early = parseContext('{"passages":[{"index":1,"supportsGold":true},{"index":2,"supportsGold":false}],"points":[]}')
  const late = parseContext('{"passages":[{"index":1,"supportsGold":false},{"index":2,"supportsGold":true}],"points":[]}')
  assert.equal(contextPrecision(early, 2), 1)
  assert.ok(contextPrecision(late, 2) < 1, '排到第 2 位要打折')
  assert.equal(contextRecall(parseContext('{"passages":[],"points":[{"index":1,"supported":true},{"index":2,"supported":false}]}'), 2), 0.5)
  assert.equal(contextPrecision(parseContext('{"passages":[]}'), 3), 0)
})

test('负对照: 三条都是"真的坏",且各自指向不同的指标', () => {
  const controls = negativeControls([{ id: 'c1', title: '规范', text: 'chunker 版本号不一致时分片会重建。' }], ['版本号不一致时分片重建'])
  assert.equal(controls.length, 3)
  assert.deepEqual(controls.map((c) => c.metric).sort(), ['answerRelevance', 'contextPrecision', 'faithfulness'])
  assert.ok(controls.every((c) => c.expect === 'drop'))
  assert.ok(controls.every((c) => c.answer !== '' && c.question !== ''))
  // 第三条必须真的把顺序反了
  const gold = controls[2]
  assert.ok(gold !== undefined)
  assert.match(gold.broken, /排到最后/)
  assert.ok(faithfulnessPrompt('q', 'a', gold.contexts).includes('supported'))
})

test('报告: 自带数据独立性与样本量两条 caveats(新运行器不可能漏写)', () => {
  const report = buildReport({
    generatedAt: '2026-09-20T00:00:00.000Z',
    dataset: 'beir/nfcorpus',
    split: 'test',
    corpus: { documents: 10, queries: 3 },
    ks: [10],
    rows: [{ config: 'lexical', metrics: { 'nDCG@10': 0.2 } }],
  })
  assert.equal(report.ok, true)
  assert.match(report.caveats[0] ?? '', /不得与内部合成集\/金标集混算/)
  assert.match(report.caveats[1] ?? '', /3 条查询/)
})
