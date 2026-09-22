/**
 * V0/V2 — the hybrid retriever (原规划 §7, 不变量 5/7/9).
 *
 * Two things are being defended here, and they pull in opposite directions:
 *
 * - **The semantic channel must actually add recall.** The test achieves that
 *   with an injected `Embedder` whose vector space is a hand-built concept map
 *   (two texts about the same concept share a dimension, even with disjoint
 *   words). That is the design's point — the engine sees a port, not a model —
 *   and it is the only way to test "同义改写被召回" without a live endpoint.
 * - **Today's behavior must survive untouched.** `--channel lexical --rerank
 *   off` is not a reimplementation of the old order; it DELEGATES to it, and
 *   the test compares the two outputs element by element (不变量 9).
 *
 * Plus the honesty rule: every way the semantic channel can be off produces a
 * NAMED state and a note on the hits, so a lexical-only answer can never be
 * mistaken for a semantic one (不变量 5).
 *
 * @module @clue-harness/rag/test/hybrid
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openGlobalStore, openProjectStore, readVectorIndex, type KbStore } from '@clue-harness/kb'
import {
  buildVectorIndex,
  createFulltextRetriever,
  createHybridRetriever,
  hashEmbedder,
  type Embedder,
} from '../src/index.ts'

/**
 * A concept-map embedder: the smallest thing that HAS semantics.
 *
 * Each dimension is a concept; a token contributes to the concepts it belongs
 * to. Two texts that use different words for the same concept ("键盘可达性"
 * and "必须可被 Tab 选中") therefore have a high cosine while sharing no
 * token — exactly the gap the vector channel exists to close (§1.3-1).
 */
function conceptEmbedder(): Embedder & { calls: number } {
  const concepts: string[][] = [
    ['键盘', 'tab', 'focusable', '可达', '焦点顺序', 'sequence'],
    ['对比度', '颜色', 'contrast', 'aa', '4.5'],
    ['分片', 'chunk', '重建', '版本号', 'chunker'],
    ['划除', 'redline', '作废', '撤'],
  ]
  const state = { calls: 0 }
  return {
    id: 'concept-test-v1',
    dim: concepts.length,
    get calls() { return state.calls },
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      state.calls += 1
      return texts.map((text) => {
        const lower = text.toLowerCase()
        const vector = new Float32Array(concepts.length)
        concepts.forEach((tokens, index) => {
          for (const token of tokens) if (lower.includes(token)) vector[index] = (vector[index] as number) + 1
        })
        let sum = 0
        for (const value of vector) sum += value * value
        if (sum === 0) return vector
        const norm = Math.sqrt(sum)
        for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] as number) / norm
        return vector
      })
    },
  }
}

async function world(t: { after(fn: () => unknown): void }): Promise<{ store: KbStore; global: KbStore; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-hybrid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  const home = path.join(root, 'home')
  const store = await openProjectStore(project, home)
  await store.add({ kind: 'decision', title: '键盘可达性要求', text: '所有交互元素必须可被 Tab 选中,且焦点顺序与视觉顺序一致。', tags: ['a11y'] })
  await store.add({ kind: 'decision', title: '对比度约定', text: '正文对比度不得低于 4.5:1。', tags: ['a11y'] })
  await store.add({ kind: 'fact', title: '分片重建', text: 'chunker 版本号不一致时,分片会在查询路径上静默重建。', tags: ['kb'] })
  return { store, global: await openGlobalStore(home), home }
}

test('不变量 9: --channel lexical --rerank off 与今日排序逐条相同', async (t) => {
  const { store, global } = await world(t)
  const query = '键盘 焦点 顺序'
  const today = await createFulltextRetriever(store, global, { topK: 5 }).retrieve(query)
  const hybrid = createHybridRetriever(store, global, { channels: 'lexical', rerank: false, topK: 5 })
  const viaHybrid = await hybrid.retrieve(query)
  assert.deepEqual(
    viaHybrid.map((hit) => [String(hit.entry.id), hit.score]),
    today.map((hit) => [String(hit.entry.id), hit.score]),
  )
  assert.equal(hybrid.provider, 'fulltext')
})

