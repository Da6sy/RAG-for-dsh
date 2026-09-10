/**
 * L3 capture tests (M6), browser-gated like the rest of the render suite:
 * module clip, full-page fallback, content-hash dedupe, and the honest
 * failure for a missing module. No Chromium → clean skip.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { captureScreenshot, probeBrowser } from '@clue-harness/evidence-render'

const probe = await probeBrowser()
const skip = probe.ok
  ? undefined
  : `Chromium 不可用(${probe.error ?? '原因未知'});装好浏览器二进制/系统库后重跑即自动转真测`

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>capture</title></head>
<body><main>
<form data-module="signup"><input type="email"><button type="submit">提交</button></form>
<footer data-module="foot">页脚</footer>
</main></body></html>
`

async function freshProject(): Promise<{ root: string; project: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-capture-'))
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, 'page.html'), PAGE)
  return { root, project, home: path.join(root, 'home') }
}

test('module capture: clipped PNG lands content-addressed; second identical capture reuses', { skip }, async (t) => {
  const { root, project, home } = await freshProject()
  t.after(() => rm(root, { recursive: true, force: true }))

  const first = await captureScreenshot({ projectRoot: project, page: 'page.html', moduleId: 'signup', home })
  assert.equal(first.reused, false)
  assert.ok(first.bytes > 0)
  assert.ok(first.path.endsWith(`${first.sha256}.png`), '文件名必须是内容哈希')
  const bytes = await readFile(first.path)
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG', '必须是真 PNG 字节')

  // Same screen → same hash → stored once (the §4.8 cache discipline).
  const second = await captureScreenshot({ projectRoot: project, page: 'page.html', moduleId: 'signup', home })
  assert.equal(second.sha256, first.sha256, '同画面哈希必须相同(确定性归一化)')
  assert.equal(second.reused, true)

  // A different module is different content.
  const foot = await captureScreenshot({ projectRoot: project, page: 'page.html', moduleId: 'foot', home })
  assert.notEqual(foot.sha256, first.sha256)
})

test('full-page capture (no moduleId) and honest failure for a missing module', { skip }, async (t) => {
  const { root, project, home } = await freshProject()
  t.after(() => rm(root, { recursive: true, force: true }))

  const full = await captureScreenshot({ projectRoot: project, page: 'page.html', home })
  assert.ok(full.bytes > 0)

  await assert.rejects(
    captureScreenshot({ projectRoot: project, page: 'page.html', moduleId: 'ghost', home }),
    /没有 data-module="ghost"/,
    '缺失模块必须响亮失败,不得静默截全页',
  )
})
