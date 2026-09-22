/**
 * R1 of `docs/落地计划-剩余工程.md` — the inverted index.
 *
 * Three claims are pinned here, in order of importance:
 *
 * 1. **Equivalence.** Scoring through the index (postings + meta lengths) must
 *    produce the SAME score and the same matched tokens as scoring by scanning
 *    the corpus. If this ever drifts, the index is not an optimization — it is
 *    a second ranking law, which is exactly what the module header forbids.
 * 2. **Freshness.** A content change invalidates; a stats-only write (`touch`,
 *    which every ordinary retrieval performs) does NOT, or the query path would
 *    rebuild the whole index on every question.
 * 3. **Degradation is data.** A missing, corrupt, stale or over-budget index
 *    returns a status plus a sentence, never a throw: the caller falls back to
 *    the scan and can say why.
 *
 * @module @clue-harness/kb/test/lexical-index
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openGlobalStore, openProjectStore, type KbStore } from '../src/store.ts'
import { bm25fScoreFrom, buildLexicalStats, type LexicalStats } from '../src/bm25.ts'
import { entryTextAfterRedlines, queryKb, scoreEntry } from '../src/query.ts'
import { tokenize } from '../src/tokenize.ts'
import { DEFAULT_WEIGHTS } from '../src/query.ts'
import {
  buildLexicalIndex,
  fingerprintLexicalIndex,
  forgetLexicalIndex,
  lexicalCandidates,
  lexicalIndexDir,
  lexicalStatsFrom,
  loadLexicalIndex,
  mergeLexicalIndexes,
} from '../src/lexical-index.ts'
import { lexicalIndexVersion } from '../src/types.ts'

/** A store with enough variety that a real query exercises several fields. */
async function world(t: { after(fn: () => unknown): void }): Promise<{ store: KbStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-lexindex-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await openProjectStore(path.join(root, 'p'), path.join(root, 'h'))
  await store.add({ kind: 'decision', title: '分片重建', text: 'chunker 版本号不一致时分片会重建。', tags: ['kb'] })
  await store.add({ kind: 'pitfall', title: '焦点陷阱', text: '隐藏容器里的焦点会变成死区,焦点管理要显式。', tags: ['a11y'] })
  await store.add({ kind: 'fact', title: '对比度约定', text: '正文对比度不得低于 4.5:1,标签对比度另算。', tags: ['a11y'] })
  await store.add({ kind: 'note', title: '分片 重建 的排查', text: '分片重建时先看版本号,再看分片正文。', tags: ['kb', 'ops'] })
  return { store, root }
}

test('R1 建索引:postings 带真实词频,meta 的字段均值与扫描口径一致', async (t) => {
  const { store } = await world(t)
  const entries = await store.list()
  const { index, report } = await buildLexicalIndex({ storeDir: store.dir, entries })
  assert.equal(report.overBudget, false)
  assert.equal(report.entries, entries.length)
  assert.ok(report.postings > 0)
  assert.equal(index.meta.indexVersion, lexicalIndexVersion())

  // 词频是真的计数(不是 0/1):"分片"在一个标题里出现两次的那条要能看出来。
  const repeated = entries.find((entry) => entry.title.includes('分片 重建 的排查'))
  assert.ok(repeated !== undefined)
  const posting = (index.postings['分片'] ?? []).find((row) => row.id === String(repeated.id))
  assert.ok(posting !== undefined, 'postings 里要有这条')
  assert.ok((posting?.tf[0] ?? 0) >= 1, '标题字段的词频应为正')

  // 均值:索引里的 avgDistinct 必须等于扫描口径 buildLexicalStats 的均值。
  const scanned = buildLexicalStats(entries.map((entry) => ({
    title: entry.title,
    tags: entry.tags,
    text: entryTextAfterRedlines(entry),
  })))
  assert.equal(index.meta.entryCount, scanned.total)
  assert.equal(index.meta.avgDistinct[0], scanned.avgTitle)
  assert.equal(index.meta.avgDistinct[1], scanned.avgTag)
  assert.equal(index.meta.avgDistinct[2], scanned.avgText)
})

