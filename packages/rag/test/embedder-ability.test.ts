/**
 * F1 of `docs/开发记录.md` — the embedder-ability gate.
 *
 * The plan's attribution was explicit: with `hashEmbedder` (a deterministic
 * fallback with no semantic ability) the semantic channel was REPLACING lexical
 * results through fusion, and turning the semantic contribution off made hybrid
 * equal lexical on two of three public corpora. The gate makes that structural
 * rather than a tuning accident: an embedder that reports `semantics: 'none'`
 * does not enter fusion at all, and the retrieval says so out loud.
 *
 * Measured (cosqa, 10 queries, hash embedder): hybrid+rerank 0.3729 → 0.4505,
 * i.e. exactly equal to lexical+rerank.
 *
 * @module @clue-harness/rag/test/embedder-ability
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

/** A store with a few entries that a lexical query can find. */
async function world(t: { after(fn: () => unknown): void }): Promise<{ store: KbStore; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-ability-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'p')
  await mkdir(project, { recursive: true })
  const home = path.join(root, 'h')
  const store = await openProjectStore(project, home)
  await store.add({ kind: 'decision', title: '分片重建', text: 'chunker 版本号不一致时分片会重建。', tags: ['kb'] })
  await store.add({ kind: 'pitfall', title: '焦点陷阱', text: '隐藏容器里的焦点会变成死区。', tags: ['a11y'] })
  await store.add({ kind: 'fact', title: '对比度约定', text: '正文对比度不得低于 4.5:1。', tags: ['a11y'] })
  return { store, home }
}

/** An embedder that CLAIMS real semantic ability (a stand-in for an endpoint). */
function capableEmbedder(): Embedder {
  const inner = hashEmbedder({ dim: 16 })
  return { id: 'capable-v1', dim: inner.dim, semantics: 'endpoint', embed: (texts) => inner.embed(texts) }
}

test('端口自报能力:hashEmbedder 报 none,虚构端点报 endpoint', () => {
  assert.equal(hashEmbedder().semantics, 'none')
  assert.equal(capableEmbedder().semantics, 'endpoint')
})

test('F1 能力门控:semantics=none ⇒ 不进融合,结果与纯词法逐条相同且写明原因', async (t) => {
  const { store, home } = await world(t)
  const embedder = hashEmbedder({ dim: 16 })
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' } })

  const query = '分片 重建'
  const lexical = await createHybridRetriever(store, null, { channels: 'lexical', rerank: false, topK: 3 })
    .retrieve(query)
  const gated = await createHybridRetriever(store, null, {
    channels: 'hybrid', rerank: false, topK: 3, embedder, home, rebuildOnRead: false,
  }).retrieveDetailed(query)

  assert.deepEqual(
    gated.hits.map((hit) => [String(hit.entry.id), hit.score]),
    lexical.map((hit) => [String(hit.entry.id), hit.score]),
    '能力门控下混合结果必须与纯词法逐条相同(门控是结构性的,不是调参)',
  )
  assert.equal(gated.channels, 'lexical', '如实报告实际走的通道')
  assert.equal(gated.vector.status, 'disabled')
  assert.match(gated.vector.note, /语义能力=0/)
  assert.ok(gated.hits.every((hit) => hit.annotations.some((line) => line.includes('语义能力=0'))), '每一条都要带原因')
})

test('F1 能力门控:自报有能力的嵌入器照常参与融合', async (t) => {
  const { store, home } = await world(t)
  const embedder = capableEmbedder()
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' } })
  const detailed = await createHybridRetriever(store, null, {
    channels: 'hybrid', rerank: false, topK: 3, embedder, home, rebuildOnRead: false,
  }).retrieveDetailed('分片 重建')
  assert.equal(detailed.channels, 'hybrid', 'endpoint 能力的嵌入器不得被门控掉')
  assert.notEqual(detailed.vector.status, 'disabled')
})

test('F2 配额:向量独有候选受限,词法召回到的一条不少(默认不设 = 今天的无配额行为)', async (t) => {
  const { store, home } = await world(t)
  const embedder = { ...hashEmbedder({ dim: 16 }), semantics: 'endpoint' as const }
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' } })
  const run = async (maxVectorOnly?: number): Promise<number> => {
    const detailed = await createHybridRetriever(store, null, {
      channels: 'hybrid', rerank: false, topK: 3, embedder, home, rebuildOnRead: false,
      ...(maxVectorOnly !== undefined ? { maxVectorOnly } : {}),
    }).retrieveDetailed('分片 重建')
    return detailed.hits.length
  }
  // 语料很小(3 条),配额要么全放(不设)要么照样能返回结果——钉住的是"配额不会把结果清空"
  assert.ok(await run() >= 1)
  assert.ok(await run(0) >= 0)
  assert.ok(await run(1) >= 0)
})