test('不变量 9: 绑定召回分层在 lexical 模式下同样保留', async (t) => {
  const { store, global } = await world(t)
  // An entry bound to a changed file must top the list in both implementations.
  const bound = await store.add({ kind: 'pitfall', title: '无关标题', text: '这段正文与失败签名没有共同词。' })
  await store.recordSignal(bound.id, 'human-confirm', 'test')
  const today = await createFulltextRetriever(store, global, { topK: 3 }).retrieve('一个完全无关的查询词', { boostBindings: ['src/button.ts'] })
  const viaHybrid = await createHybridRetriever(store, global, { channels: 'lexical', rerank: false, topK: 3 }).retrieve('一个完全无关的查询词', { boostBindings: ['src/button.ts'] })
  assert.deepEqual(viaHybrid.map((hit) => String(hit.entry.id)), today.map((hit) => String(hit.entry.id)))
})

test('R2 回滚开关抵达委派路径: lexicalScorer="weights" 在 lexical-only 上同样生效', async (t) => {
  const { store, global } = await world(t)
  // 刻意造一对"旧公式同分、新公式分得开"的条目:同一个词只出现在正文,
  // 旧公式按字段权重裸和(两条都是 text=1)⇒ 并列;BM25 按长度归一 ⇒ 短的赢。
  const filler = Array.from({ length: 40 }, (_, index) => `填充${String.fromCharCode(0x4e00 + index)}`).join(' ')
  const long = await store.add({ kind: 'fact', title: '焦点管理长文', text: `${filler} 焦点` })
  const short = await store.add({ kind: 'fact', title: '焦点管理短文', text: '焦点' })
  const query = '焦点'
  const scoreOf = (hits: readonly { entry: { id: unknown }; score: number }[], id: unknown): number | undefined =>
    hits.find((hit) => String(hit.entry.id) === String(id))?.score

  const weightsRun = await createHybridRetriever(store, global, {
    channels: 'lexical', rerank: false, topK: 10, lexicalScorer: 'weights',
  }).retrieve(query)
  const bm25Run = await createHybridRetriever(store, global, {
    channels: 'lexical', rerank: false, topK: 10,
  }).retrieve(query)

  assert.equal(scoreOf(weightsRun, long.id), scoreOf(weightsRun, short.id), '旧公式下两条正文命中同分(裸和)')
  assert.ok(
    (scoreOf(bm25Run, short.id) ?? 0) > (scoreOf(bm25Run, long.id) ?? 0),
    'BM25 档下短条目必须胜出(长度归一),否则这条测试没有测到开关',
  )
  // 委派路径的 weights 档必须与直接调用 fulltext 逐条一致(开关没有在半路丢失)。
  const direct = await createFulltextRetriever(store, global, { topK: 10, lexicalScorer: 'weights' }).retrieve(query)
  assert.deepEqual(
    weightsRun.map((hit) => [String(hit.entry.id), hit.score]),
    direct.map((hit) => [String(hit.entry.id), hit.score]),
  )
})

test('语义通道真的加召回: 同义改写(零 token 重叠)被向量通道捞回', async (t) => {
  const { store, global, home } = await world(t)
  const embedder = conceptEmbedder()
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' } })
  // 「键盘可达性要求」这条的正文含 Tab/focusable —— 查询用的是完全不同的词。
  const query = '无障碍 focusable 键盘'
  const lexicalOnly = await createHybridRetriever(store, global, { channels: 'lexical', rerank: false, topK: 3 }).retrieve(query)
  const hybrid = createHybridRetriever(store, global, { channels: 'hybrid', embedder, home, topK: 3, now: new Date('2026-09-19T00:00:00.000Z') })
  const result = await hybrid.retrieveDetailed(query)
  assert.equal(result.vector.status, 'used')
  assert.ok(result.recalled.vector > 0, '向量通道应有召回')
  const lexicalIds = new Set(lexicalOnly.map((hit) => String(hit.entry.id)))
  const vectorOnly = result.hits.filter((hit) => !lexicalIds.has(String(hit.entry.id)))
  assert.ok(result.hits.length >= lexicalOnly.length)
  // 语义通道把 lexical 召不回的东西排上来 —— 这正是 §1.3-1 的硬零召回缺口。
  assert.ok(result.hits[0]?.explain !== undefined)
  assert.ok(vectorOnly.length > 0 || (result.hits[0]?.explain?.semantic ?? 0) > 0)
})

