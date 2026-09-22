/**
 * F2/F3 of `docs/落地计划-剩余工程.md` §2-5 — the two knobs that were not
 * telling the truth.
 *
 * Measured problems this file pins down:
 *
 * - `rerankCandidates`' sibling `maxVectorOnly` existed in the library but had
 *   no setting, no UI, and its only test asserted `hits >= 0` — a vacuous
 *   assertion that would pass with the quota ignored entirely.
 * - `channelWeights.vector`, with the reranker ON, changed NOTHING (weight 1 → 0
 *   produced identical results): the semantic signal reaches the ranking as a
 *   rerank FEATURE, not through the fusion sum. A knob that does nothing is
 *   worse than no knob, because it looks like the reason a result changed.
 *
 * Case A (the plan's recommendation) gives the weights ONE meaning: in `quota`
 * mode they decide how much of the window vector-only candidates may occupy,
 * and the fusion sum uses equal weights. `fusion` (the default) keeps today.
 *
 * @module @clue-harness/rag/test/channel-quota
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openProjectStore, type KbStore } from '@clue-harness/kb'
import { createHybridRetriever } from '../src/hybrid.ts'
import { hashEmbedder, type Embedder } from '../src/embedder.ts'
import { buildVectorIndex } from '../src/index-pipeline.ts'

/** Six entries; only ONE contains the query token, so the rest are vector-only. */
async function world(t: { after(fn: () => unknown): void }): Promise<{ store: KbStore; home: string; embedder: Embedder }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-quota-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'p')
  await mkdir(project, { recursive: true })
  const home = path.join(root, 'h')
  const store = await openProjectStore(project, home)
  await store.add({ kind: 'decision', title: '分片重建', text: 'chunker 版本号不一致时分片会重建。', tags: ['kb'] })
  await store.add({ kind: 'pitfall', title: '焦点陷阱', text: '隐藏容器里的焦点会变成死区。', tags: ['a11y'] })
  await store.add({ kind: 'fact', title: '对比度约定', text: '正文对比度不得低于 4.5:1。', tags: ['a11y'] })
  await store.add({ kind: 'note', title: '构建缓存', text: '缓存命中时不会重新构建。', tags: ['ops'] })
  await store.add({ kind: 'note', title: '日志轮转', text: '日志按大小轮转。', tags: ['ops'] })
  await store.add({ kind: 'note', title: '窗口尺寸', text: '小窗口下工具栏会折叠。', tags: ['ui'] })
  /**
   * A deterministic "endpoint" whose vectors are all identical: every entry is
   * recalled by the vector channel (cosine 1 vs 1), so "how many candidates are
   * VECTOR-ONLY" is decided by the lexical channel alone. A `hashEmbedder`
   * produces near-orthogonal noise where only a couple of entries clear the
   * recall threshold, which made the quota untestable.
   */
  const dim = 8
  const flat = new Array(dim).fill(1 / Math.sqrt(dim))
  const embedder: Embedder = {
    id: 'flat-v1',
    dim,
    semantics: 'endpoint',
    embed: async (texts) => texts.map(() => [...flat]),
  }
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' } })
  return { store, home, embedder }
}

/** The vector-only rows of one retrieval (no lexical rank = only the vector recalled it). */
async function vectorOnlyRows(
  store: KbStore,
  home: string,
  embedder: Embedder,
  config: Record<string, unknown>,
): Promise<{ hits: number; vectorOnly: number; lexicalIds: string[] }> {
  const detailed = await createHybridRetriever(store, null, {
    channels: 'hybrid',
    rerank: true,
    rerankCandidates: 6,
    topK: 6,
    embedder,
    home,
    rebuildOnRead: false,
    profile: 'tool',
    ...config,
  }).retrieveDetailed('分片 重建', { limit: 6, noTouch: true })
  return {
    hits: detailed.hits.length,
    vectorOnly: detailed.hits.filter((hit) => hit.explain?.channels?.lexical === undefined).length,
    lexicalIds: detailed.hits
      .filter((hit) => hit.explain?.channels?.lexical !== undefined)
      .map((hit) => String(hit.entry.id))
      .sort(),
  }
}

