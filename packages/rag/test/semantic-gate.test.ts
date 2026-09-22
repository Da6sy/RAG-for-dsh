/**
 * F1 of `docs/落地计划-剩余工程.md` §2-6 — the half that was never implemented:
 * semantic normalization, the dispersion gate, and an `explain` line that says
 * WHEN the semantic feature was switched off and why.
 *
 * The plan's warning is the reason everything here ships OFF by default: rank
 * normalization was once made the default and cost cosqa 0.2558 → 0.1739,
 * because mapping ranks amplifies a channel that has no discrimination. So the
 * gate exists precisely to detect that flatness, and the tests below check both
 * halves: the switch changes the feature when asked, and the gate refuses to let
 * a flat channel speak.
 *
 * @module @clue-harness/rag/test/semantic-gate
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KB_FORMAT_VERSION, KbEntryId, tokenize, type KbEntry } from '@clue-harness/kb'
import { rerankAll, type RerankCandidate, type RerankContext } from '../src/rerank.ts'

/** A minimal entry. */
function entry(id: string): KbEntry {
  return {
    version: KB_FORMAT_VERSION,
    id: KbEntryId(id),
    tier: 'project',
    kind: 'fact',
    title: '分片重建',
    text: 'chunker 版本号不一致时分片会重建。',
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

const candidate = (id: string, semantic?: number): RerankCandidate => ({
  entry: entry(id),
  lexicalScore: 1,
  matched: tokenize('分片 重建'),
  ...(semantic !== undefined ? { semantic } : {}),
  annotations: [],
})

const context = (over: Partial<RerankContext> = {}): RerankContext => ({
  queryText: '分片 重建',
  queryTokens: tokenize('分片 重建'),
  stats: { total: 3, df: new Map([['分片', 2], ['重建', 1]]), avgTitle: 1, avgTag: 0, avgText: 2 },
  now: new Date('2026-09-21T00:00:00.000Z'),
  ...over,
})

const semanticOf = (rows: ReturnType<typeof rerankAll>, id: string): number =>
  rows.find((row) => String(row.candidate.entry.id) === id)?.features.semantic ?? -1

test('F1 归一化:raw 是今天;rank 把候选集内名次映射到 0–1,minmax 拉满极差', () => {
  const rows = [candidate('k-a', 0.9), candidate('k-b', 0.5), candidate('k-c', 0.2)]
  const raw = rerankAll(rows, context())
  assert.equal(semanticOf(raw, 'k-a'), 0.9, 'raw 档:原始余弦')

  const rank = rerankAll(rows, context({ semanticNormalization: 'rank' }))
  assert.equal(semanticOf(rank, 'k-a'), 1, 'rank 档:第一名 = 1')
  assert.equal(semanticOf(rank, 'k-c'), 0, 'rank 档:最后一名 = 0')
  assert.equal(semanticOf(rank, 'k-b'), 0.5)

  const minmax = rerankAll(rows, context({ semanticNormalization: 'minmax' }))
  assert.equal(semanticOf(minmax, 'k-a'), 1)
  assert.equal(semanticOf(minmax, 'k-c'), 0)
  assert.ok(Math.abs(semanticOf(minmax, 'k-b') - 0.42857142857142855) < 1e-9, '(0.5−0.2)/(0.9−0.2)')
})

test('F1 归一化只看被语义召回的候选:缺失值不得参与标定', () => {
  // 三条里只有两条有语义分:名次必须在"被召回的两条"上算,否则一条缺失值会
  // 把名次整体推移(D3 的规矩用到归一化上)。
  const rows = [candidate('k-a', 0.9), candidate('k-b', 0.4), candidate('k-c')]
  const rank = rerankAll(rows, context({ semanticNormalization: 'rank' }))
  assert.equal(semanticOf(rank, 'k-a'), 1)
  assert.equal(semanticOf(rank, 'k-b'), 0, '两条参与标定 ⇒ 第二名就是 0,而不是被缺失值挤成 0.5')
})

test('F1 门控:被门控时语义项归零,且 explain 写明原因(不是静默的 0)', () => {
  const rows = [candidate('k-a', 0.9), candidate('k-b', 0.8)]
  const open = rerankAll(rows, context())
  const gated = rerankAll(rows, context({
    semanticGate: { gated: true, reason: '语义分在该候选集内几乎不区分(最高−中位 = 0.001 < 阈值 0.05)' },
  }))
  assert.ok(semanticOf(open, 'k-a') > 0, '不门控时语义项有值')
  assert.equal(semanticOf(gated, 'k-a'), 0, '门控时语义项必须归零')
  const lines = gated[0]?.explanation ?? []
  assert.ok(
    lines.some((line) => line.includes('语义相似度 未参与') && line.includes('几乎不区分')),
    `explain 必须写明静音原因(实际:${JSON.stringify(lines)})`,
  )
  // 分数差就是语义那一项的差 —— 门控是"整项停用",不是"乘个系数"
  const delta = (open[0]?.score ?? 0) - (gated[0]?.score ?? 0)
  assert.ok(Math.abs(delta - 0.8 * 0.9) < 1e-9, `门控前后应差 weight×cosine,实际差 ${delta}`)
})

test('F1 门控:默认不开(raw + 无门控 ⇒ 今天的分数逐条不变)', () => {
  const rows = [candidate('k-a', 0.9), candidate('k-b', 0.5)]
  const implicit = rerankAll(rows, context())
  const explicit = rerankAll(rows, context({ semanticNormalization: 'raw' }))
  assert.deepEqual(
    implicit.map((row) => [String(row.candidate.entry.id), row.score]),
    explicit.map((row) => [String(row.candidate.entry.id), row.score]),
  )
  assert.ok(!(implicit[0]?.explanation ?? []).some((line) => line.includes('未参与')), '默认档不得出现"未参与"')
})
