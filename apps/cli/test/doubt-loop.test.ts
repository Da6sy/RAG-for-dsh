/**
 * M6 acceptance line — "连续点踩 2 次 → 自动截图验证 → 产生'该模块需视觉
 * 确认'候选知识", end to end on the REAL composition with a REAL browser:
 *
 *   turn 1: 脚本模型改 page.html + kb_cite 引用种子知识 → 门禁真检验 PASS
 *           → 检验目标(模块清单)记入轮次摘要
 *   测试驱动 dsh message-feedback 对 turn 1 的回答点踩(带一句话反馈)
 *   turn 2: turn/start 反馈轮询消费点踩#1 → 两本账各记 1(阈值 2,不升级)
 *   点踩 turn 2 的回答
 *   turn 3: 轮询消费点踩#2 → 达到阈值:
 *           模块账 → L3 截图(真 Chromium,入附件库)+ 候选知识沉淀
 *           知识账 → 被精确引用的种子条目记 user-reject(-6,最重负信号)
 *
 * The feedback intake is the dsh service itself (dynamically mounted with
 * its storage chain — the CLI composition does not ship it, the web one
 * does); the poll-diff latency is real, so the test waits on the LEDGERS,
 * the product's own source of truth.
 *
 * @module @clue-harness/cli/test/doubt-loop
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  CallId, createUserMessage, LlmAdapter, SessionId,
  type Agent, type GenerateOptions, type StreamChunk,
} from '@clue-harness/compat'
import { openProjectStore, readSignals } from '@clue-harness/kb'
import { readDoubtLedger } from '@clue-harness/kb-loop'
import { probeBrowser } from '@clue-harness/evidence-render'

const configPath = fileURLToPath(new URL('../src/clue.cordis.yml', import.meta.url))
const probe = await probeBrowser()
const skip = probe.ok
  ? undefined
  : `Chromium 不可用(${probe.error ?? '原因未知'});截图升级需要真实浏览器`

/** The page: every module MARKED, so captures and doubt keys are clean ids. */
const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>注册</title></head>
<body><main data-module="main-area">
<form data-module="signup">
  <input data-module="email-input" type="email" placeholder="邮箱">
  <button data-module="submit-btn" type="submit">提交</button>
