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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

/**
 * M9 end-to-end lab: one entry MOUNTED on a really-ingested document, plus a
 * redline over the entry's own text. Mirrors bootLab's isolation discipline
 * (temp cwd + temp CLUE_HOME/DSH_HOME), and — because the tool script needs
 * the entry id — the script is built by the caller AFTER seeding.
 */
async function bootDocLab(
  t: { after(fn: () => unknown): void },
  scriptFor: (ids: { entryId: string; docId: string }) => readonly ScriptedCall[],
  options: { mountDoc?: boolean; redline?: boolean } = {},
): Promise<{ ctx: Context; agent: Agent; entryId: string; docId: string; store: Awaited<ReturnType<typeof openProjectStore>> }> {
  const workdir = await mkdtemp(path.join(tmpdir(), 'clue-kbdetail-'))
  const home = path.join(workdir, 'clue-home')
  const project = path.join(workdir, 'proj')
  await mkdir(project, { recursive: true })
  const savedCwd = process.cwd()
  const savedHome = process.env.CLUE_HOME
  const savedDshHome = process.env.DSH_HOME
  const savedKey = process.env.DEEPSEEK_API_KEY
  process.chdir(project)
  process.env.CLUE_HOME = home
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

  // ── the M9 write channel, exercised for real ─────────────────────────────
  const { ingestFile } = await import('@clue-harness/rag')
  const store = await openProjectStore(project, home)
  const spec = [
    '# 组件规范',
    '',
    '## 按钮',
    '',
    '按钮必须可被 Tab 选中,禁用态使用 aria-disabled 而不是 disabled 属性。',
    '',
  ].join('\n')
  const specFile = path.join(project, 'spec.md')
  await writeFile(specFile, spec, 'utf8')
  const report = await ingestFile({ store, file: specFile })
  const docId = String(report.doc?.docId)

  const entry = await store.add({
    kind: 'pitfall',
    title: '按钮焦点与隐藏方案',
    text: '按钮必须可被 Tab 选中。另外,旧方案 sunset-legacy 用绝对定位隐藏按钮,已废弃不要再用。',
    tags: ['按钮'],
    createdBy: 'agent:lab',
  })
  if (options.mountDoc !== false) {
    await store.attachDoc(entry.id, docId, { lines: [5, 5], quoteAnchor: '按钮必须可被 Tab 选中' })
  }
  if (options.redline === true) {
    const tail = entry.text.indexOf('另外')
    await store.redlineText(entry.id, { chars: [tail + 1, entry.text.length], reason: '旧方案已废弃' })
  }

  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  const ctx = await boot('clue-kbface-test', configPath)
  t.after(() => ctx.fiber.dispose())
  const release = ctx.llm.registerAdapter(['mock-script'], new ScriptedAdapter(scriptFor({ entryId: String(entry.id), docId })))
  t.after(() => release())
  const agent = ctx.agentLoop.create(
    SessionId(`kbdetail-${Date.now().toString(36)}`),
    { provider: 'mock-script', model: 'scripted' },
    { cwd: project },
  )
  return { ctx, agent, entryId: String(entry.id), docId, store }
}

