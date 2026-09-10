/**
 * Baseline store tests (no browser): round-trip, confirmation flow,
 * staleness detection, version refusal, path encoding.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RENDER_SNAPSHOT_VERSION, type LayoutSnapshot } from '../src/types.ts'
import {
  BASELINE_RECORD_VERSION,
  baselinePath,
  baselineSnapshot,
  confirmBaseline,
  encodeSegment,
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

test('baseline path lives with the workspace: <projectRoot>/.clue/render-baselines', () => {
  const file = baselinePath('/proj/root', 'pages/a.html')
  assert.equal(file, path.join('/proj/root', '.clue', 'render-baselines', 'pages-a-html.json'))
})

test('save → load round-trips; records start unconfirmed', async (t) => {
  const { home, project } = await tmpHome()
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) })

  const hashes = { 'search.html': await sourceHash(path.join(import.meta.dirname, 'fixtures/sample.html')) }
  const saved = await saveBaseline(project, snapshot(), hashes)
  assert.equal(saved.record.confirmed, false)

  const loaded = await loadBaseline(project, 'search.html')
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

  await saveBaseline(project, snapshot(), { 'search.html': 'h0' })
  const confirmed = await confirmBaseline(project, 'search.html')
  assert.equal(confirmed.confirmed, true)
  assert.ok(confirmed.confirmedAt !== null)
  const reloaded = await loadBaseline(project, 'search.html')
  assert.equal(reloaded?.confirmed, true)
})

test('confirming a missing baseline teaches the next step', async (t) => {
  const { home, project } = await tmpHome()
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) })
  await assert.rejects(() => confirmBaseline(project, 'nope.html'), /先运行 --record/)
})

test('isStale detects changed AND newly-bound source files', async (t) => {
  const { home, project } = await tmpHome()
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) })

  await saveBaseline(project, snapshot(), { 'search.html': 'aaa', 'style.css': 'bbb' })
  const record = (await loadBaseline(project, 'search.html'))!
  assert.equal(isStale(record, { 'search.html': 'aaa', 'style.css': 'bbb' }), false)
  assert.equal(isStale(record, { 'search.html': 'CHANGED', 'style.css': 'bbb' }), true)
  assert.equal(isStale(record, { 'search.html': 'aaa', 'style.css': 'bbb', 'new.js': 'ccc' }), true)
})

test('load refuses a foreign record version (no auto-migration)', async (t) => {
  const { home, project } = await tmpHome()
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); await rm(project, { recursive: true, force: true }) })

  const file = baselinePath(project, 'search.html')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 999 }), 'utf8')
  await assert.rejects(() => loadBaseline(project, 'search.html'), /版本不匹配/)
})

test('sourceHash is sha256 of bytes and stable', async () => {
  const fixture = path.join(import.meta.dirname, 'fixtures/sample.html')
  const a = await sourceHash(fixture)
  const b = await sourceHash(fixture)
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{64}$/)
})
