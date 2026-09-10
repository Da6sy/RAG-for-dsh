/**
 * Attribution tests: the conservatism rule (decision #9) — a failing
 * verification penalizes ONLY entries whose bindings intersect the changed
 * renderable files; everything else is transparently unattributed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KB_FORMAT_VERSION,
  KbEntryId,
  type KbEntry,
} from '@clue-harness/kb'
import { attributeEvidence, type EvidenceOutcome } from '../src/attribution.ts'

function entry(id: string, bindings: Array<{ path: string; contentHash: string }> = []): KbEntry {
  return {
    version: KB_FORMAT_VERSION,
    id: KbEntryId(id),
    tier: 'project',
    kind: 'pitfall',
    title: id, text: 'x', tags: [],
    bindings,
    provenance: { createdBy: 'test', createdAt: '2026-09-10T00:00:00.000Z' },
    status: 'candidate',
    needsReview: false, reviewReason: null,
    stats: { lastReferencedAt: null, referenceCount: 0 },
    history: [],
    discardedAt: null,
  }
}

const pass: EvidenceOutcome = { exitOk: true, errorCount: 0, failedAssertions: [], errorEntrySummaries: [] }
const fail: EvidenceOutcome = {
  exitOk: false,
  errorCount: 2,
  failedAssertions: ['搜索按钮可被 Tab 选中(实际: 不在 Tab 顺序中)'],
  errorEntrySummaries: ['[interactive] 主区域 > 搜索按钮: 掉出 Tab 顺序(键盘不可达)'],
}

test('passing verification credits EVERY referenced entry', () => {
  const plan = attributeEvidence(pass, [entry('k-1'), entry('k-2')], ['index.html'])
  assert.equal(plan.pass.length, 2)
  assert.equal(plan.fail.length, 0)
  assert.equal(plan.unattributed.length, 0)
  assert.ok(plan.pass.every((p) => p.signal === 'evidence-pass'))
})

test('failing verification penalizes only entries bound to CHANGED renderable files', () => {
  const bound = entry('k-bound', [{ path: 'search.html', contentHash: 'h' }])
  const plan = attributeEvidence(fail, [bound], ['search.html'])
  assert.equal(plan.fail.length, 1)
  assert.equal(plan.fail[0].entryId, bound.id)
  assert.match(plan.fail[0].note, /归因成立/)
  assert.match(plan.fail[0].note, /Tab 顺序/, '失败明细必须进入信号备注(可审计)')
})

test('unbound entries are NEVER penalized by a failure (no attribution, no signal)', () => {
  const unbound = entry('k-free')
  const plan = attributeEvidence(fail, [unbound], ['search.html'])
  assert.equal(plan.fail.length, 0)
  assert.equal(plan.unattributed.length, 1)
  assert.match(plan.unattributed[0].reason, /无源文件绑定/)
})

test('entries bound to UNCHANGED files are not penalized either', () => {
  const elsewhere = entry('k-other', [{ path: 'docs/guide.html', contentHash: 'h' }])
  const plan = attributeEvidence(fail, [elsewhere], ['search.html'])
  assert.equal(plan.fail.length, 0)
  assert.match(plan.unattributed[0].reason, /不在本次改动内/)
})

test('binding match normalizes separators (windows worklog ↔ posix binding)', () => {
  const bound = entry('k-win', [{ path: 'pages/search.html', contentHash: 'h' }])
  const plan = attributeEvidence(fail, [bound], ['.\\pages\\search.html'])
  assert.equal(plan.fail.length, 1)
})

test('mixed batch: each referenced entry gets its own verdict', () => {
  const bound = entry('k-b', [{ path: 'a.html', contentHash: 'h' }])
  const unbound = entry('k-u')
  const plan = attributeEvidence(fail, [bound, unbound], ['a.html'])
  assert.equal(plan.fail.length, 1)
  assert.equal(plan.unattributed.length, 1)
  assert.equal(plan.pass.length, 0)
})
