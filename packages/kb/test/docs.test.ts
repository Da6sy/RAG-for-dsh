/**
 * M9-1 文档层 tests: ingest snapshots are immutable, drift flags every entry
 * mounted on a doc (and only the entries mounted on it), and the chunk ledger
 * is pure derivation (delete it, rebuild it, get the same rows back).
 *
 * Everything runs over REAL temp-dir stores: the whole point of this layer is
 * what happens between the filesystem, the hash and the entry's flag — a mock
 * would prove nothing.
 *
 * @module @clue-harness/kb/test/docs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  chunkDocument,
  docSnapshotPath,
  ingestSnapshot,
  listDocs,
  openGlobalStore,
  openProjectStore,
  readChunks,
  type KbStore,
} from '../src/index.ts'

/** One isolated world: a project root with a spec file + both stores. */
async function world(t: { after(fn: () => unknown): void }): Promise<{ root: string; home: string; project: string; store: KbStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-docs-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  return { root, home, project, store: await openProjectStore(project, home) }
}

const SPEC = [
  '# 组件规范',
  '',
  '## 按钮',
  '',
  '按钮必须可被 Tab 选中,禁用态使用 aria-disabled 而不是 disabled。',
  '',
  '## 表单',
  '',
  '表单提交按钮必须在 form 内,提交后给出 aria-live 反馈。',
  '',
].join('\n')

test('M9-1: ingest snapshots the source once; identical bytes reuse the same docId', async (t) => {
  const { project, store } = await world(t)
  const source = path.join(project, 'spec.md')
  await writeFile(source, SPEC, 'utf8')

  const first = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })
  assert.equal(first.reused, false)
  assert.match(String(first.record.docId), /^d-[0-9a-f]{12}$/)
  assert.equal(first.record.sourcePath, 'spec.md')
  assert.equal(first.record.lineCount, SPEC.split('\n').length - 1)
  // The snapshot is on disk and byte-identical to what was ingested.
  assert.equal(await readFile(docSnapshotPath(store.dir, first.record.docId), 'utf8'), SPEC)

  const again = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })
  assert.equal(again.reused, true, '同字节重复 ingest 复用 docId,不产生副本')
  assert.equal(String(again.record.docId), String(first.record.docId))
  assert.equal((await listDocs(store.dir)).length, 1)
})

test('M9-1: a changed source produces a NEW docId linked by supersedes (旧快照不可覆盖)', async (t) => {
  const { project, store } = await world(t)
  const source = path.join(project, 'spec.md')
  await writeFile(source, SPEC, 'utf8')
  const v1 = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })

  const v2Text = SPEC.replace('aria-disabled', 'aria-disabled + 视觉禁用色')
  await writeFile(source, v2Text, 'utf8')
  const v2 = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: v2Text, sourceFile: source })

  assert.notEqual(String(v2.record.docId), String(v1.record.docId))
  assert.equal(String(v2.record.supersedes), String(v1.record.docId))
  // The OLD snapshot still reads exactly as it was (invariant 7).
  assert.equal(await readFile(docSnapshotPath(store.dir, v1.record.docId), 'utf8'), SPEC)
  assert.equal((await listDocs(store.dir)).length, 2)
  // Newest first, so `doc list` shows the current version at the top.
  assert.equal(String((await listDocs(store.dir))[0].docId), String(v2.record.docId))
})

