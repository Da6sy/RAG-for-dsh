/**
 * V4 — the second level's vector channel (规划 §12).
 *
 * The gap V4 exists to close: a段 that answers the question in DIFFERENT WORDS
 * is invisible to bigram matching, so a long document's local answer stays
 * unfound no matter how good the entry-level recall is. The test below builds
 * exactly that situation (a chunk sharing no token with the query) and requires
 * the vector channel to find it — with a concept-map embedder, because the
 * engine sees a port and that is the only way to test "同义改写被召回" without a
 * live endpoint.
 *
 * The other half is regression discipline: with no embedder configured, the
 * second level must behave EXACTLY as it did before V4 (不变量 9).
 *
 * @module @clue-harness/rag/test/chunks-vector
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ingestSnapshot, openProjectStore, readVectorIndex, type KbStore } from '@clue-harness/kb'
import { queryChunks, type ChunkVectorState } from '../src/chunks.ts'
import { ingestFile } from '../src/ingest.ts'
import type { Embedder } from '../src/embedder.ts'

/** A concept-map embedder: dimensions are topics, so synonyms collide. */
function conceptEmbedder(): Embedder {
  const concepts: string[][] = [
    ['键盘', 'tab', 'focusable', '可达', '焦点顺序'],
    ['对比度', '颜色', 'contrast', 'aa'],
    ['滑窗', 'overlap', '重叠', '切片', 'chunk', '分段'],
    ['划除', 'redline', '作废'],
  ]
  return {
    id: 'chunk-concept-v1',
    dim: concepts.length,
    async embed(texts: readonly string[]) {
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

const DOC = [
  '# 检索层规范',
  '',
  '## 一级检索',
  '',
  '条目级检索按标题、标签、正文三处字段权重求和。',
  '',
  '## 二级检索',
  '',
  '无结构文本按 800/600 滑窗切片,重叠 200 字,查询时按 overlapWith 去重。',
  '',
  '## 治理',
  '',
  '划除的段落不参与显示与评分。',
  '',
  '## 可访问性',
  '',
  '所有交互元素必须可被 Tab 选中。',
  '',
].join('\n')

async function world(t: { after(fn: () => unknown): void }): Promise<{ store: KbStore; home: string; docId: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-chunkvec-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  const home = path.join(root, 'home')
  const store = await openProjectStore(project, home)
  const file = path.join(project, 'spec.md')
  await writeFile(file, DOC, 'utf8')
  const report = await ingestFile({ store, file, sourcePath: 'spec.md' })
  const docId = String(report.doc?.docId ?? '')
  assert.notEqual(docId, '', 'ingest 应产生 docId')
  return { store, home, docId }
}

test('V4: 与查询零词重叠的分段,靠向量通道被捞回(长文局部命中)', async (t) => {
  const { store, home, docId } = await world(t)
  const query = '键盘操作能不能到达'
  const lexicalOnly = await queryChunks({ store, docId }, { query })
  assert.equal(lexicalOnly.some((hit) => hit.headingPath.includes('可访问性')), false, '该分段与查询没有共同 token,词法必然漏')

  const states: ChunkVectorState[] = []
  const hybrid = await queryChunks({ store, docId }, {
    query,
    vector: { embedder: conceptEmbedder(), home, onState: (state) => states.push(state) },
  })
  assert.ok(hybrid.some((hit) => hit.headingPath.includes('可访问性')), '向量通道应把这一段落捞回')
  assert.equal(states.at(-1)?.status, 'used')
  assert.ok((states.at(-1)?.count ?? 0) > 0, '状态里要报出向量段数')
})

test('V4: 未配置嵌入 ⇒ 第二级行为与今天逐条相同(不变量 9)', async (t) => {
  const { store, docId } = await world(t)
  const query = '划除 段落 评分'
  const plain = await queryChunks({ store, docId }, { query })
  const withEmptyVector = await queryChunks({ store, docId }, { query, vector: undefined })
  assert.deepEqual(
    withEmptyVector.map((hit) => [hit.seq, hit.score, hit.matched.join(',')]),
    plain.map((hit) => [hit.seq, hit.score, hit.matched.join(',')]),
  )
})

test('V4: 索引缺失时按护栏查询期重建,失败则如实标注并退回词法', async (t) => {
  const { store, home, docId } = await world(t)
  const query = '键盘操作能不能到达'
  const states: ChunkVectorState[] = []
  await queryChunks({ store, docId }, { query, vector: { embedder: conceptEmbedder(), home, onState: (state) => states.push(state) } })
  const index = await readVectorIndex(store.dir, { kind: 'chunks', docId })
  assert.ok(index !== null && index.meta.count > 0, '查询期应把分段向量层建起来')

  // 重建关掉 + 索引删掉 ⇒ 只能是"待建",而且结果仍是词法序(不抛穿)
  const { rm: remove } = await import('node:fs/promises')
  const { vectorsDir } = await import('@clue-harness/kb')
  await remove(vectorsDir(store.dir), { recursive: true, force: true })
  const offline: ChunkVectorState[] = []
  const hits = await queryChunks({ store, docId }, {
    query,
    vector: { embedder: conceptEmbedder(), home, rebuildOnRead: false, onState: (state) => offline.push(state) },
  })
  assert.equal(offline.at(-1)?.status, 'index-missing')
  assert.equal(hits.some((hit) => hit.headingPath.includes('可访问性')), false, '没有向量层时退回词法,且如实标注')
})

test('V4: 向量通道失败不抛穿检索(降级诚实)', async (t) => {
  const { store, home, docId } = await world(t)
  const broken: Embedder = {
    id: 'broken', dim: 4,
    async embed() { throw new Error('connect ECONNREFUSED') },
  }
  const states: ChunkVectorState[] = []
  const hits = await queryChunks({ store, docId }, {
    query: '划除 段落',
    vector: { embedder: broken, home, onState: (state) => states.push(state) },
  })
  assert.ok(hits.length > 0, '词法结果照常返回')
  assert.equal(states.at(-1)?.status, 'error')
  assert.match(states.at(-1)?.note ?? '', /ECONNREFUSED/)
})

test('V4: 全划除的分段永远不进结果,向量通道也一样(先过滤后评分)', async (t) => {
  const { store, home, docId } = await world(t)
  const entry = await store.add({ kind: 'fact', title: '挂载', text: '挂载原文。' })
  await store.attachDoc(entry.id, docId)
  await store.redlineDocLines(entry.id, { lines: [12, 13], reason: '该段已作废', by: 'test' })
  const states: ChunkVectorState[] = []
  for (const mode of ['lexical', 'vector'] as const) {
    const hits = await queryChunks({ store, docId }, {
      query: '滑窗 重叠 去重',
      ...(mode === 'vector' ? { vector: { embedder: conceptEmbedder(), home, onState: (state) => states.push(state) } } : {}),
    })
    assert.equal(hits.some((hit) => hit.lines.start === 12), false, `${mode}: 全划除的段不得出现`)
  }
})