test('M9 two-level end to end: kb_search annotates the原文, kb_detail drills to anchors, and the drill is a pure read', async (t) => {
  const { ctx, agent, entryId, docId, store } = await bootDocLab(t, ids => [
    { toolCall: { id: 'call-search', name: 'kb_search', args: { query: '按钮 Tab 焦点 禁用态' } } },
    { toolCall: { id: 'call-detail', name: 'kb_detail', args: { entryId: ids.entryId, query: '禁用态 aria-disabled' } } },
    // A second search AFTER the drill: the touch counter is the observable that
    // proves the drill itself recorded nothing.
    { toolCall: { id: 'call-search-2', name: 'kb_search', args: { query: '按钮 Tab 焦点 禁用态' } } },
    { text: '按条目与原文段处理。' },
  ], { redline: true })

  // Count the retrievals the turn performs (synchronously — an async probe here
  // races the very next tool call). The final reference counter must equal this
  // count exactly: pre-step injection + every kb_search touch, kb_detail never.
  let retrievals = 0
  const stop = ctx.on('tools/result', (exec) => { if (exec.name === 'kb_search') retrievals += 1 })
  t.after(() => stop())

  follow(agent, '按钮的焦点和禁用态要注意什么?')
  await waitForIdle(ctx, agent)

  const events = [...agent.session.events]
  const names = events.filter((e) => e.type === 'tool/call').map((e) => (e.type === 'tool/call' ? e.data.name : ''))
  assert.deepEqual(names, ['kb_search', 'kb_detail', 'kb_search'], `模型应能连调一级与二级,实际 ${JSON.stringify(names)}`)

  const results = events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 3)
  const first = results[0]
  const second = results[1]
  const third = results[2]
  assert.ok(first.type === 'tool/result' && second.type === 'tool/result' && third.type === 'tool/result')
  const searchPayload = JSON.stringify(first.data.message.content)
  const detailPayload = JSON.stringify(second.data.message.content)

  // 一级: the hit self-reports its原文 layer (段数 + 下钻入口) …
  assert.ok(searchPayload.includes(entryId), '一级结果必须带回条目 id')
  assert.match(searchPayload, /含原文 \d+ 段/, '挂了原文的命中必须自报段数')
  assert.match(searchPayload, /kb_detail/, '命中要给出下钻入口(拍板 3: 只提示)')
  // …and the redlined tail never reaches the model through the return path.
  assert.doesNotMatch(searchPayload, /sunset-legacy/, '被划除的正文不得出现在一级返回里')

  // 二级: anchors are the whole point — docId + 行号 + heading + 摘录.
  assert.ok(detailPayload.includes(docId), '下钻必须带 docId(证据位置)')
  assert.match(detailPayload, /行 \d+-\d+/, '下钻必须带行号锚点')
  assert.match(detailPayload, /组件规范/, '下钻必须带 heading 路径')
  assert.match(detailPayload, /aria-disabled/, '下钻必须含命中段的摘录')

  // 宪法 4: the drill is a pure read. The queue here is NOT empty — the seed's
  // 45% redline legitimately queued its advisory proposal — so the assertion is
  // "the drill changed nothing", which is the actual invariant.
  const { readSignals } = await import('@clue-harness/kb')
  const queueAfter = await store.listApprovals(false)
  assert.deepEqual(await readSignals(path.join(store.dir, 'signals.jsonl')), [], 'kb_detail 不产生信号(查了≠用到)')
  assert.equal(queueAfter.length, 1, '队列里只有种子划除自己入队的那条提案')
  assert.equal(queueAfter[0].action, 'redline-review')
  const still = await store.get(entryId as never)
  assert.equal(still?.status, 'candidate', 'kb_detail 不改状态')
  assert.equal(still?.needsReview, false)
  // touch accounting (M2 doctrine: retrieval touches, because reference drives
  // the expire timer): the pre-step injection + two kb_search calls touch, the
  // drill between them does not.
  assert.equal(retrievals, 2, '本回合有两次 kb_search')
  assert.equal(still?.stats.referenceCount, retrievals + 1, '计数 = 两次检索 + 一次注入;kb_detail 未计数')
})

test('M9: 未挂原文的条目在二级检索里诚实回执(不伪造原文段)', async (t) => {
  const { ctx, agent, entryId, store } = await bootDocLab(t, ids => [
    { toolCall: { id: 'call-search', name: 'kb_search', args: { query: '按钮 Tab 焦点' } } },
    { toolCall: { id: 'call-detail', name: 'kb_detail', args: { entryId: ids.entryId, query: '按钮' } } },
    { text: '该条没有原文层,按正文处理。' },
  ], { mountDoc: false })

  follow(agent, '这条知识有原文吗?')
  await waitForIdle(ctx, agent)

  const results = agent.session.events.filter((e) => e.type === 'tool/result')
  assert.equal(results.length, 2)
  const [first, second] = results
  assert.ok(first.type === 'tool/result' && second.type === 'tool/result')
  const searchPayload = JSON.stringify(first.data.message.content)
  const detailPayload = JSON.stringify(second.data.message.content)
  assert.doesNotMatch(searchPayload, /含原文/, '没有 doc 的条目不得出现下钻标注')
  assert.match(detailPayload, /无原文层/, '二级检索必须诚实回执"正文即全部"')
  assert.doesNotMatch(detailPayload, /行 \d+-\d+/, '诚实回执里不得出现编造的行号')
  void entryId
})

test('M9-4 end to end: kb_search 尊重划除 — 被划掉的词既召回不到也看不到', async (t) => {
  const { ctx, agent, store } = await bootDocLab(t, () => [
    { toolCall: { id: 'call-search', name: 'kb_search', args: { query: 'sunset-legacy' } } },
    { text: '该方案已作废,不再引用。' },
  ], { redline: true })

  follow(agent, '旧方案 sunset-legacy 还能用吗?')
  await waitForIdle(ctx, agent)

  const result = agent.session.events.find((e) => e.type === 'tool/result')
  assert.ok(result && result.type === 'tool/result')
  const payload = JSON.stringify(result.data.message.content)
  assert.doesNotMatch(payload, /sunset-legacy/, '被划除的词不得出现在任何返回路径')
  // The surviving half still answers, and says it was redlined.
  const { queryKb } = await import('@clue-harness/kb')
  const kept = await queryKb(store, null, { text: '按钮 Tab', noTouch: true })
  assert.equal(kept.length, 1)
  assert.ok(kept[0].annotations.some((note) => note.includes('人工划除')), '命中必须自报含划除段')
})
