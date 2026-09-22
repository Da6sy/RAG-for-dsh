/**
 * V2 — the ablation harness's own invariants (原规划 §10).
 *
 * The generator is the part that can lie, and it has lied before (a phrase drawn
 * twice; non-unique phrases giving one query dozens of right answers). The
 * ablation adds three classes with their own way of lying, so each one is
 * pinned here:
 *
 *   - a `cross-lingual` query that shares a token with its gold document is a
 *     lexical measurement wearing a semantic label;
 *   - a `negation` query without its subject has as many right answers as the
 *     corpus reuses the pitfall, so its recall@1 measures tie-breaking;
 *   - an `identifier` query must be answerable from its gold document alone.
 *
 * The guardrail MATH is pinned too, because a guardrail that cannot fail is
 * decoration: the tests below hand it a deliberate regression and require it to
 * be reported.
 *
 * @module @clue-harness/cli/test/recall-abl
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from '@clue-harness/kb'
import { hashEmbedder } from '@clue-harness/rag'
import { buildSyntheticSet, parseArgs, type SummaryBlock } from '../src/recall-cli.ts'
import {
  ABLATION_MATRIX,
  BASELINE_ID,
  crossLingualLeaks,
  guardrails,
  pickEmbedder,
  resolveConfigs,
  type AblationConfig,
} from '../src/recall-abl.ts'

/** One summary block with the given recall@1. */
function block(recall1: number): SummaryBlock {
  return { queries: 40, recall: { 1: recall1, 5: 1, 10: 1 }, ndcg: { 1: recall1, 5: 1, 10: 1 }, mrr: recall1 }
}

const toolConfig: AblationConfig = { id: 'hybrid+rerank', channels: 'hybrid', rerank: true, profile: 'tool' }

test('默认跑矩阵,给了开关就跑单个配置(每配置一行与 delta 是同一个报告)', () => {
  assert.deepEqual(resolveConfigs(parseArgs([])), ABLATION_MATRIX)
  const one = resolveConfigs(parseArgs(['--channel', 'lexical', '--rerank', 'off']))
  assert.equal(one.length, 1)
  assert.equal(one[0]?.channels, 'lexical')
  assert.equal(one[0]?.rerank, false)
  assert.equal(resolveConfigs(parseArgs(['--profile', 'gate']))[0]?.profile, 'gate')
})

test('嵌入来源:hash 明确标注语义能力=0,http 缺配置时拒绝而不是假装', () => {
  const hash = pickEmbedder('hash', null)
  assert.equal(hash.semantics, 'none')
  assert.match(hash.embedder.id, /hash/)
  assert.throws(() => pickEmbedder('http', null), /requires a configured embedding endpoint/)
  const real = pickEmbedder('http', hashEmbedder({ dim: 8 }))
  assert.equal(real.semantics, 'endpoint')
  assert.throws(() => pickEmbedder('nope', null), /accepts only hash\|http/)
})

test('护栏:词法金矿类回退超 1pt 即失败(硬线,不可被平均掉)', () => {
  const baseline = { exact: block(1), entity: block(1), identifier: block(1), paraphrase: block(0.5), 'cross-lingual': block(0) }
  const dropped = { ...baseline, exact: block(0.9) }
  const violations = guardrails(dropped, baseline, toolConfig)
  assert.ok(violations.some((line) => line.includes('exact recall@1 regressed 10.0pt')), violations.join(' | '))
  // 1pt 以内不算违规(阈值是"回退 > 1pt")
  const tiny = { ...baseline, entity: block(0.995) }
  assert.equal(guardrails(tiny, baseline, toolConfig).some((line) => line.includes('entity')), false)
})

test('护栏:语义目标类提升不足 5pt 时,向量通道算"未证明有效"(任一截断点算数)', () => {
  const baseline = { exact: block(1), entity: block(1), identifier: block(1), paraphrase: block(0.6), 'cross-lingual': block(0.2) }
  const flat = { ...baseline, paraphrase: block(0.62) }
  assert.ok(guardrails(flat, baseline, toolConfig).some((line) => line.includes('not proven effective')))
  const improved = { ...baseline, paraphrase: block(0.7), 'cross-lingual': block(0.3) }
  assert.deepEqual(guardrails(improved, baseline, toolConfig), [])
  // 词法-only 的配置不该被要求证明语义
  const lexicalOnly: AblationConfig = { id: 'lexical+rerank', channels: 'lexical', rerank: true, profile: 'tool' }
  assert.deepEqual(guardrails(flat, baseline, lexicalOnly), [])
})

