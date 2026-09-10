/**
 * M3b integration tests: boot the REAL composition (now including the
 * kb-face row) against a scripted mock adapter and prove the two headline
 * mechanisms end to end, keylessly and browser-free:
 *
 *   1. the model can call `kb_search` and receives the seeded knowledge —
 *      the "agent A proposes, agent B retrieves" sharing mechanism (same
 *      store, two agents) reduced to its observable core;
 *   2. retrieval-first injection: fresh user input lands a plugin-sourced
 *      `user/message` (kb_context) in the DURABLE log before the step runs —
 *      model-visible ⟺ logged, and the prompt prefix is untouched.
 *
 * The evidence gate is exercised by gate.test.ts (pure) and the browser-gated
 * M1 suite; these turns change no files, so the gate provably stays closed
 * (decision #25 — a kb turn must never open a browser).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  CallId, createUserMessage, LlmAdapter, SessionId,
  type Agent, type GenerateOptions, type StreamChunk,
} from '@clue-harness/compat'
import { openProjectStore } from '@clue-harness/kb'

const configPath = fileURLToPath(new URL('../src/clue.cordis.yml', import.meta.url))

/** One scripted model call: either a tool call or a plain text answer. */
type ScriptedCall =
  | { toolCall: { id: string; name: string; args: Record<string, unknown> } }
  | { text: string }

/** Adapter that replays a fixed script, one call per model step.
 * NOTE: no constructor parameter properties (`constructor(private x)`) —
 * Node's strip-only type stripping rejects codegen syntax; assign explicitly. */
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

