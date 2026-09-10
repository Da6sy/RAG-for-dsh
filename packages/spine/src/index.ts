/**
 * `@clue-harness/spine` — the ClueHarness assembly spine (design doc §1.1, §2.1).
 *
 * One Cordis function plugin that mounts the minimal dsh service set a
 * conversational agent needs. This package IS a composition layer: unlike
 * business packages (which import dsh vocabulary only through
 * `@clue-harness/compat`), it imports dsh services directly — choosing and
 * wiring them is exactly its job.
 *
 * Deliberately minimal for M0. NOT mounted yet, each joins when a consumer
 * exists: session-title (M1, UI shows titles), skill / goal / jobs /
 * invariants / bash / workspace-context (M1–M3 as the KB and evidence loop
 * land). Named exports only: the Cordis Loader unwraps a `default` export
 * and would silently discard sibling exports such as a future `Config`
 * schema (dsh docs/postmortem/0001 — we inherit the lesson, not the bug).
 *
 * Mount order below carries NO semantics — Cordis pends each child fiber on
 * its `inject` list until the required services exist — but it mirrors the
 * dependency layering for readability: vocabulary and registries first, the
 * extensions that wrap their seams next, the loop that drives them last.
 *
 * @module @clue-harness/spine
 */
import type { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as llmRetry from '@deepseek-ai/dsh-llm-retry'

/** Cordis plugin name (stable id in logs and fiber dumps). */
export const name = 'clue-spine'

/**
 * Spine configuration (M0): the deployment persona only.
 *
 * A schemastery `Config` schema is intentionally deferred: in M0 this plugin
 * is mounted programmatically by the app bin (never through a YAML config
 * row, which is where the Loader applies schema validation), and the single
 * optional field is forwarded to SystemPrompt, whose own schema owns the
 * validation semantics. The schema arrives together with the M1 composition
 * file that mounts this spine from YAML.
 */
export interface Config {
  /** Deployment persona text rendered into the system prompt. */
  persona?: string
}

/**
 * Mount the spine.
 * @param ctx - the mounting context; every service below becomes a child fiber.
 * @param config - spine configuration (see {@link Config}).
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Message/stream vocabulary + the adapter registry (ctx.llm). Concrete
  // adapters are mounted BESIDE the spine by the app composition
  // (llm-deepseek in M0) — the spine never picks a model vendor.
  ctx.plugin(LlmRuntime)

  // The append-only session event log and in-memory store (ctx.sessions):
  // the history truth every model request is derived from (lesson 8).
  ctx.plugin(SessionStore)

  // Prompt-section and tool-schema assembly (ctx.systemPrompt).
  // includeHarnessIdentity is OFF on purpose: that section would introduce
  // the agent as "DeepSeek Harness"; ClueHarness presents its own identity
  // through the persona instead.
  ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    persona: config.persona ?? '',
  })

  // Scoped tool registry + the guarded execution pipeline (ctx.tools).
  // M0 mounts it empty — the loop injects it, and consumers (bash/fs in M1,
  // kb/evidence tools from M2) register into it as they land.
  ctx.plugin(ToolRuntime, {})

  // Live agent registry + the agent/* event vocabulary (ctx.agents).
  ctx.plugin(AgentRegistry)

  // Provider-routed request retry: listens on the agents seam and wraps
  // request failures (its inject is ['agents'], not ['llm']).
  ctx.plugin(llmRetry)

  // The default loop implementing the Agent interface (ctx.agentLoop); it
  // registers itself as the agent factory on ctx.agents. Agents are created
  // by the app driver at runtime (M0), not pre-declared in config.
  ctx.plugin(AgentLoop, { agents: [] })
}
