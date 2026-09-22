/**
 * Store + retrieval tests over a real temp-dir KB (no browser, no network):
 * facts round-trip, binding drift raises the orthogonal flag, retrieval ranks
 * by status/tier and annotates, touch ≠ signal.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  KB_FORMAT_VERSION,
  KbEntryId,
  openGlobalStore,
  openProjectStore,
  queryKb,
  tokenize,
  type KbStore,
} from '../src/index.ts'

async function lab(): Promise<{ root: string; home: string; project: string; projectStore: KbStore; globalStore: KbStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-kb-'))
  const home = path.join(root, 'home')
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, '.keep'), '', 'utf8')
  return {
    root,
    home,
    project,
    projectStore: await openProjectStore(project, home),
    globalStore: await openGlobalStore(home),
  }
}

test('add always starts at candidate; facts round-trip through disk', async (t) => {
  const { root, home, project, projectStore } = await lab()
  t.after(() => rm(root, { recursive: true, force: true }))

  const entry = await projectStore.add({
    kind: 'pitfall',
    title: '绝对定位按钮掉出 Tab 顺序',
    text: '在 flex 容器里给提交按钮加绝对定位,它会掉出 Tab 顺序;需要显式检查键盘可达性。',
    tags: ['css', '可访问性'],
  })
  assert.equal(entry.status, 'candidate')
  assert.equal(entry.needsReview, false)
  assert.equal(entry.history.length, 1)

  const loaded = await projectStore.get(entry.id)
  assert.deepEqual(loaded, entry)
  const listed = await projectStore.list()
  assert.equal(listed.length, 1)
  assert.equal((await projectStore.list({ status: 'trusted' })).length, 0)
  // M9 (decision #6 re-revised): the project tier is CENTRAL, keyed by the
  // workspace path — the workspace directory itself carries nothing of ours.
  assert.ok(projectStore.dir.startsWith(path.join(home, 'kb')), `中心库应在 <home>/kb 下: ${projectStore.dir}`)
  assert.equal(await readdir(path.join(project, '.clue')).catch(() => null), null, '工作区内不得出现 .clue/')
})

test('entry files refuse foreign versions (house style)', async (t) => {
  const { home, projectStore } = await lab()
  t.after(() => rm(path.dirname(home), { recursive: true, force: true }))
  const entry = await projectStore.add({ kind: 'fact', title: 'x', text: 'y' })
  const file = path.join(projectStore.dir, 'entries', `${entry.id}.json`)
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'))
  raw.version = 999
  await writeFile(file, JSON.stringify(raw), 'utf8')
  await assert.rejects(() => projectStore.get(entry.id), /kb entry version mismatch/)
})

test('binding drift raises needsReview automatically on query; reverify --accept rebinds and clears', async (t) => {
  const { home, project, projectStore } = await lab()
  t.after(() => rm(path.dirname(home), { recursive: true, force: true }))

  const bound = path.join(project, 'form.html')
  await writeFile(bound, '<form>v1</form>', 'utf8')
  const entry = await projectStore.add({
    kind: 'pitfall', title: '表单按钮检查', text: '提交按钮必须在 form 内且可 Tab。', bindings: ['form.html'],
  })
  assert.equal(entry.bindings[0].path, 'form.html')

  // Modify the bound file → the M2 acceptance: query auto-flags 待复核.
  await writeFile(bound, '<form>v2 moved button</form>', 'utf8')
  const hits = await queryKb(projectStore, null, { text: '提交按钮 Tab', noTouch: false })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].entry.needsReview, true)
  assert.match(hits[0].entry.reviewReason ?? '', /源文件内容已变: form\.html/)
  assert.ok(hits[0].annotations.some((a) => a.includes('待复核')))

  // Accept the new content: hashes rebind, flag clears, history records it.
  const accepted = await projectStore.reverify(entry.id, true)
  assert.equal(accepted.needsReview, false)
  assert.ok(accepted.history.some((h) => h.change === 'rebind'))

  // And drifting again re-raises the flag (the check is continuous, not once).
  await writeFile(bound, '<form>v3 drifted again</form>', 'utf8')
  await projectStore.checkBindings(entry.id)
  const raised = await projectStore.get(entry.id)
  assert.equal(raised?.needsReview, true)
  assert.match(raised?.reviewReason ?? '', /源文件内容已变/)
})

test('tokenizer: ASCII words + CJK bigrams (2-char Chinese queries work)', () => {
  const tokens = tokenize('提交按钮 tab order 检查')
  assert.ok(tokens.includes('tab'))
  assert.ok(tokens.includes('order'))
  assert.ok(tokens.includes('提交'))
  assert.ok(tokens.includes('交按'))
  assert.ok(tokens.includes('检查'))
})

test('query ranks trusted over candidate, annotates expired, excludes discarded', async (t) => {
  const { home, projectStore } = await lab()
  t.after(() => rm(path.dirname(home), { recursive: true, force: true }))

  const candidate = await projectStore.add({ kind: 'fact', title: '按钮规范', text: '本项目按钮必须用 ds-button 组件。' })
  const trusted = await projectStore.add({ kind: 'fact', title: '按钮规范(旧)', text: '本项目按钮必须用 ds-button 组件,直接写 button 会丢焦点框。' })
  await projectStore.transition(trusted.id, 'trusted', 'approve-promote', '测试提升')
  const discarded = await projectStore.add({ kind: 'fact', title: '按钮规范(废弃)', text: '本项目按钮必须用 ds-button 组件(已废弃说法)。' })
  await projectStore.recordSignal(discarded.id, 'user-reject', '测试否定')
  await projectStore.transition(discarded.id, 'discarded', 'strong-negative', '测试')

  const hits = await queryKb(projectStore, null, { text: '按钮 ds-button 规范', noTouch: true })
  assert.equal(hits.length, 2, `discarded 必须不返回,got ${hits.map((h) => h.entry.id).join(',')}`)
  assert.equal(hits[0].entry.id, trusted.id, 'trusted 必须排在 candidate 前')

  const expired = await projectStore.add({ kind: 'fact', title: '过期知识', text: '这条讲按钮布局的旧知识。' })
  await projectStore.transition(expired.id, 'expired', 'expire-idle', '测试')
  const withoutExpired = await queryKb(projectStore, null, { text: '按钮 布局', noTouch: true })
  assert.ok(!withoutExpired.some((h) => h.entry.id === expired.id))
  const withExpired = await queryKb(projectStore, null, { text: '按钮 布局', includeExpired: true, noTouch: true })
  const expiredHit = withExpired.find((h) => h.entry.id === expired.id)
  assert.ok(expiredHit)
  assert.ok(expiredHit.annotations.some((a) => a.includes('已过期')), '过期命中必须带标注(读=放行带标注)')
})

test('global tier merges under project precedence (nearer scope wins)', async (t) => {
  const { home, projectStore, globalStore } = await lab()
  t.after(() => rm(path.dirname(home), { recursive: true, force: true }))

  await globalStore.add({ kind: 'fact', title: '通用按钮可访问性', text: '按钮应保持键盘可达与足够对比度。' })
  await projectStore.add({ kind: 'fact', title: '项目按钮约定', text: '按钮应保持键盘可达,且必须用 ds-button。' })

  const hits = await queryKb(projectStore, globalStore, { text: '按钮 键盘可达', noTouch: true })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].entry.tier, 'project', '项目库必须遮蔽全局库')
  assert.ok(hits[1].annotations.some((a) => a.includes('全局库')))
})

test('query touches lastReferencedAt but records NO signal (retrieved≠used)', async (t) => {
  const { home, projectStore } = await lab()
  t.after(() => rm(path.dirname(home), { recursive: true, force: true }))

  const entry = await projectStore.add({ kind: 'fact', title: 'touch 测试', text: '引用计数与信号分离。' })
  const hits = await queryKb(projectStore, null, { text: '引用计数' })
  assert.equal(hits.length, 1)
  const touched = await projectStore.get(entry.id)
  assert.equal(touched?.stats.referenceCount, 1)
  assert.ok(touched?.stats.lastReferencedAt !== null)
  const score = await projectStore.score(entry.id)
  assert.equal(score.counted, 0, '检索命中不得记任何信号(决策 #9: 没用到不扣分,也不算用到)')
})

test('project tier is central and workspace-keyed; the roster is clue\'s own (M9)', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-bind-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const { mkdir, readFile, realpath } = await import('node:fs/promises')
  const siteA = path.join(root, 'a', 'site')
  const siteB = path.join(root, 'b', 'site')
  await mkdir(siteA, { recursive: true })
  await mkdir(path.join(siteA, '.git'), { recursive: true }) // 假装是个仓库
  await mkdir(siteB, { recursive: true })

  const storeA = await openProjectStore(siteA, home)
  const realA = await realpath(siteA)
  assert.ok(storeA.dir.startsWith(path.join(home, 'kb')), '项目库必须在中心 home 里')
  assert.ok(storeA.dir.endsWith('-site'), `键由路径编码而来: ${storeA.dir}`)
  // 中心化的代价换来的一条硬保证:工作区目录一个字节都不属于 clue。
  assert.equal(await readdir(path.join(siteA, '.clue')).catch(() => null), null, '工作区内不得出现 .clue/')
  assert.equal(
    await readFile(path.join(siteA, '.git', 'info', 'exclude')).catch(() => null), null,
    'M9: 我们再也不碰用户的 git 簿记',
  )
  const roster = JSON.parse(await readFile(path.join(home, 'workspaces.json'), 'utf8')) as { workspaces: Array<{ root: string; key: string }> }
  assert.deepEqual(roster.workspaces.map((w) => w.root), [realA], 'open 即入名单(面板与泛化的花名册)')

  // 同名不同路径各归各库:键尾带根路径摘要,天然不撞。
  const storeB = await openProjectStore(siteB, home)
  assert.notEqual(storeA.dir, storeB.dir)
  assert.notEqual(storeA.key, storeB.key)
  // 重复 open 不重复登记。
  await openProjectStore(siteA, home)
  const again = JSON.parse(await readFile(path.join(home, 'workspaces.json'), 'utf8')) as { workspaces: Array<{ root: string }> }
  assert.equal(again.workspaces.filter((w) => w.root === realA).length, 1, '重复 open 不重复登记')
})
