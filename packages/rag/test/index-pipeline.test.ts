/**
 * V0/V1 — the index pipeline (规划 §5.3/§6, 不变量 1/12).
 *
 * The pipeline is where money is spent, so the tests here are mostly about
 * what it REFUSES to do: call the embedder when the cache already has the
 * vector, spend past the budget, or write an index that claims to be complete
 * when a batch failed. The counting embedders below are the evidence — they
 * record every call, so "zero calls" is measured, not asserted from prose.
 *
 * @module @clue-harness/rag/test/index-pipeline
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openProjectStore, readVectorIndex, vectorsDir, type KbStore } from '@clue-harness/kb'
import {
  buildVectorIndex,
  collectUnits,
  entryEmbedText,
  hashEmbedder,
  planEmbed,
  vectorIndexIsCurrent,
  type Embedder,
} from '../src/index.ts'

/** A counting embedder: the call log IS the assertion. */
function countingEmbedder(inner: Embedder = hashEmbedder({ dim: 8 })): Embedder & { calls: string[][]; failures: number } {
  const log: string[][] = []
  const wrapper = {
    id: inner.id,
    dim: inner.dim,
    calls: log,
    failures: 0,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      log.push([...texts])
      if (wrapper.failures > 0) {
        wrapper.failures -= 1
        throw new Error('endpoint 503')
      }
      return inner.embed(texts)
    },
  }
  return wrapper
}

async function world(t: { after(fn: () => unknown): void }): Promise<{ store: KbStore; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-pipe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  const home = path.join(root, 'home')
  const store = await openProjectStore(project, home)
  await store.add({ kind: 'decision', title: '按钮可 Tab', text: '按钮必须可被 Tab 选中。', tags: ['a11y'] })
  await store.add({ kind: 'pitfall', title: '抽屉焦点', text: '打开抽屉后焦点必须移入内部。', tags: ['focus'] })
  await store.add({ kind: 'fact', title: '对比度', text: '正文对比度不得低于 4.5:1。', tags: ['contrast'] })
  return { store, home }
}

test('unit 文本 = 标题 + 标签 + 划除后正文(先过滤后嵌入,不变量 4)', async (t) => {
  const { store } = await world(t)
  const entries = await store.list()
  const entry = entries.find((candidate) => candidate.title === '按钮可 Tab')
  assert.ok(entry !== undefined)
  assert.ok(entryEmbedText(entry).includes('按钮必须可被 Tab 选中。'))
  // 划掉正文前 4 个字(「按钮必须」):那些字符一个都不该进向量。
  const withRedline = { ...entry, redlines: [{ target: 'text' as const, chars: [1, 4] as [number, number], quoteAnchor: '', reason: '作废', at: 'now', by: 'cli' }] }
  assert.ok(!entryEmbedText(withRedline).includes('按钮必须'), '被划除的字符一个都不该进向量')
  assert.ok(entryEmbedText(withRedline).includes('可被 Tab 选中'))
})

test('collectUnits 按 key 升序(确定性:两次构建必须得到同一文件)', async (t) => {
  const { store } = await world(t)
  const units = await collectUnits(store, { kind: 'entries' })
  assert.deepEqual(units.map((unit) => unit.key), [...units.map((unit) => unit.key)].sort())
})

test('V1 验收: 同一语料二次构建零调用(全部命中缓存)', async (t) => {
  const { store, home } = await world(t)
  const embedder = countingEmbedder()
  const first = await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, batchSize: 2 })
  assert.equal(first.units, 3)
  assert.equal(first.cacheHits, 0)
  assert.equal(first.calls, 2, '3 条 / batch 2 ⇒ 2 次调用')
  assert.equal(first.missing, 0)

  await rm(vectorsDir(store.dir), { recursive: true, force: true })
  const second = await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, batchSize: 2 })
  assert.equal(second.cacheHits, 3)
  assert.equal(second.calls, 0, '第二次构建必须一次都不调用端点')
  assert.equal(second.embedded, 0)
  assert.equal(embedder.calls.length, 2, '整个测试里端点只被调用过两次')
})

test('不变量 12: 预算护栏 — 超限即停并标注剩余量,不静默多花', async (t) => {
  const { store, home } = await world(t)
  const embedder = countingEmbedder()
  const report = await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, maxUnitsPerBuild: 1 })
  assert.equal(report.embedded, 1)
  assert.equal(report.skipped, 2)
  assert.equal(report.missing, 2)
  const index = await readVectorIndex(store.dir, { kind: 'entries' })
  assert.equal(index?.meta.count, 1)
  assert.equal(index?.meta.partial?.missing, 2)

  const plan = await planEmbed(store, { home, embedder, target: { kind: 'entries' }, maxUnitsPerBuild: 1 })
  assert.equal(plan.budgetHit, true)
  assert.equal(plan.withinBudget, 1)
  assert.equal(plan.toEmbed, 2, '已命中缓存的那条不算在预算里')
})

test('--dry-run 零调用零花费:planEmbed 只算账', async (t) => {
  const { store, home } = await world(t)
  const embedder = countingEmbedder()
  const plan = await planEmbed(store, { home, embedder, target: { kind: 'entries' } })
  assert.equal(plan.units, 3)
  assert.equal(plan.toEmbed, 3)
  assert.equal(plan.batches, 1)
  assert.ok(plan.chars > 0)
  assert.equal(embedder.calls.length, 0, 'dry-run 不得发出任何调用')
})

