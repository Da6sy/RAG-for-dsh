/**
 * `clue bench diff` verdict tests — the three ways this command used to lie.
 *
 * All three were measured, not imagined (`docs/评测结果.md` §7), and
 * each one produced a *plausible-looking* output rather than an error:
 *
 * 1. a RED BASELINE was counted as a regression, so the change that repaired a
 *    failure was rejected by the command measuring it (exit 1);
 * 2. two reports with DIFFERENT sample sizes were compared silently, printing
 *    "✓ 提升 / ✗ 回退" for a difference that may be the sample;
 * 3. with a no-ability embedder (`hashEmbedder`) the ability gate forces
 *    `hybrid ≡ lexical`, so the hard lines passed **by construction** — a green
 *    CI that proves nothing.
 *
 * The comparison is pure (`evaluateDiff`), so the tests pin the DECISIONS
 * without touching `evals/runs` or spawning a process.
 *
 * @module @clue-harness/cli/test/bench-diff
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateDiff, hardLineVerdicts, provenanceMismatches, type IndexEntry } from '../src/bench-cli.ts'

/** A report that passes both hard lines, with a small 4-row matrix. */
function entry(over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    id: 'r1',
    file: 'r1.json',
    generatedAt: '2026-09-21T10:00:00.000Z',
    dataset: 'coir/cosqa',
    split: 'test',
    queries: 100,
    documents: 1700,
    embedder: 'text-embedding-v4(dim=1024,endpoint)',
    judge: null,
    judgeVersion: null,
    rows: {
      'lexical+rerank': { 'nDCG@10': 0.3, 'recall@10': 0.45, seconds: 40 },
      'hybrid+no-rerank': { 'nDCG@10': 0.48, 'recall@10': 0.75, seconds: 16 },
      'hybrid+rerank': { 'nDCG@10': 0.56, 'recall@10': 0.8, seconds: 31 },
    },
    hybridMinusLexical: 0.26,
    rerankMinusFusion: 0.08,
    okHybridVsLexical: true,
    okRerankVsFusion: true,
    ok: true,
    caveats: [],
    embedderId: 'text-embedding-v4',
    embedderSemantics: 'endpoint',
    ks: [10],
    knobs: {},
    ...over,
  }
}

/** A report whose reranker lost to the fusion order (the pre-D1 defect). */
function broken(over: Partial<IndexEntry> = {}): IndexEntry {
  return entry({
    id: 'r0',
    file: 'r0.json',
    generatedAt: '2026-09-21T09:00:00.000Z',
    rows: {
      'lexical+rerank': { 'nDCG@10': 0.3, 'recall@10': 0.45, seconds: 40 },
      'hybrid+no-rerank': { 'nDCG@10': 0.48, 'recall@10': 0.75, seconds: 16 },
      'hybrid+rerank': { 'nDCG@10': 0.43, 'recall@10': 0.65, seconds: 34 },
    },
    hybridMinusLexical: 0.13,
    rerankMinusFusion: -0.05,
    okRerankVsFusion: false,
    ok: false,
    ...over,
  })
}

test('缺陷 7.1: 基线是红的只作对照,不再让"修好了"的 diff 退出 1', () => {
  const report = evaluateDiff(broken(), entry())
  assert.equal(report.comparable, true)
  // The baseline's own line is still shown, and still says it failed…
  assert.equal(report.before[1]?.state, 'fail')
  // …but only the NEWER report decides.
  assert.equal(report.after[1]?.state, 'pass')
  assert.equal(report.regressed, false, '基线红不构成回退')
})

test('缺陷 7.1 反面: 新报告自己没过硬线时仍然退出 1', () => {
  const report = evaluateDiff(entry(), broken())
  assert.equal(report.after[1]?.state, 'fail')
  assert.equal(report.regressed, true)
})

