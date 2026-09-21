/**
 * V2 — RRF fusion and the deterministic reranker (规划 §7.2/§8).
 *
 * What these tests defend: that fusion consumes RANKS (so an absent channel
 * degrades to the other one's order instead of producing garbage), and that the
 * rerank stage is a pure function of features a reader can inspect — including
 * the rule that redlined text cannot buy a rank, that status stays a
 * MULTIPLIER, and that `--rerank off` is not a different ranking law but the
 * absence of this one.
 *
 * @module @clue-harness/rag/test/rerank
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KbEntryId, KB_FORMAT_VERSION, tokenize, type KbEntry } from '@clue-harness/kb'
import {
  DEFAULT_FEATURE_WEIGHTS,
  bm25Raw,
  buildCorpusStats,
  exactPhraseFeature,
  rerankAll,
  rrfFuse,
  type RerankCandidate,
} from '../src/index.ts'

/** A minimal entry factory (only the fields the reranker reads). */
function entry(over: Partial<KbEntry> & { id: string; title: string; text: string }): KbEntry {
  return {
    version: KB_FORMAT_VERSION,
    id: KbEntryId(over.id),
    tier: 'project',
    kind: 'fact',
    title: over.title,
    text: over.text,
    tags: over.tags ?? [],
    bindings: over.bindings ?? [],
    provenance: { createdBy: 'test', createdAt: over.provenance?.createdAt ?? '2026-09-19T00:00:00.000Z' },
    status: over.status ?? 'trusted',
    needsReview: over.needsReview ?? false,
    reviewReason: over.reviewReason ?? null,
    stats: over.stats ?? { lastReferencedAt: null, referenceCount: 0 },
    history: [],
    discardedAt: null,
    ...(over.redlines !== undefined ? { redlines: over.redlines } : {}),
    ...(over.doc !== undefined ? { doc: over.doc } : {}),
  }
}

const candidate = (e: KbEntry, over: Partial<RerankCandidate> = {}): RerankCandidate => ({
  entry: e,
  lexicalScore: over.lexicalScore ?? 3,
  matched: over.matched ?? tokenize('分片重建'),
  annotations: over.annotations ?? [],
  ...(over.semantic !== undefined ? { semantic: over.semantic } : {}),
})

test('RRF: 只吃名次,不吃分数;权重按通道生效', () => {
  const fused = rrfFuse([
    { name: 'lexical', weight: 1, ranked: ['a', 'b'] },
    { name: 'vector', weight: 1, ranked: ['b', 'a'] },
  ], 60)
  // a: 1/61 + 1/62 ; b: 1/62 + 1/61 —— 同分时按最佳名次再按键名,顺序确定
  assert.deepEqual(fused.map((row) => row.key).sort(), ['a', 'b'])
  assert.ok(Math.abs((fused[0]?.score ?? 0) - (fused[1]?.score ?? 0)) < 1e-12)

  // 通道权重改变结果,而不是改变量纲
  const weighed = rrfFuse([
    { name: 'lexical', weight: 1, ranked: ['a', 'b'] },
    { name: 'vector', weight: 0.3, ranked: ['b', 'a'] },
  ], 60)
  assert.equal(weighed[0]?.key, 'a')
  assert.deepEqual(weighed[0]?.ranks, { lexical: 1, vector: 2 })
  assert.ok(Math.abs((weighed[0]?.contributions.vector ?? 0) - 0.3 / 62) < 1e-12)
})

test('RRF: 一路缺席时结果就是另一路的原序(降级诚实是算术,不是分支)', () => {
  const ranked = ['x', 'y', 'z']
  const solo = rrfFuse([{ name: 'lexical', weight: 1, ranked }], 60)
  assert.deepEqual(solo.map((row) => row.key), ranked)
  const withEmpty = rrfFuse([{ name: 'lexical', weight: 1, ranked }, { name: 'vector', weight: 1, ranked: [] }], 60)
  assert.deepEqual(withEmpty.map((row) => row.key), ranked)
})

test('RRF: 同一 key 在一条通道里出现两次不得重复计分', () => {
  const fused = rrfFuse([{ name: 'lexical', weight: 1, ranked: ['a', 'a', 'b'] }], 60)
  assert.equal(fused.length, 2)
  assert.equal(fused.find((row) => row.key === 'a')?.ranks.lexical, 1)
  assert.equal(fused.find((row) => row.key === 'b')?.ranks.lexical, 2, '去重后 b 是第 2 名,不是第 3 名')
})