test('失败隔离: 只有真正嵌不了的单元变 missing,其余照常落盘并标 partial', async (t) => {
  const { store, home } = await world(t)
  // A unit that NO batch size can save (the failure follows the text, not the
  // batch): splitting must not paper over it, but it also must not take the
  // healthy units down with it.
  const inner = hashEmbedder({ dim: 8 })
  const embedder: Embedder & { calls: string[][] } = {
    id: inner.id,
    dim: inner.dim,
    calls: [],
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      embedder.calls.push([...texts])
      if (texts.some((text) => text.includes('按钮'))) throw new Error('endpoint 400: 该条文本无法嵌入')
      return inner.embed(texts)
    },
  }
  const report = await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, batchSize: 3 })
  assert.equal(report.missing, 1, '只有那条坏文本缺失')
  assert.equal(report.rows, 2, '其余照常落盘')
  const index = await readVectorIndex(store.dir, { kind: 'entries' })
  assert.equal(index?.meta.partial?.missing, 1, 'partial 是给读者看的诚实字段')
})

test('批量上限自适应: 服务端拒收过大批次时对半拆分,而不是丢掉整批', async (t) => {
  const { store, home } = await world(t)
  // The measured real case: dashscope answers HTTP 400 `batch size is invalid,
  // it should not be larger than 10` for 25 inputs. Our default is 32, so the
  // pipeline has to discover the limit by splitting instead of losing data.
  const inner = hashEmbedder({ dim: 8 })
  let maxAccepted = 0
  const embedder: Embedder = {
    id: inner.id,
    dim: inner.dim,
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length > 1) throw new Error('400 batch size is invalid, it should not be larger than 1')
      maxAccepted = Math.max(maxAccepted, texts.length)
      return inner.embed(texts)
    },
  }
  const report = await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, batchSize: 3 })
  assert.equal(report.missing, 0, '对半拆分后应当全部成功')
  assert.equal(report.rows, 3)
  assert.equal(maxAccepted, 1)
  // 3 单元 / 上限 1: 3-batch 失败两次(2) + 拆成 2+1 → 2-batch 失败两次(2) + 两个单条(2) + 顶层单条(1) = 7
  assert.equal(report.calls, 7, `拆分把失败尝试也计入调用数(实际 ${report.calls})`)
})

test('一次重试救回瞬时失败: 第二批成功即不标 missing', async (t) => {
  const { store, home } = await world(t)
  const embedder = countingEmbedder()
  // One batch of 3: first attempt fails, retry succeeds.
  embedder.failures = 1
  const report = await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, batchSize: 3 })
  assert.equal(report.missing, 0)
  assert.equal(report.rows, 3)
  assert.equal(report.calls, 2, '失败一次 + 成功一次')
  assert.equal(embedder.calls.length, 2)
})

test('重建字节一致 + up-to-date 短路', async (t) => {
  const { store, home } = await world(t)
  const embedder = countingEmbedder(hashEmbedder({ dim: 16 }))
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, at: '2026-09-19T00:00:00.000Z' })
  const bin1 = await readFile(path.join(vectorsDir(store.dir), 'entries.bin'))

  const again = await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, at: '2026-09-20T00:00:00.000Z' })
  assert.equal(again.upToDate, true, '语料与版本都没变 ⇒ 不动文件')

  await rm(vectorsDir(store.dir), { recursive: true, force: true })
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' }, at: '2026-09-21T00:00:00.000Z' })
  const bin2 = await readFile(path.join(vectorsDir(store.dir), 'entries.bin'))
  assert.deepEqual([...bin2], [...bin1], '不变量 1:删除后重建逐字节一致')

  const version = (await readVectorIndex(store.dir, { kind: 'entries' }))?.meta.embedderVersion ?? ''
  assert.equal(await vectorIndexIsCurrent(store, { kind: 'entries' }, version), true)
  assert.equal(await vectorIndexIsCurrent(store, { kind: 'entries' }, `${version}-换模型`), false)
})

test('换 model/dim ⇒ 整层作废重建(版本号变了,旧向量不再可比)', async (t) => {
  const { store, home } = await world(t)
  const small = countingEmbedder(hashEmbedder({ dim: 8 }))
  const big = countingEmbedder(hashEmbedder({ dim: 32 }))
  await buildVectorIndex(store, { home, embedder: small, target: { kind: 'entries' } })
  const versionA = (await readVectorIndex(store.dir, { kind: 'entries' }))?.meta.embedderVersion

  const report = await buildVectorIndex(store, { home, embedder: big, target: { kind: 'entries' } })
  const index = await readVectorIndex(store.dir, { kind: 'entries' })
  assert.notEqual(index?.meta.embedderVersion, versionA)
  assert.equal(index?.meta.dim, 32)
  assert.equal(report.cacheHits, 0, '换了版本 ⇒ 缓存分区不同,必须真调用')
})

test('条目文本变化 ⇒ 该条目向量作废(内容指纹变了即重建)', async (t) => {
  const { store, home } = await world(t)
  const embedder = countingEmbedder()
  await buildVectorIndex(store, { home, embedder, target: { kind: 'entries' } })
  const version = (await readVectorIndex(store.dir, { kind: 'entries' }))?.meta.embedderVersion ?? ''
  assert.equal(await vectorIndexIsCurrent(store, { kind: 'entries' }, version), true)

  const [entry] = await store.list()
  assert.ok(entry !== undefined)
  await store.updateEntryText(entry.id, `${entry.text}补充一句。`, 'test')
  const units = await collectUnits(store, { kind: 'entries' })
  const index = await readVectorIndex(store.dir, { kind: 'entries' })
  // The key set is unchanged (same ids) — what changes is the TEXT, so the
  // cache misses and the vector is recomputed. That is why the pipeline's
  // up-to-date check also hashes the text through the cache key.
  assert.equal(units.length, index?.meta.count)
  const plan = await planEmbed(store, { home, embedder, target: { kind: 'entries' } })
  assert.equal(plan.cacheHits, 2)
  assert.equal(plan.toEmbed, 1, '只有被改过的那条需要重新嵌入')
})
