/**
 * ui-kb pure-logic tests (M3c).
 *
 * The browser surfaces split their derivations into React-free modules
 * (parse.ts, api.ts URL building) precisely so the house runner — node
 * --test with strip-types, no jsdom, no React — can pin them: badge
 * derivation, tolerant wire parsing (mid-stream args, error results), and
 * the query contract the kb-web routes answer. Component behavior itself is
 * proven one level up, by the real-composition boot test serving the built
 * bundle into a real browser shell.
 *
 * @module @clue-harness/ui-kb/test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actionCopy, parseArgs, parseKbCiteResult, parseKbProposeResult, parseKbSearchResult,
  resultText, shortId, stateBadge,
} from '@clue-harness/ui-kb/src/client/parse.ts'
import { buildEntriesQuery, KB_API } from '@clue-harness/ui-kb/src/client/api.ts'

test('stateBadge: the four states, and needs-review prefixes + escalates', () => {
  assert.deepEqual(stateBadge('trusted', false), { label: '可信', tone: 'ok' })
  assert.deepEqual(stateBadge('candidate', false), { label: '候选', tone: 'muted' })
  assert.deepEqual(stateBadge('expired', false), { label: '过期', tone: 'warn' })
  assert.deepEqual(stateBadge('discarded', false), { label: '遗弃', tone: 'bad' })
  // The orthogonal flag is part of the label (the M2 acceptance line made it
  // a first-class visible fact) and never downgrades a bad tone.
  assert.deepEqual(stateBadge('trusted', true), { label: '⚑待复核·可信', tone: 'warn' })
  assert.deepEqual(stateBadge('candidate', true), { label: '⚑待复核·候选', tone: 'warn' })
  assert.deepEqual(stateBadge('discarded', true), { label: '⚑待复核·遗弃', tone: 'bad' })
  // Unknown status stays honest (renders the raw value).
  assert.deepEqual(stateBadge('weird', false), { label: 'weird', tone: 'muted' })
})

test('parseArgs: tolerant to truncation and non-objects', () => {
  assert.deepEqual(parseArgs('{"query":"tab 顺序","limit":5}'), { query: 'tab 顺序', limit: 5 })
  // Mid-stream truncation (a running call's argsRaw) degrades to null.
  assert.equal(parseArgs('{"query":"tab 顺'), null)
  assert.equal(parseArgs(''), null)
  assert.equal(parseArgs(null), null)
  assert.equal(parseArgs('[1,2]'), null)
  assert.equal(parseArgs('"text"'), null)
})

test('parseKbSearchResult: the SEARCH_OUTPUT wire shape, defensively', () => {
  const wire = {
    hits: [
      {
        id: 'kb-project-abc123', title: '按钮必须进 Tab 顺序', kind: 'pitfall',
        status: 'candidate', needsReview: true, score: 12.5, text: '悬浮按钮要能被键盘聚焦',
        annotations: ['候选知识', '⚠待复核'],
      },
      // A junk item is skipped, not fatal.
      null,
      { id: 'x' },
    ],
    total: 2,
  }
  const parsed = parseKbSearchResult([{ type: 'text', text: JSON.stringify(wire) }])
  assert.ok(parsed)
  assert.equal(parsed.hits.length, 1)
  assert.equal(parsed.total, 2)
  assert.equal(parsed.hits[0].title, '按钮必须进 Tab 顺序')
  assert.deepEqual(parsed.hits[0].annotations, ['候选知识', '⚠待复核'])

  // Error results (non-JSON text) and empty content degrade to null.
  assert.equal(parseKbSearchResult([{ type: 'text', text: 'tool failed:boom' }]), null)
  assert.equal(parseKbSearchResult([]), null)
  assert.equal(parseKbSearchResult(undefined), null)
  // A JSON payload without hits[] is not the structured output.
  assert.equal(parseKbSearchResult([{ type: 'text', text: '{"ok":true}' }]), null)
})

test('parseKbProposeResult: the PROPOSE_OUTPUT receipt', () => {
  const parsed = parseKbProposeResult([{
    type: 'text',
    text: JSON.stringify({ id: 'kb-project-def456', status: 'candidate', note: '已入候选,待攒批' }),
  }])
  assert.deepEqual(parsed, { id: 'kb-project-def456', status: 'candidate', note: '已入候选,待攒批' })
  assert.equal(parseKbProposeResult([{ type: 'text', text: '{}' }]), null)
  assert.equal(parseKbProposeResult([{ type: 'text', text: 'nope' }]), null)
})

test('parseKbCiteResult: the M4 citation receipt, defensively', () => {
  const parsed = parseKbCiteResult([{
    type: 'text',
    text: JSON.stringify({ cited: ['k-1', 'k-2'], missing: ['k-404'], note: '已记录 2 条引用;1 个 id 不存在' }),
  }])
  assert.deepEqual(parsed, { cited: ['k-1', 'k-2'], missing: ['k-404'], note: '已记录 2 条引用;1 个 id 不存在' })
  // Non-string items are filtered, not fatal; missing/note default cleanly.
  const loose = parseKbCiteResult([{ type: 'text', text: JSON.stringify({ cited: ['k-1', 42, null] }) }])
  assert.deepEqual(loose, { cited: ['k-1'], missing: [], note: '' })
  // Without a cited array it is not the receipt.
  assert.equal(parseKbCiteResult([{ type: 'text', text: '{"note":"x"}' }]), null)
  assert.equal(parseKbCiteResult([{ type: 'text', text: 'nope' }]), null)
  assert.equal(parseKbCiteResult([]), null)
})

test('resultText concatenates only text blocks', () => {
  assert.equal(
    resultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]),
    'ab',
  )
  assert.equal(resultText(undefined), '')
})

test('actionCopy covers the four verbs and unknown ones', () => {
  assert.equal(actionCopy('promote').approve, '批准提升为可信')
  assert.equal(actionCopy('discard').summary, '遗弃')
  assert.equal(actionCopy('rescue').approve, '批准捞回候选')
  assert.equal(actionCopy('reactivate').summary, '重新激活')
  assert.equal(actionCopy('mystery').approve, '批准(mystery)')
})

test('shortId keeps short ids and elides long ones', () => {
  assert.equal(shortId('kb-1'), 'kb-1')
  assert.equal(shortId('kb-project-0123456789abcdef'), 'kb-proje…cdef')
})

test('buildEntriesQuery: the /entries query contract', () => {
  assert.equal(buildEntriesQuery({}), '')
  assert.equal(buildEntriesQuery({ scope: 'project' }), '?scope=project')
  assert.equal(
    buildEntriesQuery({ scope: 'global', status: 'trusted', kind: 'pitfall', needsReview: true, limit: 10 }),
    '?scope=global&status=trusted&kind=pitfall&needsReview=1&limit=10',
  )
  // Empty strings stay absent; q trims, and spaces ride URLSearchParams'
  // `+` form (the route decodes it back to a space — same semantics).
  assert.equal(buildEntriesQuery({ status: '', q: '  ' }), '')
  assert.equal(buildEntriesQuery({ scope: 'project', q: ' BOM 编码 ' }), '?scope=project&q=BOM+%E7%BC%96%E7%A0%81')
  assert.equal(new URLSearchParams(buildEntriesQuery({ q: ' BOM 编码 ' }).slice(1)).get('q'), 'BOM 编码')
  // The API base mirrors the host route prefix.
  assert.equal(KB_API, '/api/clue-kb')
})