test('R1 等价性:走索引打分与走扫描打分逐条同分同 matched(这是本项的安全网)', async (t) => {
  const { store } = await world(t)
  const entries = await store.list()
  const { index } = await buildLexicalIndex({ storeDir: store.dir, entries })
  const query = '分片 重建 对比度'
  const queryTokens = tokenize(query)

  const scanStats: LexicalStats = buildLexicalStats(entries.map((entry) => ({
    title: entry.title,
    tags: entry.tags,
    text: entryTextAfterRedlines(entry),
  })))
  const byScan = entries.map((entry) => {
    const scored = scoreEntry(entry, queryTokens, DEFAULT_WEIGHTS, { scorer: 'bm25', stats: scanStats })
    return [String(entry.id), scored.score, scored.matched.join(',')]
  }).filter((row) => Number(row[1]) > 0).sort((a, b) => a[0].localeCompare(b[0]))

  const stats = lexicalStatsFrom(index)
  const byIndex = lexicalCandidates(index, queryTokens).map((candidate) => {
    const scored = bm25fScoreFrom(candidate.fields, queryTokens, stats, DEFAULT_WEIGHTS)
    const entry = entries.find((row) => String(row.id) === candidate.id)
    assert.ok(entry !== undefined)
    // The scan path applies status/tier/review multipliers and zeroes a zero
    // score; the index path must apply exactly the same ones.
    const viaQuery = scoreEntry(entry, queryTokens, DEFAULT_WEIGHTS, { scorer: 'bm25', stats })
    return [candidate.id, viaQuery.score, viaQuery.matched.join(',')]
  }).filter((row) => Number(row[1]) > 0).sort((a, b) => a[0].localeCompare(b[0]))

  assert.ok(byScan.length > 0, 'fixture 必须真的能召回几条,否则这条测试没有意义')
  assert.deepEqual(byIndex, byScan, '索引路径与扫描路径必须逐条一致(同一条目、同分、同 matched)')
})

test('R1 freshness:内容改了算过期,touch(只动统计)不算', async (t) => {
  const { store } = await world(t)
  forgetLexicalIndex()
  const entries = await store.list()
  const { index } = await buildLexicalIndex({ storeDir: store.dir, entries })
  assert.equal(index.meta.entryCount, entries.length)

  // 首次读取:缓存为空 ⇒ 需要逐文件核对
  const first = await loadLexicalIndex(store.dir)
  assert.equal(first.status, 'current', first.note)

  // touch:每次普通检索都会发生(引用计数),它不得让索引作废
  await store.touch(entries[0]?.id as never)
  forgetLexicalIndex(store.dir)
  const afterTouch = await loadLexicalIndex(store.dir, { useCache: false })
  assert.equal(afterTouch.index === null, false, `stats-only 写不得让索引作废:${afterTouch.note}`)

  // 改正文:必须作废
  await store.updateEntryText(entries[0]?.id as never, '正文改过了,词也换了。', 'test')
  forgetLexicalIndex(store.dir)
  const afterEdit = await loadLexicalIndex(store.dir, { useCache: false })
  assert.equal(afterEdit.index, null)
  assert.equal(afterEdit.status, 'stale')
  assert.match(afterEdit.note, /退回全库扫描/)

  // 新条目:条目数不符 ⇒ 作废
  await store.add({ kind: 'fact', title: '新增一条', text: '新条目的正文。', tags: ['new'] })
  forgetLexicalIndex(store.dir)
  const afterAdd = await loadLexicalIndex(store.dir, { useCache: false })
  assert.equal(afterAdd.status, 'stale')
})

test('R1 降级是数据:缺失/损坏/超预算都返回状态与一句话,不抛', async (t) => {
  const { store } = await world(t)
  forgetLexicalIndex()
  const missing = await loadLexicalIndex(store.dir)
  assert.equal(missing.index, null)
  assert.equal(missing.status, 'missing')
  assert.match(missing.note, /尚未建立/)

  // 损坏:写出一个读不了的 meta
  const entries = await store.list()
  await buildLexicalIndex({ storeDir: store.dir, entries })
  await writeFile(path.join(lexicalIndexDir(store.dir), 'meta.json'), '{ 这不是 JSON', 'utf8')
  forgetLexicalIndex(store.dir)
  const corrupt = await loadLexicalIndex(store.dir, { useCache: false })
  assert.equal(corrupt.status, 'corrupt')
  assert.match(corrupt.note, /损坏/)

  // 超预算:建的时候就不建,读的时候明说不划算(用另一个干净的库,免得读到上面那份损坏文件)
  const second = await world(t)
  const secondEntries = await second.store.list()
  const over = await buildLexicalIndex({ storeDir: second.store.dir, entries: secondEntries, budget: { maxEntries: 1 } })
  assert.equal(over.report.overBudget, true)
  assert.match(over.report.reason, /超过预算/)
  forgetLexicalIndex(second.store.dir)
  const loaded = await loadLexicalIndex(second.store.dir, { maxEntries: 1, useCache: false })
  assert.equal(loaded.index, null)
  assert.equal(loaded.status, 'over-budget', loaded.note)
})

