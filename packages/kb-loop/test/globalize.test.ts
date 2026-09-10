/**
 * M5 engine tests — the global-library milestone (design §3.6, decision #14):
 * generalization proposals, failure propagation, tier-aware attribution, and
 * the stricter global discard bound. All against real temp-dir KBs; the
 * loops run with INJECTED inspections (loop.test's browser-free pattern).
 *
 * The headline test is the §7 M5 acceptance line, end to end:
 *   同一坑在两个项目各自验证 → 泛化提议(全局候选+promote 待批)
 *   → 人批 → 全局可信 → 第三个项目检索可见(带"来自全局库"标注)
 *   → 重复扫描不重复提案。
 *
 * @module @clue-harness/kb-loop/test/globalize
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  openGlobalStore,
  openProjectStore,
  queryKb,
  readSignals,
  type KbStore,
} from '@clue-harness/kb'
import type { InspectResult } from '@clue-harness/evidence-render'
import { buildWorkLog } from '../src/worklog.ts'
import { evidenceFailureStreak, runEvidenceLoop } from '../src/loop.ts'
import { overlapCoefficient, suggestGeneralizations } from '../src/generalize.ts'

function fakeInspection(exitOk: boolean): InspectResult {
  return {
    snapshot: null,
    snapshotText: '',
    baseline: null,
    stale: false,
    diff: exitOk
      ? { target: 'search.html', viewportChanged: false, entries: [], identical: true }
      : {
        target: 'search.html',
        viewportChanged: false,
        identical: false,
        entries: [{
          kind: 'interactive', moduleId: 'submit', label: '主区域 > 提交按钮',
          detail: '掉出 Tab 顺序(键盘不可达)', severity: 'error',
        }],
      },
    report: '',
    baselinePath: null,
    exitOk,
  }
}

/** One isolated world: two project roots + one shared KB home. */
async function world(t: { after(fn: () => unknown): void }): Promise<{
  root: string; home: string; projA: string; projB: string
  storeA: KbStore; storeB: KbStore; global: KbStore
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-m5-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const projA = path.join(root, 'projA')
  const projB = path.join(root, 'projB')
  await mkdir(projA, { recursive: true })
  await mkdir(projB, { recursive: true })
  return {
    root,
    home,
    projA,
    projB,
    storeA: await openProjectStore(projA, home),
    storeB: await openProjectStore(projB, home),
    global: await openGlobalStore(home),
  }
}

/** The same pitfall, project-flavored wording (overlap ≥ 0.5 by title). */
const PITFALL_A = { kind: 'pitfall' as const, title: '悬浮按钮别掉出 Tab 顺序', text: '本项目评审踩过三次:绝对定位的提交按钮必须检查键盘可达性。' }
const PITFALL_B = { kind: 'pitfall' as const, title: '悬浮按钮别掉出 Tab 顺序', text: '浮动胶囊按钮要保留焦点顺序,键盘用户必须能到达提交按钮。' }

test('overlapCoefficient: containment scores high, disjoint scores zero', () => {
  const short = new Set(['按钮', 'tab', '顺序'])
  const long = new Set(['按钮', 'tab', '顺序', '本项', '项目', '评审', '绝对', '对定', '定位'])
  // Containment: the short rule fully lives inside the detailed one.
  assert.equal(overlapCoefficient(short, long), 1)
  assert.equal(overlapCoefficient(long, short), 1)
  assert.equal(overlapCoefficient(new Set(), short), 0)
  assert.equal(overlapCoefficient(new Set(['对比度']), short), 0)
})

test('evidenceFailureStreak: trailing consecutive evidence negatives only', () => {
  const sig = (source: string, polarity: string) => ({ at: '', entryId: '' as never, source, polarity, weight: 0, note: '' })
  assert.equal(evidenceFailureStreak([sig('evidence', 'negative'), sig('evidence', 'negative')]), 2)
  // A pass in between resets the streak ("连续" means exactly that).
  assert.equal(evidenceFailureStreak([sig('evidence', 'negative'), sig('evidence', 'positive'), sig('evidence', 'negative')]), 1)
  // A trailing human signal breaks it too (a human word outranks the streak).
  assert.equal(evidenceFailureStreak([sig('evidence', 'negative'), sig('human', 'positive')]), 0)
  assert.equal(evidenceFailureStreak([]), 0)
})