test('护栏:基线自己不受罚(它就是尺子)', () => {
  const baseline = { exact: block(0.9) }
  assert.deepEqual(guardrails(baseline, baseline, { ...toolConfig, id: BASELINE_ID }), [])
  assert.deepEqual(guardrails(baseline, null, toolConfig), [])
})

test('cross-lingual 自检:与金标文档共享 token 的查询会被抓出来', () => {
  const docs = [{ id: 'd-1', title: '按钮的键盘可达性约定', body: 'ds-button#1 约定:必须可被 Tab 选中;关联标记 focusable。' }]
  const leaky = [{ kind: 'cross-lingual', text: 'focusable controls', goldDocId: 'd-1' }]
  const leaks = crossLingualLeaks(docs, leaky)
  assert.equal(leaks.length, 1)
  assert.ok((leaks[0]?.shared ?? []).length > 0)

  const clean = [{ kind: 'cross-lingual', text: 'which controls can be reached from the keyboard', goldDocId: 'd-1' }]
  assert.deepEqual(crossLingualLeaks(docs, clean), [])
})

test('生成器:真实语料的 cross-lingual 查询不含金标 token(否则那一类毫无意义)', () => {
  const set = buildSyntheticSet({ chunks: 60, queries: 90, seed: 99, kinds: ['cross-lingual', 'negation', 'identifier'] })
  const leaks = crossLingualLeaks(set.docs, set.queries)
  assert.deepEqual(leaks, [], `cross-lingual 查询与金标文档共享 token: ${JSON.stringify(leaks.slice(0, 2))}`)
})

test('生成器:negation 带 subject(否则一条查询有几十个同样正确的答案)', () => {
  const set = buildSyntheticSet({ chunks: 40, queries: 30, seed: 5, kinds: ['negation'] })
  const byId = new Map(set.docs.map((doc) => [doc.id, doc]))
  for (const query of set.queries) {
    const doc = byId.get(query.goldDocId)
    assert.ok(doc !== undefined)
    assert.ok(query.text.includes(doc.subject), `negation 查询缺少 subject: ${query.text}`)
    // 否定形态:必须真的带着否定词,否则它只是 exact 的复制
    assert.match(query.text, /不要/)
  }
})

test('生成器:identifier 查询由主题+版本+标记构成,且主题是唯一的', () => {
  const set = buildSyntheticSet({ chunks: 40, queries: 30, seed: 6, kinds: ['identifier'] })
  const byId = new Map(set.docs.map((doc) => [doc.id, doc]))
  for (const query of set.queries) {
    const doc = byId.get(query.goldDocId)
    assert.ok(doc !== undefined)
    assert.ok(query.text.includes(doc.subject), `identifier 查询缺少主题: ${query.text}`)
  }
  // 唯一性:主题只属于一个文档(词法金矿类的前提)
  const subjects = set.docs.map((doc) => doc.subject)
  assert.equal(new Set(subjects).size, subjects.length)
  // 且查询里确实有 ASCII 标识符(词法该赢的那部分)
  assert.ok(set.queries.every((query) => tokenize(query.text).some((token) => /^[a-z0-9-]{2,}$/.test(token))))
})

test('生成器:类别轮转按请求的集合走,默认仍是三类(老报告的数字含义不变)', () => {
  const legacy = buildSyntheticSet({ chunks: 30, queries: 30, seed: 3 })
  assert.deepEqual([...new Set(legacy.queries.map((query) => query.kind))].sort(), ['entity', 'exact', 'paraphrase'])
  const six = buildSyntheticSet({ chunks: 30, queries: 60, seed: 3, kinds: ['exact', 'cross-lingual', 'negation', 'identifier'] })
  assert.deepEqual([...new Set(six.queries.map((query) => query.kind))].sort(), ['cross-lingual', 'exact', 'identifier', 'negation'])
  assert.throws(() => buildSyntheticSet({ kinds: [] }), /kinds must not be empty/)
})
