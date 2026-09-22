/**
 * V0 — the vector layer's storage invariants (原规划 §5 / §13).
 *
 * These tests exist because every one of them is a claim about a boundary that
 * a later refactor would happily cross: "the index is derived", "it carries no
 * governance", "the version stamp has one source", "the cache is content
 * addressed". Each test names the invariant it guards, in the same style the
 * M9-3.5 gate established for the two-level retrieval.
 *
 * @module @clue-harness/kb/test/vectors
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  EMBED_NORM_VERSION,
  cosineSimilarity,
  countCachedVectors,
  embedCacheKey,
  embedderVersion,
  encodeVectorMatrix,
  decodeVectorMatrix,
  l2Normalize,
  normalizeEmbedText,
  openProjectStore,
  readCachedVector,
  readVectorIndex,
  removeVectorIndex,
  vectorIndexStatuses,
  vectorMetaFor,
  vectorsDir,
  writeCachedVector,
  writeVectorIndex,
  type KbStore,
} from '../src/index.ts'

async function world(t: { after(fn: () => unknown): void }): Promise<{ store: KbStore; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-vec-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  const home = path.join(root, 'home')
  return { store: await openProjectStore(project, home), home }
}

test('不变量 8: embedderVersion 只有一个出处,且把 model/dim/归一化都编进去', () => {
  const a = embedderVersion({ modelId: 'bge-m3', dim: 1024 })
  assert.equal(a, `bge-m3@dim=1024:${EMBED_NORM_VERSION}`)
  // Every axis that changes what a stored vector MEANS must change the stamp:
  // a model swap, a dimension swap, and a normalization change each rebuild.
  assert.notEqual(a, embedderVersion({ modelId: 'bge-m3', dim: 512 }))
  assert.notEqual(a, embedderVersion({ modelId: 'text-embedding-3-small', dim: 1024 }))
})

test('不变量 1/2: 索引是派生的纯数值文件,meta 里没有任何治理字段', async (t) => {
  const { store } = await world(t)
  const meta = vectorMetaFor({
    embedderVersion: embedderVersion({ modelId: 'hash-v1', dim: 4 }),
    dim: 4,
    idOrder: ['k-a', 'k-b'],
    unitsHash: 'fingerprint',
    builtAt: '2026-09-19T00:00:00.000Z',
  })
  await writeVectorIndex(store.dir, { kind: 'entries' }, meta, Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0]))

  const raw = await readFile(path.join(vectorsDir(store.dir), 'entries.meta.json'), 'utf8')
  for (const forbidden of ['status', 'needsReview', 'signal', 'approval', 'tier', 'discarded']) {
    assert.equal(raw.includes(forbidden), false, `向量 meta 不得出现治理字段 "${forbidden}"`)
  }
  assert.deepEqual(meta.idOrder, ['k-a', 'k-b'])
  assert.equal(meta.count, 2)
})

test('不变量 1: 删掉 vectors/ 之后重建,字节完全一致', async (t) => {
  const { store } = await world(t)
  const version = embedderVersion({ modelId: 'hash-v1', dim: 3 })
  const matrix = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])
  const first = vectorMetaFor({ embedderVersion: version, dim: 3, idOrder: ['k-a', 'k-b'], unitsHash: 'fingerprint', builtAt: '2026-09-19T00:00:00.000Z' })
  await writeVectorIndex(store.dir, { kind: 'entries' }, first, matrix)
  const before = await readFile(path.join(vectorsDir(store.dir), 'entries.bin'))

  await removeVectorIndex(store.dir, { kind: 'entries' })
  assert.equal(await readVectorIndex(store.dir, { kind: 'entries' }), null, '删掉后读到的必须是"没有",不是空索引')

  // Same inputs ⇒ same bytes. `builtAt` is the ONE field allowed to differ: it
  // records when the rebuild happened, not what it produced.
  const second = vectorMetaFor({ embedderVersion: version, dim: 3, idOrder: ['k-a', 'k-b'], unitsHash: 'fingerprint', builtAt: '2026-09-20T00:00:00.000Z' })
  await writeVectorIndex(store.dir, { kind: 'entries' }, second, matrix)
  const after = await readFile(path.join(vectorsDir(store.dir), 'entries.bin'))
  assert.deepEqual([...after], [...before])
})

test('索引读到坏文件/版本不符时为 null(读侧判"需重建",不是抛错)', async (t) => {
  const { store } = await world(t)
  const version = embedderVersion({ modelId: 'hash-v1', dim: 2 })
  await writeVectorIndex(store.dir, { kind: 'entries' }, vectorMetaFor({ embedderVersion: version, dim: 2, idOrder: ['k-a'], unitsHash: 'f', builtAt: 'now' }), Float32Array.from([1, 0]))

  // Truncated matrix (crash mid-write cannot happen through the atomic writer,
  // but a hand-edited or copied file can) must read as "rebuild me".
  await writeFile(path.join(vectorsDir(store.dir), 'entries.bin'), Buffer.alloc(3))
  assert.equal(await readVectorIndex(store.dir, { kind: 'entries' }), null)

  // Foreign format version: refuse, never migrate.
  await writeFile(path.join(vectorsDir(store.dir), 'entries.meta.json'), JSON.stringify({ version: 99, dim: 2, count: 1, idOrder: ['k-a'], quant: 'fp32', embedderVersion: version, builtAt: 'x' }))
  assert.equal(await readVectorIndex(store.dir, { kind: 'entries' }), null)
})

test('writeVectorIndex 拒绝 meta 与矩阵不一致(损坏要在写时就暴露)', async (t) => {
  const { store } = await world(t)
  await assert.rejects(
    () => writeVectorIndex(store.dir, { kind: 'entries' }, vectorMetaFor({ embedderVersion: 'v', dim: 4, idOrder: ['k-a'], unitsHash: 'f', builtAt: 'now' }), Float32Array.from([1, 0])),
    /矩阵/,
  )
})

test('doctor: 状态报告区分版本过期 / partial / 文件缺失,且不发一次调用', async (t) => {
  const { store } = await world(t)
  const current = embedderVersion({ modelId: 'm', dim: 2 })
  await writeVectorIndex(store.dir, { kind: 'entries' }, vectorMetaFor({ embedderVersion: current, dim: 2, idOrder: ['k-a'], unitsHash: 'f', builtAt: 'now', missing: 3 }), Float32Array.from([1, 0]))
  await writeVectorIndex(store.dir, { kind: 'chunks', docId: 'd-1' }, vectorMetaFor({ embedderVersion: 'm@dim=2:old', dim: 2, idOrder: ['d-1#1'], unitsHash: 'f', builtAt: 'now' }), Float32Array.from([1, 0]))
  await rm(path.join(vectorsDir(store.dir), 'entries.bin'), { force: true })

  const rows = await vectorIndexStatuses(store.dir, current)
  const entries = rows.find((row) => row.stem === 'entries')
  const chunks = rows.find((row) => row.stem === 'chunks-d-1')
  assert.equal(entries?.missing, 3)
  assert.equal(entries?.unreadable, true)
  assert.equal(entries?.stale, false)
  assert.equal(chunks?.stale, true, '换模型后旧索引必须报"过期"')
})

test('缓存: 键只看归一化文本,命中按 embedderVersion 分目录', async (t) => {
  const { home } = await world(t)
  assert.equal(normalizeEmbedText('a\r\n\r\n\r\n  b  '), 'a\n\nb')
  assert.equal(embedCacheKey('x  y'), embedCacheKey('x y'), '空白差异不该产生两次调用')
  assert.notEqual(embedCacheKey('X'), embedCacheKey('x'), '大小写不同 ⇒ 文本不同,不得共用向量')

  const v1 = embedderVersion({ modelId: 'm', dim: 2 })
  const v2 = embedderVersion({ modelId: 'm', dim: 3 })
  const key = embedCacheKey('同一段文字')
  await writeCachedVector(home, v1, key, Float32Array.from([1, 0]))
  assert.deepEqual([...(await readCachedVector(home, v1, key, 2) ?? [])], [1, 0])
  assert.equal(await readCachedVector(home, v2, key, 3), null, '换维度后不得复用旧向量')
  assert.equal(await readCachedVector(home, v1, key, 3), null, '维度不符按 miss 处理')
  assert.equal(await countCachedVectors(home, v1), 1)
})

test('编解码与余弦:L2 归一化后余弦就是点积,零向量不产生 NaN', () => {
  const round = decodeVectorMatrix(encodeVectorMatrix(Float32Array.from([0.25, -1.5, 3])))
  assert.deepEqual([...round], [0.25, -1.5, 3])

  const a = l2Normalize(Float32Array.from([3, 4]))
  assert.ok(Math.abs(Math.hypot(a[0] as number, a[1] as number) - 1) < 1e-6)
  assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-6)

  const zero = l2Normalize(Float32Array.from([0, 0]))
  assert.deepEqual([...zero], [0, 0], '零向量保持零,不产生 NaN')
  assert.equal(cosineSimilarity(zero, Float32Array.from([1, 0])), 0)
  assert.equal(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0])), 0, '维度不符 ⇒ 不可比')
})
