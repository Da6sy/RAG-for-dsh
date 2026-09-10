/**
 * rag engine tests (M4).
 *
 * Signature extraction and assist rendering are pure functions; the
 * retriever runs over REAL KbStore instances (temp CLUE_HOME) because its
 * whole job is the interplay of queryKb scoring, the binding boost, and the
 * annotation discipline — none of which a mock would prove.
 *
 * @module @clue-harness/rag/test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openGlobalStore, openProjectStore, type KbStore } from '@clue-harness/kb'
import {
  createFulltextRetriever, failureSignature, normalizePath, renderRetrievalAssist,
} from '@clue-harness/rag'

test('failureSignature: assertions first, then diffs, then files; dedup + caps', () => {
  const signature = failureSignature(
    {
      failedAssertions: ['按钮可被 Tab 选中(实际: 不在 Tab 顺序中)'],
      errorEntrySummaries: ['[attr] submit: tabindex 出现 -1'],
    },
    ['page.html'],
  )
  assert.equal(
    signature,
    '按钮可被 Tab 选中(实际: 不在 Tab 顺序中) [attr] submit: tabindex 出现 -1 page.html',
  )
  // Deterministic: identical inputs, identical signature.
  assert.equal(signature, failureSignature(
    { failedAssertions: ['按钮可被 Tab 选中(实际: 不在 Tab 顺序中)'], errorEntrySummaries: ['[attr] submit: tabindex 出现 -1'] },
    ['page.html'],
  ))
  // Dedup keeps first-occurrence priority.
  assert.equal(failureSignature({ failedAssertions: ['A', 'A'], errorEntrySummaries: ['A'] }, []), 'A')
  // maxFacts caps the fold; maxLength truncates with the honest marker.
  assert.equal(failureSignature({ failedAssertions: ['a', 'b', 'c'], errorEntrySummaries: [] }, [], { maxFacts: 2 }), 'a b')
  const long = failureSignature({ failedAssertions: ['x'.repeat(500)], errorEntrySummaries: [] }, [], { maxLength: 100 })
  assert.equal(long.length, 100)
  assert.ok(long.endsWith('…'))
  // Nothing to say → empty signature (the gate then skips retrieval).
  assert.equal(failureSignature({ failedAssertions: [], errorEntrySummaries: [] }, []), '')
})

test('normalizePath: win separators and leading ./ collapse to one form', () => {
  assert.equal(normalizePath('src\\a.html'), 'src/a.html')
  assert.equal(normalizePath('./src/a.html'), 'src/a.html')
  assert.equal(normalizePath('src/a.html'), 'src/a.html')
})

/** One isolated world: project root on disk + both stores opened. */
async function world(t: { after(fn: () => unknown): void }): Promise<{ project: KbStore; global: KbStore; projectRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clue-rag-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = path.join(root, 'proj')
  await mkdir(projectRoot, { recursive: true })
  return {
    project: await openProjectStore(projectRoot, path.join(root, 'clue-home')),
    global: await openGlobalStore(path.join(root, 'clue-home')),
    projectRoot,
  }
}

test('retriever: signature text finds the pitfall; binding boost re-ranks and ANNOUNCES itself', async (t) => {
  const { project, global, projectRoot } = await world(t)
  // Bindings are hashed at add time — the bound file must exist first.
  await writeFile(path.join(projectRoot, 'page.html'), '<button>提交</button>')
  // The bound pitfall shares few tokens with the signature — plain text
  // scoring ranks it low; the boost is what makes retrieval work here.
  const pitfall = await project.add({
    kind: 'pitfall',
    title: '悬浮按钮的可访问性',
    text: '浮动定位的操作按钮不要移出焦点顺序,键盘用户必须能到达它。',
    bindings: ['page.html'],
  })
  const noisy = await project.add({
    kind: 'fact',
    title: '按钮可被 Tab 选中的历史',
    text: '按钮可被 Tab 选中 是断言库第一批断言,tabindex 出现 -1 即失败。',
  })
  const retriever = createFulltextRetriever(project, global)
  const signature = failureSignature(
    { failedAssertions: ['按钮可被 Tab 选中(实际: 不在 Tab 顺序中)'], errorEntrySummaries: ['[attr] submit: tabindex 出现 -1'] },
    ['page.html'],
  )

  // Without boost context: the token-rich fact wins (pure text scoring).
  const plain = await retriever.retrieve(signature)
  assert.ok(plain.length >= 2)
  assert.equal(plain[0].entry.id, noisy.id)

  // With boostBindings: the bound pitfall outranks the 4×-higher text score
  // (categorical stratum, not a multiplier race) AND says why.
  const boosted = await retriever.retrieve(signature, { boostBindings: ['page.html'] })
  assert.equal(boosted[0].entry.id, pitfall.id)
  assert.ok(
    boosted[0].annotations.some((a) => a.includes('绑定文件在本次改动中')),
    `boost 未公告: ${boosted[0].annotations.join(' | ')}`,
  )
  assert.equal(boosted[1].entry.id, noisy.id, '无绑定的文本命中排第二')

  // bindingBoost=1 keeps raw scores; the stratum (the ranking FACT) stands.
  const rawScore = createFulltextRetriever(project, global, { bindingBoost: 1 })
  const rawHits = await rawScore.retrieve(signature, { boostBindings: ['page.html'] })
  assert.equal(rawHits[0].entry.id, pitfall.id)
  assert.equal(rawHits[0].score, plain.find((h) => h.entry.id === pitfall.id)?.score)
})

