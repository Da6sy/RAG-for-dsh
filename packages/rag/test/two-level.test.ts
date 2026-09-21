/**
 * M9-2/M9-3 tests: the ingest channel and the second retrieval level.
 *
 * These run over REAL stores and REAL files because the guarantees under test
 * are cross-layer: "查询纯读" is a claim about which files changed, "redline
 * 先过滤后评分" is a claim about two different code paths agreeing, and
 * "chunk 纯派生" is a claim about deletion and rebuild.
 *
 * @module @clue-harness/rag/test/two-level
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openProjectStore, type KbStore } from '@clue-harness/kb'
import {
  buildExcerpt,
  extractText,
  formatOf,
  htmlToMarkdown,
  ingestFile,
  queryChunks,
  renderDetailView,
  type ChunkSource,
} from '@clue-harness/rag'

async function world(t: { after(fn: () => unknown): void }): Promise<{ root: string; project: string; store: KbStore }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-rag2-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'proj')
  await mkdir(project, { recursive: true })
  const store = await openProjectStore(project, path.join(root, 'home'))
  return { root, project, store }
}

const SPEC = [
  '# 组件规范',
  '',
  '## 按钮',
  '',
  '按钮必须可被 Tab 选中,禁用态请使用 aria-disabled 而不是 disabled 属性。',
  '',
  '### 禁用态',
  '',
  '禁用态下按钮仍需保持可见的焦点环,并给出 aria-disabled="true"。',
  '',
  '## 表单',
  '',
  '表单提交按钮必须位于 form 元素内部,提交后通过 aria-live 区域播报结果。',
  '',
  '## 抽屉',
  '',
  '抽屉打开时焦点必须移入抽屉内部,关闭时焦点回到触发按钮。',
  '',
].join('\n')

/** Ingest the spec fixture and return the source + report. */
async function ingestSpec(project: string, store: KbStore, text: string = SPEC, name = 'spec.md') {
  const file = path.join(project, name)
  await writeFile(file, text, 'utf8')
  const report = await ingestFile({ store, file })
  return { file, report, source: { store, docId: String(report.doc!.docId) } as ChunkSource }
}

