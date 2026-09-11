/**
 * M0 chat driver: one interactive agent over readline.
 *
 * The shape is lifted from dsh's own headless-agent example driver (the
 * proven pattern): create the agent through the loop's factory, send user
 * input with `followup(createUserMessage(...))`, and await the agent going
 * idle through the `agent/status` event. Assistant text is streamed to the
 * console as it arrives by observing the durable `session/event` firehose —
 * the same event stream every other consumer (UI, persistence, telemetry)
 * reads, so nothing here is a private channel.
 *
 * Note the imports: the driver sits in the composition layer (apps/*), yet it
 * still pulls its dsh vocabulary through `@clue-harness/compat` — the
 * discipline is "business AND driver code speak ClueHarness vocabulary; only
 * spine and the composition YAML name dsh packages".
 *
 * @module @clue-harness/cli/chat
 */
import { createInterface } from 'node:readline/promises'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, SessionId, type Agent } from '@clue-harness/compat'

/** M0 route: fixed provider/model (settings override lands with M1 UI). */
const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-v4-flash'

/**
 * Resolve when the agent reports idle. Subscribed synchronously after
 * `followup()` (which kicks the driver asynchronously), so the initial idle
 * state can never be mistaken for turn completion — only a real
 * running→idle transition resolves. Copied from the dsh example harness.
 * @param ctx - context carrying the agent/* event bus.
 * @param agent - the agent to watch.
 * @returns a promise resolved on the next idle status for this agent.
 */
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
 * Run the interactive chat loop until EOF/empty line, then dispose the tree.
 * @param ctx - the settled boot context (spine + adapter + persistence active).
 */
export async function runChat(ctx: Context): Promise<void> {
  const sessionId = SessionId(`clue-${Date.now().toString(36)}`)
  // The loop registered itself as the agent factory on ctx.agents; create()
  // opens (or resumes) the session and publishes the live agent.
  const agent = ctx.agentLoop.create(sessionId, { provider: PROVIDER, model: MODEL }, { cwd: process.cwd() })

  // Stream assistant text deltas as they commit to the session log.
  // Listener signature is (session, event); reasoning deltas stay hidden in
  // M0 — thinking is enabled on the adapter, and printing both streams would
  // double the console noise.
  let streamedText = false
  const offEvent = ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      process.stdout.write(event.data.chunk.text)
      streamedText = true
    }
  })

  // One identity line, no hint block: the credentials sentence printed on every
  // run even when the key resolved fine (a standing false alarm), and the
  // milestone label went stale three milestones ago. A missing key already
  // fails loud on the first request, with the resolution paths in the message.
  console.log(`clue · session ${sessionId} · ${PROVIDER}/${MODEL}`)

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const line = (await rl.question('\n> ')).trim()
      if (line === '') break
      streamedText = false
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: line }],
        source: { kind: 'user' },
      }))
      await waitForIdle(ctx, agent)
      process.stdout.write('\n')
      if (!streamedText) {
        console.log('[本轮没有文本输出:多半是凭据缺失或请求失败,详见上方错误/会话日志]')
      }
    }
  } finally {
    offEvent()
    rl.close()
    // Disposing the root fiber cascades: agents stop, sessions flush,
    // the adapter registration unwinds — everything was an effect.
    await ctx.fiber.dispose()
  }
}