test('M9-1: checkDocs flags every entry mounted on a drifted doc — and only those', async (t) => {
  const { project, store } = await world(t)
  const source = path.join(project, 'spec.md')
  await writeFile(source, SPEC, 'utf8')
  const snap = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })

  const mounted = await store.add({
    kind: 'decision', title: '按钮可 Tab', text: '按钮必须可被 Tab 选中。', tags: ['a11y'],
  })
  const bare = await store.add({ kind: 'fact', title: '无关知识', text: '与规范无关的内容。' })
  await store.attachDoc(mounted.id, snap.record.docId, { lines: [5, 5], quoteAnchor: '按钮必须可被 Tab 选中' })

  assert.equal((await store.get(mounted.id))?.doc?.docId, snap.record.docId)
  // No drift yet → no flag.
  assert.equal((await store.checkDocs(mounted.id)).needsReview, false)

  await writeFile(source, `${SPEC}\n新增一段。\n`, 'utf8')
  const flagged = await store.checkDocs(mounted.id)
  assert.equal(flagged.needsReview, true)
  assert.match(flagged.reviewReason ?? '', /原文已更新: spec\.md \([0-9a-f]{8}\)/)
  assert.deepEqual(flagged.history.at(-1)?.change, 'needsReview')

  // The unmounted entry is untouched by another entry's evidence drifting.
  assert.equal((await store.get(bare.id))?.needsReview, false)
  // The snapshot itself was NOT rewritten by the drift check.
  assert.equal(await readFile(docSnapshotPath(store.dir, snap.record.docId), 'utf8'), SPEC)

  // A deleted source is drift too (the现场 evidence is gone), with its own reason.
  await rm(source, { force: true })
  const missing = await store.checkDocs(mounted.id)
  assert.match(missing.reviewReason ?? '', /原文文件不存在: spec\.md/)

  // …and restoring the SOURCE BYTES auto-clears the flag (自动重验通过).
  await writeFile(source, SPEC, 'utf8')
  const cleared = await store.checkDocs(mounted.id)
  assert.equal(cleared.needsReview, false)
  assert.match(cleared.history.at(-1)?.reason ?? '', /自动重验通过/)
})

test('M9-1: sweeping reports doc drift for live sources only', async (t) => {
  const { project, store } = await world(t)
  const source = path.join(project, 'spec.md')
  await writeFile(source, SPEC, 'utf8')
  const snap = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })
  const entry = await store.add({ kind: 'fact', title: 'x', text: 'y' })
  await store.attachDoc(entry.id, snap.record.docId)

  const clean = await store.sweep()
  assert.deepEqual(clean.docDrift, [])

  await writeFile(source, `${SPEC}\n追加。\n`, 'utf8')
  const drifted = await store.sweep()
  assert.equal(drifted.docDrift.length, 1)
  assert.equal(drifted.docDrift[0].kind, 'changed')
  assert.equal(drifted.docDrift[0].recordedHash.length, 8)
  // Idempotent: the second sweep finds the flag already raised (no new finding).
  assert.deepEqual((await store.sweep()).docDrift, [])
})

test('M9-1: chunk ledger is pure derivation — delete it, rebuild, same rows', async (t) => {
  const { project, store } = await world(t)
  const source = path.join(project, 'spec.md')
  await writeFile(source, SPEC, 'utf8')
  const snap = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })
  const rows = chunkDocument(SPEC, { chunkChars: 800, windowStep: 600, quoteAnchorChars: 40, version: store.config.chunkerVersion })
  await store.saveChunks(snap.record.docId, rows)
  assert.equal((await store.getChunks(snap.record.docId)).length, rows.length)
  assert.equal(await store.chunksNeedRebuild(snap.record.docId), false)

  await store.dropChunks(snap.record.docId)
  assert.deepEqual(await readChunks(store.dir, snap.record.docId), [])
  assert.equal(await store.chunksNeedRebuild(snap.record.docId), true, '删掉派生 → 需要重建')

  const rebuilt = chunkDocument(SPEC, { chunkChars: 800, windowStep: 600, quoteAnchorChars: 40, version: store.config.chunkerVersion })
  assert.deepEqual(rebuilt, rows, '同一快照 + 同一 chunker ⇒ 逐字节相同')
})

test('M9-1: attaching evidence fails loud — unknown snapshot, unknown entry', async (t) => {
  const { home, store } = await world(t)
  const global = await openGlobalStore(home)
  const globalEntry = await global.add({ kind: 'fact', title: 'g', text: 'global' })
  const local = await store.add({ kind: 'fact', title: 'l', text: 'local' })
  // An unknown snapshot is refused with the actionable reason.
  await assert.rejects(() => store.attachDoc(local.id, 'd-nope'), /document snapshot not found/)
  // An entry that is not in this tier is refused too (no cross-tier edits).
  await assert.rejects(() => store.attachDoc(globalEntry.id as never, 'd-whatever'), /entry not found/)
  assert.equal(await store.getDoc('d-nope'), null)
  assert.deepEqual(await store.listDocs(), [])
})
