/**
 * Browser-gated acceptance tests (design doc §4.6 determinism gate + §4.5
 * baseline lifecycle). These need a real Chromium for layout; environments
 * without one SKIP cleanly (the same pattern dsh uses for key-gated e2e).
 *
 * On a normal dev machine (Windows/macOS/WSL with browser deps) these run
 * and constitute the M1 acceptance:
 *   1. three captures of the same page are BYTE-identical (the gate);
 *   2. record → compare reports "identical" (baseline lifecycle);
 *   3. modifying the source flips the button below the input — the diff
 *      names the move AND the relation change (the killer feature);
 *   4. the seeded pitfalls (tabindex=-1 button, low-contrast text) are
 *      caught by the built-in assertions in a REAL browser.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspectPage, probeBrowser } from '../src/index.ts'

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures')
const probe = await probeBrowser()
const skip = probe.ok
  ? undefined
  : `Chromium 不可用(${probe.error ?? '原因未知'});装好浏览器二进制/系统库后重跑即自动转真测`

async function freshProject(): Promise<{ project: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-render-'))
  const project = path.join(root, 'proj')
  const home = path.join(root, 'home')
  await cp(FIXTURE_DIR, project, { recursive: true })
  return { project, home }
}

test('determinism gate: three captures are byte-identical (volatile clock masked)', { skip }, async (t) => {
  const { project, home } = await freshProject()
  t.after(() => rm(path.dirname(project), { recursive: true, force: true }))

  const runs: string[] = []
  for (let i = 0; i < 3; i += 1) {
    const result = await inspectPage({
      projectRoot: project, page: 'sample.html', mode: 'show',
      maskSelectors: ['.volatile'],
    })
    assert.ok(result.snapshot !== null)
    runs.push(JSON.stringify(result.snapshot))
  }
  assert.equal(runs[0], runs[1], '第 1/2 次采集不一致')
  assert.equal(runs[1], runs[2], '第 2/3 次采集不一致')
})

test('record → compare: identical verdict, baseline pending confirmation', { skip }, async (t) => {
  const { project, home } = await freshProject()
  t.after(() => rm(path.dirname(project), { recursive: true, force: true }))

  const recorded = await inspectPage({
    projectRoot: project, page: 'sample.html', mode: 'record',
    maskSelectors: ['.volatile'], home,
  })
  assert.ok(recorded.baselinePath)
  assert.ok(recorded.baselinePath.startsWith(home), `基准必须落在中心 home: ${recorded.baselinePath}`)
  assert.equal(
    await readdir(path.join(project, '.clue')).catch(() => null), null,
    'M9: 工作区目录里不再出现 .clue/',
  )
  assert.match(recorded.report, /pending human confirmation/)

  const compared = await inspectPage({
    projectRoot: project, page: 'sample.html', mode: 'compare',
    maskSelectors: ['.volatile'], home,
  })
  assert.ok(compared.diff)
  assert.equal(compared.diff.identical, true)
  assert.match(compared.report, /identical to the baseline/)
  assert.match(compared.report, /has not been human-confirmed/)

  const confirmed = await inspectPage({ projectRoot: project, page: 'sample.html', mode: 'confirm', home })
  assert.equal(confirmed.baseline?.confirmed, true)
})

test('real-browser pitfalls: tab-order loss and low contrast are caught', { skip }, async (t) => {
  const { project, home } = await freshProject()
  t.after(() => rm(path.dirname(project), { recursive: true, force: true }))

  const result = await inspectPage({
    projectRoot: project, page: 'sample.html', mode: 'show',
    maskSelectors: ['.volatile'],
  })
  assert.ok(result.snapshot)
  const failed = result.snapshot.assertions.filter((a) => !a.pass).map((a) => a.name)
  assert.ok(failed.some((n) => n.includes('can be reached via Tab')), `未抓到 Tab 顺序坑: ${failed.join(', ')}`)
  assert.ok(failed.some((n) => n.includes('text contrast')), `未抓到对比度坑: ${failed.join(', ')}`)
  // Evidence gate: the planted pitfalls make exitOk false (scriptable signal).
  assert.equal(result.exitOk, false)
})

test('baseline lifecycle: edit source → stale flag + moved/relation diff', { skip }, async (t) => {
  const { project, home } = await freshProject()
  t.after(() => rm(path.dirname(project), { recursive: true, force: true }))

  await inspectPage({ projectRoot: project, page: 'sample.html', mode: 'record', maskSelectors: ['.volatile'], home })

  // Break the layout the way real bugs do: the form goes vertical, so the
  // submit button drops from "beside the input" to "below the input".
  const file = path.join(project, 'sample.html')
  const html = await readFile(file, 'utf8')
  await writeFile(file, html.replace(
    'form[data-module="search-form"] { display: flex;',
    'form[data-module="search-form"] { display: flex; flex-direction: column;',
  ), 'utf8')

  const compared = await inspectPage({
    projectRoot: project, page: 'sample.html', mode: 'compare',
    maskSelectors: ['.volatile'], home,
  })
  assert.ok(compared.diff)
  assert.equal(compared.stale, true, '源文件变了必须标 stale(待复核)')
  assert.match(compared.report, /baseline is stale/)
  const moved = compared.diff.entries.find((e) => e.kind === 'moved' && e.label.includes('搜索'))
  assert.ok(moved, `未见按钮移动条目: ${compared.diff.entries.map((e) => `${e.kind}:${e.label}`).join(', ')}`)
  assert.match(moved.detail, /moved down/)
  assert.match(moved.detail, /relations changed/)
  assert.equal(compared.exitOk, false)
})

test('M7 dogfood finding: marked controls keep interactive facts (tab assertion fires)', { skip }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-marked-'))
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, 'page.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body><main><form data-module="f">'
    + '<button data-module="go" type="submit" tabindex="-1">go</button></form></main></body></html>')
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await inspectPage({ projectRoot: project, page: 'page.html', mode: 'show' })
  const failed = (result.snapshot?.assertions ?? []).filter((a) => !a.pass).map((a) => a.name)
  assert.ok(failed.some((n) => n.includes('can be reached via Tab')),
    `带 data-module 的按钮必须吃到 Tab 断言(身份 marker、事实跟随元素): ${failed.join(' | ')}`)
  assert.equal(result.exitOk, false)
})
