/**
 * 落地计划 §2-7 — ranklog 的可归因性（哪一行来自哪个库、写失败算不算数）。
 *
 * 背景是一次**误报**：一份报告读到「8 行 ranklog 全是 `pre-step`」，据此判定
 * "工具通道从来不落盘"。复核（2026-09-22）发现那 8 行的时间戳早于 ranklog 这套
 * 代码，真正的缺陷是两处：
 *
 * 1. `hybrid.ts` 的两条静默出口（纯词法委派、空 token 查询）一行都不写；
 * 2. 写失败只有一条 warn，"日志是空的"与"日志写不进去"在产品面上无法区分。
 *
 * 所以本文件钉的不是"有没有日志"，而是**可归因**：行必须落在被问的那个库里，
 * 失败必须带目标文件的绝对路径并被计数。
 *
 * @module @clue-harness/kb-face/test/ranklog
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { openGlobalStore, openProjectStore } from '@clue-harness/kb'
import { registerEmbeddingSettings } from '../src/embedding-config.ts'
import { createRetrievalPlane, type RetrievalPlane } from '../src/retrieval-plane.ts'

/** A host context plus a project with one entry, and a plane over both. */
async function world(t: { after(fn: () => unknown): void }): Promise<{
  plane: RetrievalPlane
  stores: { project: Awaited<ReturnType<typeof openProjectStore>>; global: Awaited<ReturnType<typeof openGlobalStore>> }
  warnings: string[]
  home: string
}> {
  const home = await mkdtemp(path.join(tmpdir(), 'clue-ranklog-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  ctx.plugin(FileSettingsProvider as never, { dshHome: home, watch: false } as never)
  ctx.plugin(CredentialsLocal as never, { dshHome: home, watch: false } as never)
  await new Promise((resolve) => setTimeout(resolve, 300))
  registerEmbeddingSettings(ctx)
  const root = path.join(home, 'proj')
  await mkdir(root, { recursive: true })
  const project = await openProjectStore(root, home)
  await project.add({ kind: 'pitfall', title: '键盘可达性', text: '所有交互元素必须能被 Tab 选中。', tags: ['a11y'] })
  const global = await openGlobalStore(home)
  const warnings: string[] = []
  const plane = createRetrievalPlane(ctx, { home, onWarn: (message) => warnings.push(message) })
  return { plane, stores: { project, global }, warnings, home }
}

test('§2-7 tool 通道的行落在被问的那个库里,且与 pre-step 同一份数据', async (t) => {
  const { plane, stores } = await world(t)
  const first = await plane.retrieve(stores, '键盘 可达性', { profile: 'tool' })
  assert.ok(first.hits.length > 0, '这轮要真的召回')
  const file = path.join(stores.project.dir, 'ranklog.jsonl')
  const rows = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { profile: string; query: string })
  assert.equal(rows.length, 1, '工具路径必须写一行')
  assert.equal(rows[0]?.profile, 'tool')
  assert.equal(rows[0]?.query, '键盘 可达性')

  await plane.retrieve(stores, '键盘', { profile: 'pre-step' })
  const after = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { profile: string })
  assert.deepEqual(after.map((row) => row.profile), ['tool', 'pre-step'], '两条通道共用一个文件,顺序即调用顺序')
})

test('§2-7 ranklog 写失败必须带目标文件绝对路径、被计数,并且不影响检索', async (t) => {
  const { plane, stores, warnings } = await world(t)
  // 制造一次必然失败的写入:让 ranklog 的路径上存在一个**目录**。
  await mkdir(path.join(stores.project.dir, 'ranklog.jsonl'), { recursive: true })
  const result = await plane.retrieve(stores, '键盘 可达性', { profile: 'tool' })
  assert.ok(result.hits.length > 0, 'ranklog 写失败不得影响检索(护栏 2)')
  const status = await plane.status()
  assert.equal(status.ranklog.enabled, true)
  assert.equal(status.ranklog.failures, 1, '失败要被计数')
  assert.ok(status.ranklog.lastError !== null && status.ranklog.lastError !== '', '失败原因要留下')
  assert.equal(status.ranklog.file, path.join(stores.project.dir, 'ranklog.jsonl'), '必须点名目标文件(误报的根源就是没有出处)')
  assert.ok(warnings.some((line) => line.includes('ranklog') && line.includes('ranklog.jsonl')), `warn 要带路径,实际:${JSON.stringify(warnings)}`)
})

test('§2-7 检索结果自带词法索引状态(R1 的"索引待建"必须可读,不能只是变慢)', async (t) => {
  const { plane, stores } = await world(t)
  const result = await plane.retrieve(stores, '键盘 可达性', { profile: 'tool' })
  assert.equal(result.lexicalIndex.used, true, '第一次查询会建索引并使用它')
  assert.match(result.lexicalIndex.note, /索引/)
  const status = await plane.status()
  assert.equal(status.ranklog.failures, 0)
})