test('M9-3: html extraction produces ATX headings and drops non-content elements', () => {
  assert.equal(formatOf('a/b.HTML'), 'html')
  assert.equal(formatOf('a/b.md'), 'markdown')
  const { text, dropped } = htmlToMarkdown([
    '<html><head><style>p{color:red}</style><script>var x=1</script></head>',
    '<body><h1>规范</h1><p>第一段</p><h2>按钮</h2><ul><li>可 Tab</li><li>aria-disabled</li></ul>',
    '<!-- 注释 --><table><tr><td>a</td><td>b</td></tr></table></body></html>',
  ].join(''))
  assert.equal(dropped, 2)
  assert.match(text, /^# 规范$/m)
  assert.match(text, /^## 按钮$/m)
  assert.match(text, /^- 可 Tab$/m)
  assert.match(text, /a \| b \|/)
  assert.ok(!text.includes('color:red'))
  assert.ok(!text.includes('注释'))
  // Entities survive; unknown tags disappear.
  assert.equal(htmlToMarkdown('<p>a&nbsp;&amp;&nbsp;b</p>').text, 'a & b')
  const extracted = extractText('<div>没有标题</div>', 'html')
  assert.deepEqual(extracted.notes, ['未识别到标题标签,分片将走滑窗(800/600)'])
})

test('M9-3: dry-run previews without writing a single byte', async (t) => {
  const { project, store } = await world(t)
  const file = path.join(project, 'spec.md')
  await writeFile(file, SPEC, 'utf8')
  const report = await ingestFile({ store, file, dryRun: true })
  assert.equal(report.dryRun, true)
  assert.equal(report.doc, undefined)
  assert.ok(report.chunks.length >= 4)
  assert.equal(report.chunks[0].headingPath, '组件规范')
  assert.ok(report.chunks.every((c) => c.quoteAnchor.length <= 40))
  // Nothing landed on disk — not even the docs/ directory.
  assert.equal(await stat(path.join(store.dir, 'docs')).catch(() => null), null)
  assert.deepEqual(await store.listDocs(), [])
})

test('M9-2: queryChunks ranks by heading×2/body×1, returns anchors, and strips nothing', async (t) => {
  const { project, store } = await world(t)
  const { source, report } = await ingestSpec(project, store)
  assert.equal(report.doc?.sourcePath, 'spec.md')
  assert.equal(await store.chunksNeedRebuild(source.docId), false, 'ingest 已写入派生 ledger')

  const heading = await queryChunks(source, { query: '表单' })
  assert.equal(heading[0].headingPath, '组件规范 > 表单', 'heading 命中排在前面')
  assert.equal(heading[0].lines.start > 0, true)
  assert.match(heading[0].excerpt, /form 元素内部/)
  assert.ok(heading[0].score >= 2, 'headingPath 权重 ×2')

  // Paraphrase (同义表达): the 抽屉 section is reachable by its own words.
  const body = await queryChunks(source, { query: '移入抽屉内部' })
  assert.ok(body.length >= 1)
  assert.ok(body.some((hit) => hit.headingPath === '组件规范 > 抽屉'))
  assert.ok(body.every((hit) => hit.matched.length > 0))

  // Exact keyword (长文局部命中): the excerpt really carries the term.
  const exact = await queryChunks(source, { query: '播报结果' })
  assert.equal(exact.length, 1)
  assert.match(exact[0].excerpt, /aria-live/)
  assert.equal(exact[0].headingPath, '组件规范 > 表单')
  // A query that matches nothing returns nothing (no fabricated段).
  assert.deepEqual(await queryChunks(source, { query: 'zzzz-不存在' }), [])

  // Browsing: an empty query walks the whole document in order — the merge
  // (one continuous text for the reader) replaces overlapping neighbours, so
  // the span covered equals the document's, and nothing is returned twice.
  const all = await queryChunks(source, { query: '', limit: 50 })
  assert.deepEqual(all.map((hit) => hit.seq), all.map((hit) => hit.seq).sort((a, b) => a - b))
  assert.equal(all[0].lines.start, 1)
  assert.equal(all[all.length - 1].lines.end, report.lineCount)
  const covered = new Set<number>()
  for (const hit of all) {
    for (let line = hit.lines.start; line <= hit.lines.end; line += 1) covered.add(line)
  }
  assert.equal(covered.size, report.lineCount, '浏览模式必须覆盖全文,不漏行')
})

test('M9-2: overlap rows are deduped and adjacent hits merge into one span', async (t) => {
  const { project, store } = await world(t)
  // A long, structure-less body forces the sliding window.
  const long = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 段:焦点管理与键盘可达性说明。`).join('\n')
  const { source } = await ingestSpec(project, store, long, 'long.md')

  const hits = await queryChunks(source, { query: '焦点管理', limit: 20 })
  assert.ok(hits.length >= 1)
  // No two returned hits share a seq (dedup), and merged spans stay ordered.
  const seqs = hits.map((hit) => hit.seq)
  assert.equal(new Set(seqs).size, seqs.length)
  for (const hit of hits) assert.ok(hit.lines.end >= hit.lines.start)
  // The window's overlap means consecutive raw chunks share content; the
  // merged output must not report the same sentence twice in one block.
  for (const hit of hits) {
    const first = hit.excerpt.slice(0, 40)
    assert.equal(hit.excerpt.split(first).length - 1, 1, '同一段摘录内不重复开头的句子')
  }
})

test('M9-2: queryChunks is a pure read — no signal, no status, no approval, no ledger writes', async (t) => {
  const { project, store } = await world(t)
  const { source } = await ingestSpec(project, store)
  const entry = await store.add({ kind: 'decision', title: '焦点管理', text: '焦点必须回到触发按钮。' })
  await store.attachDoc(entry.id, source.docId, { lines: [15, 16], quoteAnchor: '抽屉打开时' })

  const before = {
    entry: JSON.stringify(await store.get(entry.id)),
    approvals: JSON.stringify(await store.listApprovals(false)),
    signals: await readFile(path.join(store.dir, 'signals.jsonl'), 'utf8').catch(() => ''),
  }
  await queryChunks(source, { query: '焦点' })
  await queryChunks({ store, docId: source.docId }, { query: '' })

  assert.equal(JSON.stringify(await store.get(entry.id)), before.entry, '查询不得改动条目(含 stats/needsReview)')
  assert.equal(JSON.stringify(await store.listApprovals(false)), before.approvals, '查询不得产生审批')
  assert.equal(await readFile(path.join(store.dir, 'signals.jsonl'), 'utf8').catch(() => ''), before.signals, '查询不得产生信号')
})

test('M9-2: chunk ledger deletion is self-healing — the next query rebuilds identical rows', async (t) => {
  const { project, store } = await world(t)
  const { source } = await ingestSpec(project, store)
  const original = await store.getChunks(source.docId)
  assert.ok(original.length > 0)

  await store.dropChunks(source.docId)
  assert.deepEqual(await store.getChunks(source.docId), [])
  const hits = await queryChunks(source, { query: '按钮' })
  assert.ok(hits.length > 0, '查询时按需重建,不空手而归')
  assert.deepEqual(await store.getChunks(source.docId), original, '重建结果与删除前逐行一致')
})

test('M9-2: redline filters before scoring — a fully redlined chunk is unreachable, a partial one is marked', async (t) => {
  const { project, store } = await world(t)
  const { source } = await ingestSpec(project, store)
  const entry = await store.add({ kind: 'decision', title: '规范摘要', text: '组件规范摘要。' })
  await store.attachDoc(entry.id, source.docId)

  // Find the段 by CONTENT, then redline exactly its lines — anchors are
  // derived from the snapshot, so a test must never hard-code them.
  const target = (await queryChunks(source, { query: 'aria-live 播报结果' }))[0]
  assert.equal(target.headingPath, '组件规范 > 表单')
  const { entry: redlined, ratio, proposal } = await store.redlineDocLines(entry.id, {
    lines: [target.lines.start, target.lines.end],
    reason: '表单规范已改版为 ds-form v2',
  })
  assert.ok(ratio > 0 && ratio <= 0.4, `该段占全文不足 40%,不触发提案(实际 ${ratio})`)
  assert.equal(proposal, null)
  assert.equal(redlined.redlines?.length, 1)
  assert.equal(String(redlined.redlines?.[0].docId), source.docId, 'redline 绑定 docId,不是 sourcePath')

  const gone = await queryChunks(source, { query: 'aria-live 播报结果', limit: 10 })
  assert.ok(!gone.some((hit) => /aria-live/.test(hit.excerpt)), '被整段划除的段不可再被检索到')

  // A PARTIAL redline — the FIRST line of another multi-line chunk — keeps that
  // chunk retrievable but marks it: the ✂ marker is how a reader learns part of
  // the段 has been retracted while the rest still stands.
  const other = (await queryChunks(source, { query: 'aria-disabled 焦点环' }))[0]
  assert.ok(other.lines.end > other.lines.start, '夹具里这一段是多行段')
  const partial = await store.redlineDocLines(entry.id, { lines: [other.lines.start, other.lines.start], reason: '标题行措辞已改' })
  assert.equal(partial.entry.redlines?.length, 2)
  const still = await queryChunks(source, { query: 'aria-disabled 焦点环', limit: 10 })
  const marked = still.filter((hit) => hit.partialRedline)
  assert.equal(marked.length, 1, '被部分划除的段必须出现在结果里')
  assert.equal(marked[0].seq, other.seq)
  assert.ok(marked[0].excerpt.includes('✂'), '被划除的行在摘录里标 ✂')
  assert.equal(marked[0].redlines[0].reason, '标题行措辞已改')
  // The same rule in its cleanest form: a custom doc per section, so a whole
  // section's retraction is unambiguous.
  const custom = [
    '# 迁移说明',
    '',
    '## 旧接口',
    '',
    '旧接口 sunset-alpha 已下线,禁止再调用。',
    '',
    '## 新接口',
    '',
    '新接口请改用 stable-beta,参数不变。',
    '',
  ].join('\n')
  const { source: customSource } = await ingestSpec(project, store, custom, 'custom.md')
  const customEntry = await store.add({ kind: 'decision', title: '接口迁移', text: '按迁移说明执行。' })
  await store.attachDoc(customEntry.id, customSource.docId)
  const oldChunk = (await queryChunks(customSource, { query: 'sunset-alpha' }))[0]
  assert.ok(oldChunk !== undefined, '划除前该段可被检索到')
  await store.redlineDocLines(customEntry.id, { lines: [oldChunk.lines.start, oldChunk.lines.end], reason: '旧接口整节作废' })
  assert.deepEqual(await queryChunks(customSource, { query: 'sunset-alpha' }), [], '被整段划除的原文不再可达')
  const fresh = await queryChunks(customSource, { query: 'stable-beta' })
  assert.equal(fresh.length, 1, '未划除的兄弟段照常服役')
  assert.equal(fresh[0].partialRedline, false, '不相交的段不带划除标记')

  // The ENTRY-level redline (own text) filters BOTH scoring and display.
  const own = await store.add({
    kind: 'pitfall',
    title: '按钮键盘可达性',
    text: '提交按钮必须可 Tab。旧的绝对定位做法会让按钮掉出 Tab 顺序。',
  })
  const keep = own.text.indexOf('旧的绝对定位')
  const { entry: textRedlined } = await store.redlineText(own.id, {
    chars: [keep + 1, own.text.length],
    reason: '绝对定位方案已废弃',
  })
  assert.equal(textRedlined.redlines?.length, 1)
  assert.match(textRedlined.redlines?.[0].quoteAnchor ?? '', /^旧的绝对定位/)
})

test('M9-2: >40% redlined queues a split/discard PROPOSAL, never an action', async (t) => {
  const { project, store } = await world(t)
  const { source } = await ingestSpec(project, store)
  const entry = await store.add({ kind: 'decision', title: '摘要', text: '摘要正文。' })
  await store.attachDoc(entry.id, source.docId)

  const { proposal } = await store.redlineDocLines(entry.id, { lines: [1, 10], reason: '大半已过时' })
  assert.ok(proposal !== null)
  assert.equal(proposal.action, 'redline-review')
  assert.match(proposal.reason, /已划除 \d+%/)
  assert.equal((await store.listApprovals(true)).length, 1)
  // The entry is UNTOUCHED: still trusted-or-candidate, still retrievable.
  assert.equal((await store.get(entry.id))?.status, 'candidate')

  // Resolving the proposal changes no entry state (advisory by design).
  const { entry: after } = await store.resolveApproval(proposal.id, true)
  assert.equal(after, null)
  assert.equal((await store.get(entry.id))?.status, 'candidate')
})

test('M9-2: kb_detail renders anchors, redline marks and the honest no-doc receipt', async (t) => {
  const { project, store } = await world(t)
  const { source } = await ingestSpec(project, store)
  const withDoc = await store.add({ kind: 'decision', title: '焦点管理', text: '焦点必须回到触发按钮。' })
  await store.attachDoc(withDoc.id, source.docId)

  const hits = await queryChunks({ store, docId: source.docId }, { query: '焦点' })
  const view = renderDetailView({
    entryId: String(withDoc.id),
    title: withDoc.title,
    docIds: [source.docId],
    hits,
    noDoc: false,
  })
  assert.match(view.text, new RegExp(`^# ${withDoc.id} · 焦点管理`))
  assert.match(view.text, /行 \d+-\d+ · 组件规范 > 抽屉/)
  assert.match(view.text, /锚点: “/)
  assert.match(view.text, /纯读取,不记信号、不改状态/)

  // Budget honesty: a tiny budget truncates WITH a marker.
  const tiny = renderDetailView({ entryId: 'k', title: 't', docIds: [source.docId], hits, noDoc: false }, 120)
  assert.ok(tiny.text.length <= 120 + 40)
  assert.match(tiny.text, /预算 120 字已满/)

  // No doc → the honest receipt, never a fabricated段.
  const bare = await store.add({ kind: 'fact', title: '无原文条目', text: '正文即全部。' })
  const noDoc = renderDetailView({ entryId: String(bare.id), title: bare.title, docIds: [], hits: [], noDoc: true })
  assert.match(noDoc.text, /该知识无原文层/)
  assert.doesNotMatch(noDoc.text, /行 \d+/)
})

test('M9-2: buildExcerpt marks redlined lines and respects the budget', () => {
  const lines = ['a', 'b', 'c', 'd', 'e']
  const redlines = [{ target: 'doc' as const, docId: 'd-1' as never, lines: [2, 3] as [number, number], quoteAnchor: 'b', reason: 'x', at: 'now', by: 'cli' }]
  const excerpt = buildExcerpt(lines, { startLine: 1, endLine: 4 }, 600, redlines, 'd-1')
  assert.equal(excerpt, 'a\n✂ b\n✂ c\nd')
  // Redlines of ANOTHER doc must not mark this one (绑定 docId).
  assert.equal(buildExcerpt(lines, { startLine: 1, endLine: 2 }, 600, redlines, 'd-2'), 'a\nb')
  // Budget: the first line is trimmed with a marker rather than dropped.
  const tight = buildExcerpt(['x'.repeat(100)], { startLine: 1, endLine: 1 }, 10, [], 'd-1')
  assert.equal(tight.length, 10)
  assert.ok(tight.endsWith('…'))
})

test('M9-3: re-ingesting a changed file produces a new docId and the old chunks stay on the old doc', async (t) => {
  const { project, store } = await world(t)
  const { source: v1 } = await ingestSpec(project, store)
  const v1Chunks = await store.getChunks(v1.docId)

  // A DIFFERENT file (same directory): a new source gets its own snapshot and
  // its own ledger, and the first doc's derived rows are untouched.
  const second = await ingestSpec(project, store, `${SPEC}\n## 新增章节\n\n补充说明。\n`, 'spec-v2.md')
  assert.notEqual(second.source.docId, v1.docId)
  const v2Record = await store.getDoc(second.source.docId)
  assert.equal(v2Record?.sourcePath, 'spec-v2.md')
  assert.equal(v2Record?.supersedes, undefined, '不同 sourcePath 之间不建立版本链')
  assert.deepEqual(await store.getChunks(v1.docId), v1Chunks, '旧文档的派生索引一字未动')
  assert.ok((await store.getChunks(second.source.docId)).length > v1Chunks.length)

  // The SAME path re-ingested with new bytes is a version: new docId, linked
  // by supersedes, old snapshot and old redlines left exactly where they are.
  const third = await ingestSpec(project, store, `${SPEC}\n## 又一段\n\n继续补充。\n`)
  assert.notEqual(third.source.docId, v1.docId)
  assert.equal((await store.getDoc(third.source.docId))?.supersedes, v1.docId)
  assert.deepEqual(await store.getChunks(v1.docId), v1Chunks)
})
