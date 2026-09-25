/**
 * M9-0 injection-quota tests (proposal §4 G4).
 *
 * The acceptance line this file guards is a BUDGET property, not a rendering
 * detail: a 1800-character hit must no longer push the remaining hits out of
 * the injected block (债#5 预算垄断). The renderer runs with the FACE's real
 * defaults, so a config drift that re-breaks the quota fails here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QueryHit } from '@clue-harness/kb'
import { renderKbContext, DEFAULT_INJECT_PER_ENTRY_CHARS } from '../src/index.ts'

/** One synthetic hit (the renderer only needs status/kind/title/text). */
function hit(id: string, title: string, text: string, extra: Partial<QueryHit> = {}): QueryHit {
  return {
    entry: {
      id, status: 'candidate', needsReview: false, kind: 'fact', title, text,
    } as never,
    score: 1,
    matched: [],
    annotations: [],
    ...extra,
  }
}

const opts = { perEntryChars: DEFAULT_INJECT_PER_ENTRY_CHARS, minChars: 0 }

test('M9-0: 一条 1800 字的命中不再挤掉后面 5 条', () => {
  const long = hit('k-long', '长条目', '甲'.repeat(1800))
  const rest = Array.from({ length: 5 }, (_, i) => hit(`k-${i}`, `短条目${i}`, `乙${i}`.repeat(60)))
  const block = renderKbContext([long, ...rest], 2400, opts)
  for (const short of rest) assert.ok(block.includes(short.entry.id), `${short.entry.id} 必须仍在块里`)
  // The long entry is present but bounded: identity kept, body trimmed to quota.
  assert.ok(block.includes('k-long'))
  const longLine = block.split('\n').find(line => line.startsWith('- [k-long')) as string
  const body = longLine.slice(longLine.indexOf('长条目: '))
  assert.ok(body.length <= DEFAULT_INJECT_PER_ENTRY_CHARS + 20, `长条目正文应被配额截断,实际 ${body.length}`)
  assert.ok(body.includes('…'), '截断必须留痕')
})

test('M9-0: 配额是每条正文上限,标注与标题不计入(身份永不截断)', () => {
  const annotated = hit('k-annotated', '带标注条目', '丙'.repeat(900), {
    annotations: ['候选知识(尚未人工批准为可信)', '含原文 12 段,细节用 kb_detail 下钻'],
  })
  const block = renderKbContext([annotated], 2400, opts)
  const line = block.split('\n').find(entry => entry.startsWith('- [k-annotated')) as string
  assert.ok(line.includes('候选知识'), '标注必须原样保留')
  assert.ok(line.includes('kb_detail'), '下钻标注必须原样保留')
  assert.ok(line.includes('带标注条目'), '标题是身份,不参与配额')
})

test('M9-0: 收益递减时要主动让位 — minChars 抬高后,装不下的条目整条让位', () => {
  const huge = hit('k-huge', '巨条目', '丁'.repeat(400))
  const fits = hit('k-fits', '能装下', '戊的对'.repeat(80)) // ~240 字,过 minChars 线
  // Budget = header(~206)+1 + huge line(~330) + tail(~180) ⇒ an entry that
  // cannot get a fair share (minChars 200) yields instead of arriving as a stub.
  const block = renderKbContext([huge, fits], 730, { perEntryChars: 400, minChars: 200 })
  assert.ok(block.includes('k-huge'))
  assert.ok(!block.includes('k-fits'), '拿不到公平份额的条目整条让位(保广度弃深度)')
  assert.ok(block.endsWith('</kb_context>'), '块必须闭合')
  // With plenty of room the SAME pair renders both — the yield was about the
  // budget, not about the renderer refusing small entries.
  const roomy = renderKbContext([huge, fits], 2400, { perEntryChars: 400, minChars: 200 })
  assert.ok(roomy.includes('k-fits'), '预算充足时小条目必须进块')
})

test('M9-0: 剩余空间不足以完整容纳时按剩余量裁剪(不吐半条垃圾)', () => {
  const first = hit('k-first', '第一条', '己'.repeat(120))
  const second = hit('k-second', '第二条', '庚'.repeat(300))
  const block = renderKbContext([first, second], 560, { perEntryChars: 400, minChars: 0 })
  assert.ok(block.includes('k-first'))
  const line = block.split('\n').find(entry => entry.startsWith('- [k-second')) as string
  assert.ok(line !== undefined, '放得下的部分必须给出')
  assert.ok(line.endsWith('…'), '裁剪要留痕')
  assert.ok(block.endsWith('</kb_context>'))
})

test('M9-0: 无原文层的条目输出与旧版逐字节一致(兼容线)', () => {
  const bare = hit('k-bare', '旧条目', '正文。')
  const block = renderKbContext([bare], 2400, opts)
  assert.ok(block.includes('- [k-bare|candidate|fact] 旧条目: 正文。'))
  assert.ok(!block.includes('kb_detail'), '没有 doc 就不该出现下钻提示')
})