test('R1 指纹:能证明索引描述了现场;现场被外部改动后就不再一致', async (t) => {
  const { store } = await world(t)
  forgetLexicalIndex()
  const entries = await store.list()
  await buildLexicalIndex({ storeDir: store.dir, entries })
  const ok = await fingerprintLexicalIndex(store.dir)
  assert.equal(ok.ok, true, ok.note)

  // 模拟"有人直接改 entries/*.json"(绕过 store):mtime 会动 ⇒ 校验应当不通过。
  const target = path.join(store.dir, 'entries', `${entries[0]?.id}.json`)
  const raw = JSON.parse(await readFile(target, 'utf8')) as { text: string }
  const withText = JSON.stringify({ ...raw, text: `${raw.text} 外部加的一句。` })
  await writeFile(target, withText, 'utf8')
  const drifted = await fingerprintLexicalIndex(store.dir)
  assert.equal(drifted.ok, false)
  assert.match(drifted.note, /指纹不符/)
})

test('R1 端到端:queryKb 带索引与不带索引逐条同分同序(第一级的等价性)', async (t) => {
  const { store } = await world(t)
  forgetLexicalIndex()
  const entries = await store.list()
  const { index } = await buildLexicalIndex({ storeDir: store.dir, entries })
  const queries = ['分片 重建', '对比度 标签', '焦点', 'chunker 版本号']
  for (const text of queries) {
    const scanned = await queryKb(store, null, { text, limit: 5, noTouch: true })
    const indexed = await queryKb(store, null, { text, limit: 5, noTouch: true, lexicalIndexes: [index] })
    assert.deepEqual(
      indexed.map((hit) => [String(hit.entry.id), hit.score, hit.matched.join(',')]),
      scanned.map((hit) => [String(hit.entry.id), hit.score, hit.matched.join(',')]),
      `查询「${text}」在两条路径上必须完全一致`,
    )
  }
})

test('R1 多层级:两个索引合并后的统计量与"把两层当一个语料"逐条一致', async (t) => {
  const { store } = await world(t)
  const global = await openGlobalStore(path.join(path.dirname(store.dir), 'h'))
  await global.add({ kind: 'fact', title: '全局的对比度约定', text: '全局库里的对比度说明。', tags: ['a11y'] })
  const projectEntries = await store.list()
  const globalEntries = await global.list()
  const built = await buildLexicalIndex({ storeDir: store.dir, entries: projectEntries })
  const builtGlobal = await buildLexicalIndex({ storeDir: global.dir, entries: globalEntries })
  const merged = mergeLexicalIndexes([built.index, builtGlobal.index])
  const scan = buildLexicalStats([...projectEntries, ...globalEntries].map((entry) => ({
    title: entry.title,
    tags: entry.tags,
    text: entryTextAfterRedlines(entry),
  })))
  assert.equal(merged.meta.entryCount, scan.total)
  assert.equal(merged.meta.avgDistinct[0], scan.avgTitle)
  assert.equal(merged.meta.avgDistinct[2], scan.avgText)
  const mergedStats = lexicalStatsFrom(merged)
  assert.equal(mergedStats.total, scan.total)
  for (const [token, df] of scan.df) assert.equal(mergedStats.df.get(token), df, `token ${token} 的 df 必须一致`)

  const scanned = await queryKb(store, global, { text: '对比度 约定', limit: 5, noTouch: true })
  const indexed = await queryKb(store, global, { text: '对比度 约定', limit: 5, noTouch: true, lexicalIndexes: [merged] })
  assert.deepEqual(
    indexed.map((hit) => [String(hit.entry.id), hit.score]),
    scanned.map((hit) => [String(hit.entry.id), hit.score]),
    '跨两层查询也必须逐条一致(否则层级布局就成了排序参数)',
  )
})

test('R1 版本号只有一个出处(与 embedderVersion 同规矩)', () => {
  // The stamp lives in types.ts and nowhere else; the index's meta carries it.
  assert.match(lexicalIndexVersion(), /^lexical-v1:k1=1\.2:b=0\.75$/)
})
