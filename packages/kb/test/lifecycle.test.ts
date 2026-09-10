/**
 * Lifecycle tests: sweep (expire / strong-negative discard / 60-day purge)
 * and the batched approval flow (suggest → approve/reject), the M2 acceptance
 * "state machine runs on real files" suite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openProjectStore, type KbStore } from '../src/index.ts'

const NOW = new Date('2026-09-10T00:00:00.000Z')
const daysAgo = (n: number, from: Date = NOW): string => new Date(from.getTime() - n * 24 * 60 * 60 * 1000).toISOString()

async function lab(): Promise<{ root: string; store: KbStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-life-'))
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, '.keep'), '', 'utf8')
  return { root, store: await openProjectStore(project, path.join(root, 'home')) }
}

test('sweep expires idle knowledge (default 90 days unreferenced)', async (t) => {
  const { root, store } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const idle = await store.add({ kind: 'fact', title: '陈年旧事', text: '很久没人引用了。' }, daysAgo(100))
  const fresh = await store.add({ kind: 'fact', title: '新知识', text: '刚刚入库。' }, daysAgo(1))
  const referenced = await store.add({ kind: 'fact', title: '老而常新', text: '入库很久但一直被引用。' }, daysAgo(100))
  await store.touch(referenced.id, daysAgo(2))

  const result = await store.sweep(NOW)
  assert.deepEqual(result.expired, [idle.id])
  assert.equal((await store.get(idle.id))?.status, 'expired')
  assert.equal((await store.get(fresh.id))?.status, 'candidate')
  assert.equal((await store.get(referenced.id))?.status, 'candidate', '最近被引用过的老条目不得过期')
})

test('sweep discards on SUSTAINED strong negative WITHOUT a queue (entering is machine-driven)', async (t) => {
  const { root, store } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const rejected = await store.add({ kind: 'fact', title: '错误知识', text: '用户反复说不对。' })
  // Threshold ±20: one rejection (-6) must NOT discard; four (-24) must.
  await store.recordSignal(rejected.id, 'user-reject', '第一次说不对', daysAgo(3))
  let mid = await store.sweep(NOW)
  assert.deepEqual(mid.discarded, [], '单次否定不得遗弃(阈值 ±20 的含义)')
  await store.recordSignal(rejected.id, 'user-reject', '第二次', daysAgo(2))
  await store.recordSignal(rejected.id, 'user-reject', '第三次', daysAgo(1))
  await store.recordSignal(rejected.id, 'user-reject', '第四次', daysAgo(0))
  const result = await store.sweep(NOW)
  assert.deepEqual(result.discarded, [rejected.id])
  const entry = await store.get(rejected.id)
  assert.equal(entry?.status, 'discarded')
  assert.equal(entry?.discardedAt, NOW.toISOString())
})

test('decision #11: discarded entries purge after 60 days, not before', async (t) => {
  const { root, store } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const old = await store.add({ kind: 'fact', title: '早该清退', text: 'x' })
  await store.transition(old.id, 'discarded', 'strong-negative', '测试', daysAgo(61))
  const recent = await store.add({ kind: 'fact', title: '还在保留期', text: 'y' })
  await store.transition(recent.id, 'discarded', 'strong-negative', '测试', daysAgo(59))

  const result = await store.sweep(NOW)
  assert.deepEqual(result.purged, [old.id])
  assert.equal(await store.get(old.id), null, '清退=事实文件删除')
  assert.notEqual(await store.get(recent.id), null, '保留期内不得清退')
  // Rescue still works inside the retention window.
  const rescued = await store.transition(recent.id, 'candidate', 'rescue', '人工捞回')
  assert.equal(rescued.status, 'candidate')
  assert.equal(rescued.discardedAt, null)
})

test('promotion is a queued human decision: suggest → approve → trusted (+human signal)', async (t) => {
  const { root, store } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const entry = await store.add({ kind: 'pitfall', title: '被验证过的坑', text: '多次帮到忙。' })
  // Threshold 20: a mixed evidence basket — 3×human(15) + 2×evidence(6) = 21.
  await store.recordSignal(entry.id, 'human-confirm', '第一次确认', daysAgo(5))
  await store.recordSignal(entry.id, 'human-confirm', '第二次确认', daysAgo(4))
  await store.recordSignal(entry.id, 'human-confirm', '第三次确认', daysAgo(3))
  await store.recordSignal(entry.id, 'evidence-pass', 'render_assert 通过', daysAgo(2))
  await store.recordSignal(entry.id, 'evidence-pass', 'render_assert 通过', daysAgo(1))

  const first = await store.sweep(NOW)
  assert.equal(first.promotions.length, 1)
  const request = first.promotions[0]
  assert.equal(request.action, 'promote')
  assert.equal(request.scoreAtRequest, 21)
  assert.equal((await store.get(entry.id))?.status, 'candidate', '建议≠提升:必须等人批')

  // Sweeping again must not duplicate the pending request.
  const second = await store.sweep(NOW)
  assert.equal(second.promotions.length, 0)

  const resolved = await store.resolveApproval(request.id, true)
  assert.equal(resolved.entry?.status, 'trusted')
  const score = await store.score(entry.id)
  assert.ok(score.score >= 21 + store.config.weights.human, '批准本身是最强正信号,应入账')
})

test('rejecting a promote records NO negative signal and quiets re-suggestion within the window', async (t) => {
  const { root, store } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const entry = await store.add({ kind: 'decision', title: '有争议的决策', text: '分数够但人不同意。' })
  // 4×human = 20 ≥ 阈值 20:够格被建议,但人可以选择不同意。
  await store.recordSignal(entry.id, 'human-confirm', '', daysAgo(4))
  await store.recordSignal(entry.id, 'human-confirm', '', daysAgo(3))
  await store.recordSignal(entry.id, 'human-confirm', '', daysAgo(2))
  await store.recordSignal(entry.id, 'human-confirm', '', daysAgo(1))
  const swept = await store.sweep(NOW)
  assert.equal(swept.promotions.length, 1)

  const before = await store.score(entry.id)
  await store.resolveApproval(swept.promotions[0].id, false)
  const after = await store.score(entry.id)
  assert.equal(after.score, before.score, '否决提升 ≠ 否定知识:不得记负信号')
  assert.equal((await store.get(entry.id))?.status, 'candidate')

  // Not re-suggested while the rejection is inside the window.
  const again = await store.sweep(NOW)
  assert.equal(again.promotions.length, 0)
})

test('double resolution of one request is refused (single-shot decisions)', async (t) => {
  const { root, store } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const entry = await store.add({ kind: 'fact', title: 'q', text: 'q' })
  const request = await store.requestApproval(entry.id, 'promote', '测试', 99)
  await store.resolveApproval(request.id, true)
  await assert.rejects(() => store.resolveApproval(request.id, true), /已被处理/)
})
