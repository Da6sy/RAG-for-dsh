/**
 * R1 (落地计划 §2-1) — the retriever's indexed path must be the SAME retriever.
 *
 * The index is an optimization, so the only thing that matters is that nothing
 * observable changes: same hits, same scores, same `matched`, same explanation
 * inputs, same fusion order. The measured reason the path exists (nfcorpus,
 * 3.6k entries): `store.list()` costs ~1.25s per query and the corpus stats
 * ~0.21s, for a question that returns five rows.
 *
 * @module @clue-harness/rag/test/lexical-index-path
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildLexicalIndex, openProjectStore, type KbStore } from '@clue-harness/kb'
import { createHybridRetriever } from '../src/hybrid.ts'
import { hashEmbedder } from '../src/embedder.ts'
import { buildVectorIndex } from '../src/index-pipeline.ts'

/** A store with entries that make a real lexical channel work. */
async function world(t: { after(fn: () => unknown): void }): Promise<{ store: KbStore; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-indexpath-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'p')
  await mkdir(project, { recursive: true })
  const home = path.join(root, 'h')
  const store = await openProjectStore(project, home)
  await store.add({ kind: 'decision', title: '分片重建', text: 'chunker 版本号不一致时分片会重建。', tags: ['kb'] })
  await store.add({ kind: 'decision', title: '分片 重建 的排查步骤', text: '分片重建先看版本号,再看分片正文的长度。', tags: ['kb', 'ops'] })
  await store.add({ kind: 'pitfall', title: '焦点陷阱', text: '隐藏容器里的焦点会变成死区。', tags: ['a11y'] })
  await store.add({ kind: 'fact', title: '对比度约定', text: '正文对比度不得低于 4.5:1。', tags: ['a11y'] })
  await store.add({ kind: 'note', title: '分片与重建的区别', text: '分片是切,重建是重新生成。', tags: ['kb'] })
  return { store, home }
}

/** Every observable of one retrieval, for exact comparison. */
async function snapshot(
  store: KbStore,
  home: string,
  options: { channels: 'lexical' | 'hybrid'; rerank: boolean; index: boolean },
  query: string,
): Promise<unknown> {
  const indexes = options.index ? [await currentIndex(store)] : undefined
  const detailed = await createHybridRetriever(store, null, {
    channels: options.channels,
    rerank: options.rerank,
    topK: 5,
    ...(indexes !== undefined ? { lexicalIndexes: indexes } : {}),
    ...(options.channels === 'hybrid' ? { embedder: { ...hashEmbedder({ dim: 16 }), semantics: 'endpoint' as const }, home, rebuildOnRead: false } : {}),
  }).retrieveDetailed(query, { limit: 5, noTouch: true })
  return {
    channels: detailed.channels,
    vector: detailed.vector.status,
    recalled: detailed.recalled,
    fused: detailed.fused,
    hits: detailed.hits.map((hit) => [
      String(hit.entry.id),
      hit.score,
      hit.matched.join(','),
      (hit.explain?.lines ?? []).join(' | '),
    ]),
  }
}

let cached: Awaited<ReturnType<typeof buildLexicalIndex>> | null = null
/** Build (once per process) the index of a store. */
async function currentIndex(store: KbStore): Promise<Awaited<ReturnType<typeof buildLexicalIndex>>['index']> {
  if (cached === null) cached = await buildLexicalIndex({ storeDir: store.dir, entries: await store.list() })
  return cached.index
}

test('R1 索引路径:纯词法(精排开/关)与扫描路径逐条相同', async (t) => {
  cached = null
  const { store, home } = await world(t)
  for (const rerank of [true, false]) {
    for (const query of ['分片 重建', '对比度', '焦点 死区', 'chunker 版本号']) {
      const scanned = await snapshot(store, home, { channels: 'lexical', rerank, index: false }, query)
      const indexed = await snapshot(store, home, { channels: 'lexical', rerank, index: true }, query)
      assert.deepEqual(indexed, scanned, `纯词法 rerank=${rerank} 查询「${query}」必须逐条相同`)
    }
  }
})

test('R1 索引路径:混合通道(融合+精排)与扫描路径逐条相同', async (t) => {
  cached = null
  const { store, home } = await world(t)
  const embedder = { ...hashEmbedder({ dim: 16 }), semantics: 'endpoint' as const }
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' } })
  for (const rerank of [true, false]) {
    for (const query of ['分片 重建', '对比度 约定', '焦点']) {
      const scanned = await snapshot(store, home, { channels: 'hybrid', rerank, index: false }, query)
      const indexed = await snapshot(store, home, { channels: 'hybrid', rerank, index: true }, query)
      assert.deepEqual(indexed, scanned, `混合 rerank=${rerank} 查询「${query}」必须逐条相同(融合序也要一样)`)
    }
  }
})
