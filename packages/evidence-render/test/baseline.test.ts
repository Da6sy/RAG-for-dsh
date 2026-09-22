/**
 * Baseline store tests (no browser): round-trip, confirmation flow,
 * staleness detection, version refusal, path encoding.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RENDER_SNAPSHOT_VERSION, type LayoutSnapshot } from '../src/types.ts'
import {
  BASELINE_RECORD_VERSION,
  baselinePath,
  baselineSnapshot,
  baselinesDir,
  confirmBaseline,
  encodeSegment,
  externalAssetsOf,
  isStale,
  loadBaseline,
  saveBaseline,
  sourceHash,
} from '../src/baseline.ts'

function snapshot(target = 'search.html'): LayoutSnapshot {
  return {
    version: RENDER_SNAPSHOT_VERSION,
    target,
    viewport: { width: 1440, height: 900 },
    dpr: 1,
    page: { width: 1440, height: 1200, needsScroll: true },
    modules: [],
    assertions: [{ name: 'x', pass: true, actual: 'ok', expected: null, severity: 'error' }],
    markerHints: [],
  }
}

async function tmpHome(): Promise<{ home: string; project: string }> {
  const home = await mkdtemp(path.join(tmpdir(), 'clue-home-'))
  const project = await mkdtemp(path.join(tmpdir(), 'clue-proj-'))
  return { home, project }
}

test('encodeSegment is path-safe and stable', () => {
  assert.equal(encodeSegment('/home/daisy/app/clue-harness'), '-home-daisy-app-clue-harness')
  assert.equal(encodeSegment('a/b c.html'), 'a-b-c-html')
  assert.equal(encodeSegment('x'), encodeSegment('x'))
})

test('baseline path is central and workspace-keyed: <home>/baselines/<key>', async () => {
  const { home, project } = await tmpHome()
  const file = await baselinePath(project, 'pages/a.html', home)
  assert.equal(path.dirname(file), path.join(home, 'baselines', path.basename(await baselinesDir(project, home))))
  assert.equal(file, path.join(await baselinesDir(project, home), 'pages-a-html.json'))
  // The workspace directory carries nothing of ours (M9).
  assert.equal((await readdir(project)).length, 0)
})

test('two workspaces with the same basename get distinct central keys', async () => {
  const { home } = await tmpHome()
  const one = await mkdtemp(path.join(tmpdir(), 'clue-same-'))
  const two = await mkdtemp(path.join(tmpdir(), 'clue-same-'))
  const nested = path.join(one, 'site')
  await mkdir(nested, { recursive: true })
  const d1 = await baselinesDir(nested, home)
  const d2 = await baselinesDir(two, home)
  assert.notEqual(d1, d2)
  assert.ok(d1.includes('-site'))
})

test('save → load round-trips; records start unconfirmed', async (t) => {
  const { home, project } = await tmpHome()
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) })

  const hashes = { 'search.html': await sourceHash(path.join(import.meta.dirname, 'fixtures/sample.html')) }
  const saved = await saveBaseline(project, snapshot(), hashes, home)
  assert.equal(saved.record.confirmed, false)

  const loaded = await loadBaseline(project, 'search.html', home)
  assert.ok(loaded)
  assert.equal(loaded.version, BASELINE_RECORD_VERSION)
  assert.deepEqual(loaded.sourceHashes, hashes)
  assert.deepEqual(baselineSnapshot(loaded), snapshot())
  assert.ok(loaded.savedAt.length > 0)
  assert.equal(loaded.confirmedAt, null)
})

test('confirm flips the record and stamps confirmedAt', async (t) => {
  const { home, project } = await tmpHome()
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) })

  await saveBaseline(project, snapshot(), { 'search.html': 'h0' }, home)
  const confirmed = await confirmBaseline(project, 'search.html', home)
  assert.equal(confirmed.confirmed, true)
  assert.ok(confirmed.confirmedAt !== null)
  const reloaded = await loadBaseline(project, 'search.html', home)
  assert.equal(reloaded?.confirmed, true)
})

test('confirming a missing baseline teaches the next step', async (t) => {
  const { home, project } = await tmpHome()
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) })
  await assert.rejects(() => confirmBaseline(project, 'nope.html', home), /先运行 --record/)
})

test('isStale detects changed AND newly-bound source files', async (t) => {
  const { home, project } = await tmpHome()
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) })

  await saveBaseline(project, snapshot(), { 'search.html': 'aaa', 'style.css': 'bbb' }, home)
  const record = (await loadBaseline(project, 'search.html', home))!
  assert.equal(isStale(record, { 'search.html': 'aaa', 'style.css': 'bbb' }), false)
  assert.equal(isStale(record, { 'search.html': 'CHANGED', 'style.css': 'bbb' }), true)
  assert.equal(isStale(record, { 'search.html': 'aaa', 'style.css': 'bbb', 'new.js': 'ccc' }), true)
})

test('load refuses a foreign record version (no auto-migration)', async (t) => {
  const { home, project } = await tmpHome()
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) })

  const file = await baselinePath(project, 'search.html', home)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 999 }), 'utf8')
  await assert.rejects(() => loadBaseline(project, 'search.html', home), /版本不匹配/)
})

test('sourceHash is sha256 of bytes and stable', async () => {
  const fixture = path.join(import.meta.dirname, 'fixtures/sample.html')
  const a = await sourceHash(fixture)
  const b = await sourceHash(fixture)
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
})

// ── §9 of the 落地计划: 基准要绑页面的外链样式/脚本,不能只绑页面文件本身 ──
test('externalAssetsOf 只取本地样式与脚本,跳过远程/内联/重复', () => {
  const html = [
    '<html><head>',
    '<link rel="stylesheet" href="style.css">',
    "<link rel='stylesheet' href='./sub/theme.css'>",
    '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
    '<link rel="icon" href="favicon.ico">',
    '<script src="app.js"></script>',
    '<script src="//cdn.example.com/lib.js"></script>',
    '<script>const inline = 1;</script>',
    '<script src="app.js"></script>',
    '</head></html>',
  ].join('\n')
  assert.deepEqual(externalAssetsOf(html), ['./sub/theme.css', 'app.js', 'style.css'])
})

test('§9 回归:改了页面引用的外部 CSS,基准必须变 stale', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-baseline-assets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(path.join(root, 'search.html'), '<link rel="stylesheet" href="style.css"><h1>Search</h1>', 'utf8')
  await writeFile(path.join(root, 'style.css'), ':root { --ink: #111; }', 'utf8')

  const pageRel = 'search.html'
  const hashes: Record<string, string> = { [pageRel]: await sourceHash(path.join(root, pageRel)) }
  const pageHtml = await readFile(path.join(root, pageRel), 'utf8')
  for (const asset of externalAssetsOf(pageHtml)) {
    hashes[asset.replace(/^\.\//, '')] = await sourceHash(path.join(root, asset.replace(/^\.\//, '')))
  }
  const saved = await saveBaseline(root, snapshot(pageRel), hashes)
  const record = saved.record
  assert.deepEqual(Object.keys(record.sourceHashes).sort(), ['search.html', 'style.css'])

  // 只改外部 CSS:哈希变了 ⇒ stale(这正是旧采集端看不见的那种改动)
  const afterCss = { ...hashes, 'style.css': await sourceHash(path.join(root, 'style.css')).then(() => 'CHANGED') }
  assert.equal(isStale(record, afterCss), true, '外链 CSS 变了必须标 stale')
  assert.equal(isStale(record, hashes), false, '什么都没改时不得误报')
})
