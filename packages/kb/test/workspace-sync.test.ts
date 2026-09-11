/**
 * The workspace sync (M9.1): the host registry owns panel visibility, a
 * vanished workspace becomes a question rather than an action, and answering
 * "delete it" moves bytes to the trash instead of deleting them.
 *
 * Host rows are pushed in as plain data — which is exactly the shape the
 * engine sees when kb-web reads `ctx.workspaceRegistry.list()`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { canonicalRoot, workspaceKey } from '@clue-harness/util'
import {
  KbEntryId,
  keepWorkspace,
  listTrash,
  openProjectStore,
  panelWorkspaces,
  purgeAllOrphans,
  purgeWorkspace,
  readWorkspaces,
  registerWorkspace,
  syncWorkspaces,
} from '../src/index.ts'

async function lab(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-sync-'))
  const home = path.join(root, 'home')
  await mkdir(home, { recursive: true })
  return { root, home }
}

async function dir(name: string, root: string): Promise<string> {
  const path_ = path.join(root, name)
  await mkdir(path_, { recursive: true })
  return path_
}

const host = (id: string, dirPath: string, title: string) => ({ id, path: dirPath, title })

test('a brand-new workspace with zero sessions is visible immediately', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const fresh = await dir('fresh', root)

  const report = await syncWorkspaces([host('w1', fresh, '新项目')], home)
  assert.equal(report.live.length, 1)
  assert.equal(report.live[0].label, '新项目', '标题镜像宿主的,不自己起')
  assert.equal(report.newlyOrphaned.length, 0)

  const panel = await panelWorkspaces(home)
  assert.deepEqual(panel.map((row) => row.root), [canonicalRoot(fresh)])
  // Visible means addressable: the central tier exists and is empty.
  const store = await openProjectStore(panel[0].root, home)
  assert.equal((await store.list()).length, 0, '空库也是库')
})

test('a path only the CLI touched is real data but NOT a panel row', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const cliOnly = await dir('cli-only', root)
  const sidebar = await dir('sidebar', root)

  await registerWorkspace(cliOnly, { home }) // what a CLI open does
  await syncWorkspaces([host('w1', sidebar, '侧边栏项目')], home)

  const panel = await panelWorkspaces(home)
  assert.deepEqual(panel.map((row) => row.root), [canonicalRoot(sidebar)], '面板=侧边栏,不多列')
  const all = await readWorkspaces(home)
  assert.equal(all.length, 2, 'CLI 那行没被抹掉(知识还在,只是不当作侧边栏工作区)')
})

test('a workspace removed from the registry becomes a one-time question', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const a = await dir('a', root)
  const b = await dir('b', root)
  await syncWorkspaces([host('w1', a, 'A'), host('w2', b, 'B')], home)

  // B disappears from the host list.
  const report = await syncWorkspaces([host('w1', a, 'A')], home)
  assert.equal(report.newlyOrphaned.length, 1)
  assert.equal(report.newlyOrphaned[0].title, 'B')

  const panel = await panelWorkspaces(home)
  const orphans = panel.filter((row) => row.state === 'orphaned')
  assert.equal(orphans.length, 1, '孤儿行仍在面板上——以提问的形式')
  assert.equal(orphans[0].hostTitle, 'B')
  assert.ok(orphans[0].orphanedAt !== undefined)

  // Syncing again must not ask twice (the question is a state, not an event log).
  const again = await syncWorkspaces([host('w1', a, 'A')], home)
  assert.equal(again.newlyOrphaned.length, 0, '重复同步不重复提问')
  // A purge refusal must not be silently re-asked either.
  await keepWorkspace(orphans[0].key, home)
  assert.deepEqual((await panelWorkspaces(home)).filter((row) => row.state === 'orphaned'), [])
})

test('purging moves the whole workspace state to the trash, and nothing is rm-ed', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const doomed = await dir('doomed', root)
  await syncWorkspaces([host('w1', doomed, '要删的项目')], home)
  const key = await workspaceKey(canonicalRoot(doomed), home)

  const store = await openProjectStore(doomed, home)
  const entry = await store.add({ kind: 'pitfall', title: '坑', text: '正文' })
  await store.recordSignal(entry.id, 'human-confirm', '测试')
  await mkdir(path.join(home, 'baselines', key), { recursive: true })
  await writeFile(path.join(home, 'baselines', key, 'index-html.json'), '{}', 'utf8')

  await syncWorkspaces([], home) // the host dropped it
  const [orphan] = (await panelWorkspaces(home)).filter((row) => row.state === 'orphaned')
  assert.equal(orphan.key, key)

  const result = await purgeWorkspace(key, home)
  assert.deepEqual(result.moved.map((row) => row.kind).sort(), ['baselines', 'kb'])
  for (const piece of result.moved) {
    assert.equal((await stat(piece.from).catch(() => null)) === null, true, '原位置已腾空')
    assert.ok(piece.to.startsWith(path.join(home, 'trash')), `必须落在回收目录: ${piece.to}`)
  }
  // The bytes are all still there — restorable by hand.
  const trashed = await listTrash(home)
  assert.equal(trashed.length, 1)
  assert.deepEqual(trashed[0].kinds.sort(), ['baselines', 'kb'])
  const kept = await readdir(path.join(trashed[0].dir, 'kb', 'entries'))
  assert.deepEqual(kept, [`${entry.id}.json`])
  const ledger = await readFileSafe(path.join(trashed[0].dir, 'kb', 'signals.jsonl'))
  assert.equal(ledger.trim().split('\n').length, 1, '信号账本一起搬走,没丢')

  const row = (await readWorkspaces(home)).find((item) => item.key === key)
  assert.equal(row?.state, 'kept')
  assert.ok(row?.purgedAt !== undefined)
  assert.equal((await stat(path.join(home, 'kb', key)).catch(() => null)) === null, true, '中心位腾空')
})

test('purge refuses a live workspace (the question is the only door)', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const live = await dir('live', root)
  await syncWorkspaces([host('w1', live, '还活着')], home)
  const key = await workspaceKey(canonicalRoot(live), home)
  await assert.rejects(() => purgeWorkspace(key, home), /只能清退/)
})

test('re-creating the workspace revives the row and its knowledge', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const back = await dir('back', root)
  await syncWorkspaces([host('w1', back, '回归')], home)
  const key = await workspaceKey(canonicalRoot(back), home)
  const store = await openProjectStore(back, home)
  const entry = await store.add({ kind: 'fact', title: '留着', text: '别忘' })

  await syncWorkspaces([], home) // deleted
  await keepWorkspace(key, home) // "keep it"
  assert.equal((await panelWorkspaces(home)).length, 0)

  const revived = await syncWorkspaces([host('w1', back, '回归')], home)
  assert.deepEqual(revived.revived, [key], '回来了要停止隐藏')
  const panel = await panelWorkspaces(home)
  assert.equal(panel.length, 1)
  const reopened = await openProjectStore(panel[0].root, home)
  assert.equal((await reopened.get(entry.id))?.title, '留着', '答案"保留"之后知识还在原地')
})

test('purge-all batches under one trash stamp', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const one = await dir('one', root)
  const two = await dir('two', root)
  await syncWorkspaces([host('w1', one, '一'), host('w2', two, '二')], home)
  // Give each tier real bytes: a workspace that was only registered has no
  // directory to move, and a purge of nothing must not mint an empty trash dir.
  await openProjectStore(one, home)
  await openProjectStore(two, home)
  await syncWorkspaces([], home) // both dropped
  const report = await purgeAllOrphans(home)
  assert.equal(report.keys.length, 2)
  assert.deepEqual(report.moved.map((row) => row.kind), ['kb', 'kb'], '两本库各搬一次')
  assert.ok(report.trashRoot.startsWith(path.join(home, 'trash')))
  const trashed = await listTrash(home)   // 显式 home:漏传就会去读真实 ~/.clue/trash
  assert.equal(new Set(trashed.map((row) => row.stamp)).size, 1, '一次批量一个时间戳,好整体回滚')
  assert.equal(trashed.length, 2, '两个工作区各自一格,同属这一批')
  assert.equal((await panelWorkspaces(home)).filter((row) => row.state === 'orphaned').length, 0)
})

async function readFileSafe(file: string): Promise<string> {
  try { return await readFile(file, 'utf8') } catch { return '' }
}
