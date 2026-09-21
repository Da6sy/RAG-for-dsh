/**
 * M9-4 lifecycle tests: redline's threshold act, split's superseded state, and
 * the sweep's treatment of a terminal provenance state.
 *
 * The acceptance lines from the proposal's roadmap (§10 M9-4) are the test
 * names here: 划除段不再被检索命中也不显示 · >40% 触发拆分提案入队 · split 后
 * 旧条 superseded 检索隐身、新条候选起步、信号零随迁 · superseded 不被 sweep 清退.
 *
 * @module @clue-harness/kb/test/superseded
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  applyTransition,
  canTransition,
  entryTextAfterRedlines,
  openGlobalStore,
  openProjectStore,
  queryKb,
  transitionTable,
  type KbStore,
} from '../src/index.ts'
import { suggestGeneralizations } from '@clue-harness/kb-loop'

async function world(t: { after(fn: () => unknown): void }): Promise<{ root: string; project: string; store: KbStore; global: KbStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-sup-'))
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

test('状态机: superseded 只能由 split 到达,且没有出边(终态)', () => {
  assert.equal(canTransition('trusted', 'superseded', 'split'), true)
  assert.equal(canTransition('candidate', 'superseded', 'split'), true)
  assert.equal(canTransition('expired', 'superseded', 'split'), true)
  assert.equal(canTransition('discarded', 'superseded', 'split'), false, '已遗弃的条目不再拆分')
  // Only the split trigger reaches it — no other trigger may.
  for (const trigger of ['expire-idle', 'strong-negative', 'reactivate', 'rescue', 'approve-promote', 'human-retire'] as const) {
    assert.equal(canTransition('trusted', 'superseded', trigger), false, `${trigger} 不得到达 superseded`)
  }
  // Terminal: no out-edges at all.
  assert.deepEqual(transitionTable().filter((edge) => edge.from === 'superseded'), [])
  assert.throws(
    () => applyTransition(
      { status: 'superseded' } as never,
      'candidate',
      'rescue',
      'x',
    ),
    /非法状态迁移/,
  )
})

test('M9-4: 划除段不再被检索命中;条目其余部分照常服役', async (t) => {
  const { store } = await world(t)
  const entry = await store.add({
    kind: 'pitfall',
    title: '按钮可访问性',
    text: '按钮必须可被 Tab 选中。旧的绝对定位方案 shadow-legacy 会让按钮掉出 Tab 顺序,已废弃。',
  })
  const legacyStart = entry.text.indexOf('旧的绝对定位')
  const { entry: redlined, ratio, proposal } = await store.redlineText(entry.id, {
    chars: [legacyStart + 1, entry.text.length],
    reason: '绝对定位方案已废弃',
  })
  assert.equal(redlined.redlines?.length, 1)
  assert.equal(redlined.status, 'candidate', '划除不改状态(它是显示/评分过滤,不是生命周期事件)')
  assert.ok(ratio > 0.4, `本例划除占比应过 40%,实际 ${ratio}`)
  assert.equal(proposal?.action, 'redline-review', '过阈值即入队提案(系统提议,人执行)')

  assert.deepEqual(await queryKb(store, null, { text: 'shadow-legacy', noTouch: true }), [], '被划除的词不再召回')
  const kept = await queryKb(store, null, { text: 'Tab 选中', noTouch: true })
  assert.equal(kept.length, 1, '未被划除的正文继续参与检索')
  assert.ok(kept[0].annotations.some((note) => note.includes('人工划除')), '命中必须自报家门:该条含划除段')
  // The raw body still LIVES in the entry (governance must be auditable —
  // `clue kb show` prints it verbatim) but no RETURN path may hand it back
  // unfiltered: that is 划除's "不只遮显示" half.
  const raw = await store.get(entry.id)
  assert.match(raw?.text ?? '', /shadow-legacy/, '条目原文保留被划除内容,便于人工复核')
  assert.match(entryTextAfterRedlines(raw!), /\[…\]/, '过滤后的文本用空缺标记被划除处')
  assert.doesNotMatch(entryTextAfterRedlines(raw!), /shadow-legacy/)
})

test('M9-4: 划除占比 >40% 自动入队 redline-review 提案(系统提议,人执行)', async (t) => {
  const { store } = await world(t)
  const entry = await store.add({
    kind: 'decision',
    title: '混合质量条目',
    text: '甲'.repeat(50) + '乙'.repeat(50),
  })
  const first = await store.redlineText(entry.id, { chars: [1, 30], reason: '第一段过时' })
  assert.equal(first.proposal, null, '30% 不触发')
  const second = await store.redlineText(entry.id, { chars: [31, 60], reason: '第二段也过时' })
  assert.ok(second.proposal !== null, '60% 必须触发提案')
  assert.equal(second.proposal.action, 'redline-review')
  assert.match(second.proposal.reason, /建议拆分或遗弃/)
  const queue = await store.listApprovals(true)
  assert.equal(queue.length, 1)
  // Idempotent: a third redline does not stack a second identical proposal.
  const third = await store.redlineText(entry.id, { chars: [61, 70], reason: '第三段过时' })
  assert.equal(third.proposal?.id, second.proposal.id)
  assert.equal((await store.listApprovals(true)).length, 1)
  // Resolving the advisory request changes NO entry state.
  const { entry: after } = await store.resolveApproval(second.proposal.id, true)
  assert.equal(after, null)
  const current = await store.get(entry.id)
  assert.equal(current?.status, 'candidate', '提案通过≠自动拆弃(人权仍在人手里)')
  assert.equal(current?.redlines?.length, 3)
})

test('M9-4: split 后旧条 superseded 检索隐身、新条候选起步、信号零随迁', async (t) => {
  const { store } = await world(t)
  const entry = await store.add({
    kind: 'pitfall',
    title: '按钮交互坑',
    text: '按钮要可 Tab;旧的绝对定位做法已废弃。',
  })
  await store.recordSignal(entry.id, 'evidence-pass', '验证通过一次')
  await store.recordSignal(entry.id, 'human-confirm', '人确认')
  const scoreBefore = (await store.score(entry.id)).score
  assert.ok(scoreBefore > 0)

  const { old, created } = await store.splitEntry(entry.id, [
    { title: '按钮要可 Tab', text: '按钮必须可被 Tab 选中。' },
    { title: '旧方案已废弃', text: '绝对定位做法已废弃。' },
  ], '条目内一半过时')

  assert.equal(old.status, 'superseded')
  assert.equal(old.stats.referenceCount, 0, 'stats 定格(拆分不增加引用)')
  assert.deepEqual(old.splitInto?.length, 2)

  const hits = await queryKb(store, null, { text: '按钮 绝对定位', noTouch: true, includeExpired: true })
  assert.equal(hits.some((hit) => String(hit.entry.id) === String(entry.id)), false, 'superseded 检索隐身(即便 includeExpired)')
  assert.equal(hits.length, 2, '两条新知识接管了召回')
  for (const child of created) {
    assert.equal(child.status, 'candidate')
    assert.equal((await store.score(child.id)).score, 0, '信号不随迁')
  }
  // The provenance chain is intact: the old entry records where its knowledge went.
  const shown = await store.get(entry.id)
  assert.deepEqual(shown?.splitInto, created.map((child) => child.id))
  assert.ok(shown?.history.some((event) => event.change === 'status' && event.to === 'superseded'))
})

test('M9-4: superseded 不被 sweep 清退,也不会过期/discarded', async (t) => {
  const { store } = await world(t)
  const entry = await store.add({ kind: 'fact', title: '老知识', text: '内容。' })
  const { old } = await store.splitEntry(entry.id, [{ title: '新知识', text: '内容。' }], '拆分')
  assert.equal(old.status, 'superseded')

  // A sweep far in the future: every other state would expire/discard/purge,
  // superseded must survive untouched (溯源链必须永久).
  const future = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000)
  const result = await store.sweep(future)
  assert.equal(result.purged.length, 0, 'superseded 永不清退')
  assert.equal(result.expired.includes(old.id), false, 'superseded 不会过期')
  assert.equal(result.discarded.includes(old.id), false, 'superseded 不会被强负遗弃')
  assert.ok(await store.get(old.id) !== null, '条目仍在库里')
  assert.equal((await store.get(old.id))?.status, 'superseded')
})

test('M9-4: superseded 不参与泛化聚类(状态过滤天然挡住)', async (t) => {
  const { root, project, store } = await world(t)
  // Two projects with the SAME knowledge, both objectively verified…
  const otherRoot = path.join(root, 'proj2')
  await mkdir(otherRoot, { recursive: true })
  const other = await openProjectStore(otherRoot, path.join(root, 'home'))
  const seed = await store.add({ kind: 'pitfall', title: '按钮别掉出 Tab 顺序', text: '按钮要可 Tab。' })
  await store.recordSignal(seed.id, 'evidence-pass', '验证通过')
  const twin = await other.add({ kind: 'pitfall', title: '按钮别掉出 Tab 顺序', text: '按钮要可 Tab。' })
  await other.recordSignal(twin.id, 'evidence-pass', '验证通过')

  // …and the first one is then split away.
  await store.splitEntry(seed.id, [{ title: '按钮别掉出 Tab 顺序', text: '按钮要可 Tab。' }], '改写')

  const scan = await suggestGeneralizations({ home: path.join(root, 'home'), dryRun: true })
  const sources = scan.proposals.flatMap((proposal) => proposal.sources.map((source) => source.entryId))
  assert.equal(sources.includes(String(seed.id)), false, 'superseded 不参与聚类')
  void project
})

test('M9-4: 阈值提案也覆盖原文层划除(按行数计占比)', async (t) => {
  const { project, store } = await world(t)
  const { ingestSnapshot } = await import('../src/index.ts')
  const { writeFile } = await import('node:fs/promises')
  const text = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 行内容。`).join('\n') + '\n'
  const source = path.join(project, 'doc.md')
  await writeFile(source, text, 'utf8')
  const snap = await ingestSnapshot({ kbDir: store.dir, sourcePath: 'doc.md', text, sourceFile: source })
  const entry = await store.add({ kind: 'decision', title: '文档摘要', text: '摘要。' })
  await store.attachDoc(entry.id, snap.record.docId)

  const small = await store.redlineDocLines(entry.id, { lines: [1, 2], reason: '两行过时' })
  assert.equal(small.proposal, null, '2/10 不触发')
  const big = await store.redlineDocLines(entry.id, { lines: [3, 8], reason: '六行过时' })
  assert.ok(big.proposal !== null, '8/10 触发')
  assert.equal(big.proposal.action, 'redline-review')
})
