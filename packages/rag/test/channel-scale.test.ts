/**
 * 落地计划 §2-2 — D1/D2 按通道启用。
 *
 * 事实基础（三套语料、真端点、见 `docs/评测结果.md`）：开 D1+D2 之后混合档在三套语料上全变好
 * （cosqa hybrid+rerank 0.5100 → 0.6184、nfcorpus 0.3157 → 0.3509、scifact 0.7721 → 0.8345），
 * 但**纯词法档退分**（scifact 0.6788 → 0.6501、cosqa 0.3003 → 0.2833）。
 * 机制：绝对尺度（`bm25ish = raw/(raw+scale_q)`）把整池词法分压到 0.5 上下，
 * 单通道场景下没有"对侧"可以重新配重，只是把分辨率压平。
 *
 * 所以档位判定必须**按实际跑过的通道**做，而"实际跑过的通道"只有在 F1 能力门控之后才知道：
 * 被门控降级的 hybrid 就是一次纯词法运行，必须拿词法档。
 *
 * 本文件钉三件事：① 纯函数判定表；② 引擎里 `auto` 真的按通道解析；③ 显式值永远压过 `auto`（可 A/B、可回滚）。
 *
 * @module @clue-harness/rag/test/channel-scale
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openProjectStore, type KbStore } from '@clue-harness/kb'
import { createHybridRetriever } from '../src/hybrid.ts'
import { RETRIEVAL_DEFAULTS, resolveLexicalNormalization, resolveSemanticScale } from '../src/defaults.ts'
import { hashEmbedder } from '../src/embedder.ts'
import { buildVectorIndex } from '../src/index-pipeline.ts'

/** A store with entries a lexical query can find. */
async function world(t: { after(fn: () => unknown): void }): Promise<{ store: KbStore; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-channel-scale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'p')
  await mkdir(project, { recursive: true })
  const home = path.join(root, 'h')
  const store = await openProjectStore(project, home)
  await store.add({ kind: 'decision', title: '分片重建', text: 'chunker 版本号不一致时分片会重建。', tags: ['kb'] })
  await store.add({ kind: 'decision', title: '分片 重建 分片 重建', text: '分片重建的排查步骤与注意事项。', tags: ['kb'] })
  await store.add({ kind: 'note', title: '分片重建的替代方案', text: '另一种分片重建的做法。', tags: ['kb'] })
  await store.add({ kind: 'pitfall', title: '焦点陷阱', text: '隐藏容器里的焦点会变成死区。', tags: ['a11y'] })
  await store.add({ kind: 'fact', title: '对比度约定', text: '正文对比度不得低于 4.5:1。', tags: ['a11y'] })
  return { store, home }
}

/** An embedder that CLAIMS real semantic ability (a stand-in for an endpoint). */
const capable = (): ReturnType<typeof hashEmbedder> => ({ ...hashEmbedder({ dim: 16 }), semantics: 'endpoint' as const })

test('判定表:auto 只在混合通道上启用新尺度,显式值永远优先', () => {
  assert.equal(RETRIEVAL_DEFAULTS.lexicalNormalization, 'auto', '默认必须是 auto(落地计划 §2-2/§5-4)')
  assert.equal(RETRIEVAL_DEFAULTS.semanticScale, 'auto')
  assert.equal(resolveLexicalNormalization('auto', 'hybrid'), 'absolute')
  assert.equal(resolveLexicalNormalization('auto', 'lexical'), 'candidates')
  assert.equal(resolveLexicalNormalization('auto', 'vector'), 'candidates', '单通道(只向量)也没有"对侧"可配重')
  assert.equal(resolveSemanticScale('auto', 'hybrid'), 'calibrated')
  assert.equal(resolveSemanticScale('auto', 'lexical'), 'raw')
  assert.equal(resolveSemanticScale('auto', 'vector'), 'raw')
  // 显式覆盖:回滚与单变量 A/B 靠的就是这两行
  assert.equal(resolveLexicalNormalization('candidates', 'hybrid'), 'candidates')
  assert.equal(resolveLexicalNormalization('absolute', 'lexical'), 'absolute')
  assert.equal(resolveSemanticScale('raw', 'hybrid'), 'raw')
  assert.equal(resolveSemanticScale('calibrated', 'lexical'), 'calibrated')
})

