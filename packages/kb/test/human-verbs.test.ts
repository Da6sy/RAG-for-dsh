/**
 * The lifecycle 人权入口: promote (candidate → trusted), retire (→ expired),
 * reactivate (expired → candidate) and rescue (discarded → candidate).
 *
 * The gap these pin down: every one of those decisions existed ONLY as a queue
 * resolution — and the queue only holds EVIDENCE-driven proposals
 * (`suggestPromotions` needs `windowScore ≥ trustThreshold`, and a never-cited
 * entry scores 0 forever). A human looking at 23 candidates, or at an expired
 * entry worth reviving, had no verb at all (CLI only had `approve <requestId>`,
 * which needs a queued request to exist first). The library could sit at
 * candidate — or at expired — forever.
 *
 * Asserted from store truth (entry file + signal ledger + approvals.json), not
 * from echoes: each act must leave the shape its queue-approved twin leaves,
 * must refuse the statuses that have their own edge, and must never let the
 * queue keep displaying a decision the human already made.
 *
 * @module @clue-harness/kb/test/human-verbs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  KbEntryId,
  openGlobalStore,
  openProjectStore,
  readSignals,
  type KbStore,
} from '../src/index.ts'

/** One temp home with both tiers opened (the house test lab). */
async function lab(): Promise<{ root: string; projectStore: KbStore; globalStore: KbStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-kb-human-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, '.keep'), '', 'utf8')
  return {
    root,
    projectStore: await openProjectStore(project, home),
    globalStore: await openGlobalStore(home),
  }
}

test('promote: 候选 → 可信,理由进履历,并记下 human-confirm 信号', async (t) => {
  const { root, projectStore } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const entry = await projectStore.add({
    kind: 'decision',
    title: '中心库位置',
    text: '项目库在 <home>/kb/<工作区键>,工作区目录里零残留。',
  })
  assert.equal(entry.status, 'candidate')

  const { entry: trusted, requests } = await projectStore.promote(entry.id, { by: 'web', reason: '三条独立证据核对过' })
  assert.equal(trusted.status, 'trusted')
  assert.deepEqual(requests, [], '没有在队请求时不做多余动作')

  const last = trusted.history[trusted.history.length - 1]
  assert.equal(last.change, 'status')
  assert.equal(last.from, 'candidate')
  assert.equal(last.to, 'trusted')
  assert.match(last.reason, /^approve-promote: 人工提升为可信\(web\): 三条独立证据核对过$/)

  // Same ledger shape as approving a queued promote: human-confirm is the
  // strongest positive and the approval IS that positive (weights.human).
  const ledger = await readSignals(path.join(projectStore.dir, 'signals.jsonl'))
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].source, 'human')
  assert.equal(ledger[0].polarity, 'positive')
  assert.match(ledger[0].note, /human-confirm: 人工提升为可信\(web\)/)
  const score = await projectStore.score(entry.id)
  assert.equal(score.counted, 1)
  assert.equal(score.negative, 0)
  assert.equal(score.score, ledger[0].weight, '窗口分就是这条人工确认的权重')
  assert.ok(score.score > 0)

  // It is on disk, and retrieval now sees a trusted entry.
  assert.equal((await projectStore.get(entry.id))?.status, 'trusted')
  assert.equal((await projectStore.list({ status: 'trusted' })).length, 1)
})

test('promote: 理由可留空,但入口(by)永远被记下', async (t) => {
  const { root, projectStore } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = await projectStore.add({ kind: 'fact', title: '无理由', text: '人不必解释每一次判断。' })
  const { entry: trusted } = await projectStore.promote(entry.id, { by: 'cli', reason: '   ' })
  assert.equal(trusted.status, 'trusted')
  assert.match(trusted.history.at(-1)?.reason ?? '', /^approve-promote: 人工提升为可信\(cli\)$/)
})

test('promote: 结清在队的提升请求(队列不留"已经做过的决定")', async (t) => {
  const { root, projectStore } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = await projectStore.add({ kind: 'pitfall', title: '候选', text: '窗口分达标会入队一条提升请求。' })
  const queued = await projectStore.requestApproval(entry.id, 'promote', '窗口分数 99 ≥ 20(多次成功引用)', 99)
  // An unrelated advisory request must survive the same act untouched.
  const advisory = await projectStore.requestApproval(entry.id, 'redline-review', '已划除 60%', 0)
  assert.equal((await projectStore.listApprovals(true)).length, 2)

  const { entry: trusted, requests } = await projectStore.promote(entry.id, { by: 'web', reason: '人直接提升' })
  assert.equal(trusted.status, 'trusted')
  assert.deepEqual(requests.map((r) => r.id), [queued.id])
  assert.equal(requests[0].resolution, 'approved')
  assert.ok(requests[0].resolvedAt !== null)

  const pending = await projectStore.listApprovals(true)
  assert.deepEqual(pending.map((r) => r.id), [advisory.id], '只结清提升请求,不碰建议类请求')
  // The settled request is done: resolving it again reports that honestly
  // instead of attempting an illegal trusted → trusted transition.
  await assert.rejects(() => projectStore.resolveApproval(queued.id, true), /已被处理/)
})

