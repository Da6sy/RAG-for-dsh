/**
 * Pure gate/tracker tests (no dsh, no browser): the turn-stopping evidence
 * gate's decision chain, decision #25 (backend-only never inspects), and the
 * loop-protection cap.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TurnTracker, gateDecision, pickInspectPage } from '../src/turn-state.ts'

const opts = { gate: true, maxInspectionsPerTurn: 4 }

test('tracker records changes, surfaced and CITED ids per turn, resets on start', () => {
  const tracker = new TurnTracker()
  tracker.start('s1', 1)
  tracker.recordChangedFile('s1', 'index.html')
  tracker.recordSurfaced('s1', ['k-1', 'k-2'])
  tracker.recordCited('s1', ['k-2'])
  const state = tracker.get('s1')
  assert.ok(state)
  assert.deepEqual([...state.changedFiles], ['index.html'])
  assert.equal(state.surfacedIds.size, 2)
  assert.deepEqual([...state.citedIds], ['k-2'], 'kb_cite 声明的条目单独记账')
  tracker.start('s1', 2)
  const fresh = tracker.get('s1')
  assert.equal(fresh?.turn, 2)
  assert.equal(fresh?.changedFiles.size, 0, '新 turn 必须清零')
  assert.equal(fresh?.citedIds.size, 0, '新 turn 必须清零引用')
  assert.equal(tracker.get('unknown'), undefined)
})

test('decision #25: backend-only and no-change turns never inspect', () => {
  const tracker = new TurnTracker()
  tracker.start('s', 1)
  assert.equal(gateDecision(tracker.get('s'), [], opts).act, 'skip')
  tracker.recordChangedFile('s', 'src/api/users.ts')
  const decision = gateDecision(tracker.get('s'), [], opts)
  assert.equal(decision.act, 'skip')
  assert.match(decision.reason, /纯后端/)
})

test('gate disabled or already inspected → skip', () => {
  const tracker = new TurnTracker()
  tracker.start('s', 1)
  tracker.recordChangedFile('s', 'index.html')
  assert.equal(gateDecision(tracker.get('s'), ['index.html'], { gate: false, maxInspectionsPerTurn: 4 }).act, 'skip')
  tracker.markInspected('s')
  assert.equal(gateDecision(tracker.get('s'), ['index.html'], opts).act, 'skip')
})

test('M4 budget split: a fired gate still RE-VERIFIES the fix; the inspection cap bounds browser runs', () => {
  const tracker = new TurnTracker()
  tracker.start('s', 1)
  tracker.recordChangedFile('s', 'index.html')
  assert.equal(gateDecision(tracker.get('s'), ['index.html'], opts).act, 'inspect')
  // Inspection #1 failed and the face injected its one correction report.
  tracker.markInspected('s')
  tracker.markGateFired('s')
  // The model fixes something → the new change clears `inspected`…
  tracker.recordChangedFile('s', 'index.html')
  assert.equal(tracker.get('s')?.inspected, false, '新改动必须重置 inspected(修复后要能复验)')
  // …and the re-verification RUNS even though the fire budget is spent: a
  // passing inspection injects nothing (the M4 semantics fix — the old rule
  // skipped here, making "修复→复验通过" impossible at the default cap).
  assert.equal(gateDecision(tracker.get('s'), ['index.html'], opts).act, 'inspect')
  // The injection budget lives in the face; the decision chain ignores fires.
  tracker.markGateFired('s')
  tracker.recordChangedFile('s', 'index.html')
  tracker.markInspected('s') // inspections: 2 → still under the cap of 4…
  tracker.recordChangedFile('s', 'index.html')
  assert.equal(gateDecision(tracker.get('s'), ['index.html'], opts).act, 'inspect')
  // Spend the inspection budget: browser runs are the cost face, capped.
  tracker.markInspected('s') // 3
  tracker.recordChangedFile('s', 'index.html')
  tracker.markInspected('s') // 4 = cap
  tracker.recordChangedFile('s', 'index.html')
  const capped = gateDecision(tracker.get('s'), ['index.html'], opts)
  assert.equal(capped.act, 'skip')
  assert.match(capped.reason, /已验证 4 次\(上限 4\)/)
  // A tighter cap re-shapes the budget without touching fire semantics.
  assert.equal(gateDecision(tracker.get('s'), ['index.html'], { gate: true, maxInspectionsPerTurn: 8 }).act, 'inspect')
})

test('pickInspectPage: configured page wins, else first sorted .html, CSS-only → null', () => {
  assert.equal(pickInspectPage(['a.html', 'b.html'], 'fixed.html'), 'fixed.html')
  assert.equal(pickInspectPage(['z.html', 'a.HTM']), 'a.HTM')
  assert.equal(pickInspectPage(['styles/app.css']), null)
  assert.equal(pickInspectPage([]), null)
})

test('M6 attribution context: inspection targets archive per turn and resolve by turn number', () => {
  const tracker = new TurnTracker()
  tracker.start('s', 1)
  tracker.recordChangedFile('s', 'page.html')
  tracker.recordCited('s', ['k-1'])
  tracker.recordInspectionTargets('s', 'page.html', [
    { id: 'signup', marked: true },
    { id: 'main>form>button', marked: false },
  ])
  tracker.markInspected('s')
  // Turn 2 archives turn 1; the live state is now turn 2 (text-only: empty).
  tracker.start('s', 2)
  const archived = tracker.turnContext('s', 1)
  assert.ok(archived)
  assert.deepEqual(archived.modules, [
    { id: 'signup', marked: true },
    { id: 'main>form>button', marked: false },
  ], '归档摘要必须保住检验看过的模块(含标记事实)')
  assert.equal(archived.page, 'page.html')
  assert.deepEqual(archived.citedIds, ['k-1'])
  // An EMPTY turn inherits the nearest working turn: a dislike on a "收到"
  // reply is about the last real output, not about the echo.
  assert.equal(tracker.turnContext('s', 2)?.turn, 1, '纯文本轮的点踩必须归因到最近干活的轮')
  // Unmappable messages fall back to the newest context-bearing turn.
  assert.equal(tracker.turnContext('s', null)?.turn, 1)
  assert.equal(tracker.turnContext('s', 99)?.turn, 1)
  // An unknown session has no context at all.
  assert.equal(tracker.turnContext('ghost', null), undefined)
  // clear() wipes summaries too.
  tracker.clear('s')
  assert.equal(tracker.turnContext('s', 1), undefined)
})
