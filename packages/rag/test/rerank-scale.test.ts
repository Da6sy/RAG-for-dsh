/**
 * D1/D2 of `docs/修复方案-精排量纲与语义名次.md` — the two scales that make the
 * reranker's features comparable.
 *
 * The measured defect these fix (真端点 cosqa, 20 查询): `hybrid+rerank` lost to
 * `hybrid+no-rerank` (0.4265 vs 0.4829, recall@10 0.65 vs 0.75) because the gold
 * documents that the SEMANTIC channel ranked #1 but the lexical channel never
 * recalled were scored ≈1.01 against distractors at ≈1.48. Three causes live in
 * this file: `bm25ish` was relative to the best candidate (always someone at
 * 1.0), the cosine was an uncalibrated absolute, and neither had a scale that
 * could say "this query has no real lexical evidence here".
 *
 * The tests pin the PROPERTIES the plan requires, not tuned numbers:
 * absolute scaling must depend on the POOL, calibrated scaling must be a
 * deterministic map, and both old positions must reproduce today exactly.
 *
 * @module @clue-harness/rag/test/rerank-scale
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KB_FORMAT_VERSION, KbEntryId, tokenize, type KbEntry } from '@clue-harness/kb'
import { rerankAll, type RerankCandidate, type RerankContext } from '../src/rerank.ts'

/** A minimal entry. */
function entry(id: string, title: string, text: string): KbEntry {
  return {
    version: KB_FORMAT_VERSION,
    id: KbEntryId(id),
    tier: 'project',
    kind: 'fact',
    title,
    text,
    tags: [],
    bindings: [],
    provenance: { createdBy: 'test', createdAt: '2026-09-21T00:00:00.000Z' },
    status: 'trusted',
    needsReview: false,
    reviewReason: null,
    stats: { lastReferencedAt: null, referenceCount: 0 },
    history: [],
    discardedAt: null,
  }
}

const candidate = (id: string, title: string, text: string, semantic?: number): RerankCandidate => ({
  entry: entry(id, title, text),
  lexicalScore: 1,
  matched: tokenize(text),
  ...(semantic !== undefined ? { semantic } : {}),
  annotations: [],
})

const context = (over: Partial<RerankContext> = {}): RerankContext => ({
  queryText: '分片 重建',
  queryTokens: tokenize('分片 重建'),
  stats: { total: 3, df: new Map([['分片', 2], ['重建', 1], ['正文', 3]]), avgTitle: 2, avgTag: 0, avgText: 4 },
  now: new Date('2026-09-21T00:00:00.000Z'),
  ...over,
})

test('D1 绝对尺度:最弱的那条不再被拉满,池子整体弱时全池都低', () => {
  // 同一条候选,配一个"词法很强"的池与"词法很弱"的池
  const target = candidate('k-a', '分片', '分片 重建')
  const strongPool = [target, candidate('k-b', '分片 重建 分片 重建', '分片 重建 分片 重建'), candidate('k-c', '重建 分片', '重建 分片')]
  const weakPool = [target, candidate('k-b', '无关标题', '无关正文 内容'), candidate('k-c', '别的标题', '别的正文')]
  // 缺陷 1 的准确表述是"总有一条被拉满",而不是"某一条等于 1"——所以量的是最大值。
  const old = (pool: RerankCandidate[]): number =>
    Math.max(...rerankAll(pool, context({ lexicalNormalization: 'candidates' })).map((row) => row.features.bm25ish))
  const absMax = (pool: RerankCandidate[]): number =>
    Math.max(...rerankAll(pool, context({ lexicalNormalization: 'absolute' })).map((row) => row.features.bm25ish))
  const absOf = (pool: RerankCandidate[], id: string): number =>
    rerankAll(pool, context({ lexicalNormalization: 'absolute' })).find((row) => String(row.candidate.entry.id) === id)?.features.bm25ish ?? 0

  assert.equal(old(strongPool), 1, '旧尺度:候选集里最好的一条恒为 1.0(这正是缺陷 1)')
  assert.equal(old(weakPool), 1, '旧尺度:池子再弱也有一条被拉满')
  // 缺陷 1 的对偶:绝对尺度下**没有任何一条会被拉满** —— `raw/(raw+scale)` 恒 < 1。
  // (两者都断言,是因为"谁被拉满"随语料变,而"总有人被拉满"是结构性的。)
  assert.ok(absMax(weakPool) < 1, `绝对尺度下弱池不得拉满(实际 ${absMax(weakPool)})`)
  assert.ok(absMax(strongPool) < 1, `绝对尺度下强池也不得拉满(实际 ${absMax(strongPool)})`)
  assert.ok(absOf(weakPool, 'k-a') > 0, '该候选自身有词法命中时仍应为正分')
})

test('D2 定标:余弦按 floor/ceil 映射到 [0,1],且区间外夹紧', () => {
  const rows = [
    candidate('k-a', '标题', '正文', 0.9),
    candidate('k-b', '标题', '正文', 0.3),
    candidate('k-c', '标题', '正文', 0.1),
  ]
  const raw = rerankAll(rows, context({ semanticScale: 'raw' }))
  const scaled = rerankAll(rows, context({ semanticScale: 'calibrated', semanticFloor: 0.3, semanticCeil: 0.8 }))
  const value = (result: typeof raw, id: string): number => result.find((row) => String(row.candidate.entry.id) === id)?.features.semantic ?? -1
  assert.equal(value(raw, 'k-a'), 0.9, 'raw = 今天的原始余弦')
  assert.equal(value(scaled, 'k-a'), 1, '高于 ceil ⇒ 夹到 1')
  assert.equal(value(scaled, 'k-b'), 0, '等于 floor ⇒ 0')
  assert.equal(value(scaled, 'k-c'), 0, '低于 floor ⇒ 夹到 0')
})

test('不变量:旧档位(candidates/raw)逐条复现今天(默认值未变)', () => {
  const rows = [
    candidate('k-a', '分片', '分片 重建', 0.62),
    candidate('k-b', '无关', '别的正文', 0.11),
  ]
  const explicit = rerankAll(rows, context({ lexicalNormalization: 'candidates', semanticScale: 'raw' }))
  const implicit = rerankAll(rows, context())
  assert.deepEqual(
    explicit.map((row) => [String(row.candidate.entry.id), row.score, row.features.bm25ish, row.features.semantic]),
    implicit.map((row) => [String(row.candidate.entry.id), row.score, row.features.bm25ish, row.features.semantic]),
    '不显式传开关时必须是旧行为(默认保持不变)',
  )
})

test('确定性 + 可解释:新尺度下同输入同序,且 explain 仍有贡献行', () => {
  const rows = [candidate('k-a', '分片', '分片 重建', 0.7), candidate('k-b', '重建', '重建', 0.5)]
  const run = (): string => JSON.stringify(rerankAll(rows, context({ lexicalNormalization: 'absolute', semanticScale: 'calibrated' })).map((row) => row.score))
  assert.equal(run(), run())
  const result = rerankAll(rows, context({ lexicalNormalization: 'absolute', semanticScale: 'calibrated' }))
  assert.ok(result.every((row) => row.explanation.length > 1), '每一分都要能解释')
})