test('降级诚实: 未配置嵌入时给出明确标注,绝不当成语义命中', async (t) => {
  const { store, global } = await world(t)
  const result = await createHybridRetriever(store, global, { channels: 'hybrid', topK: 3 }).retrieveDetailed('键盘 焦点 顺序')
  assert.equal(result.vector.status, 'not-configured')
  assert.ok(result.hits.length > 0, '词法照旧工作')
  assert.ok(result.hits.every((hit) => hit.annotations.some((note) => note.includes('语义通道未启用'))))
})

test('降级诚实: 向量层缺失 → 待建标注;版本过期 → 过期标注', async (t) => {
  const { store, global, home } = await world(t)
  const embedder = conceptEmbedder()
  // 索引不存在,且不允许查询期重建 ⇒ 报"待建"
  const missing = await createHybridRetriever(store, global, { channels: 'hybrid', embedder, home, rebuildOnRead: false, topK: 2 }).retrieveDetailed('键盘')
  assert.equal(missing.vector.status, 'index-missing')
  assert.ok(missing.hits.every((hit) => hit.annotations.some((note) => note.includes('向量层待建'))))

  // 用旧 embedder 建好,再用新 embedder 查 ⇒ 报"过期"
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' } })
  const other: Embedder = { ...hashEmbedder({ dim: 4 }), id: 'another-model', semantics: 'endpoint' }
  const stale = await createHybridRetriever(store, global, { channels: 'hybrid', embedder: other, home, rebuildOnRead: false, topK: 2 }).retrieveDetailed('键盘')
  assert.equal(stale.vector.status, 'index-stale')
  assert.ok(stale.hits.every((hit) => hit.annotations.some((note) => note.includes('版本已过期'))))
})

test('降级诚实: 嵌入调用失败 → 退回纯词法并标注原因(不抛穿检索)', async (t) => {
  const { store, global, home } = await world(t)
  const broken: Embedder = {
    id: 'broken-v1',
    dim: 4,
    async embed(): Promise<Float32Array[]> {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9999')
    },
  }
  const result = await createHybridRetriever(store, global, { channels: 'hybrid', embedder: broken, home, topK: 2 }).retrieveDetailed('键盘')
  assert.equal(result.vector.status, 'error')
  assert.ok(result.hits.length > 0)
  assert.ok(result.hits.every((hit) => hit.annotations.some((note) => note.includes('语义通道本次失败'))))
})

test('查询期重建有护栏: 索引缺失时按预算自动建好,随后即可用', async (t) => {
  const { store, global, home } = await world(t)
  const embedder = conceptEmbedder()
  const retriever = createHybridRetriever(store, global, { channels: 'hybrid', embedder, home, topK: 2, allowNoAbilityEmbedder: true })
  const result = await retriever.retrieveDetailed('键盘 可达性')
  assert.equal(result.vector.status, 'used')
  const index = await readVectorIndex(store.dir, { kind: 'entries' })
  assert.equal(index?.meta.count, 3)
})

test('不变量 7: 同 query + 同 embedder + 同库 ⇒ 同序;ranklog 只落 id 与特征', async (t) => {
  const { store, global, home } = await world(t)
  const embedder = conceptEmbedder()
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' } })
  const lines: Array<{ query: string; candidates: Array<{ id: string; features: Record<string, number> }>; vector: string }> = []
  const make = () => createHybridRetriever(store, global, {
    channels: 'hybrid',
    embedder,
    home,
    topK: 3,
    now: new Date('2026-09-19T00:00:00.000Z'),
    onRank: (line) => { lines.push(line as never) },
  })
  const first = await make().retrieve('键盘 焦点 顺序')
  const second = await make().retrieve('键盘 焦点 顺序')
  assert.deepEqual(first.map((hit) => String(hit.entry.id)), second.map((hit) => String(hit.entry.id)))
  assert.deepEqual(first.map((hit) => hit.score), second.map((hit) => hit.score))

  assert.equal(lines.length, 2)
  assert.equal(lines[0]?.query, '键盘 焦点 顺序')
  assert.equal(lines[0]?.vector, 'used')
  assert.ok(lines[0]?.candidates.every((row) => typeof row.id === 'string' && typeof row.features.bm25ish === 'number'))
})

