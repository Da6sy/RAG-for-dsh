/**
 * D3/D4 of `docs/开发记录.md` — missing values and ranks.
 *
 * D3's claim is narrow and it is tested as such: "没召回" and "召回但分低" must be
 * distinguishable, which in the current additive model means the bookkeeping
 * (`missing`), the explain line (未参与) and a missing-value INDICATOR — not a
 * different number. The plan's own risk table lists the danger of pretending
 * otherwise, so the equivalence of the two modes' scores is pinned here ON
 * PURPOSE: if a future change makes them differ, this test fails and someone has
 * to decide which behavior is right.
 *
 * D4's claim is also narrow: rank features exist, carry the plan's formula, and
 * ship at weight 0 — so adding them cannot move today's order. The plan's
 * worked example (rank normalization alone still loses to the distractors) is
 * why they are a supplement to D1/D2 and not a replacement.
 *
 * @module @clue-harness/rag/test/rerank-missing-rank
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KB_FORMAT_VERSION, KbEntryId, tokenize, type KbEntry } from '@clue-harness/kb'
import { DEFAULT_FEATURE_WEIGHTS, rerankAll, type RerankCandidate, type RerankContext } from '../src/rerank.ts'

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

const candidate = (
  id: string,
  title: string,
  text: string,
  extra: Partial<RerankCandidate> = {},
): RerankCandidate => ({
  entry: entry(id, title, text),
  lexicalScore: 1,
  matched: tokenize(text),
  annotations: [],
  ...extra,
})

const context = (over: Partial<RerankContext> = {}): RerankContext => ({
  queryText: '分片 重建',
  queryTokens: tokenize('分片 重建'),
  stats: { total: 4, df: new Map([['分片', 2], ['重建', 1], ['正文', 3]]), avgTitle: 2, avgTag: 0, avgText: 4 },
  now: new Date('2026-09-21T00:00:00.000Z'),
  ...over,
})

/** The candidate set used by most cases: one semantic hit, one lexical-only. */
const pool = (): RerankCandidate[] => [
  candidate('k-sem', '语义命中的标题', '语义命中的正文', { semantic: 0.71, semanticRank: 1 }),
  candidate('k-lex', '分片', '分片 重建'),
]

test('D3 三态:absent 档把"该通道没召回"标成缺失,zero 档(默认)不区分', () => {
  const zero = rerankAll(pool(), context({ missingFeatureMode: 'zero' }))
  const absent = rerankAll(pool(), context({ missingFeatureMode: 'absent' }))
  const lexAbsent = absent.find((row) => String(row.candidate.entry.id) === 'k-lex')
  const semAbsent = absent.find((row) => String(row.candidate.entry.id) === 'k-sem')
  assert.deepEqual(lexAbsent?.missing, ['semantic', 'semanticRank'], '词法专有候选:语义两个特征都是"未参与"')
  assert.deepEqual(semAbsent?.missing, [], '语义召回过的候选没有缺失特征')
  assert.deepEqual(
    zero.map((row) => row.missing),
    [[], []],
    'zero 档(旧行为)必须仍然不区分 —— 否则"关掉即今天"不成立',
  )
})

test('D3 算术等价(有意为之):两种档位同分,差别只在记账与解释', () => {
  const zero = rerankAll(pool(), context({ missingFeatureMode: 'zero' }))
  const absent = rerankAll(pool(), context({ missingFeatureMode: 'absent' }))
  assert.deepEqual(
    zero.map((row) => [String(row.candidate.entry.id), row.score]),
    absent.map((row) => [String(row.candidate.entry.id), row.score]),
    '当前加法模型下缺失项本来就贡献 0;若这里失败,说明某处归一化开始"看见"缺失值,必须重新拍板',
  )
  const lexZero = zero.find((row) => String(row.candidate.entry.id) === 'k-lex')
  const lexAbsent = absent.find((row) => String(row.candidate.entry.id) === 'k-lex')
  assert.ok(
    !lexZero?.explanation.some((line) => line.includes('未参与')),
    'zero 档不该出现"未参与"',
  )
  assert.ok(
    lexAbsent?.explanation.some((line) => line.includes('语义相似度 未参与')),
    `absent 档必须能看出是哪一种(实际解释:${JSON.stringify(lexAbsent?.explanation)})`,
  )
})

