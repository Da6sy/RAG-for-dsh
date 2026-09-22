/**
 * V0–V2 — the architecture invariants of the vector layer (规划 §13).
 *
 * Two claims that no amount of unit testing inside the engine can make, because
 * they are claims about the SHAPE of the code rather than about its behavior:
 *
 * 1. **引擎零 dsh 依赖** (不变量 6): `packages/{kb,rag}` may not import
 *    `@deepseek-ai/*`. This is what makes the embedding call a PORT instead of
 *    a convenience: the moment the engine could reach a dsh service it would
 *    start reaching one, and the engine would stop being testable without a
 *    host. The check reads the source tree, so it also catches a type-only
 *    import — those are exactly the ones that look harmless.
 * 2. **引擎之间不横向依赖** (the same discipline the M9 modules stated): `kb`
 *    is the knowledge engine and `rag` builds on it, never the reverse. A
 *    `kb → rag` import would make the storage layer depend on the retrieval
 *    layer, and the dependency cycle would be invisible until something had to
 *    be rebuilt.
 *
 * These are cheap to run and impossible to satisfy by accident, which is the
 * point: a boundary that is not tested is a boundary that the next refactor
 * crosses.
 *
 * @module @clue-harness/rag/test/architecture
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')

/** Every `.ts` file under one directory, recursively. */
async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await sourceFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** The import specifiers of one file (static `import`/`export … from` forms). */
function importsOf(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s+['"]([^'"]+)['"]/gm)) specifiers.push(match[1] as string)
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specifiers.push(match[1] as string)
  return specifiers
}

test('不变量 6: 引擎(kb/rag)不得 import 任何 @deepseek-ai/* —— 嵌入只能经端口注入', async () => {
  for (const engine of ['kb', 'rag']) {
    const files = await sourceFiles(path.join(repoRoot, 'packages', engine, 'src'))
    assert.ok(files.length > 0, `packages/${engine}/src 里没有源文件?`)
    for (const file of files) {
      for (const specifier of importsOf(await readFile(file, 'utf8'))) {
        assert.equal(
          specifier.startsWith('@deepseek-ai/'),
          false,
          `${path.relative(repoRoot, file)} 依赖了 ${specifier}(引擎必须零 dsh 依赖,网络与凭据都在 face 层)`,
        )
      }
    }
  }
})

test('引擎不横向依赖: kb 不得 import @clue-harness/rag(存储层不依赖检索层)', async () => {
  for (const file of await sourceFiles(path.join(repoRoot, 'packages', 'kb', 'src'))) {
    for (const specifier of importsOf(await readFile(file, 'utf8'))) {
      assert.equal(
        specifier.startsWith('@clue-harness/rag'),
        false,
        `${path.relative(repoRoot, file)} 依赖了 ${specifier}(kb 是治理与存储引擎,rag 建在它上面,反向依赖会成环)`,
      )
    }
  }
})

test('R2 不变量 7: k1 / b 只在 kb 的 bm25.ts 出现一处字面量', async () => {
  const files = await sourceFiles(path.join(repoRoot, 'packages'))
  const offenders: string[] = []
  for (const file of files) {
    const relative = path.relative(repoRoot, file)
    if (relative.endsWith(path.join('kb', 'src', 'bm25.ts'))) continue
    const source = await readFile(file, 'utf8')
    // `1.2` / `0.75` written as BM25 constants anywhere else is the third
    // repetition of the "same constant, two files" accident the plan forbids.
    if (/(BM25_K1|BM25_B)\s*[:=]\s*(1\.2|0\.75)/.test(source)) offenders.push(relative)
    if (/k1\s*[:=]\s*1\.2/.test(source)) offenders.push(relative)
  }
  assert.deepEqual(offenders, [], '这些文件自己写了 BM25 常量(应 import BM25_K1 / BM25_B)')
})

test('不变量 8 的钉子: embedderVersion 只有 types.ts 一个出处', async () => {
  const files = await sourceFiles(path.join(repoRoot, 'packages'))
  const offenders: string[] = []
  for (const file of files) {
    const relative = path.relative(repoRoot, file)
    if (relative.endsWith(path.join('kb', 'src', 'types.ts'))) continue
    const source = await readFile(file, 'utf8')
    // The stamp's shape (`@dim=` + the norm version) written by hand anywhere
    // else is exactly the M9 `chunkerVersion` accident waiting to recur: three
    // literals, one of them stale, and every query decides to rebuild.
    if (/@dim=\$\{|@dim='|@dim="/.test(source) && !/embedderVersion\(/.test(source)) {
      offenders.push(relative)
    }
  }
  assert.deepEqual(offenders, [], '这些文件自己拼了 embedderVersion 字符串(应调用 embedderVersion())')
})

test('落地计划 §2-1: indexVersion 只在 kb 的 types.ts 生成一处', async () => {
  const files = await sourceFiles(path.join(repoRoot, 'packages'))
  const offenders: string[] = []
  for (const file of files) {
    const relative = path.relative(repoRoot, file)
    if (relative.endsWith(path.join('kb', 'src', 'types.ts'))) continue
    if (relative.endsWith('architecture.test.ts')) continue
    const source = await readFile(file, 'utf8')
    // The same rule as `embedderVersion`: a hand-built stamp somewhere else is
    // how `chunkerVersion` ended up in three files with one of them stale, and
    // every query decided the ledger needed a rebuild.
    if (/'lexical-v1/.test(source) || /`lexical-v1/.test(source)) offenders.push(relative)
    if (/function\s+lexicalIndexVersion/.test(source)) offenders.push(relative)
  }
  assert.deepEqual(offenders, [], '这些文件自己拼了词法索引版本号(应调用 lexicalIndexVersion())')
})
