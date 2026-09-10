/**
 * M4 acceptance mainline — the FULL evidence loop, keyless and scripted:
 *
 *   pre-step 检索注入踩坑知识 → 脚本化模型无视它写坏页面(tabindex=-1 悬浮按钮)
 *   → turn-stopping 门禁真浏览器验证 FAIL → 失败签名自动检索 → 纠正报告+先例
 *   知识合并注入(一条消息) → 同轮续跑 → 模型修复 + kb_cite 精确引用
 *   → 门禁复验 PASS(M4 预算分离:注入预算已尽不妨碍复验) → turn 完成
 *   → 账本上 evidence-fail 与 evidence-pass 各一条,绑定漂移自动待复核。
 *
 * Both attribution paths run in ONE flow: the FAIL phase attributes through
 * the surfaced-set fallback (no citation yet), the PASS phase through the
 * precise kb_cite set — decision #9's "用作依据,不是检索到过" end to end.
 *
 * Browser-gated (house pattern): no Chromium → clean skip with the install
 * instruction; a real browser turns this into the real acceptance run.
 *
 * @module @clue-harness/cli/test/gate-loop
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  CallId, createUserMessage, LlmAdapter, SessionId,
  type Agent, type GenerateOptions, type StreamChunk,
} from '@clue-harness/compat'
import { openProjectStore, readSignals } from '@clue-harness/kb'
import { probeBrowser } from '@clue-harness/evidence-render'

const configPath = fileURLToPath(new URL('../src/clue.cordis.yml', import.meta.url))
const probe = await probeBrowser()
const skip = probe.ok
  ? undefined
  : `Chromium 不可用(${probe.error ?? '原因未知'});装好浏览器二进制/系统库后重跑即自动转真测`

/** The page as seeded (binding hash anchors here) — button in normal flow. */
const PAGE_GOOD = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>注册</title></head>
<body><main>
<form data-module="signup">
  <input type="email" placeholder="邮箱">
  <button type="submit">提交</button>
</form>
</main></body></html>
`

/** The pitfall write: floating capsule with tabindex=-1 (drops tab order). */
const PAGE_BROKEN = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>注册</title></head>
<body><main>
<form data-module="signup">
  <input type="email" placeholder="邮箱">
  <button type="submit" tabindex="-1" style="position:absolute;right:16px;bottom:16px">提交</button>
</form>
</main></body></html>
`

/** The fix: back in flow, tabbable again. */
const PAGE_FIXED = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>注册</title></head>
<body><main>
<form data-module="signup">
  <input type="email" placeholder="邮箱">
  <button type="submit" style="float:right">提交</button>
