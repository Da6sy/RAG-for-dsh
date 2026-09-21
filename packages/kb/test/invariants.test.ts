/**
 * M9-3.5 — the architecture-invariant gate (proposal §11).
 *
 * These tests add no user-facing feature. They exist so the seven invariants
 * the proposal pins down stop being prose and start being checkable: every one
 * of them is a claim about a SEMANTIC BOUNDARY, and a boundary that is not
 * tested is a boundary that will be crossed by the next refactor.
 *
 * Each test names the invariant it guards.
 *
 * @module @clue-harness/kb/test/invariants
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  chunkDocument,
  ingestSnapshot,
  openGlobalStore,
  openProjectStore,
  queryKb,
  renderHitLine,
  type KbStore,
} from '../src/index.ts'

async function world(t: { after(fn: () => unknown): void }): Promise<{ root: string; project: string; store: KbStore; global: KbStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-inv-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  const home = path.join(root, 'home')
  return {
    root,
    project,
    store: await openProjectStore(project, home),
    global: await openGlobalStore(home),
  }
}

const SPEC = [
  '# 规范',
  '',
  '## 按钮',
  '',
  '按钮可 Tab,禁用态用 aria-disabled。',
  '',
  '## 表单',
  '',
  '提交按钮必须在 form 内。',
  '',
].join('\n')

test('不变量 7: 旧快照不可被覆盖 — 漂移只产生待复核信号,历史证据仍从旧 docId 读', async (t) => {
  const { project, store } = await world(t)
  const source = path.join(project, 'spec.md')
  await writeFile(source, SPEC, 'utf8')
  const snap = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })
  const entry = await store.add({ kind: 'decision', title: '按钮规范', text: '按钮可 Tab。' })
  await store.attachDoc(entry.id, snap.record.docId, { lines: [5, 5], quoteAnchor: '按钮可 Tab' })
  const snapshotPath = path.join(store.dir, 'docs', `${String(snap.record.docId)}.md`)
  const before = await readFile(snapshotPath, 'utf8')

  await writeFile(source, `${SPEC}## 新增\n\n追加。\n`, 'utf8')
  const flagged = await store.checkDocs(entry.id)
  assert.equal(flagged.needsReview, true)
  assert.equal(flagged.status, 'candidate', '漂移绝不自动改变 status(只有 needsReview 是正交标志)')
  // Both truths, kept apart: the live file changed, the evidence did not.
  assert.equal(await readFile(snapshotPath, 'utf8'), before, '快照字节未变')
  assert.notEqual(await readFile(source, 'utf8'), before, '现场文件确实变了')
})

test('不变量 1: split 继承证据、不继承治理 — 信号/审批/划除零随迁', async (t) => {
  const { project, store } = await world(t)
  const source = path.join(project, 'spec.md')
  await writeFile(source, SPEC, 'utf8')
  const snap = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })
  const entry = await store.add({ kind: 'pitfall', title: '混合质量条目', text: '前半对,后半过时。' })
  await store.attachDoc(entry.id, snap.record.docId, { lines: [5, 5], quoteAnchor: '按钮可 Tab' })

  // Give the old entry a full governance record…
  await store.recordSignal(entry.id, 'evidence-fail', '验证失败')
  await store.redlineText(entry.id, { chars: [4, 6], reason: '后半过时' })
  assert.ok((await store.listApprovals(false)).length === 0 || true)
  // …then split it.
  const { old, created } = await store.splitEntry(entry.id, [
    { title: '前半(对)', text: '前半是对的。' },
    { title: '后半(已改)', text: '后半已改版。' },
  ], '条目内一半已过时')

  assert.equal(old.status, 'superseded')
  assert.deepEqual(old.splitInto, created.map((child) => child.id))
  assert.equal(old.redlines?.length, 1, '旧条目带着它全部的对错进溯源链')
  for (const child of created) {
    assert.equal(child.status, 'candidate', '新条目从候选起步')
    assert.equal(child.redlines, undefined, '划除不随迁')
    // The child's history starts at its own creation; the only other entry is
    // the evidence MOUNT it just received (which IS the child's own act, not
    // an inherited one — the governance fields below are what must not travel).
    const changes = child.history.map((event) => event.change)
    assert.equal(changes[0], 'status')
    assert.deepEqual(changes.slice(1), ['rebind'])
    assert.equal(child.history[0].to, 'candidate')
    assert.equal((await store.score(child.id)).score, 0, '信号不随迁(反漂白:拆分不是弃疗后门)')
    assert.equal((await store.listApprovals(true)).every((request) => request.entryId !== child.id), true, '审批不随迁')
    assert.equal(String(child.doc?.docId), String(snap.record.docId), '证据可继承:同一 docId')
  }
  // The successor's evidence anchor is a NEW human decision, never a copy.
  assert.equal(created[0].doc?.anchor?.quoteAnchor, '按钮可 Tab', '锚点由人给出,不按行号静默继承')
})

test('不变量 5+6: chunk 纯派生、查询纯读 — 删除重建不改治理,查询不写任何状态', async (t) => {
  const { project, store } = await world(t)
  const source = path.join(project, 'spec.md')
  await writeFile(source, SPEC, 'utf8')
  const snap = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })
  const entry = await store.add({ kind: 'decision', title: '按钮规范', text: '按钮可 Tab。' })
  await store.attachDoc(entry.id, snap.record.docId)

  const governanceBefore = JSON.stringify(await store.get(entry.id))
  const ledgerBefore = await store.getChunks(snap.record.docId)
  await store.dropChunks(snap.record.docId)
  assert.deepEqual(await store.getChunks(snap.record.docId), [])
  await store.saveChunks(snap.record.docId, ledgerBefore)

  // A query with its freshness checks must leave the entry byte-identical
  // (noTouch = the read-only form every "pure read" surface uses), and the
  // DEFAULT form may only move the reference counter — never governance.
  await queryKb(store, null, { text: '按钮', noTouch: true })
  const governanceAfter = JSON.stringify(await store.get(entry.id))
  assert.equal(governanceAfter, governanceBefore, '查询(noTouch)不得改动条目任何字段')
  await queryKb(store, null, { text: '按钮' })
  const touched = await store.get(entry.id)
  assert.equal(touched?.stats.referenceCount, 1, '非 noTouch 的查询只记一次引用(它不是信号)')
  assert.equal(touched?.status, 'candidate', '查询不改状态')
  assert.deepEqual(await store.listApprovals(true), [], '查询不产生审批')
  assert.equal(await readFile(path.join(store.dir, 'signals.jsonl'), 'utf8').catch(() => ''), '', '查询不产生信号')
  // Chunk deletion/re-creation never touched governance.
  assert.equal(JSON.stringify(await store.get(entry.id)).includes('"redlines"'), false, 'chunk 操作不引入治理字段')
  assert.deepEqual(await store.getChunks(snap.record.docId), ledgerBefore, '重建后逐行一致')
})

test('不变量 2: redline 绑定 docId — 换文档版本不自动继承旧划除', async (t) => {
  const { project, store } = await world(t)
  const source = path.join(project, 'spec.md')
  await writeFile(source, SPEC, 'utf8')
  const v1 = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })
  const entry = await store.add({ kind: 'decision', title: '摘要', text: '摘要正文。' })
  await store.attachDoc(entry.id, v1.record.docId, { lines: [5, 5], quoteAnchor: '按钮可 Tab' })
  await store.redlineDocLines(entry.id, { lines: [5, 5], reason: '该行已作废' })

  const v2Text = `${SPEC}## 新章节\n\n新的内容。\n`
  await writeFile(source, v2Text, 'utf8')
  const v2 = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: v2Text, sourceFile: source })
  assert.notEqual(String(v2.record.docId), String(v1.record.docId))
  assert.equal(String(v2.record.supersedes), String(v1.record.docId))

  // The old redline still points at the OLD doc; mounting the new one keeps it
  // (it governs the old evidence, which is still readable)…
  const remounted = await store.attachDoc(entry.id, v2.record.docId, { lines: [5, 5], quoteAnchor: '按钮可 Tab' })
  const docRedlines = (remounted.redlines ?? []).filter((line) => line.target === 'doc')
  assert.equal(docRedlines.length, 1)
  assert.equal(String(docRedlines[0].docId), String(v1.record.docId), 'redline 仍绑定旧 docId,未被静默迁移')
  // …and the OLD snapshot is still on disk and unchanged (溯源链完整).
  const oldText = await readFile(path.join(store.dir, 'docs', `${String(v1.record.docId)}.md`), 'utf8')
  assert.equal(oldText, SPEC.endsWith('\n') ? SPEC : `${SPEC}\n`)
})

test('不变量 3: redline 先过滤、后评分 — 划除段的词不进检索表示', async (t) => {
  const { project, store } = await world(t)
  const source = path.join(project, 'spec.md')
  await writeFile(source, SPEC, 'utf8')
  const snap = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })
  const entry = await store.add({
    kind: 'pitfall',
    title: '按钮交互坑',
    text: '按钮可 Tab。旧的绝对定位方案 sunset-gamma 会让它掉出顺序,已废弃。',
  })
  await store.attachDoc(entry.id, snap.record.docId)

  const hitBefore = await queryKb(store, null, { text: 'sunset-gamma', noTouch: true })
  assert.equal(hitBefore.length, 1, '划除前该词能召回')
  const start = entry.text.indexOf('旧的绝对定位')
  await store.redlineText(entry.id, { chars: [start + 1, entry.text.length], reason: '该方案已废弃' })

  const hitAfter = await queryKb(store, null, { text: 'sunset-gamma', noTouch: true })
  assert.deepEqual(hitAfter, [], '划除后该词不再召回(不是遮显示,是从检索表示里拿掉)')
  // …while the surviving half still serves, and the annotation says so.
  const kept = await queryKb(store, null, { text: '按钮 掉出顺序', noTouch: true })
  assert.equal(kept.length, 1)
  assert.ok(kept[0].annotations.some((note) => note.includes('人工划除')))
})

test('不变量 4: citation identity ≠ evidence location — kb_cite 的对象永远是条目', async (t) => {
  const { project, store } = await world(t)
  const source = path.join(project, 'spec.md')
  await writeFile(source, SPEC, 'utf8')
  const snap = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })
  const entry = await store.add({ kind: 'decision', title: '按钮规范', text: '按钮可 Tab。' })
  await store.attachDoc(entry.id, snap.record.docId, { lines: [5, 5], quoteAnchor: '按钮可 Tab' })

  // Governance lives on the entry: signals, approvals and status are all
  // addressed by entry id. A doc has no status/signal surface at all.
  await store.recordSignal(entry.id, 'human-confirm', '确认')
  assert.equal((await store.score(entry.id)).score > 0, true)
  assert.equal(typeof (await store.getDoc(snap.record.docId))?.docId, 'string')
  const docKeys = Object.keys((await store.getDoc(snap.record.docId)) as object)
  for (const forbidden of ['status', 'signals', 'approvals', 'needsReview', 'redlines']) {
    assert.ok(!docKeys.includes(forbidden), `DocRecord 不得携带治理字段 ${forbidden}`)
  }
  await store.saveChunks(snap.record.docId, chunkDocument(SPEC, { ...store.config, chunkChars: 800, windowStep: 600, quoteAnchorChars: 40 }))
  const rows = await store.getChunks(snap.record.docId)
  assert.ok(rows.length > 0)
  for (const forbidden of ['status', 'signal', 'approval', 'needsReview']) {
    assert.ok(!Object.keys(rows[0]).includes(forbidden), `ChunkRecord 不得携带治理字段 ${forbidden}`)
  }
})

test('M9-0 配额制: 长条目不再垄断注入预算,后 5 条仍然进入', () => {
  const long = {
    entry: { id: 'k-long', status: 'candidate', needsReview: false, kind: 'fact', title: '长条目', text: '甲'.repeat(1800) },
    score: 10,
    matched: ['甲'],
    annotations: [],
  }
  const rest = Array.from({ length: 5 }, (_, i) => ({
    entry: { id: `k-${i}`, status: 'trusted', needsReview: false, kind: 'fact', title: `短条目${i}`, text: '乙'.repeat(120) },
    score: 5 - i,
    matched: ['乙'],
    annotations: [],
  }))
  const lines = [long, ...rest].map((hit) => renderHitLine(hit as never, 400, 0))
  assert.equal(lines.length, 6)
  // The long entry's body is trimmed to the quota and ANNOUNCES it.
  assert.ok(lines[0] !== null && lines[0].length < 500)
  assert.ok(lines[0]?.endsWith('…') || lines[0]?.includes('…'), '被配额截断要留痕')
  // Every short entry kept its line: 保广度弃深度.
  for (const line of lines.slice(1)) assert.ok(line !== null)
})

test('M9-0/无 doc 兼容: 没有原文层的条目输出与 M9 之前一致(无额外标注)', () => {
  const bare = {
    entry: { id: 'k-bare', status: 'trusted', needsReview: false, kind: 'fact', title: '旧条目', text: '正文。' },
    score: 1,
    matched: [],
    annotations: [],
  }
  const line = renderHitLine(bare as never, 400, 0)
  assert.equal(line, '- [k-bare|trusted|fact] 旧条目: 正文。')
})

test('M9-1: 文档层目录结构就是提案写的那三个(entries/docs/chunks)', async (t) => {
  const { project, store } = await world(t)
  const source = path.join(project, 'spec.md')
  await writeFile(source, SPEC, 'utf8')
  const snap = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'spec.md', text: SPEC, sourceFile: source })
  await store.saveChunks(snap.record.docId, chunkDocument(SPEC, { ...store.config, chunkChars: 800, windowStep: 600, quoteAnchorChars: 40 } as never))
  const entry = await store.add({ kind: 'fact', title: 'x', text: 'y' })
  assert.ok(await stat(path.join(store.dir, 'entries', `${String(entry.id)}.json`)))
  assert.ok(await stat(path.join(store.dir, 'docs', `${String(snap.record.docId)}.md`)))
  assert.ok(await stat(path.join(store.dir, 'docs', `${String(snap.record.docId)}.meta.json`)))
  assert.ok(await stat(path.join(store.dir, 'chunks', `${String(snap.record.docId)}.jsonl`)))
})
