/**
 * Loop-orchestrator tests with an INJECTED inspection (no browser needed):
 * the trigger rule, signal recording, binding freshness, and sweep all run
 * against real temp-dir KBs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openProjectStore, type KbStore } from '@clue-harness/kb'
import type { InspectResult } from '@clue-harness/evidence-render'
import { buildWorkLog } from '../src/worklog.ts'
import { runEvidenceLoop } from '../src/loop.ts'

function fakeInspection(exitOk: boolean, errorDetail?: string): InspectResult {
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
          kind: 'interactive', moduleId: 'search-submit', label: '主区域 > 搜索按钮',
          detail: errorDetail ?? '掉出 Tab 顺序(键盘不可达)', severity: 'error',
        }],
      },
    report: '',
    baselinePath: null,
    exitOk,
  }
}

async function lab(): Promise<{ root: string; project: string; home: string; store: KbStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-loop-'))
  const project = path.join(root, 'proj')
  const home = path.join(root, 'home')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, 'search.html'), '<html>v1</html>', 'utf8')
  return { root, project, home, store: await openProjectStore(project, home) }
}

test('backend-only worklog: NO inspection, NO signals (the trigger rule end to end)', async (t) => {
  const { root, project, home, store } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = await store.add({ kind: 'fact', title: '后端约定', text: '接口返回统一信封。', bindings: [] })

  const report = await runEvidenceLoop({
    worklog: buildWorkLog({ projectRoot: project, changedFiles: ['src/api/users.ts'], referencedEntryIds: [entry.id], page: 'search.html' }),
    home,
    // No inspection injected — and none must run: renderable is empty even
    // though a page is named. (If the rule broke, this would try to launch a
    // browser and throw in this environment.)
  })
  assert.deepEqual(report.renderable, [])
  assert.equal(report.outcome, null)
  assert.equal(report.inspection, null)
  assert.equal(report.recorded.length, 0)
})

test('renderable change + failing inspection: attributed entry gets evidence-fail', async (t) => {
  const { root, project, home, store } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const bound = await store.add({ kind: 'pitfall', title: '按钮坑', text: 'x', bindings: ['search.html'] })
  const free = await store.add({ kind: 'fact', title: '无关知识', text: 'y' })

  const report = await runEvidenceLoop({
    worklog: buildWorkLog({ projectRoot: project, changedFiles: ['search.html'], referencedEntryIds: [bound.id, free.id] }),
    home,
    inspection: fakeInspection(false),
    noSweep: true,
  })
  assert.deepEqual(report.renderable, ['search.html'])
  assert.equal(report.outcome?.exitOk, false)
  assert.equal(report.recorded.length, 1, '只有归因成立的条目记信号')
  assert.equal(report.recorded[0].entryId, bound.id)
  assert.equal(report.recorded[0].weight, store.config.weights.evidenceFail)
  assert.equal(report.plan?.unattributed.length, 1)
  const score = await store.score(bound.id)
  assert.equal(score.score, store.config.weights.evidenceFail)
})

test('passing inspection credits all referenced entries and sweep runs', async (t) => {
  const { root, project, home, store } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const a = await store.add({ kind: 'pitfall', title: 'A', text: 'a', bindings: ['search.html'] })
  const b = await store.add({ kind: 'fact', title: 'B', text: 'b' })

  const report = await runEvidenceLoop({
    worklog: buildWorkLog({ projectRoot: project, changedFiles: ['search.html'], referencedEntryIds: [a.id, b.id] }),
    home,
    inspection: fakeInspection(true),
  })
  assert.equal(report.recorded.length, 2)
  assert.ok(report.recorded.every((s) => s.weight === store.config.weights.evidence))
  assert.ok(report.sweep !== null, 'sweep 默认随闭环跑')
})

test('binding drift during the loop raises 待复核 on referenced entries', async (t) => {
  const { root, project, home, store } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = await store.add({ kind: 'pitfall', title: '绑定漂移', text: 'z', bindings: ['search.html'] })
  await writeFile(path.join(project, 'search.html'), '<html>v2 drifted</html>', 'utf8')

  const report = await runEvidenceLoop({
    worklog: buildWorkLog({ projectRoot: project, changedFiles: ['src/x.ts'], referencedEntryIds: [entry.id] }),
    home,
  })
  assert.deepEqual(report.needsReviewRaised, [entry.id])
  assert.equal((await store.get(entry.id))?.needsReview, true)
})

test('a worklog referencing a purged entry reports it, never crashes', async (t) => {
  const { root, project, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const report = await runEvidenceLoop({
    worklog: buildWorkLog({ projectRoot: project, changedFiles: ['a.ts'], referencedEntryIds: ['k-ghost'] }),
    home,
  })
  assert.ok(report.plan?.unattributed.some((u) => u.entryId === 'k-ghost' && u.reason.includes('已不存在')))
})