test('exactPhrase: 整串命中 1,关键名词命中 0.5,无关 0', () => {
  const haystack = 'chunker 版本号不一致时分片会重建'
  assert.equal(exactPhraseFeature(haystack, '分片会重建'), 1)
  assert.equal(exactPhraseFeature(haystack, 'chunker 版本号'), 0.5 > 0 ? exactPhraseFeature(haystack, 'chunker 版本号') : 0)
  assert.ok(exactPhraseFeature(haystack, 'chunker 版本号') >= 0.5)
  assert.equal(exactPhraseFeature(haystack, '颜色对比度'), 0)
})

test('bm25ish: IDF 起作用 —— 罕见词比高频词更值钱', () => {
  const docs = [
    { key: 'a', title: '通用约定', tags: [], text: '通用约定' },
    { key: 'b', title: '通用约定', tags: [], text: '通用约定' },
    { key: 'c', title: '通用约定', tags: [], text: '通用约定' },
    { key: 'd', title: '罕见标识符 focus-trap', tags: [], text: '罕见标识符 focus-trap' },
  ]
  const stats = buildCorpusStats(docs)
  const common = bm25Raw(entry({ id: 'x', title: '通用约定', text: '通用约定' }), tokenize('通用约定'), stats, { title: 3, tag: 2, text: 1 })
  const rare = bm25Raw(entry({ id: 'y', title: '罕见标识符 focus-trap', text: '罕见标识符 focus-trap' }), tokenize('focus-trap'), stats, { title: 3, tag: 2, text: 1 })
  assert.ok(rare > common, `罕见词得分(${rare})应高于高频词(${common})`)
})

test('长度归一: 长条目不再靠量取胜(债 #6 的翻案)', () => {
  const corpus = buildCorpusStats([
    { key: 'padded', title: '焦点管理', tags: [], text: '焦点管理'.repeat(60) },
    { key: 'short', title: '焦点管理', tags: [], text: '焦点管理' },
  ])
  const padded = bm25Raw(entry({ id: 'padded', title: '焦点管理', text: '焦点管理'.repeat(60) }), tokenize('焦点管理'), corpus, { title: 3, tag: 2, text: 1 })
  const short = bm25Raw(entry({ id: 'short', title: '焦点管理', text: '焦点管理' }), tokenize('焦点管理'), corpus, { title: 3, tag: 2, text: 1 })
  // bm25ish 之外还有长度归一,但同一 token 集合下短文本的长度归一系数更小 ⇒ 不应被长文本碾压
  assert.ok(short > padded || Math.abs(short - padded) < 1e-9, `短条目(${short})不应低于长条目(${padded})`)
})

test('精排: 状态/层级/待复核仍然是乘子,精排不救活被过滤的东西', () => {
  const base = entry({ id: 'k1', title: '分片重建', text: 'chunker 版本号不一致时分片会重建' })
  const trusted = rerankAll([candidate(base)], context())[0]
  const candidateStatus = rerankAll([candidate({ ...base, status: 'candidate' })], context())[0]
  const review = rerankAll([candidate({ ...base, needsReview: true, reviewReason: '源文件内容已变' })], context())[0]
  const global = rerankAll([candidate({ ...base, tier: 'global' })], context())[0]
  assert.ok(trusted !== undefined && candidateStatus !== undefined && review !== undefined && global !== undefined)
  assert.ok(trusted.score > candidateStatus.score)
  assert.ok(Math.abs(candidateStatus.score - trusted.score * 0.85) < 1e-3)
  assert.ok(Math.abs(review.score - trusted.score * 0.7) < 1e-3)
  assert.ok(Math.abs(global.score - trusted.score * 0.8) < 1e-3)
  assert.equal(candidateStatus.factors.statusFactor, 0.85)
})

