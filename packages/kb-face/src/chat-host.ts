/**
 * A minimal chat host for NON-agent surfaces (V3 A/B, V5 LLM rerank).
 *
 * Two V3–V5 features need a real model call and neither needs an agent:
 * the prompt A/B has to see what a model WRITES for a query, and `llmRerank`
 * has to ask a model to reorder ten candidates. Booting the whole agent tree
 * (sessions, tools, loop, persistence) to send one prompt would be both slow and
 * dishonest about what is being measured, so this mounts exactly three plugins
 * on a bare Cordis context:
 *
 *   `LlmRuntime` (the `ctx.llm` registry) + the provider adapter + the
 *   settings/credentials providers the adapter resolves its key through.
 *
 * That is the same seam the product uses (`ctx.llm.prepareCall`), reached
 * without the agent: whatever the A/B measures about prompt style is a
 * statement about the model, and the transport is the product's own.
 *
 * `DEEPSEEK_API_KEY` (or whichever reference the composition names) is resolved
 * per call through the credential provider, so a rotated key applies to the
 * next request — the same 不变量 11 discipline the embedder follows.
 *
 * @module @clue-harness/kb-face/chat-host
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import { apply as applyDeepSeek } from '@deepseek-ai/dsh-llm-deepseek'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { clueHostHome } from '@clue-harness/util'
import type { LlmRankPort } from '@clue-harness/rag'

/** One chat call's knobs. */
export interface ChatRequest {
  /** The user prompt (the whole request; there is no history here). */
  prompt: string
  /** Optional system slot. */
  system?: string
  /** Provider route (default `deepseek-official`). */
  provider?: string
  /** Model id (default `deepseek-flash`). */
  model?: string
  maxTokens?: number
  /**
   * Reasoning effort for THIS call. Utility calls (writing retrieval queries,
   * reordering ten candidates) want `off`: the adapter's default is `high`, and
   * a long thinking phase can consume the whole `maxTokens` budget and leave
   * the visible answer empty — a failure mode that looks like "the model
   * returned nothing".
   */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Per-call ceiling; exceeding it aborts the stream. */
  timeoutMs?: number
  /** External cancellation (combined with the timeout). */
  signal?: AbortSignal
}

/** The host: one method, plus an honest teardown. */
export interface ChatHost {
  /** Send one prompt and return the full text. */
  ask(request: ChatRequest): Promise<{ text: string; provider: string; model: string; ms: number; reasoningChars: number }>
  /** The default route in effect. */
  readonly route: { provider: string; model: string }
  close(): Promise<void>
}

/** The shipped default route (matches the composition's `agent-default-model`). */
export const DEFAULT_CHAT_ROUTE = { provider: 'deepseek-official', model: 'deepseek-flash' }

