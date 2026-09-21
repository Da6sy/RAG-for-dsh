/**
 * R1/R2 of `docs/修复规划-一级检索BM25化.md` — the BM25 engine invariants.
 *
 * The three claims that matter, and why each is a test rather than a comment:
 *
 * 1. **The formula has one implementation** (plan §3.4). The project has twice
 *    been bitten by a constant written in two files; the architecture test
 *    covers the literals, and the delegation test below covers the arithmetic
 *    (the first level and the reranker's `bm25ish` must return the SAME number).
 * 2. **`lexicalScorer:'weights'` reproduces the old order exactly** (plan §3.5 /
 *    invariant 6). That is the rollback switch: without it the change is a
 *    one-way door, which the plan forbids.
 * 3. **Debt #6 is actually fixed**: a long entry may no longer win on bulk.
 *    That debt was closed as "not worth fixing" until the public benchmarks
 *    showed a 1.7–2.5× recall gap; this test is the "data spoke" half.
 *
 * @module @clue-harness/kb/test/bm25
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BM25_B,
  BM25_K1,
  bm25Fields,
  bm25fScore,
  buildLexicalStats,
  displayScore,
  idf,
  rankableScore,
  scoreEntry,
  buildLexicalStats as kbStats,
} from '../src/index.ts'
import { bm25Raw as ragBm25Raw, buildCorpusStats as ragStats } from '@clue-harness/rag'
import { KB_FORMAT_VERSION, KbEntryId, type KbEntry } from '../src/types.ts'

/** A minimal entry for direct scoring (only the fields the scorer reads). */
function entry(over: Partial<KbEntry> & { id: string; title: string; text: string }): KbEntry {
  return {
    version: KB_FORMAT_VERSION,
    id: KbEntryId(over.id),
    tier: over.tier ?? 'project',
    kind: 'decision',
    title: over.title,
    text: over.text,
    tags: over.tags ?? [],
    bindings: [],
    provenance: { createdBy: 'test', createdAt: '2026-09-20T00:00:00.000Z' },
    status: over.status ?? 'trusted',
    needsReview: over.needsReview ?? false,
    reviewReason: null,
    stats: { lastReferencedAt: null, referenceCount: 0 },
    history: [],
    discardedAt: null,
  }
}

const WEIGHTS = { title: 3, tag: 2, text: 1 }

test('IDF: 罕见词比高频词值钱,语料外的词拿到最大权重', () => {
  const stats = buildLexicalStats([
    { title: '通用约定', tags: [], text: '通用约定' },
    { title: '通用约定', tags: [], text: '通用约定' },
    { title: '通用约定', tags: [], text: '通用约定' },
    { title: '罕见标识符', tags: [], text: 'focus-trap 罕见标识符' },
  ])
  assert.ok(idf('focus', stats) > idf('通用', stats), '罕见词 IDF 必须更大')
  assert.ok(idf('从未出现过的词', stats) > idf('通用', stats))
  assert.ok(idf('通用', stats) > 0)
})

test('BM25F: 长条目不再靠体量取胜(债 #6 的翻案),且长度归一按字段各算', () => {
  const padded = entry({ id: 'k-pad', title: '焦点管理', text: '焦点管理'.repeat(80) })
  const short = entry({ id: 'k-short', title: '焦点管理', text: '焦点管理' })
  const stats = buildLexicalStats([
    { title: padded.title, tags: [], text: padded.text },
    { title: short.title, tags: [], text: short.text },
  ])
  const paddedScore = scoreEntry(padded, ['焦点', '管理'], WEIGHTS, { scorer: 'bm25', stats }).score
  const shortScore = scoreEntry(short, ['焦点', '管理'], WEIGHTS, { scorer: 'bm25', stats }).score
  // 旧公式下长条目是短条目的整数倍;BM25F 下正文那条被长度归一压住,标题那条不压
  assert.ok(shortScore >= paddedScore, `短条目(${shortScore})不应低于长条目(${paddedScore})`)
})

test('BM25F: 字段权重 3/2/1 的产品直觉不变(标题命中仍比正文命中值钱)', () => {
  const inTitle = entry({ id: 'k-1', title: '分片重建', text: '别的正文' })
  const inText = entry({ id: 'k-2', title: '别的标题', text: '分片重建' })
  const stats = buildLexicalStats([
    { title: inTitle.title, tags: [], text: inTitle.text },
    { title: inText.title, tags: [], text: inText.text },
  ])
  const titleScore = bm25fScore(bm25Fields({ title: inTitle.title, tags: [], text: inTitle.text }), ['分片'], stats, WEIGHTS).score
  const textScore = bm25fScore(bm25Fields({ title: inText.title, tags: [], text: inText.text }), ['分片'], stats, WEIGHTS).score
  assert.equal(titleScore, textScore * 3, '标题权重是正文的 3 倍')
})

