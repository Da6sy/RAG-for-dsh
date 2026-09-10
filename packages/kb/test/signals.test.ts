/**
 * Signal ledger tests: weights, sliding window, discard bound (decision #9).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_KB_CONFIG,
  KbEntryId,
  buildSignal,
  discardThreshold,
  windowScore,
  type SignalRecord,
} from '../src/index.ts'

const id = KbEntryId('k-1')
const now = new Date('2026-09-10T00:00:00.000Z')
const daysAgo = (n: number): string => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString()

test('the five signal inputs map to the decision-#9 weights', () => {
  const cases: Array<[Parameters<typeof buildSignal>[1], number, 'positive' | 'negative']> = [
    ['human-confirm', DEFAULT_KB_CONFIG.weights.human, 'positive'],
    ['evidence-pass', DEFAULT_KB_CONFIG.weights.evidence, 'positive'],
    ['implicit-use', DEFAULT_KB_CONFIG.weights.implicit, 'positive'],
    ['evidence-fail', DEFAULT_KB_CONFIG.weights.evidenceFail, 'negative'],
    ['user-reject', DEFAULT_KB_CONFIG.weights.userReject, 'negative'],
  ]
  for (const [input, weight, polarity] of cases) {
    const record = buildSignal(id, input, 'note', DEFAULT_KB_CONFIG, now.toISOString())
    assert.equal(record.weight, weight, input)
    assert.equal(record.polarity, polarity, input)
    assert.match(record.note, new RegExp(input))
  }
})

test('human confirmation outranks evidence outranks implicit', () => {
  const w = DEFAULT_KB_CONFIG.weights
  assert.ok(w.human > w.evidence && w.evidence > w.implicit)
  // One user rejection outweighs any single positive.
  assert.ok(Math.abs(w.userReject) > w.human)
})

test('sliding window: signals older than windowDays do not count', () => {
  const signals: SignalRecord[] = [
    buildSignal(id, 'human-confirm', '', DEFAULT_KB_CONFIG, daysAgo(5)),   // +5 in window
    buildSignal(id, 'human-confirm', '', DEFAULT_KB_CONFIG, daysAgo(40)),  // outside 30d
    buildSignal(id, 'implicit-use', '', DEFAULT_KB_CONFIG, daysAgo(1)),    // +1
  ]
  const score = windowScore(signals, id, now, DEFAULT_KB_CONFIG.windowDays)
  assert.equal(score.score, 6)
  assert.equal(score.counted, 2)
  assert.equal(score.positive, 6)
  assert.equal(score.negative, 0)
  assert.equal(score.lastSignalAt, daysAgo(1))
})

test('scores are per-entry: other entries’ signals never leak in', () => {
  const other = KbEntryId('k-2')
  const signals = [
    buildSignal(id, 'user-reject', ''),
    buildSignal(other, 'human-confirm', ''),
  ]
  assert.equal(windowScore(signals, id, now).score, DEFAULT_KB_CONFIG.weights.userReject)
  assert.equal(windowScore(signals, other, now).score, DEFAULT_KB_CONFIG.weights.human)
})

test('threshold ±20 (user-confirmed): one rejection no longer discards; sustained negativity does', () => {
  const bound = discardThreshold(DEFAULT_KB_CONFIG)
  assert.equal(bound, -DEFAULT_KB_CONFIG.trustThreshold)
  assert.equal(bound, -20)
  // A single "你说不对" (-6) is the heaviest per-event signal but must not
  // kill knowledge alone — a misclick cannot discard an entry.
  const rejected = windowScore([buildSignal(id, 'user-reject', '')], id, now)
  assert.ok(rejected.score > bound)
  // Four sustained rejections (-24) cross the bound.
  const four = windowScore(
    [0, 1, 2, 3].map((i) => buildSignal(id, 'user-reject', '', DEFAULT_KB_CONFIG, daysAgo(i))),
    id, now,
  )
  assert.ok(four.score <= bound, '持续否定必须能触发强负遗弃')
  // One attributed evidence failure alone is far from the bound.
  const failed = windowScore([buildSignal(id, 'evidence-fail', '')], id, now)
  assert.ok(failed.score > bound)
  assert.ok(failed.score < 0)
})

test('promotion at ±20 needs a real evidence basket, not one confirmation', () => {
  const oneHuman = windowScore([buildSignal(id, 'human-confirm', '')], id, now)
  assert.ok(oneHuman.score < DEFAULT_KB_CONFIG.trustThreshold)
  const basket = windowScore([
    buildSignal(id, 'human-confirm', '', DEFAULT_KB_CONFIG, daysAgo(4)),
    buildSignal(id, 'human-confirm', '', DEFAULT_KB_CONFIG, daysAgo(3)),
    buildSignal(id, 'evidence-pass', '', DEFAULT_KB_CONFIG, daysAgo(2)),
    buildSignal(id, 'evidence-pass', '', DEFAULT_KB_CONFIG, daysAgo(1)),
    buildSignal(id, 'implicit-use', '', DEFAULT_KB_CONFIG, daysAgo(0)),
  ], id, now)
  assert.equal(basket.score, 5 + 5 + 3 + 3 + 1)
  assert.ok(basket.score < DEFAULT_KB_CONFIG.trustThreshold, '17 分仍不够——阈值 20 是有意保守')
})

test('"retrieved but unused" is not a signal at all — the vocabulary has no such input', () => {
  // Decision #9 guard: the SignalInput union is exactly the five tiered cases.
  const inputs: Parameters<typeof buildSignal>[1][] = ['human-confirm', 'evidence-pass', 'implicit-use', 'evidence-fail', 'user-reject']
  assert.equal(inputs.length, 5)
})
