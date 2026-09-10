/**
 * Doubt-ledger engine tests (M6) + the audited text-edit store method.
 * Pure engine level: real temp dirs, real KbStore, no browser, no dsh.
 * The face-level chain (dislike → capture → knowledge) lives in
 * apps/cli/test/doubt-loop.test.ts.
 *
 * @module @clue-harness/kb-loop/test/doubt
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openProjectStore, type KbStore } from '@clue-harness/kb'
import {
  doubtLedgerPath, escalatedModules, markEscalated, openDoubtCounts, readDoubtLedger, recordDoubt,
} from '@clue-harness/kb-loop'
import { existsSync } from 'node:fs'

async function lab(t: { after(fn: () => unknown): void }): Promise<{ dir: string; store: KbStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-doubt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  const store = await openProjectStore(project, path.join(root, 'home'))
  return { dir: store.dir, store }
}

test('doubt ledger: counts accumulate, escalations reset, kinds stay separate', async (t) => {
  const { dir } = await lab(t)
  assert.equal(existsSync(doubtLedgerPath(dir)), false, '账本按需创建')
  assert.equal((await readDoubtLedger(dir)).length, 0, '缺失账本读作空')

  // Two dislikes on one module, one on another, one on an entry.
  assert.equal(await recordDoubt(dir, { kind: 'module', key: 'signup', sessionId: 's', turn: 1, reason: '点踩' }), 1)
  assert.equal(await recordDoubt(dir, { kind: 'module', key: 'signup', sessionId: 's', turn: 2, reason: '又点踩' }), 2)
  assert.equal(await recordDoubt(dir, { kind: 'module', key: 'footer', sessionId: 's', turn: 2, reason: '点踩' }), 1)
  assert.equal(await recordDoubt(dir, { kind: 'entry', key: 'k-1', sessionId: 's', turn: 2, reason: '点踩' }), 1)

  // The two ledgers count separately (分开记 — same file, no cross-talk).
  const modules = await openDoubtCounts(dir, 'module')
  const entries = await openDoubtCounts(dir, 'entry')
  assert.equal(modules.get('signup'), 2)
  assert.equal(modules.get('footer'), 1)
  assert.equal(entries.get('signup'), undefined)
  assert.equal(entries.get('k-1'), 1)

  // Escalation resets ONLY its own key's open count, and joins the roster.
  await markEscalated(dir, 'module', 'signup', 2, '截图 abc123;候选知识 k-9')
  const after = await openDoubtCounts(dir, 'module')
  assert.equal(after.get('signup'), undefined, '升级后计数清零')
  assert.equal(after.get('footer'), 1, '别的模块不受影响')
  const roster = await escalatedModules(dir)
  assert.deepEqual([...roster], ['signup'])

  // Fresh doubts after escalation count from zero again.
  assert.equal(await recordDoubt(dir, { kind: 'module', key: 'signup', sessionId: 's', turn: 3, reason: '再点踩' }), 1)

  // The ledger is the audit: every event recorded in order.
  const ledger = await readDoubtLedger(dir)
  assert.equal(ledger.length, 6)
  assert.deepEqual(ledger.map((r) => r.type), ['doubt', 'doubt', 'doubt', 'doubt', 'escalated', 'doubt'])
  const escalation = ledger[4]
  assert.equal(escalation.type === 'escalated' && escalation.action, '截图 abc123;候选知识 k-9')
})

test('updateEntryText: audited body edit, no-op on identical text, loud on blank/missing', async (t) => {
  const { store } = await lab(t)
  const entry = await store.add({ kind: 'decision', title: '泛化草稿', text: '本项目按钮必须用 ds-button 组件,评审踩过三次。' })

  const updated = await store.updateEntryText(entry.id, '表单按钮应使用统一的设计系统组件,避免自定义实现破坏可访问性。', '审批中心采纳 AI 润色稿')
  assert.equal(updated.text, '表单按钮应使用统一的设计系统组件,避免自定义实现破坏可访问性。')
  assert.equal(updated.title, entry.title, '只改正文,标题不动')
  assert.equal(updated.status, entry.status, '只改正文,状态不动')
  const last = updated.history[updated.history.length - 1]
  assert.equal(last.change, 'textUpdated')
  assert.equal(last.reason, '审批中心采纳 AI 润色稿')

  // Identical text is a no-op (no history spam).
  const same = await store.updateEntryText(entry.id, updated.text, '重复采纳')
  assert.equal(same.history.length, updated.history.length)

  // Blank text and missing entries fail loud.
  await assert.rejects(store.updateEntryText(entry.id, '   ', 'x'), /正文不能为空白/)
  await assert.rejects(store.updateEntryText('k-ghost' as never, 'x', 'y'), /条目不存在/)
})