test('不变量 6: lexicalScorer:"weights" 逐条复现旧排序(回滚开关真的存在)', async () => {
  const entries = [
    entry({ id: 'k-a', title: '分片重建', text: 'chunker 版本号不一致时分片会重建。', tags: ['kb'] }),
    entry({ id: 'k-b', title: '键盘可达性', text: '所有交互元素必须可被 Tab 选中。', tags: ['a11y'] }),
    entry({ id: 'k-c', title: '长文条目', text: `焦点管理 ${'补充说明'.repeat(50)}`, tags: ['a11y', 'focus'] }),
  ]
  const stats = kbStats(entries.map((item) => ({ title: item.title, tags: item.tags, text: item.text })))
  const tokens = ['分片', '重建', '焦点', '管理']
  const legacy = entries.map((item) => ({ id: String(item.id), ...scoreEntry(item, tokens, WEIGHTS, { scorer: 'weights' }) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const bm25 = entries.map((item) => ({ id: String(item.id), ...scoreEntry(item, tokens, WEIGHTS, { scorer: 'bm25', stats }) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  // 旧路径的分数是"权重裸和 + 两位小数",这里钉成快照:它不许变。
  // k-a 标题 分片/重建 各 ×3 + 正文各 ×1 = 8;k-c 正文 焦点/管理 各 ×1 = 2。
  assert.deepEqual(legacy.map((row) => [row.id, row.score]), [['k-a', 8], ['k-b', 0], ['k-c', 2]].filter((row) => (row[1] as number) > 0))
  assert.deepEqual(legacy.map((row) => row.id), ['k-a', 'k-c'])
  assert.deepEqual(bm25.map((row) => row.id), ['k-a', 'k-c'], '新公式在这条语料上给出同一序(分差极大时不该翻转)')
  assert.notEqual(bm25[0]?.score, legacy[0]?.score, '但分数是连续量,不再是裸和')
  assert.ok(bm25.every((row) => Number.isFinite(row.score)))
})

test('确定性 + 舍入纪律:BM25 用未舍入分排序,展示分数另算', () => {
  const stats = buildLexicalStats([{ title: '甲', tags: [], text: '甲' }, { title: '乙', tags: [], text: '乙' }])
  const raw = bm25fScore(bm25Fields({ title: '甲', tags: [], text: '甲' }), ['甲'], stats, WEIGHTS).score
  assert.equal(rankableScore(raw), raw, '排序值不得被舍入')
  assert.equal(displayScore(raw), Math.round(raw * 100) / 100)
  const again = bm25fScore(bm25Fields({ title: '甲', tags: [], text: '甲' }), ['甲'], stats, WEIGHTS).score
  assert.equal(again, raw, '同输入同输出')
})

test('唯一实现:一级与精排的 bm25ish 取到同一个数(架构断言的行为面)', () => {
  const docs = [
    { key: 'k-1', title: '分片重建', tags: ['kb'], text: 'chunker 版本号不一致时分片会重建。' },
    { key: 'k-2', title: '键盘可达性', tags: ['a11y'], text: '所有交互元素必须可被 Tab 选中。' },
  ]
  const entryA = entry({ id: 'k-1', title: docs[0]!.title, text: docs[0]!.text, tags: docs[0]!.tags })
  const kbStatsValue = buildLexicalStats(docs.map((doc) => ({ title: doc.title, tags: doc.tags, text: doc.text })))
  const ragStatsValue = ragStats(docs)
  const fromKb = bm25fScore(bm25Fields({ title: entryA.title, tags: entryA.tags, text: entryA.text }), ['分片', '重建'], kbStatsValue, WEIGHTS).score
  const fromRag = ragBm25Raw(entryA, ['分片', '重建'], ragStatsValue, WEIGHTS)
  assert.equal(fromRag, fromKb, '精排的 bm25ish 必须与一级的 BM25F 是同一个数')
})

test('常量单一出处:k1/b 只在 bm25.ts 出现(值固定,供架构测试比对)', () => {
  assert.equal(BM25_K1, 1.2)
  assert.equal(BM25_B, 0.75)
})