</form>
</main></body></html>
`

/** One scripted model call: either a tool call or a plain text answer. */
type ScriptedCall =
  | { toolCall: { id: string; name: string; args: Record<string, unknown> } }
  | { text: string }

/** Replay adapter (kbface.test pattern; no constructor parameter properties). */
class ScriptedAdapter extends LlmAdapter {
  private readonly calls: readonly ScriptedCall[]
  private index = 0
  constructor(calls: readonly ScriptedCall[]) {
    super()
    this.calls = calls
  }
  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const spec = this.calls[Math.min(this.index, this.calls.length - 1)]
    this.index += 1
    return (async function* (): AsyncGenerator<StreamChunk> {
      if ('toolCall' in spec) {
        const block = {
          type: 'tool-call' as const,
          id: CallId(spec.toolCall.id),
          name: spec.toolCall.name,
          arguments: JSON.stringify(spec.toolCall.args),
        }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: spec.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: spec.text } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

test('M4 mainline: break → gate blocks → signature-retrieved precedent injected → fix + cite → re-verify passes', { skip, timeout: 180_000 }, async (t) => {
  // ── isolation (the full M3c lesson: cwd + DSH_HOME + CLUE_HOME) ─────────
  const workdir = await mkdtemp(path.join(tmpdir(), 'clue-gateloop-'))
  const project = path.join(workdir, 'proj')
  await mkdir(project, { recursive: true })
  const savedCwd = process.cwd()
  const savedDshHome = process.env.DSH_HOME
  const savedClueHome = process.env.CLUE_HOME
  const savedKey = process.env.DEEPSEEK_API_KEY
  process.chdir(project)
  process.env.DSH_HOME = path.join(workdir, 'dsh-home')
  process.env.CLUE_HOME = path.join(workdir, 'clue-home')
  process.env.DEEPSEEK_API_KEY = 'test-key-not-used-by-mock'
  t.after(async () => {
    process.chdir(savedCwd)
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    if (savedClueHome === undefined) delete process.env.CLUE_HOME
    else process.env.CLUE_HOME = savedClueHome
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = savedKey
    await rm(workdir, { recursive: true, force: true })
  })

  // ── seed: the page (binding anchor) + the pitfall knowledge, TRUSTED ───
  await writeFile(path.join(project, 'page.html'), PAGE_GOOD)
  const seedStore = await openProjectStore(project, process.env.CLUE_HOME)
  const pitfall = await seedStore.add({
    kind: 'pitfall',
    title: '悬浮按钮的可访问性',
    text: '浮动定位的操作按钮不要移出焦点顺序(不要加 tabindex=-1),键盘用户必须能 Tab 到达它;修复:回到文档流或用可见焦点样式。',
    tags: ['按钮', '可访问性'],
    bindings: ['page.html'],
    createdBy: 'agent:earlier-session',
  })
  await seedStore.transition(pitfall.id, 'trusted', 'approve-promote', '演示前置:已批准为可信')

  // ── boot the REAL composition + the scripted model ──────────────────────
  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  const ctx = await boot('clue-gateloop', configPath)
  t.after(() => ctx.fiber.dispose())
  const release = ctx.llm.registerAdapter(['mock-gate'], new ScriptedAdapter([
    // Phase 1 — the model ignores the injected precedent and breaks the page.
    { toolCall: { id: 'c1', name: 'read', args: { file_path: 'page.html' } } },
    { toolCall: { id: 'c2', name: 'write', args: { file_path: 'page.html', content: PAGE_BROKEN } } },
    { text: '已把提交按钮做成右下角悬浮胶囊。' },
    // ── the gate fires here: FAIL → signature retrieval → injection ──
    // Phase 2 — the model follows the injected report + precedent, fixes,
    // and CITES the entry it used as basis (precise attribution path).
    { toolCall: { id: 'c3', name: 'read', args: { file_path: 'page.html' } } },
    { toolCall: { id: 'c4', name: 'write', args: { file_path: 'page.html', content: PAGE_FIXED } } },
    { toolCall: { id: 'c5', name: 'kb_cite', args: { entryIds: String(pitfall.id), note: '按坑知识移除 tabindex=-1,按钮回到文档流' } } },
    { text: '已修复:提交按钮回到文档流,可被 Tab 聚焦。' },
    // ── the gate re-verifies here: PASS → no injection → turn completes ──
  ]))
  t.after(() => release())

  const agent = ctx.agentLoop.create(
    SessionId('gate-loop-m4'),
    { provider: 'mock-gate', model: 'mock-model' },
    { cwd: project },
  )
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '给注册表单加一个提交按钮,做成右下角悬浮胶囊样式,不要抢占焦点' }],
    source: { kind: 'user' },
  }))
  await waitForIdle(ctx, agent)

  // ── the log tells the whole story (model-visible ⟺ logged) ─────────────
  const events = [...agent.session.events]
  const turnEnd = events.findLast((e) => e.type === 'turn/end')
  assert.ok(turnEnd && turnEnd.type === 'turn/end', 'turn 必须完成')
  assert.deepEqual(turnEnd.data.reason, { kind: 'completed' }, `turn 未正常收尾: ${JSON.stringify(turnEnd.data.reason)}`)

  const pluginMessages = events.filter((e) =>
    e.type === 'user/message' && (e.data as { source?: { kind?: string } }).source?.kind === 'plugin')
  const texts = pluginMessages.map((e) => {
    const message = e.data as { content: { type: string; text?: string }[] }
    return message.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
  })

  // (1) pre-step retrieval injected the pitfall BEFORE the first step.
  const kbContext = texts.find((text) => text.includes('<kb_context'))
  assert.ok(kbContext, 'pre-step 检索注入缺失')
  assert.ok(kbContext.includes(String(pitfall.id)), '注入必须携带踩坑条目')

  // (2) exactly ONE gate injection: report + signature-retrieved precedent.
  const gateMessages = texts.filter((text) => text.includes('<render_evidence'))
  assert.equal(gateMessages.length, 1, `门禁注入应恰好一次,实际 ${gateMessages.length}`)
  const gate = gateMessages[0]
  assert.ok(gate.includes('Tab'), `纠正报告必须点名失败的断言: ${gate.slice(0, 200)}`)
  assert.ok(gate.includes('<kb_assist'), '门禁第二阶段:失败签名检索的先例块缺失')
  assert.ok(gate.includes(String(pitfall.id)), '先例块必须携带踩坑条目 id')
  assert.ok(gate.includes('kb_cite'), '先例块必须指导模型用 kb_cite 声明引用')

  // (3) kb_cite ran and confirmed the citation.
  const citeResult = events.find((e) => {
    if (e.type !== 'tool/result') return false
    const content = (e as { data: { message: { content: { content?: { text?: string }[] }[] } } }).data.message.content
    return JSON.stringify(content).includes('已记录 1 条引用')
  })
  assert.ok(citeResult, 'kb_cite 的确认结果必须落日志')

  // ── the KB ledgers: both attribution paths recorded signals ────────────
  const signals = await readSignals(path.join(seedStore.dir, 'signals.jsonl'))
  const mine = signals.filter((s) => s.entryId === pitfall.id)
  const fail = mine.find((s) => s.source === 'evidence' && s.polarity === 'negative')
  const pass = mine.find((s) => s.source === 'evidence' && s.polarity === 'positive')
  assert.ok(fail, `第一次验证失败必须给被引用(曝光回退)条目记 evidence-fail: ${JSON.stringify(mine)}`)
  assert.ok(fail.note.includes('归因成立'), 'fail 信号必须说明归因依据')
  assert.ok(pass, `复验通过必须给 kb_cite 引用的条目记 evidence-pass: ${JSON.stringify(mine)}`)

  // ── the fix itself drifted the binding: the entry is honestly flagged ──
  const after = await seedStore.get(pitfall.id)
  assert.ok(after?.needsReview, '绑定文件被本轮改写,条目必须自动进入待复核')
  assert.equal(after?.status, 'trusted', '待复核与状态正交:trusted 不因漂移降级')
})