test('promote: 只有候选能提升——其它状态各有自己的边,不给捷径', async (t) => {
  const { root, projectStore } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const entry = await projectStore.add({ kind: 'fact', title: '状态守卫', text: '提升不是万能钥匙。' })
  await projectStore.promote(entry.id, { by: 'cli' })
  await assert.rejects(
    () => projectStore.promote(entry.id, { by: 'cli' }),
    /只有候选能提升为可信,当前是 trusted/,
  )

  const expiring = await projectStore.add({ kind: 'fact', title: '会过期的', text: '长期未引用会过期。' })
  await projectStore.transition(expiring.id, 'expired', 'expire-idle', '测试:闲置过期')
  await assert.rejects(
    () => projectStore.promote(expiring.id, { by: 'cli' }),
    /当前是 expired.*reverify/,
  )
  assert.equal((await projectStore.get(expiring.id))?.status, 'expired', '失败不得改状态')

  const discarded = await projectStore.add({ kind: 'fact', title: '会遗弃的', text: '强负信号会遗弃。' })
  await projectStore.transition(discarded.id, 'discarded', 'strong-negative', '测试:强负遗弃')
  await assert.rejects(
    () => projectStore.promote(discarded.id, { by: 'cli' }),
    /当前是 discarded/,
  )

  // A missing id is the store's honest not-found, never a silent create.
  await assert.rejects(() => projectStore.promote(KbEntryId('k-nope-000000'), { by: 'cli' }), /条目不存在/)
})

test('promote: 全局库同样可用(人权入口不是项目库特权)', async (t) => {
  const { root, globalStore } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = await globalStore.add({ kind: 'decision', title: '跨项目纪律', text: '全局条目也要人能提升。' })
  const { entry: trusted } = await globalStore.promote(entry.id, { by: 'cli', reason: '两个项目都验证过' })
  assert.equal(trusted.status, 'trusted')
  assert.equal(trusted.tier, 'global')
  assert.ok((await globalStore.score(entry.id)).score > 0)
})

test('retire: 候选/可信 → 过期,必须带理由,并撤掉 ⚑ 标记', async (t) => {
  const { root, projectStore } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const entry = await projectStore.add({ kind: 'decision', title: '已改版的约定', text: '旧接口约定。' })
  await projectStore.flagNeedsReview(entry.id, '绑定文件已变')
  assert.equal((await projectStore.get(entry.id))?.needsReview, true)

  // A verdict without its why is refused outright — the history line is the
  // only place a later reader can learn why the entry left the write-basis.
  await assert.rejects(() => projectStore.retire(entry.id, { by: 'web' }), /必须留下理由/)
  await assert.rejects(() => projectStore.retire(entry.id, { by: 'web', reason: '   ' }), /必须留下理由/)
  assert.equal((await projectStore.get(entry.id))?.status, 'candidate', '被拒的判定不得改状态')

  const { entry: retired } = await projectStore.retire(entry.id, { by: 'web', reason: '组件已改版为 ds-button v2' })
  assert.equal(retired.status, 'expired')
  assert.equal(retired.needsReview, false, '判定"不再成立"后不该再挂"可能过时"')
  assert.equal(retired.reviewReason, null)
  const reasons = retired.history.map((event) => event.reason).join(' | ')
  assert.match(reasons, /human-retire: 人工判定不再成立\(web\): 组件已改版为 ds-button v2/)
  // The flag is cleared through its own audited event, not silently dropped.
  assert.ok(
    retired.history.some((event) => event.change === 'reviewCleared' && /人工判定不再成立/.test(event.reason)),
    `履历里应有撤标记事件: ${reasons}`,
  )
  // Retiring is NOT discarding: 过期仍可读、可复归,零负信号。
  const ledger = await readSignals(path.join(projectStore.dir, 'signals.jsonl'))
  assert.deepEqual(ledger, [], '人工判定不再成立不记信号(它不是"知识错了"的证据)')

  // A trusted entry can be retired too (the edge covers both).
  const trusted = await projectStore.add({ kind: 'fact', title: '曾可信', text: 'x' })
  await projectStore.promote(trusted.id, { by: 'cli' })
  const { entry: retiredTrusted } = await projectStore.retire(trusted.id, { by: 'web', reason: '新规范取代' })
  assert.equal(retiredTrusted.status, 'expired')
})