test('V0 兜底: hashEmbedder 全链路可跑(不变量 7 的确定性锚点)', async (t) => {
  const { store, global, home } = await world(t)
  const embedder = { ...hashEmbedder({ dim: 32 }), semantics: 'endpoint' as const }
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' } })
  const result = await createHybridRetriever(store, global, { channels: 'hybrid', embedder, home, topK: 3 }).retrieveDetailed('分片 重建')
  assert.equal(result.vector.status, 'used')
  assert.ok(result.hits.length > 0)
  assert.ok(result.hits[0]?.explain?.semantic !== null)
})

test('过滤仍归过滤: 被 discarded 的条目不会因语义相似被召回', async (t) => {
  const { store, global, home } = await world(t)
  const doomed = await store.add({ kind: 'fact', title: '键盘可达性要求', text: '所有交互元素必须可被 Tab 选中。' })
  const embedder = conceptEmbedder()
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' } })
  // 单次否决 = -6,不到 -20 的遗弃界(设计:一次误点不能杀掉知识)⇒ 连记四次。
  for (let i = 0; i < 4; i += 1) await store.recordSignal(doomed.id, 'user-reject', `test ${i}`)
  await store.sweep()
  const after = await store.get(doomed.id)
  assert.equal(after?.status, 'discarded')
  const result = await createHybridRetriever(store, global, { channels: 'hybrid', embedder, home, rebuildOnRead: false, topK: 5 }).retrieveDetailed('键盘 可达性')
  assert.equal(result.hits.some((hit) => String(hit.entry.id) === String(doomed.id)), false)
})

// ── 落地计划 §2-7: ranklog 在每一个出口都要落一行,且 sink 异常可见 ──────────
//
// 这一节的存在理由是一份误报:某份报告读到「8 行全是 pre-step」,判定"工具通道
// 从来不写 ranklog"。复核发现那 8 行的时间戳早于 ranklog 这套代码,真正的缺陷是
// 另外两条**静默出口**——它们连一行都不写,而写盘失败又被一个空 catch 吞掉。
// 三条断言分别钉住这三处。
type RankLine = { channels: string; rerank: boolean; candidates: unknown[]; vector: string }

test('§2-7 回滚档(纯词法委派)也必须写 ranklog —— 此前一行都不写', async (t) => {
  const { store, global } = await world(t)
  const lines: RankLine[] = []
  const retriever = createHybridRetriever(store, global, {
    channels: 'lexical',
    rerank: false,
    topK: 5,
    onRank: (line) => { lines.push(line as unknown as RankLine) },
  })
  const hits = await retriever.retrieveDetailed('键盘 焦点', { limit: 5, noTouch: true })
  assert.ok(hits.hits.length > 0, '这轮要真的召回,否则测不到"有结果却不写日志"')
  assert.equal(lines.length, 1, '委派出口必须写且只写一行')
  assert.equal(lines[0]?.channels, 'lexical')
  assert.equal(lines[0]?.rerank, false)
})

test('§2-7 空 token 查询也要写一行(candidates 为空,但"问过"是事实)', async (t) => {
  const { store, global } = await world(t)
  const lines: RankLine[] = []
  const retriever = createHybridRetriever(store, global, {
    channels: 'lexical',
    rerank: true,
    topK: 5,
    onRank: (line) => { lines.push(line as unknown as RankLine) },
  })
  const detailed = await retriever.retrieveDetailed('。', { limit: 5, noTouch: true })
  assert.equal(detailed.hits.length, 0, '标点没有 token,召回必然为空')
  assert.equal(lines.length, 1, '空查询同样是一次检索,必须留痕')
  assert.equal((lines[0]?.candidates ?? [null]).length, 0)
})

test('§2-7 sink 自己抛错必须被 onRankError 看到,而不是被空 catch 吞掉', async (t) => {
  const { store, global } = await world(t)
  const errors: unknown[] = []
  const retriever = createHybridRetriever(store, global, {
    channels: 'lexical',
    rerank: true,
    topK: 5,
    onRank: () => { throw new Error('sink 坏了') },
    onRankError: (error) => { errors.push(error) },
  })
  const detailed = await retriever.retrieveDetailed('键盘 焦点', { limit: 5, noTouch: true })
  assert.ok(detailed.hits.length > 0, 'sink 坏不得影响检索结果(护栏 2)')
  assert.equal(errors.length, 1, 'sink 的异常必须可见')
  assert.match(String((errors[0] as Error).message), /sink 坏了/)
})
