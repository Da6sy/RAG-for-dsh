/**
 * State-machine tests: the edge table is the contract (design §3.3 + patches).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KB_FORMAT_VERSION,
  KbEntryId,
  applyTransition,
  canTransition,
  clearNeedsReview,
  raiseNeedsReview,
  transitionTable,
  type KbEntry,
} from '../src/index.ts'

function entry(status: KbEntry['status'], extra: Partial<KbEntry> = {}): KbEntry {
  return {
    version: KB_FORMAT_VERSION,
    id: KbEntryId('k-test'),
    tier: 'project',
    kind: 'pitfall',
    title: 't', text: 'x', tags: [], bindings: [],
    provenance: { createdBy: 'test', createdAt: '2026-09-01T00:00:00.000Z' },
    status,
    needsReview: false, reviewReason: null,
    stats: { lastReferencedAt: null, referenceCount: 0 },
    history: [],
    discardedAt: null,
    ...extra,
  }
}

test('the user-designed happy path: candidate → trusted only via human approval', () => {
  assert.equal(canTransition('candidate', 'trusted', 'approve-promote'), true)
  // No other trigger may promote — evidence scores REQUEST, humans DISPOSE.
  assert.equal(canTransition('candidate', 'trusted', 'expire-idle'), false)
  assert.equal(canTransition('candidate', 'trusted', 'strong-negative'), false)
  const next = applyTransition(entry('candidate'), 'trusted', 'approve-promote', '人工批准', '2026-09-02T00:00:00.000Z')
  assert.equal(next.status, 'trusted')
  assert.equal(next.history.length, 1)
  assert.match(next.history[0].reason, /approve-promote: 人工批准/)
})

test('patch #1: trusted is not lifetime tenure — it has both exits', () => {
  assert.equal(canTransition('trusted', 'expired', 'expire-idle'), true)
  assert.equal(canTransition('trusted', 'discarded', 'strong-negative'), true)
})

test('expired re-activates to candidate (re-earn trust), discarded rescues to candidate', () => {
  assert.equal(canTransition('expired', 'candidate', 'reactivate'), true)
  assert.equal(canTransition('discarded', 'candidate', 'rescue'), true)
  // Never straight back to trusted.
  assert.equal(canTransition('discarded', 'trusted', 'approve-promote'), false)
  assert.equal(canTransition('expired', 'trusted', 'approve-promote'), false)
})

test('illegal edges throw with the legal-edge list (fail loud, never coerce)', () => {
  assert.throws(
    () => applyTransition(entry('candidate'), 'trusted', 'rescue', 'x'),
    /illegal state transition: candidate → trusted/,
  )
  assert.throws(
    () => applyTransition(entry('discarded'), 'trusted', 'approve-promote', 'x'),
    /illegal state transition/,
  )
})

test('entering discarded stamps discardedAt; leaving clears it', () => {
  const at = '2026-09-03T00:00:00.000Z'
  const discarded = applyTransition(entry('candidate'), 'discarded', 'strong-negative', '连续被否', at)
  assert.equal(discarded.discardedAt, at)
  const rescued = applyTransition(discarded, 'candidate', 'rescue', '人工捞回', '2026-09-04T00:00:00.000Z')
  assert.equal(rescued.discardedAt, null)
})

test('patch #2: needsReview is orthogonal — raisable in every state, idempotent, transitions preserve it', () => {
  let e = entry('trusted')
  e = raiseNeedsReview(e, '源文件内容已变: a.html', '2026-09-02T00:00:00.000Z')
  assert.equal(e.needsReview, true)
  // Idempotent: same reason again adds no history spam.
  const again = raiseNeedsReview(e, '源文件内容已变: a.html', '2026-09-02T01:00:00.000Z')
  assert.equal(again.history.length, e.history.length)
  // A status transition does NOT clear the flag (orthogonal).
  const expired = applyTransition(e, 'expired', 'expire-idle', '长期未引用', '2026-09-05T00:00:00.000Z')
  assert.equal(expired.needsReview, true)
  assert.equal(expired.status, 'expired')
  const cleared = clearNeedsReview(expired, '自动重验通过', '2026-09-06T00:00:00.000Z')
  assert.equal(cleared.needsReview, false)
  assert.equal(cleared.reviewReason, null)
})

test('the table is complete: every status except discarded-only-rescue has exits', () => {
  const table = transitionTable()
  const froms = new Set(table.map((e) => e.from))
  for (const status of ['candidate', 'trusted', 'expired', 'discarded']) {
    assert.ok(froms.has(status), `${status} 没有出路`)
  }
})
