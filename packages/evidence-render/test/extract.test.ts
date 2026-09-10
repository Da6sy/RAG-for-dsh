/**
 * Extractor contract canaries (pure, no browser).
 *
 * The in-page extractor is shipped to the browser via `page.evaluate`, which
 * serializes ONLY the function text. Two classes of contamination break it:
 *   1. module-scope references (imports/closures) — banned by code review;
 *   2. TRANSPILER-INJECTED helpers — invisible in source, e.g. tsx/esbuild's
 *      keepNames wraps every named inner function in `__name(...)`, which
 *      then throws ReferenceError inside the page (this actually happened;
 *      see 开发记录 踩坑 #9). The project runs on Node's native type
 *      stripping precisely because it injects nothing. This canary fails
 *      loudly if a runtime change ever reintroduces helper injection.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_EXTRACT_CONFIG, extractInPage } from '../src/extract.ts'

test('CANARY: in-page extractor references no transpiler helpers', () => {
  const source = extractInPage.toString()
  const helpers = [...new Set(source.match(/__[A-Za-z]+\s*\(/g) ?? [])]
  assert.deepEqual(
    helpers,
    [],
    `页内提取器引用了转译器助手 ${helpers.join(', ')} —— page.evaluate 只携带函数本体,`
    + '助手不会跟过去,浏览器里必然 ReferenceError。请保持 Node 原生类型剥离运行'
    + '(不要改回 tsx/esbuild keepNames 一类会注入助手的转译器)。',
  )
})

test('CANARY: extractor stays self-contained (no module-scope identifiers)', () => {
  // Cheap structural guard: the serialized function must not reference the
  // obvious module-scope names of this package. Not exhaustive — the runtime
  // canary above is the real gate; this one teaches the rule at review time.
  const source = extractInPage.toString()
  for (const banned of ['DEFAULT_EXTRACT_CONFIG', 'RENDER_SNAPSHOT_VERSION', 'require(', 'import(']) {
    assert.ok(!source.includes(banned), `extractInPage references module scope: ${banned}`)
  }
})

test('extract defaults are sane and deterministic', () => {
  const cfg = DEFAULT_EXTRACT_CONFIG
  assert.ok(cfg.depthCap > 0)
  assert.ok(cfg.siblingCollapseMin >= 2)
  assert.ok(cfg.expandItems >= 1)
  assert.ok(cfg.gridRowPx > 0)
  assert.ok(cfg.textCap > 0)
  assert.equal(cfg.maskAttr, 'data-clue-masked')
})