test('retriever: binding-only recall — zero token overlap still surfaces the bound entry', async (t) => {
  const { project, global, projectRoot } = await world(t)
  await writeFile(path.join(projectRoot, 'page.html'), '<button>提交</button>')
  // Title/text share NO token with the signature below — text scoring gives
  // it 0 and queryKb filters it out; the binding channel must recall it.
  const silent = await project.add({
    kind: 'pitfall',
    title: '浮动胶囊规范',
    text: '右下角控件须保留焦点可达性并留出安全边距。',
    bindings: ['page.html'],
  })
  const retriever = createFulltextRetriever(project, global)
  const hits = await retriever.retrieve('contrast ratio 3.2 insufficient', { boostBindings: ['page.html'] })
  const recalled = hits.find((hit) => hit.entry.id === silent.id)
  assert.ok(recalled, '绑定召回通道没有捞回零词元重叠的条目')
  assert.equal(recalled.score, 0)
  assert.ok(
    recalled.annotations.some((a) => a.includes('按绑定召回')),
    `召回原因未公告: ${recalled.annotations.join(' | ')}`,
  )
  // Status doctrine still holds inside the channel: a discarded entry never returns.
  await project.transition(silent.id, 'discarded', 'strong-negative', '测试清退')
  const after = await retriever.retrieve('contrast ratio 3.2 insufficient', { boostBindings: ['page.html'] })
  assert.ok(!after.some((hit) => hit.entry.id === silent.id), '遗弃条目不得被绑定召回')
})

test('retriever: weights config changes ranking (the M2 promise kept)', async (t) => {
  const { project, global } = await world(t)
  // Entry A matches in the TITLE only; entry B matches in the BODY only.
  const titleHit = await project.add({ kind: 'fact', title: 'wslpath 用法', text: '路径转换的约定。' })
  const bodyHit = await project.add({ kind: 'fact', title: '路径约定', text: '统一用 wslpath 转换,不手拼。' })
  const retriever = createFulltextRetriever(project, global)
  const defaultRank = await retriever.retrieve('wslpath')
  assert.equal(defaultRank[0].entry.id, titleHit.id, '默认权重(标题×3)应让标题命中居首')

  // Cranking the body weight above the title weight flips the order.
  const bodyFirst = createFulltextRetriever(project, global, { weights: { title: 1, tag: 1, text: 5 } })
  const flipped = await bodyFirst.retrieve('wslpath')
  assert.equal(flipped[0].entry.id, bodyHit.id, '正文加权后应翻转排序')
})

test('renderRetrievalAssist: budget, annotations verbatim, kb_cite instruction, empty→empty', async (t) => {
  const { project, global } = await world(t)
  const entry = await project.add({ kind: 'pitfall', title: 'Tab 顺序坑', text: '别让按钮掉出焦点顺序。' })
  const retriever = createFulltextRetriever(project, global)
  const hits = await retriever.retrieve('Tab 顺序')
  assert.ok(hits.length >= 1)

  const block = renderRetrievalAssist(hits, 2000)
  assert.ok(block.startsWith('<kb_assist source="clue-rag">'))
  assert.ok(block.endsWith('</kb_assist>'))
  assert.ok(block.includes('kb_cite'), '必须指导模型用 kb_cite 声明引用')
  assert.ok(block.includes(String(entry.id)))
  assert.ok(block.includes('候选知识'), '状态标注必须原样出现')

  // Budget truncation is honest (marker, no half-entry garbage beyond it).
  const tight = renderRetrievalAssist(hits, 160)
  assert.ok(tight.length <= 200)
  assert.ok(tight.endsWith('</kb_assist>'))

  // No hits → empty string (the gate injects the bare report then).
  assert.equal(renderRetrievalAssist([], 2000), '')
})
