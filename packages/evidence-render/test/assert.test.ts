/**
 * Pure-logic tests for the built-in assertion library (no browser).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RENDER_SNAPSHOT_VERSION, type LayoutSnapshot, type ModuleNode } from '../src/types.ts'
import { runBuiltinAssertions } from '../src/assert.ts'

function mod(overrides: Partial<ModuleNode> = {}): ModuleNode {
  return {
    id: 'm', label: '区块', kind: 'visual', moduleName: null,
    box: { x: 0, y: 0, w: 100, h: 40 }, boxPct: { x: 0, y: 0, w: 10, h: 4 },
    grid: 'r1 c1-1', relations: [], text: null, textLength: null, attrs: {},
    style: { position: 'static', zIndex: null, contrastRatio: null },
    visibility: { displayed: true, inViewport: true, occluded: false, occludedBy: null, clipped: false },
    interactive: null, repeat: null, violations: [], children: [],
    ...overrides,
  }
}

function snapshot(modules: ModuleNode[]): LayoutSnapshot {
  return {
    version: RENDER_SNAPSHOT_VERSION, target: 'p.html',
    viewport: { width: 1440, height: 900 }, dpr: 1,
    page: { width: 1440, height: 900, needsScroll: false },
    modules, assertions: [], markerHints: [],
  }
}

const interactive = (over: Partial<NonNullable<ModuleNode['interactive']>> = {}) => ({
  tag: 'button', type: 'submit', disabled: false, tabbable: true, tabIndex: null, focused: false, ...over,
})

test('the flagship pitfall: a button out of the tab order fails its assertion', () => {
  const results = runBuiltinAssertions(snapshot([
    mod({ id: 'main', label: '主区域', kind: 'landmark' }),
    mod({
      id: 'float', label: '悬浮操作按钮', kind: 'interactive',
      interactive: interactive({ tabbable: false, tabIndex: -1 }),
    }),
  ]))
  const tabCheck = results.find((r) => r.name.includes('可被 Tab 选中'))
  assert.ok(tabCheck)
  assert.equal(tabCheck.pass, false)
  assert.equal(tabCheck.actual, '不在 Tab 顺序中')
})

test('occluded interactive module fails "未被遮挡"', () => {
  const results = runBuiltinAssertions(snapshot([
    mod({ id: 'main', label: '主区域', kind: 'landmark' }),
    mod({
      id: 'b', label: '按钮', kind: 'interactive', interactive: interactive(),
      visibility: { displayed: true, inViewport: true, occluded: true, occludedBy: '弹层', clipped: false },
    }),
  ]))
  const occlusion = results.find((r) => r.name.includes('未被遮挡'))
  assert.ok(occlusion)
  assert.equal(occlusion.pass, false)
  assert.match(occlusion.actual, /遮挡者: 弹层/)
})

test('low contrast fails with measured value; severity escalates below 3', () => {
  const warnLevel = runBuiltinAssertions(snapshot([
    mod({ id: 'main', label: '主区域', kind: 'landmark' }),
    mod({ id: 't', label: '灰字', text: '灰字', textLength: 2, style: { position: 'static', zIndex: null, contrastRatio: 3.9 } }),
  ]))
  const warn = warnLevel.find((r) => r.name.includes('对比度'))
  assert.ok(warn && !warn.pass)
  assert.equal(warn.severity, 'warn')
  assert.equal(warn.actual, '实测 3.9')

  const errorLevel = runBuiltinAssertions(snapshot([
    mod({ id: 'main', label: '主区域', kind: 'landmark' }),
    mod({ id: 't2', label: '浅字', text: '浅字', textLength: 2, style: { position: 'static', zIndex: null, contrastRatio: 2.1 } }),
  ]))
  assert.equal(errorLevel.find((r) => r.name.includes('对比度'))?.severity, 'error')
})

test('unrendered marker module fails; clipped marker warns', () => {
  const results = runBuiltinAssertions(snapshot([
    mod({ id: 'main', label: '主区域', kind: 'landmark' }),
    mod({
      id: 'search-bar', label: 'search-bar', kind: 'marker', moduleName: 'search-bar',
      visibility: { displayed: false, inViewport: false, occluded: false, occludedBy: null, clipped: true },
    }),
  ]))
  assert.equal(results.find((r) => r.name === '标记模块 search-bar 已渲染')?.pass, false)
  assert.equal(results.find((r) => r.name === '标记模块 search-bar 无溢出裁剪')?.pass, false)
})

test('exactly one main landmark: zero or two both warn', () => {
  const zero = runBuiltinAssertions(snapshot([mod({ id: 'h', label: '顶部栏', kind: 'landmark' })]))
  assert.equal(zero.find((r) => r.name.includes('main 地标'))?.pass, false)

  const two = runBuiltinAssertions(snapshot([
    mod({ id: 'm1', label: '主区域', kind: 'landmark' }),
    mod({ id: 'm2', label: '主区域', kind: 'landmark' }),
  ]))
  assert.equal(two.find((r) => r.name.includes('main 地标'))?.pass, false)

  const one = runBuiltinAssertions(snapshot([mod({ id: 'm1', label: '主区域', kind: 'landmark' })]))
  assert.equal(one.find((r) => r.name.includes('main 地标'))?.pass, true)
})

test('repeat expansions are walked too', () => {
  const results = runBuiltinAssertions(snapshot([
    mod({ id: 'main', label: '主区域', kind: 'landmark' }),
    mod({
      id: 'list', label: '结果列表', kind: 'group',
      repeat: {
        count: 8, firstBox: { x: 0, y: 0, w: 100, h: 40 }, gap: 8, structureSame: true,
        expanded: [mod({
          id: 'list>0', label: '首项按钮', kind: 'interactive',
          interactive: interactive({ tabbable: false }),
        })],
      },
    }),
  ]))
  assert.ok(results.some((r) => r.name.includes('首项按钮') && !r.pass))
})
