/**
 * M5 per-session anchoring test — the KB follows the SESSION's workspace,
 * not the launch directory (the M3c decision deferred here).
 *
 * Shape: boot the real composition with cwd = the temp ROOT, then run two
 * agents whose sessions carry DIFFERENT validated cwds (projA / projB, each
 * with its own seeded KB). Each agent's kb_search must see its own project
 * tier, and kb_propose must land in the session's own store. A launch-anchor
 * regression (everything reading resolved.projectRoot) fails this loudly:
 * the root store is seeded with a THIRD entry that neither agent may see.
 *
 * Keyless and browser-free: no file writes, so the evidence gate provably
 * stays closed (decision #25's kbface.test posture).
 *
 * @module @clue-harness/cli/test/persession
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

/** Replay adapter (the kbface.test pattern; strip-types-safe fields). */
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

/** The concatenated tool-result text of every kb_* call in one session. */
function toolResultTexts(agent: Agent): string[] {
  return [...agent.session.events]
    .filter((e) => e.type === 'tool/result')
    .map((e) => JSON.stringify((e.data as { message?: unknown }).message ?? e.data))
}

test('M5 anchoring: each session\'s kb tools work in its OWN workspace, not the launch dir', async (t) => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'clue-persession-'))
  const projA = path.join(workdir, 'projA')
  const projB = path.join(workdir, 'projB')
  await mkdir(projA, { recursive: true })
  await mkdir(projB, { recursive: true })
  const savedCwd = process.cwd()
  const savedDshHome = process.env.DSH_HOME
  const savedClueHome = process.env.CLUE_HOME
  const savedKey = process.env.DEEPSEEK_API_KEY
  process.chdir(workdir) // launch anchor: the ROOT (its own third store)
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

  // Three distinct stores: A, B, and the launch anchor (root). The root
  // entry is the tripwire — a launch-anchor regression surfaces it to both.
  const home = process.env.CLUE_HOME
  const storeA = await openProjectStore(projA, home)
  const storeB = await openProjectStore(projB, home)
  const storeRoot = await openProjectStore(workdir, home)
  await storeA.add({ kind: 'fact', title: 'CSV 导出带 BOM', text: 'A 项目约定: 导出 CSV 要写 BOM 头,Excel 不乱码。' })
  await storeB.add({ kind: 'fact', title: 'wslpath 转换路径', text: 'B 项目约定: Windows 路径一律经 wslpath 转换。' })
  await storeRoot.add({ kind: 'fact', title: '根目录锚点金丝雀', text: 'launch anchor canary: 两个会话都不应看到我。' })

  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  const ctx = await boot('clue-persession', configPath)
  t.after(() => ctx.fiber.dispose())
  const releaseA = ctx.llm.registerAdapter(['mock-a'], new ScriptedAdapter([
    { toolCall: { id: 'a1', name: 'kb_search', args: { query: 'CSV BOM 导出' } } },
    { text: 'A 会话完成检索。' },
  ]))
  const releaseB = ctx.llm.registerAdapter(['mock-b'], new ScriptedAdapter([
    { toolCall: { id: 'b1', name: 'kb_search', args: { query: 'wslpath 路径转换' } } },
    { toolCall: { id: 'b2', name: 'kb_propose', args: { kind: 'decision', title: 'B 项目终端约定', text: '终端命令统一走 B 项目的封装层。' } } },
    { text: 'B 会话完成检索与提案。' },
  ]))
  t.after(() => { releaseA(); releaseB() })

  const agentA = ctx.agentLoop.create(SessionId('session-a'), { provider: 'mock-a', model: 'm' }, { cwd: projA })
  agentA.followup(createUserMessage({ content: [{ type: 'text', text: '检索并汇报约定' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agentA)

  const agentB = ctx.agentLoop.create(SessionId('session-b'), { provider: 'mock-b', model: 'm' }, { cwd: projB })
  agentB.followup(createUserMessage({ content: [{ type: 'text', text: '检索并汇报约定' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agentB)

  // Session A saw A's knowledge — and neither B's nor the root canary.
  const resultsA = toolResultTexts(agentA).join('\n')
  assert.ok(resultsA.includes('BOM'), 'A 会话必须检索到 A 项目知识')
  assert.ok(!resultsA.includes('wslpath'), 'A 会话不得看到 B 项目知识')
  assert.ok(!resultsA.includes('canary'), 'A 会话不得看到启动锚点库')

  // Session B saw B's knowledge, and its proposal landed in B's store.
  const resultsB = toolResultTexts(agentB).join('\n')
  assert.ok(resultsB.includes('wslpath'), 'B 会话必须检索到 B 项目知识')
  assert.ok(!resultsB.includes('BOM'), 'B 会话不得看到 A 项目知识')
  assert.ok(!resultsB.includes('canary'), 'B 会话不得看到启动锚点库')

  const bEntries = await storeB.list()
  assert.ok(bEntries.some((entry) => entry.title === 'B 项目终端约定'), 'kb_propose 必须落在会话自己的项目库')
  const aEntries = await storeA.list()
  assert.ok(!aEntries.some((entry) => entry.title === 'B 项目终端约定'), '提案不得串到 A 库')
  const rootEntries = await storeRoot.list()
  assert.equal(rootEntries.length, 1, '启动锚点库不得收到任何会话提案')
})