test('M5 acceptance line: two projects verify the same pitfall → generalization proposal → approve → global trusted → third project sees it', async (t) => {
  const { root, home, storeA, storeB, global } = await world(t)

  // Project A: verified by objective evidence (an evidence-pass signal).
  const entryA = await storeA.add({ ...PITFALL_A, bindings: [] })
  await storeA.recordSignal(entryA.id, 'evidence-pass', '门禁复验通过')
  // Project B: verified by human trust (trusted status).
  const entryB = await storeB.add({ ...PITFALL_B, bindings: [] })
  await storeB.transition(entryB.id, 'trusted', 'approve-promote', '人工批准')

  const scan = await suggestGeneralizations({ home })
  assert.equal(scan.projectsScanned, 2)
  assert.equal(scan.proposals.length, 1, `应恰有一个泛化提议: ${JSON.stringify(scan.skipped)}`)
  const proposal = scan.proposals[0]
  assert.ok(proposal.created)
  assert.equal(proposal.sources.length, 2)
  assert.notEqual(proposal.sources[0].projectRoot, proposal.sources[1].projectRoot, '来源必须跨项目')

  // The global side: a CANDIDATE entry (决策 #21 — 泛化不直通可信) with an
  // auditable provenance, plus a promote request in the global queue.
  const created = await global.get(proposal.created.entry.id)
  assert.ok(created)
  assert.equal(created.tier, 'global')
  assert.equal(created.status, 'candidate')
  assert.equal(created.provenance.createdBy, 'generalization')
  assert.ok(created.provenance.note?.includes(String(entryA.id)), '溯源必须列出来源条目')
  assert.ok(created.provenance.note?.includes(String(entryB.id)))
  assert.deepEqual(created.bindings, [], '全局条目不绑定任何项目文件')
  assert.equal(proposal.created.request.action, 'promote')
  assert.match(proposal.created.request.reason, /泛化提议/)

  // Human approval promotes it (the existing queue machinery, zero new verbs).
  const resolved = await global.resolveApproval(proposal.created.request.id, true)
  assert.equal(resolved.entry?.status, 'trusted')

  // A third project retrieves it with the global-tier annotation.
  const projC = path.join(root, 'projC')
  await mkdir(projC, { recursive: true })
  const storeC = await openProjectStore(projC, home)
  const hits = await queryKb(storeC, global, { text: '悬浮按钮 Tab 顺序', noTouch: true })
  const globalHit = hits.find((hit) => hit.entry.id === created.id)
  assert.ok(globalHit, '第三个项目必须检索到泛化后的全局知识')
  assert.ok(globalHit.annotations.some((a) => a.includes('来自全局库')))

  // Re-scan: the existing global entry IS the dedupe — no stacking.
  const again = await suggestGeneralizations({ home })
  assert.equal(again.proposals.length, 0)
  assert.ok(again.skipped.some((reason) => reason.includes('全局版已存在')))
})

test('generalization discipline: unverified or dissimilar entries never propose; dry-run writes nothing', async (t) => {
  const { home, storeA, storeB, global } = await world(t)

  // Same wording but NEITHER verified (candidates without evidence) → silent.
  await storeA.add({ ...PITFALL_A })
  await storeB.add({ ...PITFALL_B })
  let scan = await suggestGeneralizations({ home })
  assert.equal(scan.proposals.length, 0, '未验证的知识不配泛化')

  // Verify one side only → still silent (≥2 projects is the rule).
  const only = await storeA.list()
  await storeA.transition(only[0].id, 'trusted', 'approve-promote', '测试批准')
  scan = await suggestGeneralizations({ home })
  assert.equal(scan.proposals.length, 0, '单项目验证不构成泛化')

  // A dissimilar verified pair → silent.
  await storeB.add({ kind: 'fact', title: 'CSV 导出带 BOM', text: '导出文件要在开头写 BOM 头,Excel 才不乱码。' })
  const bList = await storeB.list({ kind: 'fact' })
  await storeB.transition(bList[0].id, 'trusted', 'approve-promote', '测试批准')
  scan = await suggestGeneralizations({ home })
  assert.equal(scan.proposals.length, 0, '不相似的知识各自留在项目里')

  // Dry-run computes without writing.
  await storeB.transition((await storeB.list({ kind: 'pitfall' }))[0].id, 'trusted', 'approve-promote', '测试批准')
  const dry = await suggestGeneralizations({ home, dryRun: true })
  assert.equal(dry.proposals.length, 1)
  assert.equal(dry.proposals[0].created, undefined)
  assert.equal((await global.list()).length, 0, 'dry-run 不得写入全局库')
})