</form>
</main></body></html>
`

/** One scripted model call: either a tool call or a plain text answer. */
type ScriptedCall =
  | { toolCall: { id: string; name: string; args: Record<string, unknown> } }
  | { text: string }

/** Replay adapter (the house pattern; strip-types-safe). */
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

/**
 * Poll a predicate until true (the ledgers are the product's truth; the
 * feedback intake rides turn boundaries and escalations run off-band).
 * @param label - assertion label on timeout.
 * @param predicate - the awaited condition.
 */
async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}

/** The newest assistant message id of a session (the dislike target). */
function lastAssistantMessageId(agent: Agent): string {
  const events = [...agent.session.events].filter((e) => e.type === 'assistant/message')
  const last = events[events.length - 1] as { data: { message: { id: unknown } } }
  return String(last.data.message.id)
}

test('M6 acceptance: two dislikes → L3 capture + 视觉确认 candidate knowledge + user-reject on the cited entry', { skip, timeout: 300_000 }, async (t) => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'clue-doubtloop-'))
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

  await writeFile(path.join(project, 'page.html'), PAGE)
  const home = process.env.CLUE_HOME
  const store = await openProjectStore(project, home)
  const seed = await store.add({
    kind: 'pitfall',
    title: '表单按钮的可访问性',
    text: '提交按钮必须键盘可达且有足够对比度。',
    bindings: ['page.html'],
  })

  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  const ctx = await boot('clue-doubtloop', configPath)
  t.after(() => ctx.fiber.dispose())

  // The feedback plane the web surface ships, mounted dynamically (the CLI
  // composition has no reason to carry it; kb-face treats it as optional).
  const loader = ctx.get('loader')
  assert.ok(loader, 'loader 服务缺失')
  await loader.create({ name: '@deepseek-ai/dsh-storage' })
  await loader.create({ name: '@deepseek-ai/dsh-storage-json', config: { root: path.join(workdir, 'storages') } })
  await loader.create({ name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } })
  await loader.create({ name: '@deepseek-ai/dsh-message-feedback', config: { maxNoteBytes: 8192 } })
  const feedback = ctx.get('messageFeedback') as {
    put(request: unknown): Promise<{ ok: boolean; error?: { code?: string } }>
  } | undefined
  assert.ok(feedback, 'message-feedback 服务必须激活')

  const release = ctx.llm.registerAdapter(['mock-doubt'], new ScriptedAdapter([
    // Turn 1: touch the page (renderable change → gate inspects → PASS) and
    // CITE the seed entry (the entry ledger's precise-attribution input).
    { toolCall: { id: 'c1', name: 'read', args: { file_path: 'page.html' } } },
    { toolCall: { id: 'c2', name: 'write', args: { file_path: 'page.html', content: PAGE } } },
    { toolCall: { id: 'c3', name: 'kb_cite', args: { entryIds: String(seed.id), note: '按可访问性知识检查了按钮' } } },
    { text: '第一轮:页面已确认。' },
    { text: '第二轮:收到。' },
    { text: '第三轮:收到。' },
  ]))
  t.after(() => release())

  const agent = ctx.agentLoop.create(SessionId('doubt-loop-m6'), { provider: 'mock-doubt', model: 'm' }, { cwd: project })
  const sessionId = agent.session.id

  // ── turn 1 + dislike #1 ────────────────────────────────────────────────
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '确认注册页没问题' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  const put1 = await feedback.put({
    sessionId, messageId: lastAssistantMessageId(agent) as never,
    rating: 'negative', note: '按钮看着不对', ifVersion: null,
  })
  assert.ok(put1.ok, `点踩#1 必须落库: ${JSON.stringify(put1)}`)

  // ── turn 2 (poll consumes dislike #1 → counts 1, below threshold) ─────
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '再看看' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  await waitFor('点踩#1 已入怀疑账本', async () => {
    const ledger = await readDoubtLedger(store.dir)
    return ledger.filter((r) => r.type === 'doubt').length >= 4 // 3 modules + 1 entry (page has 4 marked modules incl. main-area? ≥4 covers marked set)
  })
  const put2 = await feedback.put({
    sessionId, messageId: lastAssistantMessageId(agent) as never,
    rating: 'negative', note: '还是不对', ifVersion: null,
  })
  assert.ok(put2.ok, `点踩#2 必须落库: ${JSON.stringify(put2)}`)

  // ── turn 3 (poll consumes dislike #2 → threshold → escalation) ────────
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '最后确认' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)

  // The escalation runs off-band (browser captures take seconds): wait on
  // the product's own truth — the knowledge entry, the signal, the PNGs.
  await waitFor('视觉确认候选知识已沉淀', async () =>
    (await store.list()).some((entry) => entry.title === '模块 signup 需要视觉确认'))
  await waitFor('user-reject 已记账', async () => {
    const signals = await readSignals(path.join(store.dir, 'signals.jsonl'))
    return signals.some((s) => s.entryId === seed.id && s.source === 'human' && s.polarity === 'negative')
  })
  await waitFor('截图已落盘', async () => {
    const dir = path.join(home, 'evidence', 'screenshots')
    const files = await readdir(dir).catch(() => [] as string[])
    return files.some((f) => f.endsWith('.png'))
  }, 120_000)

  // ── the full M6 story, asserted from durable state ─────────────────────
  const knowledge = (await store.list()).find((entry) => entry.title === '模块 signup 需要视觉确认')
  assert.ok(knowledge)
  assert.equal(knowledge.status, 'candidate', '升级沉淀的知识从候选开始(提升仍必经人批)')
  assert.equal(knowledge.provenance.createdBy, 'doubt-escalation')
  assert.deepEqual(knowledge.bindings.map((b) => b.path), ['page.html'], '沉淀知识绑定它来自的页面')
  assert.ok(knowledge.text.includes('结构化数据判断不了'), '知识正文必须讲清"为什么要视觉确认"')
  assert.ok(knowledge.tags.includes('模块:signup'))

  const signals = await readSignals(path.join(store.dir, 'signals.jsonl'))
  const reject = signals.find((s) => s.entryId === seed.id && s.source === 'human' && s.polarity === 'negative')
  assert.ok(reject)
  assert.equal(reject.weight, -6, '知识账升级 = 一次 user-reject(最重负信号)')
  assert.ok(reject.note.includes('连续 2 次点踩'))
  assert.ok(reject.note.includes('按钮看着不对') || reject.note.includes('还是不对'), '用户的一句话反馈必须进审计备注')

  const ledger = await readDoubtLedger(store.dir)
  const escalations = ledger.filter((r) => r.type === 'escalated')
  assert.ok(escalations.some((r) => r.kind === 'module' && r.key === 'signup'))
  assert.ok(escalations.some((r) => r.kind === 'entry' && r.key === String(seed.id)))
  const moduleEscalation = escalations.find((r) => r.kind === 'module' && r.key === 'signup')
  assert.ok(moduleEscalation && moduleEscalation.type === 'escalated' && moduleEscalation.action.includes('截图'),
    `模块升级动作必须记录截图结果: ${JSON.stringify(moduleEscalation)}`)

  // The screenshots are real PNG bytes, content-addressed.
  const shots = await readdir(path.join(home, 'evidence', 'screenshots'))
  assert.ok(shots.length >= 3, `每个被点踩的标记模块都应截图,实际 ${shots.length} 张`)
  assert.ok(shots.every((f) => /^[0-9a-f]{64}\.png$/.test(f)), '截图必须按内容哈希命名')

  // The session survived all of it: turn 3 completed normally.
  const turnEnds = [...agent.session.events].filter((e) => e.type === 'turn/end')
  assert.equal(turnEnds.length, 3)
  assert.ok(turnEnds.every((e) => (e.data as { reason: { kind: string } }).reason.kind === 'completed'))
})
