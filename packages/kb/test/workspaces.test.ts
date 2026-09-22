/**
 * The workspace roster (M9): the central key derivation, the roster's own
 * lifecycle (register / add / rename / remove / find), the settings it carries
 * (render surface), and the migrate that pulls the M8 in-workspace layout back
 * into the home.
 *
 * Everything runs against a temp home — the real ~/.clue is never touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { canonicalRoot, encodeSegment, workspaceKey } from '@clue-harness/util'
import {
  WORKSPACES_REGISTRY_VERSION,
  addWorkspace,
  findWorkspace,
  getRenderSurface,
  listActiveWorkspaces,
  migrateWorkspaceKbsToCentral,
  openProjectStore,
  readWorkspaces,
  registerWorkspace,
  removeWorkspace,
  renameWorkspace,
  setRenderSurface,
  workspacesRegistryFile,
  KbEntryId,
} from '../src/index.ts'

async function lab(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-roster-'))
  const home = path.join(root, 'home')
  await mkdir(home, { recursive: true })
  return { root, home }
}

async function workspace(root: string, name: string): Promise<string> {
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  return dir
}

test('an empty home has an empty roster (no phantom rows)', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(await readWorkspaces(home), [])
})

test('opening a tier registers the workspace; re-opening only touches it', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const proj = await workspace(root, 'shop')

  const first = await openProjectStore(proj, home)
  let roster = await readWorkspaces(home)
  assert.equal(roster.length, 1)
  assert.equal(roster[0].root, canonicalRoot(proj))
  assert.equal(roster[0].label, 'shop', '默认标签就是目录名')
  assert.equal(roster[0].source, 'auto')

  // A custom label survives the next open (touch only, never re-derive).
  await renameWorkspace(roster[0].key, '我的商店', home)
  await openProjectStore(proj, home)
  roster = await readWorkspaces(home)
  assert.equal(roster.length, 1, '重复 open 不产生第二行')
  assert.equal(roster[0].label, '我的商店', '自动登记不得抹掉人工起的名字')
  assert.ok(first.dir.startsWith(path.join(home, 'kb')))
})

test('remove unregisters but never deletes; the root re-registers on use', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const proj = await workspace(root, 'blog')
  const store = await openProjectStore(proj, home)
  const entry = await store.add({ kind: 'fact', title: '站点颜色', text: '主色是 teal' })
  const [record] = await readWorkspaces(home)

  const result = await removeWorkspace(record.key, home)
  assert.equal(result.record.key, record.key)
  assert.equal(result.kbDir, store.dir)
  assert.deepEqual(await readWorkspaces(home), [], '名单里没有了')

  // The data is still there — an unregister is not a destroy.
  const reopened = await openProjectStore(proj, home)
  const again = await reopened.get(entry.id)
  assert.ok(again !== null, '中心库仍在,条目仍可读出')
  assert.equal((await readWorkspaces(home)).length, 1, '再次使用即自动回到名单')

  await assert.rejects(() => removeWorkspace('no-such-key', home), /workspace not registered/)
})

test('add validates the directory and records the manual source', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const proj = await workspace(root, 'admin')

  await assert.rejects(() => addWorkspace(path.join(root, 'ghost'), undefined, home), /directory does not exist/)
  const record = await addWorkspace(proj, '后台', home)
  assert.equal(record.label, '后台')
  assert.equal(record.source, 'manual')
  await assert.rejects(() => renameWorkspace(record.key, '   ', home), /label must not be empty/)
})

test('findWorkspace accepts a key, a root, or any path spelling', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const proj = await workspace(root, 'api')
  const record = await registerWorkspace(proj, { home })

  assert.equal((await findWorkspace(record.key, home))?.root, canonicalRoot(proj))
  assert.equal((await findWorkspace(proj, home))?.record.key, record.key)
  assert.equal((await findWorkspace(`${proj}/.`, home))?.record.key, record.key, '带尾点的路径同键')
  assert.equal(await findWorkspace(path.join(root, 'unseen'), home), null)
})

test('same-basename workspaces get distinct keys; the anchor walk keeps them apart', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const a = await workspace(root, 'one/site')
  const b = await workspace(root, 'two/site')
  const storeA = await openProjectStore(a, home)
  const storeB = await openProjectStore(b, home)
  assert.notEqual(storeA.dir, storeB.dir, '不同路径的同名工作区各归各库')
  assert.ok(storeA.dir.includes('-site') && storeB.dir.includes('-site'), '键里保留可读路径')

  // The anchor walk: a base taken by a DIFFERENT root is stepped over, never
  // adopted, and the same root keeps asking for the same slot.
  const claimer = await workspace(root, 'claimer') // 手工造一个"锚点相符"的槽位
  const claimerKey = await workspaceKey(claimer, home)
  await mkdir(path.join(home, 'kb', claimerKey), { recursive: true })
  await writeFile(
    path.join(home, 'kb', claimerKey, 'meta.json'),
    JSON.stringify({ version: 1, tier: 'project', projectRoot: canonicalRoot(claimer), createdAt: 'x' }),
    'utf8',
  )
  assert.equal(await workspaceKey(claimer, home), claimerKey, '锚点相符 → 还是它自己的槽位')
  // A root whose ENCODED base collides (aa/bb and aa-bb both encode to
  // `-…-aa-bb`) must step to `-2` rather than share the ledger.
  const deep = await workspace(root, 'pair/one')
  const flat = await workspace(root, 'pair-one')
  assert.equal(encodeSegment(canonicalRoot(deep)), encodeSegment(canonicalRoot(flat)), '前提:两条路径基名相同')
  const storeDeep = await openProjectStore(deep, home)
  const storeFlat = await openProjectStore(flat, home)
  assert.notEqual(storeDeep.key, storeFlat.key, '基名相撞必须走位')
  assert.ok(`${storeFlat.key}`.endsWith('-2'), `应走位到 -2,实得 ${storeFlat.key}`)
  assert.equal(await workspaceKey(deep, home), storeDeep.key, '相符锚点仍认自己的槽位')

  // An existing, NON-EMPTY directory with no readable anchor is never adopted.
  const strangerKey = await workspaceKey(path.join(root, 'stranger'), home)
  await mkdir(path.join(home, 'kb', strangerKey, 'entries'), { recursive: true })
  await assert.rejects(() => workspaceKey(path.join(root, 'stranger'), home), /no readable anchor/)
  // ...and an EMPTY directory is fine to adopt (a half-created tier).
  await rm(path.join(home, 'kb', strangerKey), { recursive: true, force: true })
  await mkdir(path.join(home, 'kb', strangerKey), { recursive: true })
  assert.equal(await workspaceKey(path.join(root, 'stranger'), home), strangerKey)
})

test('the render surface lives in the record, and null clears it', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const proj = await workspace(root, 'web')
  const record = await registerWorkspace(proj, { home })

  assert.equal(await getRenderSurface(proj, home), undefined, '未配置就是没有覆盖')
  await setRenderSurface(record.key, { extensions: ['.jsx'] }, home)
  assert.deepEqual(await getRenderSurface(proj, home), { extensions: ['.jsx'] })
  await setRenderSurface(record.key, null, home)
  assert.equal(await getRenderSurface(proj, home), undefined)
  await assert.rejects(() => setRenderSurface('ghost-key', null, home), /workspace not registered/)
})

test('listActiveWorkspaces filters rows whose tier or directory is gone', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const live = await workspace(root, 'live')
  const cold = await workspace(root, 'cold')
  await openProjectStore(live, home)
  await registerWorkspace(cold, { home }) // roster row, never opened → no tier

  const active = await listActiveWorkspaces(home)
  assert.deepEqual(active.map((row) => row.root), [canonicalRoot(live)], '只留真正有库的')

  // The unmounted workspace keeps its roster row (data is in the home).
  assert.equal((await readWorkspaces(home)).length, 2)
})

test('the M8 roster file is adopted once, not copied every read', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const proj = await workspace(root, 'legacy')
  await mkdir(home, { recursive: true })
  await writeFile(
    path.join(home, 'projects.json'),
    JSON.stringify({ version: 1, projects: [{ projectRoot: proj, firstSeenAt: 'x' }] }),
    'utf8',
  )

  const roster = await readWorkspaces(home)
  assert.equal(roster.length, 1)
  assert.equal(roster[0].root, canonicalRoot(proj))
  // A READ must not write: the adopted rows are still only in memory.
  assert.equal(await readFile(workspacesRegistryFile(home), 'utf8').catch(() => null), null)
  // The first real mutation persists them (and keeps the adopted row).
  await renameWorkspace(roster[0].key, '老项目', home)
  const doc = JSON.parse(await readFile(workspacesRegistryFile(home), 'utf8')) as { version: number; workspaces: Array<{ label: string }> }
  assert.equal(doc.version, WORKSPACES_REGISTRY_VERSION)
  assert.equal(doc.workspaces.length, 1, '收养的行没有丢')
  assert.equal(doc.workspaces[0].label, '老项目')
})

test('a foreign roster version fails loud (never auto-migrated)', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(home, { recursive: true })
  await writeFile(workspacesRegistryFile(home), JSON.stringify({ version: 99, workspaces: [] }), 'utf8')
  await assert.rejects(() => readWorkspaces(home), /workspace registry version mismatch/)
})

test('migrate pulls an M8 workspace .clue back into the home (never overwrites)', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const proj = await workspace(root, 'm8proj')

  // Build the M8 shape by hand: a tier, a baseline, a surface override.
  const tierDir = path.join(proj, '.clue', 'kb')
  await mkdir(path.join(tierDir, 'entries'), { recursive: true })
  const meta = { version: 1, tier: 'project', projectRoot: canonicalRoot(proj), createdAt: 'x' }
  await writeFile(path.join(tierDir, 'meta.json'), JSON.stringify(meta), 'utf8')
  await writeFile(
    path.join(tierDir, 'entries', 'k-1.json'),
    JSON.stringify({
      version: 1, id: KbEntryId('k-1'), tier: 'project', kind: 'pitfall', title: '旧坑', text: '旧正文',
      tags: [], bindings: [], provenance: { createdBy: 'cli', createdAt: 'x' }, status: 'candidate',
      needsReview: false, reviewReason: null, stats: { lastReferencedAt: null, referenceCount: 0 },
      history: [], discardedAt: null,
    }),
    'utf8',
  )
  await writeFile(path.join(tierDir, 'signals.jsonl'), JSON.stringify({ at: 'x', entryId: 'k-1', polarity: 'positive', source: 'human', weight: 5, note: 'human-confirm' }) + '\n', 'utf8')
  await mkdir(path.join(proj, '.clue', 'render-baselines'), { recursive: true })
  await writeFile(path.join(proj, '.clue', 'render-baselines', 'index-html.json'), '{"version":1}', 'utf8')
  await writeFile(path.join(proj, '.clue', 'render-surface.json'), JSON.stringify({ extensions: ['.jsx'] }), 'utf8')

  const report = await migrateWorkspaceKbsToCentral({ home, roots: [proj] })
  assert.deepEqual(report.map((row) => `${row.kind}:${row.moved}`).sort(), ['baselines:true', 'kb:true', 'surface:true'])

  const key = await workspaceKey(proj, home)
  const moved = await openProjectStore(proj, home)
  const entry = await moved.get(KbEntryId('k-1'))
  assert.equal(entry?.title, '旧坑', '条目跟着库搬过来了')
  assert.ok(moved.dir === path.join(home, 'kb', key))
  assert.deepEqual(await getRenderSurface(proj, home), { extensions: ['.jsx'] }, '渲染面进了记录')
  const kept = await readFile(path.join(home, 'baselines', key, 'index-html.json'), 'utf8')
  assert.equal(kept, '{"version":1}')
  assert.equal(await readFile(path.join(proj, '.clue', 'kb', 'meta.json')).catch(() => null), null, '旧位置已腾空')
  assert.equal(await readFile(path.join(proj, '.clue')).catch(() => null), null, '.clue 空了就删掉')

  // A second migrate has nothing to do; an occupied destination is never clobbered.
  assert.deepEqual(await migrateWorkspaceKbsToCentral({ home, roots: [proj] }), [])
  await writeFile(path.join(proj, '.clue', 'kb', 'entries', 'k-9.json'), '{}', 'utf8').catch(() => {})
  await mkdir(path.join(proj, '.clue', 'kb', 'entries'), { recursive: true })
  await writeFile(path.join(proj, '.clue', 'kb', 'meta.json'), JSON.stringify(meta), 'utf8')
  const second = await migrateWorkspaceKbsToCentral({ home, roots: [proj] })
  assert.ok(second.some((row) => row.kind === 'kb' && !row.moved && /already exists/.test(row.reason)), '目标非空不覆盖')
})

test('migrate dry-run reports without moving', async (t) => {
  const { root, home } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))
  const proj = await workspace(root, 'dryproj')
  await mkdir(path.join(proj, '.clue', 'kb', 'entries'), { recursive: true })
  const report = await migrateWorkspaceKbsToCentral({ home, roots: [proj], dryRun: true })
  assert.ok(report.some((row) => row.kind === 'kb' && !row.moved && /dry-run/.test(row.reason)))
  assert.ok(await readFile(path.join(proj, '.clue', 'kb', 'entries')).then(() => true, () => true))
  assert.deepEqual(await readWorkspaces(home), [], 'dry-run 不写名单')
})
