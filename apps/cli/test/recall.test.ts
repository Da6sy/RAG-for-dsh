/**
 * `clue recall` harness tests: the GENERATOR invariants and the METRIC math.
 *
 * The generator is the part that can lie, and it did twice while being written
 * (a phrase drawn twice so the query text never appeared in its own gold
 * document; non-unique phrases giving one query dozens of right answers). Both
 * bugs produced a plausible-looking report, so the invariants that would have
 * caught them are pinned here rather than trusted to inspection:
 *
 *   - every gold phrase really occurs in its own gold document;
 *   - a gold subject identifies exactly one document;
 *   - the same seed yields the same corpus and queries.
 *
 * The run itself (ingest + rank) is NOT tested here: it takes seconds and a
 * temp KB, which is the script's job to prove — it prints its own
 * `queryChunks` self-check on every run.
 *
 * @module @clue-harness/cli/test/recall
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSyntheticSet,
  makeChunk,
  parseArgs,
  rng,
  scoreRanking,
  summarizeRanking,
} from '../src/recall-cli.ts'

test('rng: deterministic for a seed, uniform-ish over [0,1)', () => {
  const a = rng(42)
  const b = rng(42)
  const first = [a(), a(), a()]
  assert.deepEqual(first, [b(), b(), b()])
  assert.ok(first.every((v) => v >= 0 && v < 1))
  assert.notDeepEqual(first, [rng(43)(), rng(43)(), rng(43)()])
})

test('makeChunk: the gold phrases are substrings of the chunk body', () => {
  // The regression this pins: the body once rendered a DIFFERENT draw of the
  // phrase than the query used, so "exact" queries pointed at text their own
  // gold document did not contain.
  const rand = rng(7)
  for (let i = 0; i < 50; i += 1) {
    const chunk = makeChunk(rand, i)
    assert.ok(chunk.body.includes(chunk.exact), `exact 未出现在正文: ${chunk.exact}`)
    assert.ok(chunk.body.includes(chunk.pitfallExact), `pitfallExact 未出现在正文: ${chunk.pitfallExact}`)
    assert.ok(chunk.body.includes(chunk.subject), 'subject 必须出现在正文(实体查询的锚)')
    // The paraphrase must NOT be a verbatim substring — that is what makes it
    // the hard case; if it leaked into the body the class would be meaningless.
    assert.ok(!chunk.body.includes(chunk.paraphrase), `paraphrase 不应逐字出现在正文: ${chunk.paraphrase}`)
  }
})

test('buildSyntheticSet: subjects are unique, counts are honored, seed is stable', () => {
  const set = buildSyntheticSet({ chunks: 120, queries: 60, seed: 123 })
  assert.equal(set.docs.length, 120)
  assert.equal(set.queries.length, 60)
  const subjects = set.docs.map((d) => d.subject)
  assert.equal(new Set(subjects).size, subjects.length, '主题必须唯一,否则一个查询有多个正确答案')
  assert.equal(new Set(set.docs.map((d) => d.id)).size, 120, '文档 id 唯一')
  // Every query's gold document exists.
  for (const query of set.queries) {
    assert.ok(set.docs.some((d) => d.id === query.goldDocId), `金标文档缺失: ${query.goldDocId}`)
    assert.ok(query.text.trim().length > 0)
  }
  // Three kinds, round-robin and balanced.
  const kinds = new Set(set.queries.map((q) => q.kind))
  assert.deepEqual([...kinds].sort(), ['entity', 'exact', 'paraphrase'])
  // Determinism: same seed ⇒ identical corpus and queries.
  assert.deepEqual(buildSyntheticSet({ chunks: 120, queries: 60, seed: 123 }), set)
})

test('scoreRanking: rank, recall@K, nDCG@K and MRR agree with hand computation', () => {
  const ranked = ['d-a', 'd-b', 'd-gold', 'd-c']
  const outcome = scoreRanking(ranked, 'd-gold', [1, 3, 5])
  assert.equal(outcome.rank, 3)
  assert.equal(outcome.rr, 1 / 3)
  assert.equal(outcome.recall[1], false)
  assert.equal(outcome.recall[3], true)
  assert.equal(outcome.recall[5], true)
  // One relevant document ⇒ DCG = 1/log2(rank+1), IDCG = 1.
  assert.equal(outcome.ndcg[1], 0)
  assert.equal(outcome.ndcg[3], 1 / Math.log2(4))
  // A miss scores zero everywhere, never a silent pass.
  const miss = scoreRanking(['d-x'], 'd-gold', [1, 10])
  assert.equal(miss.rank, null)
  assert.equal(miss.rr, 0)
  assert.equal(miss.recall[10], false)
  assert.equal(miss.ndcg[10], 0)
})

test('summarizeRanking: averages overall and per kind, empty safe', () => {
  const rows = [
    { kind: 'exact', outcome: scoreRanking(['g', 'x'], 'g', [1, 5]) },
    { kind: 'exact', outcome: scoreRanking(['x', 'g'], 'g', [1, 5]) },
    { kind: 'entity', outcome: scoreRanking(['x'], 'g', [1, 5]) },
  ]
  const summary = summarizeRanking(rows, [1, 5])
  assert.equal(summary.overall.queries, 3)
  assert.equal(summary.overall.recall[1], 1 / 3)
  assert.equal(summary.overall.recall[5], 2 / 3)
  assert.equal(summary.byKind.exact.queries, 2)
  assert.equal(summary.byKind.exact.recall[1], 0.5)
  assert.equal(summary.byKind.entity.recall[5], 0)
  assert.equal(summary.byKind.entity.mrr, 0)
  const empty = summarizeRanking([], [1])
  assert.equal(empty.overall.queries, 0)
  assert.equal(empty.overall.recall[1], 0, '空集是 0,不是 NaN')
})

test('parseArgs: flags with values, bare flags, positionals', () => {
  assert.deepEqual(parseArgs(['--chunks', '600', 'extra', '--json']), { chunks: '600', json: 'true', _: ['extra'] })
  assert.deepEqual(parseArgs([]), { _: [] })
})
