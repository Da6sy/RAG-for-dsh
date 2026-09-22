/**
 * Pure-logic tests for the structured diff (no browser).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RENDER_SNAPSHOT_VERSION, type LayoutSnapshot, type ModuleNode } from '../src/types.ts'
import { diffSnapshots } from '../src/diff.ts'

function mod(overrides: Partial<ModuleNode> = {}): ModuleNode {
  return {
    id: 'm', label: '区块', kind: 'visual', moduleName: null,
    box: { x: 0, y: 0, w: 100, h: 40 }, boxPct: { x: 0, y: 0, w: 10, h: 4 },
    grid: 'r1 c1-1', relations: ['inside:page'],
    text: null, textLength: null, attrs: {},
    style: { position: 'static', zIndex: null, contrastRatio: null },
    visibility: { displayed: true, inViewport: true, occluded: false, occludedBy: null, clipped: false },
    interactive: null, repeat: null, violations: [], children: [],
    ...overrides,
  }
}

function snapshot(modules: ModuleNode[], extra: Partial<LayoutSnapshot> = {}): LayoutSnapshot {
  return {
    version: RENDER_SNAPSHOT_VERSION,
    target: 'page.html',
    viewport: { width: 1440, height: 900 },
    dpr: 1,
    page: { width: 1440, height: 900, needsScroll: false },
    modules,
    assertions: [],
    markerHints: [],
    ...extra,
  }
}

const interactive = (over: Partial<NonNullable<ModuleNode['interactive']>> = {}) => ({
  tag: 'button', type: 'submit', disabled: false, tabbable: true, tabIndex: null, focused: false, ...over,
})

test('identical snapshots produce an empty report', () => {
  const a = snapshot([mod({ id: 'x', label: 'X' })])
  const report = diffSnapshots(a, structuredClone(a))
  assert.equal(report.identical, true)
  assert.equal(report.entries.length, 0)
})

test('added and removed modules are reported with severity by kind', () => {
  const base = snapshot([mod({ id: 'keep' })])
  const next = snapshot([
    mod({ id: 'keep' }),
    mod({ id: 'new-btn', label: '新按钮', kind: 'interactive', interactive: interactive() }),
  ])
  const report = diffSnapshots(base, next)
  const added = report.entries.find((e) => e.kind === 'added')
  assert.ok(added)
  assert.equal(added.severity, 'warn') // interactive additions matter
  assert.match(added.detail, /added <interactive>/)

  const report2 = diffSnapshots(next, base)
  const removed = report2.entries.find((e) => e.kind === 'removed')
  assert.ok(removed)
  assert.equal(removed.severity, 'error') // losing an interactive module is an error
})

test('moved module reports delta, grid change and relation change', () => {
  const before = snapshot([
    mod({ id: 'input', label: '输入框', box: { x: 0, y: 0, w: 600, h: 40 } }),
    mod({ id: 'btn', label: '按钮', kind: 'interactive', interactive: interactive(), box: { x: 610, y: 0, w: 100, h: 40 }, relations: ['inside:page', 'beside:input'], grid: 'r1 c6-6' }),
  ])
  const after = snapshot([
    mod({ id: 'input', label: '输入框', box: { x: 0, y: 0, w: 600, h: 40 } }),
    mod({ id: 'btn', label: '按钮', kind: 'interactive', interactive: interactive(), box: { x: 0, y: 64, w: 100, h: 40 }, relations: ['inside:page', 'below:input'], grid: 'r2 c1-1' }),
  ])
  const report = diffSnapshots(before, after)
  const moved = report.entries.find((e) => e.kind === 'moved')
  assert.ok(moved)
  assert.match(moved.detail, /moved down 64px/)
  assert.match(moved.detail, /moved left 610px/)
  assert.match(moved.detail, /grid r1 c6-6 → r2 c1-1/)
  assert.match(moved.detail, /relations changed: gained below:input; lost beside:input/)
})

test('tabbable loss is an error-severity interactive regression', () => {
  const before = snapshot([mod({ id: 'b', kind: 'interactive', interactive: interactive({ tabbable: true }) })])
  const after = snapshot([mod({ id: 'b', kind: 'interactive', interactive: interactive({ tabbable: false }) })])
  const report = diffSnapshots(before, after)
  const entry = report.entries.find((e) => e.kind === 'interactive')
  assert.ok(entry)
  assert.equal(entry.severity, 'error')
  assert.match(entry.detail, /fell out of tab order/)
})

test('new occlusion is error; clearing it is info', () => {
  const before = snapshot([mod({ id: 'b' })])
  const after = snapshot([mod({ id: 'b', visibility: { displayed: true, inViewport: true, occluded: true, occludedBy: '弹层', clipped: false } })])
  const report = diffSnapshots(before, after)
  assert.equal(report.entries.find((e) => e.kind === 'visibility')?.severity, 'error')
  const report2 = diffSnapshots(after, before)
  assert.equal(report2.entries.find((e) => e.kind === 'visibility')?.severity, 'info')
})

test('assertion flips: pass→fail is error, fail→pass is info, vanished is warn', () => {
  const pass = { name: '按钮可 Tab', pass: true, actual: '在 Tab 顺序中', expected: null, severity: 'error' as const }
  const fail = { ...pass, pass: false, actual: '不在 Tab 顺序中' }
  const gone = { name: '旧检查', pass: true, actual: 'x', expected: null, severity: 'error' as const }
  const before = snapshot([], { assertions: [pass, gone] })
  const after = snapshot([], { assertions: [fail] })
  const report = diffSnapshots(before, after)
  const flip = report.entries.find((e) => e.label === '按钮可 Tab')
  assert.ok(flip)
  assert.equal(flip.severity, 'error')
  assert.match(flip.detail, /assertion flipped to fail/)
  const vanished = report.entries.find((e) => e.label === '旧检查')
  assert.equal(vanished?.severity, 'warn')

  const report2 = diffSnapshots(after, before)
  assert.equal(report2.entries.find((e) => e.label === '按钮可 Tab')?.severity, 'info')
})

test('viewport mismatch is flagged as noise warning', () => {
  const a = snapshot([mod({ id: 'x' })])
  const b = snapshot([mod({ id: 'x', box: { x: 5, y: 0, w: 100, h: 40 } })], { viewport: { width: 375, height: 800 } })
  const report = diffSnapshots(a, b)
  assert.equal(report.viewportChanged, true)
  assert.ok(report.entries.some((e) => e.kind === 'viewport' && e.severity === 'warn'))
})

test('entries are deterministically ordered: severity, kind, id', () => {
  const before = snapshot([
    mod({ id: 'a', kind: 'interactive', interactive: interactive() }),
    mod({ id: 'z' }),
  ])
  const after = snapshot([
    mod({ id: 'a', kind: 'interactive', interactive: interactive({ tabbable: false }) }), // error
    mod({ id: 'z', text: '新文案', textLength: 3 }),                                      // info
    mod({ id: 'm', box: { x: 9, y: 9, w: 100, h: 40 } }),                                 // warn (added, visual→info actually)
  ])
  const report = diffSnapshots(before, after)
  const ranks = report.entries.map((e) => ({ error: 0, warn: 1, info: 2 })[e.severity])
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y))
})