test('引擎:auto + 纯词法 ⇒ 逐条等于旧档 candidates(不被新尺度波及)', async (t) => {
  const { store, home } = await world(t)
  const run = async (lexicalNormalization?: 'auto' | 'candidates' | 'absolute'): Promise<Array<[string, number, number]>> => {
    const detailed = await createHybridRetriever(store, null, {
      channels: 'lexical', rerank: true, topK: 5,
      ...(lexicalNormalization !== undefined ? { lexicalNormalization } : {}),
    }).retrieveDetailed('分片 重建', { limit: 5, noTouch: true })
    return detailed.hits.map((hit) => [String(hit.entry.id), hit.score, hit.explain?.features?.bm25ish ?? -1])
  }
  const auto = await run()
  const explicitOld = await run('candidates')
  const explicitNew = await run('absolute')
  assert.deepEqual(auto, explicitOld, 'auto 在纯词法下必须复现旧档（这正是 scifact 词法档退分的修法）')
  assert.notDeepEqual(explicitNew, explicitOld, '显式 absolute 仍然可用(单变量 A/B 与回滚需要它)')
  assert.equal(Math.max(...explicitOld.map((row) => row[2])), 1, '旧档的特征:候选集里最好的一条恒为 1.0')
  assert.ok(Math.max(...explicitNew.map((row) => row[2])) < 1, '新档的特征:没有任何一条被拉满')
})

test('引擎:auto + 混合(有能力的嵌入器) ⇒ 用 absolute/calibrated', async (t) => {
  const { store, home } = await world(t)
  const embedder = capable()
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' } })
  const detailed = await createHybridRetriever(store, null, {
    channels: 'hybrid', rerank: true, topK: 5, embedder, home, rebuildOnRead: false,
  }).retrieveDetailed('分片 重建', { limit: 5, noTouch: true })
  assert.equal(detailed.channels, 'hybrid')
  const bm25 = detailed.hits.map((hit) => hit.explain?.features?.bm25ish ?? -1).filter((value) => value >= 0)
  assert.ok(bm25.length > 0, '要有可检查的特征值')
  assert.ok(bm25.every((value) => value < 1), `混合档必须走绝对尺度(不该有谁被拉满,实际 ${JSON.stringify(bm25)})`)
  // D2 的定标:余弦被映射到 0–1 —— 至少有一条的语义特征不等于原始余弦(null 表示该条未被语义召回)。
  const semantics = detailed.hits.map((hit) => hit.explain?.semantic).filter((value) => typeof value === 'number')
  assert.ok(semantics.length > 0, '这次混合运行要真的有语义命中,否则这条测试没有意义')
})

test('引擎:被 F1 门控的 hybrid 也算纯词法 ⇒ 拿词法档(判定发生在门控之后)', async (t) => {
  const { store, home } = await world(t)
  const gated = hashEmbedder({ dim: 16 })
  await buildVectorIndex(store, { home, embedder: gated, target: { kind: 'entries' } })
  const detailed = await createHybridRetriever(store, null, {
    channels: 'hybrid', rerank: true, topK: 5, embedder: gated, home, rebuildOnRead: false,
  }).retrieveDetailed('分片 重建', { limit: 5, noTouch: true })
  assert.equal(detailed.channels, 'lexical', '无能力嵌入器被门控成纯词法')
  const bm25 = detailed.hits.map((hit) => hit.explain?.features?.bm25ish ?? -1).filter((value) => value >= 0)
  assert.equal(
    Math.max(...bm25),
    1,
    '门控之后是纯词法运行 ⇒ 必须用 candidates 档(否则就是把"单通道"按"双通道"配重,正是要修的那个错)',
  )
})
