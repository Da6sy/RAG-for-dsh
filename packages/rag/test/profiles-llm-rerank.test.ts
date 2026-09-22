/**
 * V3/V5 engine invariants: profile-driven query normalization (原规划 §7.3) and
 * the model rerank's guards (原规划 §8.4).
 *
 * Both are places where a wrong answer is expensive and invisible: a profile
 * that leaks paths into the embedding quietly degrades the semantic channel,
 * and a rerank parser that drops an id quietly deletes a candidate from the
 * result. The tests below pin the boring properties that prevent both.
 *
 * @module @clue-harness/rag/test/profiles-llm-rerank
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHANNEL_PROFILES,
  isIdentifierToken,
  normalizeQuery,
  resolveProfile,
} from '../src/profiles.ts'
import {
  LLM_RERANK_MAX_CANDIDATES,
  buildRerankPrompt,
  describeRerankDiff,
  llmRerank,
  parseRerankAnswer,
  type LlmRankPort,
  type RerankPromptCandidate,
} from '../src/llm-rerank.ts'

const candidate = (id: string, title = id): RerankPromptCandidate => ({ id, title, excerpt: `${title} 的正文`, score: 1 })

test('§7.3 表: 三个 profile 的权重/绑定/规范化与规划一致', () => {
  assert.equal(CHANNEL_PROFILES.tool?.lexicalWeight, 1)
  assert.equal(CHANNEL_PROFILES.tool?.semanticWeight, 1)
  assert.equal(CHANNEL_PROFILES['pre-step']?.semanticWeight, 0.6)
  assert.equal(CHANNEL_PROFILES.gate?.lexicalWeight, 1.3)
  assert.equal(CHANNEL_PROFILES.gate?.semanticWeight, 0.3)
  assert.equal(CHANNEL_PROFILES.gate?.bindingRecall, true)
  assert.equal(CHANNEL_PROFILES['pre-step']?.normalization.stripCodeFences, true)
  assert.equal(CHANNEL_PROFILES['pre-step']?.normalization.maxChars, 1200)
  assert.equal(resolveProfile('nope').name, 'tool')
})

test('identifier 判定: 路径/标识符/常量/版本算,普通词不算', () => {
  for (const token of ['src/a.ts', 'packages/kb', 'focus-trap', 'KB_FORMAT_VERSION', 'v2.1', 'updateEntryText', 'query.ts']) {
    assert.equal(isIdentifierToken(token), true, `${token} 应判为标识符`)
  }
  for (const token of ['分片', '重建', 'the', 'a1']) {
    assert.equal(isIdentifierToken(token), false, `${token} 不该判为标识符`)
  }
})

test('gate profile: 标识符只走词法,不进嵌入(词法是金矿,向量不该被路径稀释)', () => {
  const query = '渲染失败 src/button.ts:12 updateEntryText 断言 tab-order 不成立'
  const normalized = normalizeQuery(resolveProfile('gate'), query)
  assert.ok(normalized.lexical.includes('src/button.ts'), '词法必须看到路径')
  assert.equal(normalized.semantic.includes('src/button.ts'), false, '路径不得进嵌入')
  assert.equal(normalized.semantic.includes('updateEntryText'), false)
  assert.ok(normalized.identifiers.length >= 2)
  assert.ok(normalized.semantic.includes('渲染失败'))
})

test('tool profile 原样: 不改一字(模型写的意图句就是它想要的)', () => {
  const query = 'src/button.ts 里 chunker 版本号不一致会怎样'
  const normalized = normalizeQuery(resolveProfile('tool'), query)
  assert.equal(normalized.lexical, query)
  assert.equal(normalized.semantic, query)
  assert.deepEqual(normalized.identifiers, [])
})

test('pre-step profile: 去代码围栏 + 截断(整段人类输入是有界的)', () => {
  const long = `请帮我看看这段\n\`\`\`ts\nconst a = 1\n\`\`\`\n${'背景说明'.repeat(500)}`
  const normalized = normalizeQuery(resolveProfile('pre-step'), long)
  assert.equal(normalized.truncated, true)
  assert.ok(normalized.lexical.length <= 1200)
  assert.equal(normalized.lexical.includes('const a = 1'), false, '代码块应被剥掉')
})

test('rerank 提示词: 带上全部 id 与序号,并要求 JSON 顺序', () => {
  const prompt = buildRerankPrompt('查询词', [candidate('k-1', '甲'), candidate('k-2', '乙')])
  assert.ok(prompt.includes('id=k-1') && prompt.includes('id=k-2'))
  assert.ok(prompt.includes('{"order"'))
  assert.ok(prompt.includes('不要新增、不要删除'))
})

test('rerank 解析: 部分/未知/重复/乱序都由基线补齐 —— 候选不会被模型删掉', () => {
  const baseline = ['a', 'b', 'c']
  assert.deepEqual(parseRerankAnswer('{"order":["c","a","b"]}', baseline), ['c', 'a', 'b'])
  assert.deepEqual(parseRerankAnswer('```json\n{"order":["b"]}\n```', baseline), ['b', 'a', 'c'], '漏掉的按原序补在末尾')
  assert.deepEqual(parseRerankAnswer('{"order":["zzz","b","b"]}', baseline), ['b', 'a', 'c'], '未知 id 与重复被忽略')
  assert.deepEqual(parseRerankAnswer('["c","b","a"]', baseline), ['c', 'b', 'a'], '裸数组也认')
  assert.throws(() => parseRerankAnswer('我觉得 a 更好', baseline), /没有返回可解析/)
})

test('rerank: 成功时给出与确定性精排的差异,失败/超时保留确定性序', async () => {
  const candidates = [candidate('k-1'), candidate('k-2'), candidate('k-3')]
  const good: LlmRankPort = { rank: async () => '{"order":["k-3","k-1","k-2"]}' }
  const outcome = await llmRerank(good, 'q', candidates)
  assert.ok(outcome !== null)
  assert.deepEqual(outcome.order, ['k-3', 'k-1', 'k-2'])
  assert.deepEqual(outcome.baseline, ['k-1', 'k-2', 'k-3'])
  // 变更按基线顺序列出(读起来像 diff,而不是像新序)
  assert.deepEqual(outcome.moves.map((move) => [move.id, move.from, move.to]), [['k-1', 1, 2], ['k-2', 2, 3], ['k-3', 3, 1]])
  assert.equal(describeRerankDiff(outcome, (id) => id).length, 4)

  const bad: LlmRankPort = { rank: async () => { throw new Error('boom') } }
  const reasons: string[] = []
  assert.equal(await llmRerank(bad, 'q', candidates, { onError: (reason) => reasons.push(reason) }), null)
  assert.deepEqual(reasons, ['boom'])
  // 候选不足 2 条: 直接不跑,也不报错
  assert.equal(await llmRerank(good, 'q', [candidate('k-1')]), null)
})

test('rerank 有界: 最多 LLM_RERANK_MAX_CANDIDATES 条进提示词', async () => {
  const many = Array.from({ length: 25 }, (_, index) => candidate(`k-${index}`))
  let seen = 0
  const port: LlmRankPort = { rank: async (prompt) => { seen = (prompt.match(/id=k-/g) ?? []).length; return '{"order":[]}' } }
  const outcome = await llmRerank(port, 'q', many)
  assert.equal(seen, LLM_RERANK_MAX_CANDIDATES)
  assert.equal(outcome?.baseline.length, LLM_RERANK_MAX_CANDIDATES)
})

// ── V5: the offline LTR skeleton ───────────────────────────────────────────

test('LTR: 标注只认账本信号,不够量就明确说"还没到时候"', async () => {
  const { buildTrainingSet, ltrReadiness, trainLogistic, evaluateWeights, handWeights } = await import('../src/ltr.ts')
  const row = (query: string, at: string, candidates: Array<{ id: string; bm25ish: number }>) => ({
    v: 1, at, profile: 'tool', channels: 'lexical' as const, rerank: true, query, vector: 'used' as const,
    candidates: candidates.map((c) => ({ id: c.id, score: c.bm25ish, lexicalScore: c.bm25ish, semantic: null, features: { bm25ish: c.bm25ish, exactPhrase: 0, semantic: 0, specificity: 0.5, bindingOverlap: 0, redlineRatio: 0, freshness: 0.5, signalScore: c.bm25ish, docMountBonus: 0 } })),
  })
  const signals = [
    { at: '2026-09-19T00:10:00.000Z', entryId: 'k-a' as never, polarity: 'positive' as const, source: 'human' as const, weight: 5, note: 'cite' },
    { at: '2026-09-19T00:20:00.000Z', entryId: 'k-b' as never, polarity: 'negative' as const, source: 'human' as const, weight: -6, note: 'reject' },
    // 窗口外的信号不构成标注
    { at: '2026-10-30T00:00:00.000Z', entryId: 'k-c' as never, polarity: 'positive' as const, source: 'human' as const, weight: 5, note: 'late' },
  ]
  const training = buildTrainingSet([
    row('q1', '2026-09-19T00:00:00.000Z', [{ id: 'k-a', bm25ish: 0.4 }, { id: 'k-b', bm25ish: 0.9 }, { id: 'k-c', bm25ish: 1 }]),
  ], signals)
  assert.deepEqual(training.map((r) => [r.entryId, r.label]), [['k-a', 1], ['k-b', 0]], '窗口外与未标注的候选都不成样本')

  const readiness = ltrReadiness(training)
  assert.equal(readiness.ready, false)
  assert.match(readiness.reason, /500/)

  // 够量时能拟合,且学到的权重在同一批数据上不劣于手工权重(这是下限证据)
  const many = Array.from({ length: 600 }, (_, i) => ({ ...training[i % training.length] as never, query: `q-${i}` }))
  const ready = ltrReadiness(many)
  assert.equal(ready.ready, true)
  const model = trainLogistic(many, { epochs: 60 })
  assert.equal(typeof model.weights.bm25ish, 'number')
  assert.ok(evaluateWeights(many, model.weights).mrr >= evaluateWeights(many, handWeights()).mrr - 0.001)
  assert.throws(() => trainLogistic([{ query: 'q', entryId: 'k', features: {}, label: 1 }]), /单一极性/)
})
