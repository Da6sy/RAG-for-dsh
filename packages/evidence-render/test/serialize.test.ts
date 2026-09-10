/**
 * Pure-logic tests for the snapshot vocabulary and its serializers.
 * No browser involved — determinism of the SERIALIZATION layer is proven
 * here; determinism of the CAPTURE layer (three runs byte-identical) is the
 * browser-gated test in browser.test.ts (M1-6).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RENDER_SNAPSHOT_VERSION,
  type LayoutSnapshot,
  type ModuleNode,
} from '../src/types.ts'
import {
  parseSnapshotJson,
  serializeSnapshotJson,
  serializeSnapshotText,
  stableStringify,
} from '../src/serialize.ts'

/** Build a fully-populated module with sane defaults. */
function mod(overrides: Partial<ModuleNode> = {}): ModuleNode {
  return {
    id: 'm',
    label: '区块',
    kind: 'visual',
    moduleName: null,
    box: { x: 0, y: 0, w: 10, h: 10 },
    boxPct: { x: 0, y: 0, w: 100, h: 100 },
    grid: 'r1 c1-12',
    relations: [],
    text: null,
    textLength: null,
    attrs: {},
    style: { position: 'static', zIndex: null, contrastRatio: null },
    visibility: { displayed: true, inViewport: true, occluded: false, occludedBy: null, clipped: false },
    interactive: null,
    repeat: null,
    violations: [],
    children: [],
    ...overrides,
  }
}

/** The representative fixture: markers, landmarks, interactive states, a
 * folded repeat group, an out-of-viewport footer, pass+fail assertions. */
function fixture(): LayoutSnapshot {
  return {
    version: RENDER_SNAPSHOT_VERSION,
    target: 'search.html',
    viewport: { width: 1440, height: 900 },
    dpr: 1,
    page: { width: 1440, height: 1024, needsScroll: true },
    modules: [
      mod({
        id: 'header', label: '顶部栏', kind: 'landmark',
        box: { x: 0, y: 0, w: 1440, h: 64 },
        children: [
          mod({ id: 'header>logo', label: 'logo', box: { x: 24, y: 16, w: 32, h: 32 }, grid: 'r1 c1-1' }),
        ],
      }),
      mod({
        id: 'main', label: '主区域', kind: 'landmark',
        box: { x: 0, y: 64, w: 1440, h: 772 }, grid: 'r2 c1-12',
        children: [
          mod({
            id: 'search-bar', label: '搜索栏', kind: 'marker', moduleName: 'search-bar',
            box: { x: 320, y: 96, w: 800, h: 48 }, grid: 'r2 c4-9',
            relations: ['inside:main'],
            children: [
              mod({
                id: 'search-input', label: '搜索输入框', kind: 'interactive',
                box: { x: 320, y: 96, w: 680, h: 48 }, grid: 'r2 c4-8',
                relations: ['inside:search-bar'],
                attrs: { placeholder: '搜索…' },
                interactive: { tag: 'input', type: 'text', disabled: false, tabbable: true, tabIndex: null, focused: true },
              }),
              mod({
                id: 'search-submit', label: '搜索按钮', kind: 'interactive',
                box: { x: 1008, y: 96, w: 112, h: 48 }, grid: 'r2 c9-9',
                relations: ['inside:search-bar', 'sibling-after:search-input'],
                attrs: { type: 'submit' },
                style: { position: 'static', zIndex: null, contrastRatio: 6.8 },
                interactive: { tag: 'button', type: 'submit', disabled: false, tabbable: false, tabIndex: null, focused: false },
                text: '搜索', textLength: 2,
                violations: ['不在 Tab 顺序中'],
              }),
            ],
          }),
          mod({
            id: 'results', label: '结果列表', kind: 'group',
            box: { x: 320, y: 232, w: 800, h: 560 }, grid: 'r4 c4-9',
            repeat: {
              count: 12,
              firstBox: { x: 320, y: 232, w: 800, h: 64 },
              gap: 16,
              structureSame: true,
              expanded: [
                mod({
                  id: 'results>0', label: '结果项',
                  box: { x: 320, y: 232, w: 800, h: 64 }, grid: 'r4 c4-9',
                  text: '标题 + 摘要', textLength: 30,
                }),
              ],
            },
          }),
        ],
      }),
      mod({
        id: 'footer', label: '页脚', kind: 'landmark',
        box: { x: 0, y: 936, w: 1440, h: 88 }, grid: 'r16 c1-12',
        visibility: { displayed: true, inViewport: false, occluded: false, occludedBy: null, clipped: false },
      }),
    ],
    assertions: [
      { name: '搜索按钮在 form 内', pass: true, actual: '在 form#search 内', expected: null, severity: 'error' },
      { name: '搜索按钮可被 Tab 选中', pass: false, actual: '不在 Tab 顺序中', expected: '可 Tab', severity: 'error' },
    ],
    markerHints: ['main>div.area (600×400) 面积大且结构复杂但没有 data-module 标记,建议添加'],
  }
}

