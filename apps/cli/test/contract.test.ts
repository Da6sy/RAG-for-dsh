/**
 * M0 contract test — the keyless acceptance proof (design doc §7 M0:
 * "契约快照测试就位").
 *
 * It boots the REAL M0 composition (the same clue.cordis.yml bin.ts uses),
 * registers a mock adapter on a test-only provider route, drives one full
 * turn through the real loop, and asserts against the DURABLE session log —
 * the same evidence discipline dsh's own keyless snapshot tests follow:
 * behavior is proven from recorded events, never from console noise.
 *
 * What this pins (the "contract" in contract test):
 *   1. the composition activates end to end (fail-loud boot audit passes);
 *   2. the spine provides the full M0 service surface;
 *   3. a third-party adapter can claim a route via ctx.llm.registerAdapter
 *      (the seam our own providers will use later);
 *   4. one turn records user/message → request/header → assistant/message →
 *      turn/end{completed} with the mocked route pinned in the header;
 *   5. the JSONL persistence backend materializes its store.
 *
 * Run: `npm test` (node:test + tsx; no API key, no extra dependencies).
 *
 * @module @clue-harness/cli/test/contract
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  createUserMessage, LlmAdapter, SessionId,
  type Agent, type GenerateOptions, type StreamChunk,
} from '@clue-harness/compat'

const configPath = fileURLToPath(new URL('../src/clue.cordis.yml', import.meta.url))

/**
 * Deterministic minimal adapter: one text block, usage, stop. The chunk
 * sequence is the adapter contract from dsh-llm's StreamChunk docs —
 * block-end carries the ASSEMBLED block, usage precedes the terminal
 * finish, nothing follows it.
 */
class MockAdapter extends LlmAdapter {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = `mock:${options.messages.length}`
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

/** Resolve on the agent's next idle report (dsh example-harness pattern). */
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

test('M0 contract: real composition boots and one mocked turn lands in the log', async (t) => {
  // Isolation: a temp cwd (persistence root './.sessions' lands there) and a
  // temp DSH_HOME (credentials/settings never touch the real home). DSH_HOME
  // must be set BEFORE dsh-app-boot is first imported — the module pins the
  // home path at load time — hence the dynamic import below.
  const workdir = await mkdtemp(join(tmpdir(), 'clue-contract-'))
  const savedCwd = process.cwd()
  const savedHome = process.env.DSH_HOME
  const savedClueHome = process.env.CLUE_HOME
  process.chdir(workdir)
  process.env.DSH_HOME = join(workdir, '.dsh-home')
  // The composition now includes kb-face; keep its store out of the real ~/.clue.
  process.env.CLUE_HOME = join(workdir, '.clue-home')
  t.after(async () => {
    process.chdir(savedCwd)
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    if (savedClueHome === undefined) delete process.env.CLUE_HOME
    else process.env.CLUE_HOME = savedClueHome
    await rm(workdir, { recursive: true, force: true })
  })

  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  const ctx = await boot('clue-test', configPath)
  t.after(() => ctx.fiber.dispose())

  // (2) The spine provides the full M0 service surface.
  for (const [key, service] of Object.entries({
    llm: ctx.llm,
    sessions: ctx.sessions,
    tools: ctx.tools,
    agents: ctx.agents,
    agentLoop: ctx.agentLoop,
    systemPrompt: ctx.systemPrompt,
  })) {
    assert.ok(service !== undefined, `spine service missing: ${key}`)
  }

  // (3) A third-party adapter claims its own route; the registration handle
  // is itself the disposer (callable), per the AdapterRegistrationHandle API.
  const releaseAdapter = ctx.llm.registerAdapter(['mock-contract'], new MockAdapter())
  t.after(() => releaseAdapter())

  // (4) One full turn through the real loop.
  const agent = ctx.agentLoop.create(
    SessionId('contract-m0'),
    { provider: 'mock-contract', model: 'mock-model' },
    { cwd: workdir },
  )
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'ping' }],
    source: { kind: 'user' },
  }))
  await waitForIdle(ctx, agent)

  // Assert on the durable log — model-visible means logged.
  const events = [...agent.session.events]
  const user = events.find((e) => e.type === 'user/message')
  assert.ok(user, 'user/message not logged')

  const header = events.find((e) => e.type === 'request/header')
  assert.ok(header && header.type === 'request/header', 'request/header not logged')
  assert.equal(header.data.header.config.provider, 'mock-contract')
  assert.equal(header.data.header.config.model, 'mock-model')

  const assistant = events.findLast((e) => e.type === 'assistant/message')
  assert.ok(assistant && assistant.type === 'assistant/message', 'assistant/message not logged')
  const text = assistant.data.message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('')
  assert.equal(text, 'mock:1')

  const turnEnd = events.findLast((e) => e.type === 'turn/end')
  assert.ok(turnEnd && turnEnd.type === 'turn/end', 'turn/end not logged')
  assert.deepEqual(turnEnd.data.reason, { kind: 'completed' })

  // (5) The JSONL backend materialized its store under the temp cwd.
  // Persistence is write-behind: frames flush on the durability checkpoint
  // (dispose), not per event — so dispose FIRST (idempotent; the t.after
  // safety net settles as a no-op), then assert the on-disk layout.
  await ctx.fiber.dispose()
  const sessions = await readdir(join(workdir, '.sessions'))
  assert.ok(sessions.length > 0, 'persistence store not created')
})