test('缺陷 7.2: 查询数不同 ⇒ 检出并判未证明,数字只列不判', () => {
  const report = evaluateDiff(entry({ queries: 50 }), entry({ queries: 10 }))
  assert.equal(report.comparable, false)
  assert.deepEqual(report.mismatches.map((row) => row.field), ['查询数'])
  assert.ok(report.unproven.some((line) => line.includes('口径不同')))
  assert.ok(report.after.every((row) => row.state === 'unproven' && row.reason.includes('口径不同')), '硬线一律未证明(连"会失败"也不判)')
  assert.ok(report.rows.every((row) => row.flag.includes('口径不同') && !row.regresses), '数字行不作判定')
  assert.equal(report.regressed, false, '口径不同不产生退出码')
})

test('缺陷 7.2: 嵌入器/语料规模/k 截断/判分器版本同样算口径', () => {
  const cases: Array<[string, IndexEntry]> = [
    ['嵌入器', entry({ embedderId: 'hash-v1', embedderSemantics: 'endpoint' })],
    ['语料规模', entry({ documents: 900 })],
    ['k 截断', entry({ ks: [5] })],
    ['查询数', entry({ queries: 7 })],
  ]
  for (const [field, other] of cases) {
    assert.ok(provenanceMismatches(entry(), other).some((row) => row.field === field), `${field} 必须被检出`)
  }
  // Knobs are the point of an A/B, so they must NOT block a comparison.
  assert.deepEqual(provenanceMismatches(entry(), entry({ knobs: { lexicalNormalization: 'absolute' } })), [])
})

test('缺陷 7.3: 无能力嵌入器下硬线判未证明,而不是构造性 ✓ 通过', () => {
  const hash = entry({ embedderId: 'hash-v1', embedderSemantics: 'none' })
  const verdicts = hardLineVerdicts(hash)
  assert.equal(verdicts.length, 2)
  for (const verdict of verdicts) {
    assert.equal(verdict.state, 'unproven')
    assert.match(verdict.reason, /语义能力=0/)
  }
  const report = evaluateDiff(hash, hash)
  assert.ok(report.unproven.some((line) => line.includes('无能力嵌入器')))
  assert.equal(report.regressed, false)
})

test('单配置报告(--only)没有跨配置硬线可算 ⇒ 未证明', () => {
  const single = entry({
    hybridMinusLexical: null,
    rerankMinusFusion: null,
    okHybridVsLexical: undefined,
    okRerankVsFusion: undefined,
    rows: { 'hybrid+rerank': { 'nDCG@10': 0.56, seconds: 31 } },
  })
  const verdicts = hardLineVerdicts(single)
  assert.ok(verdicts.length >= 1)
  assert.ok(verdicts.every((verdict) => verdict.state === 'unproven' && verdict.reason.includes('--only')))
})

test('旧 schema 的满矩阵报告:缺列的原因要指对地方(不是"--only")', () => {
  const old = entry({
    hybridMinusLexical: 0.26,
    rerankMinusFusion: undefined,
    okRerankVsFusion: undefined,
  })
  const fusion = hardLineVerdicts(old).find((verdict) => verdict.line.includes('no-rerank'))
  assert.equal(fusion?.state, 'unproven')
  assert.match(fusion?.reason ?? '', /旧 schema/)
  assert.doesNotMatch(fusion?.reason ?? '', /--only/)
})

test('质量回退仍然退出 1;成本与观察列不参与判定', () => {
  const better = entry({ rows: { ...entry().rows, 'hybrid+rerank': { 'nDCG@10': 0.6, 'recall@10': 0.8, seconds: 20 } } })
  assert.equal(evaluateDiff(entry(), better).regressed, false, '更快 + 提升不算回退')
  const worse = entry({ rows: { ...entry().rows, 'hybrid+rerank': { 'nDCG@10': 0.4, 'recall@10': 0.8, seconds: 31 } } })
  const report = evaluateDiff(entry(), worse)
  assert.equal(report.regressed, true)
  assert.ok(report.rows.some((row) => row.metric === 'nDCG@10' && row.flag.includes('✗ 回退')))
})

test('同一份报告自比:全通过且无未证明', () => {
  const report = evaluateDiff(entry(), entry())
  assert.equal(report.comparable, true)
  assert.deepEqual(report.unproven, [])
  assert.ok(report.after.every((verdict) => verdict.state === 'pass'))
  assert.equal(report.regressed, false)
})