/** The golden text tree — bytes, not vibes. Any serializer change must
 * update this golden deliberately (that is the point). */
const GOLDEN_TEXT = `页面 search.html  视口 1440×900 dpr 1  页面总高 1024 (需滚动)

├─ 顶部栏 <landmark>  (0, 0, 1440, 64)  grid r1 c1-12
│  └─ logo <visual>  (24, 16, 32, 32)  grid r1 c1-1
├─ 主区域 <landmark>  (0, 64, 1440, 772)  grid r2 c1-12
│  ├─ 搜索栏 <marker>  (320, 96, 800, 48)  grid r2 c4-9  inside:main
│  │  ├─ 搜索输入框 <interactive>  (320, 96, 680, 48)  grid r2 c4-8  inside:search-bar  placeholder="搜索…"  可交互 · 可Tab · 当前聚焦
│  │  └─ 搜索按钮 <interactive>  (1008, 96, 112, 48)  grid r2 c9-9  inside:search-bar · sibling-after:search-input  type="submit"  可交互 · 对比度6.8 · ⚠ 不在 Tab 顺序中  文本 "搜索"
│  └─ 结果列表 <group>  (320, 232, 800, 560)  grid r4 c4-9  ×12结构一致间距16
│     └─ 结果项 <visual>  (320, 232, 800, 64)  grid r4 c4-9  文本 "标题 + 摘要"…(共30字)
└─ 页脚 <landmark>  (0, 936, 1440, 88)  grid r16 c1-12  视口外

检查:
  ✓ [error] 搜索按钮在 form 内  实际: 在 form#search 内
  ✗ [error] 搜索按钮可被 Tab 选中  实际: 不在 Tab 顺序中  期望: 可 Tab

标记提示:
  - main>div.area (600×400) 面积大且结构复杂但没有 data-module 标记,建议添加
`

test('text serialization matches the golden bytes exactly', () => {
  assert.equal(serializeSnapshotText(fixture()), GOLDEN_TEXT)
})

test('text serialization is deterministic across repeated runs', () => {
  const first = serializeSnapshotText(fixture())
  const second = serializeSnapshotText(fixture())
  const third = serializeSnapshotText(fixture())
  assert.equal(first, second)
  assert.equal(second, third)
})

test('json serialization round-trips to an equal snapshot', () => {
  const snapshot = fixture()
  const parsed = parseSnapshotJson(serializeSnapshotJson(snapshot))
  assert.deepEqual(parsed, snapshot)
})

test('json bytes never depend on property insertion order', () => {
  const a = fixture()
  const b = fixture()
  // Rebuild one module with shuffled key insertion order.
  const shuffled = b.modules[2]
  b.modules[2] = JSON.parse(`{${Object.entries(shuffled).reverse().map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}`) as typeof shuffled
  assert.equal(serializeSnapshotJson(a), serializeSnapshotJson(b))
})

test('parse refuses a foreign snapshot version (no auto-migration)', () => {
  const bytes = serializeSnapshotJson({ ...fixture(), version: 999 as typeof RENDER_SNAPSHOT_VERSION })
  assert.throws(() => parseSnapshotJson(bytes), /版本不匹配/)
})

test('parse refuses a malformed snapshot', () => {
  assert.throws(() => parseSnapshotJson('{"version":1}'), /格式错误/)
})

test('stableStringify sorts object keys recursively', () => {
  assert.equal(stableStringify({ b: 1, a: { d: [3, { f: 6, e: 5 }] } }, 0), '{"a":{"d":[3,{"e":5,"f":6}]},"b":1}')
})