/** Poll until a service appears (providers init asynchronously). */
async function waitForService(ctx: Context, name: string, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (ctx.get(name) !== undefined) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Open the minimal chat host.
 *
 * @param options - `dshHome` override (tests) and the route to use.
 * @returns the host.
 * @throws when the llm runtime or the adapter never came up (fail loud: an A/B
 *   that silently measures nothing is worse than one that refuses to run).
 */
export async function openChatHost(options: { dshHome?: string; provider?: string; model?: string } = {}): Promise<ChatHost> {
  const dshHome = options.dshHome ?? clueHostHome()
  const ctx = new Context()
  const fibers = [
    ctx.plugin(FileSettingsProvider as never, { dshHome, watch: false } as never),
    ctx.plugin(CredentialsLocal as never, { dshHome, watch: false } as never),
  ] as unknown as Array<{ dispose?: () => Promise<void> | void }>
  const settingsReady = await waitForService(ctx, 'settings')
  if (!settingsReady) throw new Error(`chat host: cannot open the settings service (${dshHome})`)
  fibers.push(ctx.plugin(LlmRuntime as never, {} as never) as unknown as { dispose?: () => Promise<void> | void })
  if (!await waitForService(ctx, 'llm')) throw new Error('chat host: cannot mount ctx.llm (the host llm runtime never came up)')
  // The adapter layers its entry config under the `llm-deepseek` settings
  // section and resolves its key per request (its own contract).
  applyDeepSeek(ctx, {} as never)
  // The pi-ai twin too: the plan's risk table asks for a judge from a DIFFERENT
  // family than the answerer, and those routes (qwen/glm/pixel…) only exist once
  // this row is mounted — without it a cross-family judge fails with
  // `no adapter registered for provider "qwen"`.
  try {
    const { apply: applyPiAi } = await import('@deepseek-ai/dsh-llm-pi-ai')
    applyPiAi(ctx, {} as never)
  } catch {
    // A composition without pi-ai still answers with the DeepSeek route.
  }
  await new Promise((resolve) => setTimeout(resolve, 50))

  const route = { provider: options.provider ?? DEFAULT_CHAT_ROUTE.provider, model: options.model ?? DEFAULT_CHAT_ROUTE.model }
  // The SERVICE's `prepareCall` takes a config object (the ADAPTER's abstract
  // method of the same name takes `(provider, model)` — an easy mix-up that
  // fails with "no adapter registered for provider undefined").
  const llm = ctx.get('llm') as unknown as {
    prepareCall(config: { provider: string; model: string; maxTokens?: number; reasoningEffort?: string }, signal?: AbortSignal): Promise<{
      /** The resolved config, with adapter-owned defaults materialized. */
      config: Record<string, unknown>
      stream(options: Record<string, unknown>): AsyncIterable<{ type: string; text?: string }>
    }>
  }

  return {
    route,
    async ask(request: ChatRequest) {
      const provider = request.provider ?? route.provider
      const model = request.model ?? route.model
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000)
      if (request.signal !== undefined) {
        if (request.signal.aborted) controller.abort()
        else request.signal.addEventListener('abort', () => controller.abort(), { once: true })
      }
      const started = Date.now()
      try {
        const prepared = await llm.prepareCall({
          provider,
          model,
          ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
          ...(request.reasoningEffort !== undefined ? { reasoningEffort: request.reasoningEffort } : {}),
        }, controller.signal)
        // The dispatch carries the PREPARED config verbatim (`provider`,
        // `model`, and any adapter-owned default such as `reasoningEffort`):
        // the runtime refuses a request whose call config drifted from what it
        // prepared, which is what makes "prepare then dispatch" safe.
        const stream = prepared.stream({
          ...prepared.config,
          messages: [createUserMessage({ content: [{ type: 'text', text: request.prompt }], source: { kind: 'plugin', plugin: 'clue-chat-host' } }) as Message],
          ...(request.system !== undefined ? { system: request.system } : {}),
          signal: controller.signal,
        })
        let text = ''
        let reasoningChars = 0
        for await (const chunk of stream) {
          if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningChars += chunk.text.length
          else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          else if (chunk.type === 'block-end' && typeof chunk.text === 'string') text += chunk.text
        }
        return { text, provider, model, ms: Date.now() - started, reasoningChars }
      } finally {
        clearTimeout(timeout)
      }
    },
    close: async () => {
      // Disposing the fibers drains in-flight work and closes the file
      // watchers, so the process can exit without a lingering handle.
      for (const fiber of fibers) await fiber.dispose?.()
    },
  }
}

/**
 * The `LlmRankPort` implementation the reranker uses (V5).
 *
 * One adapter, so the engine's prompt and the model call stay separable: the
 * engine builds the prompt and parses the answer, this hands the prompt to the
 * configured model with thinking OFF (reordering ten items is not a reasoning
 * task, and a thinking phase would eat the answer's token budget).
 * @param host - the opened chat host.
 * @param options - route/model overrides and the per-call ceiling.
 * @returns the port.
 */
export function chatRankPort(host: ChatHost, options: { model?: string; timeoutMs?: number } = {}): LlmRankPort {
  return {
    rank: async (prompt: string, signal?: AbortSignal) => {
      const answer = await host.ask({
        prompt,
        reasoningEffort: 'off',
        maxTokens: 1500,
        timeoutMs: options.timeoutMs ?? 20_000,
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (answer.text.trim() === '') {
        throw new Error(`chat host: model returned no visible text (reasoning ${answer.reasoningChars} chars, took ${answer.ms}ms): check that the key resolves, or raise maxTokens`)
      }
      return answer.text
    },
  }
}