/** Boot the real composition over an isolated workdir/home; seed one KB entry. */
async function bootLab(t: { after(fn: () => unknown): void }, script: readonly ScriptedCall[]): Promise<{
  ctx: Context
  agent: Agent
  seededId: string
  workdir: string
}> {
  const workdir = await mkdtemp(path.join(tmpdir(), 'clue-kbface-'))
  const home = path.join(workdir, 'clue-home')
  await mkdir(path.join(workdir, 'proj'), { recursive: true })
  const project = path.join(workdir, 'proj')
  const savedCwd = process.cwd()
  const savedHome = process.env.CLUE_HOME
  const savedDshHome = process.env.DSH_HOME
  const savedKey = process.env.DEEPSEEK_API_KEY
  process.chdir(project)
  process.env.CLUE_HOME = home
  // The composition mounts dsh-settings-file + dsh-credentials-local, which
  // read $DSH_HOME: a test must NEVER touch the developer's real ~/.dsh (its
  // credentials document is the user's own — a stricter pinned parser than
  // their running dsh once turned an unisolated read into a red suite).
  process.env.DSH_HOME = path.join(workdir, 'dsh-home')
  process.env.DEEPSEEK_API_KEY = 'test-key-not-used-by-mock'
  t.after(async () => {
    process.chdir(savedCwd)
    if (savedHome === undefined) delete process.env.CLUE_HOME
    else process.env.CLUE_HOME = savedHome
    if (savedDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedDshHome
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = savedKey
    await rm(workdir, { recursive: true, force: true })
  })

  // Seed knowledge BEFORE boot: agent "A" already learned this (the A→B
  // scenario's premise); store layout is identical to the CLI's.
  const seedStore = await openProjectStore(project, home)
  const seeded = await seedStore.add({
    kind: 'pitfall',
    title: '绝对定位按钮掉出 Tab 顺序',
    text: '在 flex 容器里给提交按钮加绝对定位,它会掉出 Tab 顺序;需要显式检查键盘可达性。',
    tags: ['按钮', '可访问性'],
  })

  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  const ctx = await boot('clue-kbface-test', configPath)
  t.after(() => ctx.fiber.dispose())

  const release = ctx.llm.registerAdapter(['mock-script'], new ScriptedAdapter(script))
  t.after(() => release())

  const agent = ctx.agentLoop.create(
    SessionId(`kbface-${Date.now().toString(36)}`),
    { provider: 'mock-script', model: 'scripted' },
    { cwd: project },
  )
  return { ctx, agent, seededId: seeded.id, workdir }
}

function follow(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

test('kb_search: a model tool call retrieves the seeded knowledge from the shared store', async (t) => {
  const { ctx, agent, seededId } = await bootLab(t, [
    { toolCall: { id: 'call-1', name: 'kb_search', args: { query: '按钮 Tab 顺序' } } },
    { text: '检索完成,按知识条目处理。' },
  ])
  follow(agent, '帮我检查提交按钮的键盘可达性')
  await waitForIdle(ctx, agent)

  const events = [...agent.session.events]
  const call = events.find((e) => e.type === 'tool/call')
  assert.ok(call && call.type === 'tool/call')
  assert.equal(call.data.name, 'kb_search')

  const result = events.find((e) => e.type === 'tool/result')
  assert.ok(result && result.type === 'tool/result')
  assert.equal(result.data.message.content[0].type, 'tool-result')
  const payload = JSON.stringify(result.data.message.content)
  assert.ok(payload.includes(seededId), '工具结果必须带回种子的条目 id')
  assert.ok(payload.includes('绝对定位按钮掉出 Tab 顺序'))

  // The turn completed normally — and no file changed, so the gate stayed shut.
  const turnEnd = events.findLast((e) => e.type === 'turn/end')
  assert.ok(turnEnd && turnEnd.type === 'turn/end')
  assert.deepEqual(turnEnd.data.reason, { kind: 'completed' })
})

test('pre-step injection: fresh user input lands a logged plugin-sourced kb_context message', async (t) => {
  const { ctx, agent, seededId } = await bootLab(t, [{ text: '好的,我会注意按钮的键盘可达性。' }])
  follow(agent, '表单里的按钮有什么要注意的坑?')
  await waitForIdle(ctx, agent)

  const events = [...agent.session.events]
  const injected = events.filter(
    (e) => e.type === 'user/message' && e.data.source.kind === 'plugin',
  )
  assert.equal(injected.length, 1, 'exactly one plugin-sourced injection')
  const first = injected[0]
  assert.ok(first.type === 'user/message')
  const text = first.data.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
  assert.match(text, /<kb_context source="clue-kb">/)
  assert.ok(text.includes(seededId), '注入内容必须带条目 id(可溯源)')

  // Injection came BEFORE the assistant message (logged order = seen order).
  const injectedSeq = first.seq
  const assistant = events.find((e) => e.type === 'assistant/message')
  assert.ok(assistant && assistant.seq > injectedSeq)

  // The stable prompt prefix was NOT touched: no kb text inside request/header.
  const header = events.find((e) => e.type === 'request/header')
  assert.ok(header && header.type === 'request/header')
  assert.ok(!JSON.stringify(header.data.header.system ?? '').includes(seededId), 'KV-cache 纪律:检索结果不得进系统提示词')
})

test('A/B sharing: agent A proposes knowledge, agent B retrieves it in the same process', async (t) => {
  // The interview headline, keyless: A learns → B benefits. Two agents, one
  // boot, one shared project store (same cwd ⇒ same KB — structural sharing).
  const { ctx, agent: agentA, workdir } = await bootLab(t, [
    { toolCall: { id: 'call-p', name: 'kb_propose', args: { kind: 'pitfall', title: '回车提交依赖 form 包裹', text: '提交按钮必须在 form 内,否则回车提交失效;动态插入的按钮要复查包裹关系。', tags: '表单,按钮', bindings: '' } } },
    { text: '已提案入库。' },
  ])
  follow(agentA, '把这次学到的表单坑记下来')
  await waitForIdle(ctx, agentA)

  // A's proposal landed as a candidate in the shared store.
  const eventsA = [...agentA.session.events]
  const proposeResult = eventsA.find((e) => e.type === 'tool/result')
  assert.ok(proposeResult && proposeResult.type === 'tool/result')
  const payload = JSON.stringify(proposeResult.data.message.content)
  assert.match(payload, /candidate/, '提案必须落候选,模型不能直接写可信')
  const proposedId = (payload.match(/k-[a-z0-9]+-[a-z0-9]+/) ?? [])[0]
  assert.ok(proposedId, '提案必须返回条目 id')

  // Agent B: a different session, same boot, same project ⇒ same KB.
  const { project } = { project: path.join(workdir, 'proj') }
  const store = await openProjectStore(project, path.join(workdir, 'clue-home'))
  const listed = await store.list()
  assert.ok(listed.some((e) => e.id === proposedId && e.status === 'candidate'))

  // B's turn is scripted to just answer; the ASSERTION is on B's log: the
  // pre-step injection must surface A's proposal (id + text) before B's step.
  const release = ctx.llm.registerAdapter(['mock-b'], new ScriptedAdapter([{ text: '我会先检查按钮的包裹关系。' }]))
  t.after(() => release())
  const agentB = ctx.agentLoop.create(SessionId('kbface-b'), { provider: 'mock-b', model: 'scripted' }, { cwd: project })
  follow(agentB, '表单按钮要注意什么?')
  await waitForIdle(ctx, agentB)

  const eventsB = [...agentB.session.events]
  const injectedB = eventsB.filter((e) => e.type === 'user/message' && e.data.source.kind === 'plugin')
  assert.equal(injectedB.length, 1)
  const textB = injectedB[0].type === 'user/message'
    ? injectedB[0].data.content.filter((b) => b.type === 'text').map((b) => (b as { type: 'text'; text: string }).text).join('')
    : ''
  assert.ok(textB.includes(proposedId), 'B 的注入必须携带 A 提案的条目 id')
  assert.match(textB, /回车提交依赖 form 包裹/)
  assert.match(textB, /candidate/, '候选状态必须如实标注(B 知道这不是可信知识)')
})