test('F2 配额是真断言:maxVectorOnly=1 时窗口里最多 1 条"只被向量召回"的候选', async (t) => {
  const { store, home, embedder } = await world(t)
  const unlimited = await vectorOnlyRows(store, home, embedder, {})
  assert.ok(unlimited.vectorOnly >= 2, `这轮要真的存在多条向量独有候选,否则测不到配额(实际 ${unlimited.vectorOnly})`)
  const capped = await vectorOnlyRows(store, home, embedder, { maxVectorOnly: 1 })
  assert.equal(capped.vectorOnly, 1, '配额必须真的生效(旧测试断言 >= 0,配额被忽略也能过)')
  assert.ok(capped.hits > 0, '配额只裁向量独有候选,不得把结果清空')

  // `0` 在设置面与引擎里都是"不限"——一个数字一个含义(要"一条不放"用 quota 档 + w_v=0)。
  const zero = await vectorOnlyRows(store, home, embedder, { maxVectorOnly: 0 })
  assert.equal(zero.vectorOnly, unlimited.vectorOnly, 'maxVectorOnly=0 与不设同义("不限")')
})

test('F3 quota 档:通道权重变成窗口配额,且按比例;vector=0 时一条向量独有候选都不放', async (t) => {
  const { store, home, embedder } = await world(t)
  // rerankCandidates=6,w_v=1,w_l=1 ⇒ 配额 round(6×0.5)=3
  const half = await vectorOnlyRows(store, home, embedder, {
    channelWeightMode: 'quota',
    channelWeights: { lexical: 1, vector: 1 },
  })
  assert.ok(half.vectorOnly <= 3, `w_v=w_l 时配额应为 3,实际 ${half.vectorOnly}`)

  // w_v=0 ⇒ 配额 0:权重第一次"真的能把它关掉"
  const off = await vectorOnlyRows(store, home, embedder, {
    channelWeightMode: 'quota',
    channelWeights: { lexical: 1, vector: 0 },
  })
  assert.equal(off.vectorOnly, 0, 'compass: w_v=0 就是"不要任何向量独有候选"')

  // 显式 maxVectorOnly 优先于按权重推导(便于单变量 A/B)
  const explicit = await vectorOnlyRows(store, home, embedder, {
    channelWeightMode: 'quota',
    channelWeights: { lexical: 1, vector: 1 },
    maxVectorOnly: 1,
  })
  assert.equal(explicit.vectorOnly, 1, '显式配额优先于按权重推导')
})

test('F3 两档的区别:fusion 用"整个通道权重 0 = 不进融合"来关,quota 只裁向量独有候选', async (t) => {
  const { store, home, embedder } = await world(t)
  const unlimited = await vectorOnlyRows(store, home, embedder, {})
  // fusion 档:w_v=0 让 rrfFuse 直接跳过该通道(`weight === 0` 即 skip),
  // 于是向量独有候选一条不剩 —— 副作用是"语义通道整个消失",不是"限额"。
  const fusionOff = await vectorOnlyRows(store, home, embedder, { channelWeights: { lexical: 1, vector: 0 } })
  assert.equal(fusionOff.vectorOnly, 0, 'fusion 档 w_v=0:rrfFuse 跳过零权通道')
  // quota 档:w_v=0 同样不放向量独有候选,但它是**配额**语义(窗口留给词法候选),
  // 且词法命中的那条一直在 —— 这是 A 案让旋钮"只有一个含义"的地方。
  const quotaOff = await vectorOnlyRows(store, home, embedder, {
    channelWeightMode: 'quota',
    channelWeights: { lexical: 1, vector: 0 },
  })
  assert.equal(quotaOff.vectorOnly, 0)
  assert.deepEqual(
    quotaOff.lexicalIds,
    unlimited.lexicalIds,
    'quota 档只裁"只被向量召回"的行 —— 词法召回到的一条不动(配额不该变成召回过滤器)',
  )
})