test('D3 缺失指示特征:默认权重 0 不改变分数,给权重后才开始计分', () => {
  const base = rerankAll(pool(), context({ missingFeatureMode: 'absent' }))
  const withIndicator = rerankAll(pool(), context({
    missingFeatureMode: 'absent',
    weights: { semanticAbsent: 0 },
  }))
  assert.deepEqual(
    base.map((row) => row.score),
    withIndicator.map((row) => row.score),
    '权重 0 的指示特征不得改变分数(默认档位)',
  )
  const weighted = rerankAll(pool(), context({
    missingFeatureMode: 'absent',
    weights: { semanticAbsent: 0.5, semantic: 0 },
  }))
  const lexRow = weighted.find((row) => String(row.candidate.entry.id) === 'k-lex')
  const semRow = weighted.find((row) => String(row.candidate.entry.id) === 'k-sem')
  assert.equal(lexRow?.features.semanticAbsent, 1, '没被语义召回 ⇒ 指示为 1')
  assert.equal(semRow?.features.semanticAbsent, 0)
  assert.ok(lexRow !== undefined && semRow !== undefined && lexRow.score > semRow.score, '指示特征生效后确实进入分数')
})

test('D4 名次特征:按池内名次线性归一,单个候选的池子按定义取 1', () => {
  const rows = [
    candidate('k-1', '分片', '分片 重建', { semantic: 0.9, semanticRank: 1 }),
    candidate('k-2', '分片', '分片 重建', { semantic: 0.5, semanticRank: 4 }),
    candidate('k-3', '分片', '分片 重建', { semantic: 0.2, semanticRank: 5 }),
  ]
  const result = rerankAll(rows, context({ semanticScale: 'raw' }))
  const value = (id: string, key: 'semanticRank' | 'fusedRank'): number =>
    result.find((row) => String(row.candidate.entry.id) === id)?.features[key] ?? -1
  // 语义池大小由 rerankAll 数出来:3 条有语义名次 ⇒ N=3 ⇒ 名次 1 → 1.0,名次 4 → 夹到 0。
  assert.equal(value('k-1', 'semanticRank'), 1)
  assert.equal(value('k-2', 'semanticRank'), 0)
  assert.equal(value('k-3', 'semanticRank'), 0)
  // 融合名次按"传进来的顺序"算(输入即融合序),第一条 1、最后一条 0。
  const byInput = rerankAll(rows, context())
  assert.equal(byInput.find((row) => String(row.candidate.entry.id) === 'k-1')?.features.fusedRank, 1)
  assert.equal(byInput.find((row) => String(row.candidate.entry.id) === 'k-3')?.features.fusedRank, 0)
  const single = rerankAll([candidate('k-solo', '分片', '分片', { semantic: 0.4, semanticRank: 1 })], context())
  assert.equal(single[0]?.features.fusedRank, 1, 'N=1 时归一化按定义取 1')
  assert.equal(single[0]?.features.semanticRank, 1)
})

test('D4 缺省权重为 0:加名次特征不得改变今天的顺序(不变量 3/6)', () => {
  const withRanks = pool()
  const withoutRanks = pool().map(({ semanticRank: _rank, ...rest }) => rest)
  const a = rerankAll(withRanks, context())
  const b = rerankAll(withoutRanks, context())
  assert.deepEqual(
    a.map((row) => [String(row.candidate.entry.id), row.score]),
    b.map((row) => [String(row.candidate.entry.id), row.score]),
    '名次特征默认权重 0 ⇒ 有没有它都必须同分同序',
  )
  assert.equal(DEFAULT_FEATURE_WEIGHTS.semanticRank, 0)
  assert.equal(DEFAULT_FEATURE_WEIGHTS.fusedRank, 0)
  assert.equal(DEFAULT_FEATURE_WEIGHTS.semanticAbsent, 0)
})

test('D4 可解释 + 确定性:权重非 0 时每个新特征都有中文标签与贡献行', () => {
  const rows = [
    candidate('k-1', '分片', '分片 重建', { semantic: 0.9, semanticRank: 1 }),
    candidate('k-2', '分片', '分片 重建', { semantic: 0.5, semanticRank: 2 }),
    // 没有语义名次 ⇒ 语义通道没召回它(D3 的缺失态,不是"名次很差")。
    candidate('k-3', '分片', '分片 重建'),
  ]
  const config = context({
    semanticScale: 'raw',
    missingFeatureMode: 'absent',
    weights: { semanticRank: 0.4, fusedRank: 0.4 },
  })
  const run = rerankAll(rows, config)
  const lines = run[0]?.explanation ?? []
  const allLines = run.flatMap((row) => row.explanation)
  assert.ok(lines.some((line) => line.startsWith('语义名次 ')), `要有"语义名次"贡献行(实际:${JSON.stringify(lines)})`)
  assert.ok(lines.some((line) => line.startsWith('融合名次 ')), '要有"融合名次"贡献行')
  assert.ok(
    allLines.some((line) => line.includes('语义名次 未参与')),
    `k-3 没有语义名次,absent 档要说明未参与(实际:${JSON.stringify(allLines)})`,
  )
  assert.equal(
    JSON.stringify(rerankAll(rows, config).map((row) => [String(row.candidate.entry.id), row.score])),
    JSON.stringify(run.map((row) => [String(row.candidate.entry.id), row.score])),
    '新特征下同样要确定:同输入同序',
  )
})