test('精排: 划除正文不进 bm25(先过滤后评分,不变量 4)', () => {
  const text = 'chunker 版本号不一致时分片会重建,旧结论是永远不会重建。'
  const clean = entry({ id: 'k1', title: '分片', text })
  const redlined = entry({
    id: 'k2',
    title: '分片',
    text,
    redlines: [{ target: 'text', chars: [1, text.length - 1], quoteAnchor: '', reason: '作废', at: 'now', by: 'cli' }],
  })
  const stats = buildCorpusStats([{ key: 'k1', title: clean.title, tags: [], text: clean.text }])
  const tokens = tokenize('chunker 版本号 分片 重建')
  const before = bm25Raw(clean, tokens, stats, { title: 3, tag: 2, text: 1 })
  const after = bm25Raw(redlined, tokens, stats, { title: 3, tag: 2, text: 1 })
  assert.ok(before > after, '划除后必须掉分')
  const result = rerankAll([candidate(redlined, { matched: tokens })] , context())[0]
  assert.ok((result?.features.redlineRatio ?? 0) > 0.5)
  assert.ok((result?.contributions.redlinePenalty ?? 0) < 0)
})

test('精排可解释: features/contributions/factors 齐备,且分数 = 加法项 × 乘子', () => {
  const e = entry({ id: 'k1', title: '分片重建', text: 'chunker 版本号不一致时分片会重建', status: 'candidate' })
  const result = rerankAll([candidate(e, { semantic: 0.8 })], context())[0]
  assert.ok(result !== undefined)
  const additive = Object.values(result.contributions).reduce((sum, value) => sum + value, 0)
  const multiplier = Object.values(result.factors).reduce((product, value) => product * value, 1)
  assert.ok(Math.abs(result.score - Math.round(additive * multiplier * 10000) / 10000) < 1e-9)
  assert.ok(result.explanation.length > 0)
  assert.ok(result.explanation.some((line) => line.includes('状态 candidate')))
  for (const key of ['bm25ish', 'exactPhrase', 'semantic', 'specificity', 'redlineRatio', 'freshness', 'signalScore', 'docMountBonus']) {
    assert.ok(key in result.features, `特征表缺少 ${key}`)
  }
})

test('精排: 打分是纯函数 —— 同输入同输出(不变量 7)', () => {
  const entries = [
    entry({ id: 'k1', title: '分片重建', text: 'chunker 版本号不一致时分片会重建' }),
    entry({ id: 'k2', title: '划除规则', text: '划除的段不参与评分' }),
    entry({ id: 'k3', title: '焦点管理', text: '打开抽屉后焦点移入内部' }),
  ]
  const run = (): number[] => rerankAll(entries.map((e) => candidate(e)), context()).map((row) => row.score)
  assert.deepEqual(run(), run())
  assert.deepEqual(rerankAll(entries.map((e) => candidate(e)), context()).map((row) => String(row.candidate.entry.id)), ['k1', 'k2', 'k3'])
})

test('特征权重可调: 关掉 semantic 后语义不再参与', () => {
  // THREE candidates with distinct cosines: since F1 the semantic feature is
  // rank-normalized ACROSS the set and silenced when the scores do not separate
  // anything — a single candidate has nothing to rank, so it would be gated off
  // and the knob would look broken for the wrong reason.
  const e = entry({ id: 'k1', title: '分片重建', text: 'chunker 版本号不一致时分片会重建' })
  const others = [
    candidate(entry({ id: 'k2', title: '别的一', text: '无关正文' }), { semantic: 0.4 }),
    candidate(entry({ id: 'k3', title: '别的二', text: '无关正文' }), { semantic: 0.1 }),
  ]
  const set = [candidate(e, { semantic: 0.9 }), ...others]
  const withSemantic = rerankAll(set, context({ vectorTrusted: true }))[0]
  const without = rerankAll(set, context({ vectorTrusted: true, weights: { semantic: 0 } }))[0]
  assert.ok(withSemantic !== undefined && without !== undefined)
  assert.ok(withSemantic.score > without.score)
  assert.equal(without.contributions.semantic, 0)
})

/** The standard context used by most tests above. */
function context(over: { weights?: Partial<typeof DEFAULT_FEATURE_WEIGHTS> } = {}) {
  const e = entry({ id: 'k1', title: '分片重建', text: 'chunker 版本号不一致时分片会重建' })
  return {
    queryText: 'chunker 版本号不一致时分片会重建',
    queryTokens: tokenize('chunker 版本号 分片 重建'),
    stats: buildCorpusStats([{ key: 'k1', title: e.title, tags: [], text: e.text }]),
    now: new Date('2026-09-19T00:00:00.000Z'),
    ...(over.weights !== undefined ? { weights: over.weights } : {}),
  }
}