test('retire: 已退出/已拆分/不存在都拒绝,且不改状态', async (t) => {
  const { root, projectStore } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const discarded = await projectStore.add({ kind: 'fact', title: '已遗弃', text: 'x' })
  await projectStore.transition(discarded.id, 'discarded', 'strong-negative', '测试')
  await assert.rejects(
    () => projectStore.retire(discarded.id, { by: 'cli', reason: 'r' }),
    /只有候选\/可信能人工判定不再成立,当前是 discarded/,
  )

  const superseded = await projectStore.add({ kind: 'fact', title: '已拆分', text: 'x' })
  await projectStore.splitEntry(superseded.id, [{ title: '后继', text: 'y' }], '测试拆分')
  await assert.rejects(
    () => projectStore.retire(superseded.id, { by: 'cli', reason: 'r' }),
    /已拆分条目是历史/,
  )

  await assert.rejects(() => projectStore.retire(KbEntryId('k-nope-000000'), { by: 'cli', reason: 'r' }), /条目不存在/)
})

test('reactivate/rescue: 退出现役的条目能被人拉回来,但只能回到候选', async (t) => {
  const { root, projectStore } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const expiring = await projectStore.add({ kind: 'fact', title: '过期的', text: 'x' })
  await projectStore.transition(expiring.id, 'expired', 'expire-idle', '超过 90 天未被引用')
  const { entry: revived, requests } = await projectStore.reactivate(expiring.id, { by: 'web', reason: '又被引用了' })
  assert.equal(revived.status, 'candidate', '回到候选,不是直接可信')
  assert.match(revived.history.at(-1)?.reason ?? '', /^reactivate: 人工重新激活\(web\): 又被引用了$/)
  assert.deepEqual(requests, [])

  const dead = await projectStore.add({ kind: 'fact', title: '遗弃的', text: 'x' })
  await projectStore.transition(dead.id, 'discarded', 'strong-negative', '测试遗弃')
  const { entry: rescued } = await projectStore.rescue(dead.id, { by: 'web' })
  assert.equal(rescued.status, 'candidate')
  assert.equal(rescued.discardedAt, null, '捞回后不再挂着遗弃时间(60 天清退倒计时停下)')
  assert.match(rescued.history.at(-1)?.reason ?? '', /^rescue: 人工捞回候选\(web\)$/)

  // Wrong statuses are refused with the honest hint, never coerced.
  await assert.rejects(() => projectStore.reactivate(dead.id, { by: 'cli' }), /只有过期条目能重新激活,当前是 candidate/)
  await assert.rejects(() => projectStore.rescue(expiring.id, { by: 'cli' }), /只有已遗弃条目能捞回,当前是 candidate/)
  await assert.rejects(() => projectStore.reactivate(KbEntryId('k-nope-000000'), { by: 'cli' }), /条目不存在/)
})

test('reactivate/rescue: 也结清在队的同名请求', async (t) => {
  const { root, projectStore } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const expiring = await projectStore.add({ kind: 'fact', title: '过期的', text: 'x' })
  await projectStore.transition(expiring.id, 'expired', 'expire-idle', '测试')
  const queued = await projectStore.requestApproval(expiring.id, 'reactivate', '人工复核重新激活', 0)
  const { entry: revived, requests } = await projectStore.reactivate(expiring.id, { by: 'web' })
  assert.equal(revived.status, 'candidate')
  assert.deepEqual(requests.map((r) => r.id), [queued.id])
  assert.deepEqual(await projectStore.listApprovals(true), [], '队列不留已做过的决定')

  const dead = await projectStore.add({ kind: 'fact', title: '遗弃的', text: 'x' })
  await projectStore.transition(dead.id, 'discarded', 'strong-negative', '测试')
  const queuedRescue = await projectStore.requestApproval(dead.id, 'rescue', '人工捞回', 0)
  const { requests: settled } = await projectStore.rescue(dead.id, { by: 'web' })
  assert.deepEqual(settled.map((r) => r.id), [queuedRescue.id])
  assert.deepEqual(await projectStore.listApprovals(true), [])
})
