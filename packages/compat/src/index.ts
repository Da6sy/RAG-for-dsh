/**
 * `@clue-harness/compat` — the single dsh convergence layer (design doc §1.1, §2.1).
 *
 * The rule this package exists to enforce:
 *
 * - **Business packages** (kb, kb-loop, evidence, rag, ui) never import dsh
 *   packages directly. They import their dsh-facing vocabulary from here.
 * - **Composition layers** (`plugins/spine`, `apps/*`) MAY import dsh
 *   packages directly — mounting dsh services is their whole job.
 * - When the pinned dsh version changes (quarterly), this file is the first
 *   and usually only place that needs updating; the contract snapshot tests
 *   then show whether anything downstream actually broke.
 *
 * M0 scope: only the identity / agent / messaging vocabulary the chat driver
 * needs. This file grows when a consumer appears, never speculatively —
 * every re-export below already has a named M0–M3 consumer.
 *
 * @module @clue-harness/compat
 */

// ---- Identity ----------------------------------------------------------
// dsh brands cross-boundary ids: `Branded<'SessionId'>` is a string that
// TypeScript refuses to mix with plain strings or other brands, so a
// session id can never be passed where an entry id is expected. ClueHarness
// ids (KbEntryId, EvidenceId, …) will follow the same discipline from M2.
export type { Branded } from '@deepseek-ai/dsh-brand'
// SessionId is BOTH a type and its brand constructor (`SessionId('x')` tags a
// plain string at zero runtime cost) — re-exported as a value so consumers get
// both meanings through compat.
export { SessionId } from '@deepseek-ai/dsh-session'

// ---- Agent surface ------------------------------------------------------
// The live agent handle: inbox, send/followup/steer/inject, cancel,
// whenIdle, session. kb-loop (M3) references this type when it injects
// knowledge at step boundaries; the chat driver uses it right away.
export type { Agent } from '@deepseek-ai/dsh-agent'

// ---- Messaging ----------------------------------------------------------
// The ONLY way content enters a conversation is an identified, frozen
// message built by dsh's constructors. The chat driver (M0) and the kb
// injection path (M4) both build user messages through `createUserMessage`.
export { createUserMessage } from '@deepseek-ai/dsh-llm'
export type { UserMessage, AssistantMessage, ContentBlock } from '@deepseek-ai/dsh-llm'
// CallId brands tool-call identities; the kb-face integration test builds
// mock tool-call blocks with it (M3b consumer).
export { CallId } from '@deepseek-ai/dsh-llm'

// ---- Adapter seam (contract tests, M0) ----------------------------------
// LlmAdapter is the abstract class every model provider extends; the M0
// contract test subclasses it to drive a full turn without an API key.
// Stream vocabulary travels with it: an adapter's stream() yields exactly
// these chunk shapes (block-start → deltas → block-end → usage → finish).
export { LlmAdapter } from '@deepseek-ai/dsh-llm'
export type { StreamChunk, GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
