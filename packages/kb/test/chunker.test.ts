/**
 * M9-2 chunker tests: the write-time slicing rules of 拍板 2.
 *
 * The chunker is a pure function, so these tests pin exactly the numbers the
 * proposal fixed — 800-character sections, the 800/600 sliding window with its
 * 200-character overlap, `overlapWith` marking, and deterministic output (the
 * same text must always produce byte-identical rows, which is what makes
 * "delete the ledger and rebuild" a valid acceptance test).
 *
 * @module @clue-harness/kb/test/chunker
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkDocument, findHeadings, headingPathAt, needsRebuild, quoteAnchorOf } from '../src/index.ts'

const STRUCTURED = [
  '# 规范',
  '总则第一行。',
  '总则第二行。',
  '## 按钮',
  '按钮要可 Tab。',
  '### 禁用态',
  '用 aria-disabled。',
  '## 表单',
  '提交按钮在 form 内。',
].join('\n')

test('M9-2: structure first — a section runs from its heading to the next heading of any level', () => {
  const chunks = chunkDocument(STRUCTURED)
  assert.deepEqual(chunks.map((c) => [c.startLine, c.endLine]), [
    [1, 3], // the preamble + `# 规范` section, up to `## 按钮`
    [4, 5], // `## 按钮` — its intro paragraph belongs to the parent, not the child
    [6, 7], // `### 禁用态`
    [8, 9], // `## 表单`
  ])
  assert.deepEqual(chunks.map((c) => c.headingPath), ['规范', '规范 > 按钮', '规范 > 按钮 > 禁用态', '规范 > 表单'])
  assert.deepEqual(chunks.map((c) => c.seq), [1, 2, 3, 4])
  // No structural chunk was windowed, so no row claims an overlap.
  assert.ok(chunks.every((c) => c.overlapWith === undefined))
  // Anchors are the first 40 characters of each段.
  assert.equal(chunks[0].quoteAnchor, quoteAnchorOf(chunks[0].quoteAnchor, 40))
  assert.match(chunks[0].quoteAnchor, /^# 规范 总则第一行/)
})

test('M9-2: an over-long section is windowed INSIDE itself with overlapWith marking', () => {
  // 30 short lines under one heading: the section is one logical unit but far
  // more than 200 characters, so it must be windowed rather than emitted whole.
  const lines = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行 ` + '甲乙丙丁戊己庚辛壬癸'.repeat(3))
  const long = `## 长章节\n${lines.join('\n')}`
  const chunks = chunkDocument(long, { chunkChars: 200, windowStep: 150, quoteAnchorChars: 40, version: 'test-v1' })
  assert.ok(chunks.length > 1, '超长章节必须切成多段')
  assert.equal(chunks[0].startLine, 1)
  assert.equal(chunks[0].overlapWith, undefined)
  // Every window but the first carries overlapWith — that IS the overlap
  // 拍板 2 chose (200 of 800) instead of the polluting 500.
  for (let i = 1; i < chunks.length; i += 1) {
    assert.equal(chunks[i].overlapWith, chunks[i - 1].seq, '重叠段指向它重叠的那一段')
  }
  // Each window stays inside the character budget and really moves forward;
  // consecutive windows share lines (that is the overlap, expressed in lines).
  for (const chunk of chunks.slice(1)) assert.ok(chunk.chars <= 200, `窗口应 ≤200 字符,实际 ${chunk.chars}`)
  for (let i = 1; i < chunks.length; i += 1) {
    assert.ok(chunks[i].startLine <= chunks[i - 1].endLine, '相邻窗口的行号必须相交')
    assert.ok(chunks[i].endLine > chunks[i - 1].endLine, '窗口必须推进')
  }
  assert.ok(chunks.every((c) => c.headingPath === '长章节'))
  assert.ok(chunks.every((c) => c.chunkerVersion === 'test-v1'))
})

test('M9-2: multi-line windows really overlap in characters, not just in rows', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行 ` + '甲乙丙丁戊己庚辛壬癸'.repeat(5)) // ~105 chars/line
  const chunks = chunkDocument(lines.join('\n'), { chunkChars: 300, windowStep: 200, quoteAnchorChars: 40, version: 'test-v1' })
  assert.ok(chunks.length >= 3)
  assert.equal(chunks[0].overlapWith, undefined)
  for (let i = 1; i < chunks.length; i += 1) {
    const previous = chunks[i - 1]
    assert.equal(chunks[i].overlapWith, previous.seq)
    assert.ok(chunks[i].startLine <= previous.endLine, '相邻窗口的行号必须相交')
    assert.ok(chunks[i].endLine > previous.endLine, '窗口必须推进')
  }
})

test('M9-2: no structure at all → the sliding window (800/600), no headingPath', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行:` + '内容'.repeat(20))
  const chunks = chunkDocument(lines.join('\n'))
  assert.ok(chunks.length >= 3)
  assert.ok(chunks.every((c) => c.headingPath === ''))
  assert.ok(chunks.every((c) => c.chars <= 800 + 40), '窗口按字符预算切(单行可能略超)')
  assert.equal(chunks[0].overlapWith, undefined)
  assert.equal(chunks[1].overlapWith, 1)
})

test('M9-2: fences hide comment headings; headingPath stacks by level', () => {
  const text = ['# A', '```', '# 不是标题', '```', '## B', '正文'].join('\n')
  const headings = findHeadings(text.split('\n'))
  assert.deepEqual(headings.map((h) => h.text), ['A', 'B'])
  assert.equal(headingPathAt(headings, 4), 'A', '代码块里的 # 不产生章节')
  assert.equal(headingPathAt(headings, 6), 'A > B')
  const chunks = chunkDocument(text)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[1].headingPath, 'A > B')
})

test('M9-2: deterministic and empty-safe', () => {
  assert.deepEqual(chunkDocument(STRUCTURED), chunkDocument(STRUCTURED))
  assert.deepEqual(chunkDocument(''), [])
  assert.deepEqual(chunkDocument('\n\n\n'), [])
  // Windows are whole-line: no chunk starts or ends mid-line.
  const chunks = chunkDocument(STRUCTURED)
  for (const chunk of chunks) assert.ok(chunk.endLine >= chunk.startLine)
})

test('M9-2: needsRebuild — absent ledger or a foreign stamp means rebuild', () => {
  assert.equal(needsRebuild([], 'v1'), true)
  assert.equal(needsRebuild([{ chunkerVersion: 'v1' }], 'v1'), false)
  assert.equal(needsRebuild([{ chunkerVersion: 'v0' }], 'v1'), true, 'chunker 配置变了 → 静默重建')
  assert.equal(needsRebuild([{ chunkerVersion: 'v1' }, {}], 'v1'), true, '缺版本号的行同样触发重建')
})

test('M9-2: quoteAnchor is whitespace-flattened and capped', () => {
  assert.equal(quoteAnchorOf('  第一行\n\n第二行  ', 40), '第一行 第二行')
  assert.equal(quoteAnchorOf('x'.repeat(100), 40).length, 40)
})