test('failure propagation: consecutive CITED global failures raise 待复核; surfaced failures never do', async (t) => {
  const { home, projA, global } = await world(t)
  const rule = await global.add({ kind: 'pitfall', title: '全局按钮通则', text: '交互控件必须键盘可达。' })

  const worklog = (mode: 'cited' | 'surfaced') => buildWorkLog({
    projectRoot: projA,
    changedFiles: ['search.html'],
    referencedEntryIds: [rule.id],
    attributionMode: mode,
    page: 'search.html',
  })

  // Surfaced (exposure approximation) failure: NOT attributed — a global
  // entry must never be punished on approximate evidence.
  const loose = await runEvidenceLoop({ worklog: worklog('surfaced'), home, inspection: fakeInspection(false), noSweep: true })
  assert.equal(loose.recorded.length, 0)
  assert.ok(loose.plan?.unattributed.some((u) => u.reason.includes('曝光回退')))
  assert.equal(loose.propagated.length, 0)

  // Cited failure #1: attributed (the citation IS the gate for globals),
  // but one project's failure does not put global knowledge under review.
  const first = await runEvidenceLoop({ worklog: worklog('cited'), home, inspection: fakeInspection(false), noSweep: true })
  assert.equal(first.recorded.length, 1)
  assert.equal(first.recorded[0].weight, -3)
  assert.ok(first.recorded[0].note.includes('全局条目'), '归因备注必须说明全局规则')
  assert.equal(first.propagated.length, 0)
  assert.equal((await global.get(rule.id))?.needsReview, false)

  // Cited failure #2 (consecutive): propagation fires.
  const second = await runEvidenceLoop({ worklog: worklog('cited'), home, inspection: fakeInspection(false), noSweep: true })
  assert.equal(second.propagated.length, 1)
  assert.equal(second.propagated[0].streak, 2)
  const flagged = await global.get(rule.id)
  assert.equal(flagged?.needsReview, true)
  assert.match(flagged?.reviewReason ?? '', /失败传播: 连续 2 次/)

  // A cited PASS breaks the streak and the flag's basis (flag stays until
  // human reverify — orthogonal flags are not auto-cleared by good news,
  // same doctrine as binding drift).
  const pass = await runEvidenceLoop({ worklog: worklog('cited'), home, inspection: fakeInspection(true), noSweep: true })
  assert.equal(pass.recorded.length, 1)
  assert.equal(pass.propagated.length, 0)
  const ledger = await readSignals(path.join(global.dir, 'signals.jsonl'))
  assert.equal(evidenceFailureStreak(ledger.filter((s) => s.entryId === rule.id)), 0)
})

test('cross-tier refs: a cited GLOBAL entry passes verification and its signal lands in the GLOBAL ledger', async (t) => {
  const { home, projA, global } = await world(t)
  const rule = await global.add({ kind: 'fact', title: '全局导出约定', text: '导出统一带信封。' })
  const report = await runEvidenceLoop({
    worklog: buildWorkLog({
      projectRoot: projA,
      changedFiles: ['search.html'],
      referencedEntryIds: [rule.id],
      attributionMode: 'cited',
      page: 'search.html',
    }),
    home,
    inspection: fakeInspection(true),
    noSweep: true,
  })
  assert.equal(report.recorded.length, 1, '全局条目不得落进 missing')
  assert.ok(!(report.plan?.unattributed ?? []).some((u) => u.reason.includes('已不存在')))
  const ledger = await readSignals(path.join(global.dir, 'signals.jsonl'))
  assert.equal(ledger.filter((s) => s.entryId === rule.id).length, 1, '信号必须落在条目所属层的账本')
})

test('discard bounds are UNIFORM (-20 both tiers): two rejections kill neither, four kill both', async (t) => {
  // M5 review decision: global knowledge is NOT killed faster for being
  // global — §3.6's sensitivity lives in failure propagation (待复核 flags),
  // not in a lower discard bound. This test is the nail on that decision.
  const { home, storeA, global } = await world(t)
  const globalEntry = await global.add({ kind: 'fact', title: '全局候选', text: 'x' })
  const projectEntry = await storeA.add({ kind: 'fact', title: '项目候选', text: 'y' })
  // Two user rejections on both tiers: -12, above the uniform -20 bound.
  for (const store of [global, storeA]) {
    const entry = store === global ? globalEntry : projectEntry
    await store.recordSignal(entry.id, 'user-reject', '第一次否定')
    await store.recordSignal(entry.id, 'user-reject', '第二次否定')
  }
  await global.sweep()
  await storeA.sweep()
  assert.equal((await global.get(globalEntry.id))?.status, 'candidate', '全局层两次否定不得遗弃(统一 -20)')
  assert.equal((await storeA.get(projectEntry.id))?.status, 'candidate', '项目层两次否定不得遗弃')

  // Two more rejections on the global entry: -24 crosses the bound.
  await global.recordSignal(globalEntry.id, 'user-reject', '第三次否定')
  await global.recordSignal(globalEntry.id, 'user-reject', '第四次否定')
  await global.sweep()
  assert.equal((await global.get(globalEntry.id))?.status, 'discarded', '持续否定(-24 ≤ -20)必须遗弃')
})
