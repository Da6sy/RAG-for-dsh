/**
 * `@clue-harness/kb-face` — the Cordis face of the knowledge base (M3b).
 *
 * INTEGRATION layer (like spine and apps): imports dsh packages directly.
 * The engines (kb, kb-loop) stay dsh-free; this package is the only place
 * their capabilities touch the agent loop.
 *
 * What it mounts (every registration reversible via the plugin fiber):
 *
 * 1. `ctx.kb` — the KB service seam for sibling plugins (M3c approval UI).
 * 2. Tools: `kb_search` (retrieval) and `kb_propose` (models may ONLY
 *    propose — promotion is a human decision, decision #21).
 * 3. Retrieval-first injection on the `agent/pre-step` WATERFALL: when fresh
 *    user input arrives, top-K hits are appended to the entering messages as
 *    a plugin-sourced UserMessage. The loop logs entered messages as
 *    `user/message` events, so "model-visible ⟺ logged" holds by
 *    construction and the injection never touches the prompt prefix
 *    (KV-cache discipline, design §5).
 * 4. File-change tracking from `tools/result` (successful write/edit calls).
 * 5. The turn-stopping EVIDENCE GATE: verified contract — the serial
 *    `agent/turn-stopping` hook returns void, but the loop re-checks the
 *    next-step inbox AFTER the hook and continues the turn when it is
 *    non-empty. So the gate = inspect at turn end + `agent.inject()` a
 *    correction report on error evidence. Injection is a logged
 *    `user/message`, capped per turn (loop protection).
 *
 * CONTRACT LANDMINE (verified, design-relevant): we append NO custom
 * SessionEventMap members. `Session.append` cannot mark events `ignorable`,
 * and the persistence RESUME path refuses logs containing event types
 * outside dsh's generated catalog unless ignorable — a custom `kb/*` event
 * would poison session resumability. Model-visible facts ride `user/message`
 * (plugin source); knowledge-lifecycle facts live in the KB's own append-only
 * ledgers (entries history + signals.jsonl), which ARE this domain's event
 * sourcing. Revisit when upstream ships the plugin-event registration
 * surface its own docs defer.
 *
 * M4 additions (retrieval augmentation):
 * 6. `kb_cite` — the model declares which entries it USED AS BASIS; the
 *    gate's worklog prefers citations over the exposure set (the M3b
 *    documented approximation becomes the fallback, precise attribution the
 *    default — decision #9's "用作依据,不是检索到过" finally measurable).
 * 7. Gate stage 2 — a failed inspection builds a FAILURE SIGNATURE
 *    (@clue-harness/rag), retrieves precedents (binding-recall ranked), and
 *    injects complaint + precedent as ONE message: the acceptance line
 *    "被拦 → 检索到踩坑知识 → 自行修好" runs without the model having to
 *    think to search.
 * 8. Budget split — maxInspectionsPerTurn bounds browser runs (cost face,
 *    gateDecision rule 5); maxGateFiresPerTurn bounds injected correction
 *    reports (interrogation face, enforced at inject time). A PASSING
 *    re-verification injects nothing, so post-fix re-verification always
 *    runs within the inspection cap (the old fused rule made it impossible
 *    at the default fire cap — fixed here, pinned in gate.test).
 *
 * @module @clue-harness/kb-face
 */
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { clueHome } from '@clue-harness/util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type ImageBlock } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_INJECT_MIN_ENTRY_CHARS,
  DEFAULT_INJECT_PER_ENTRY_CHARS as DEFAULT_INJECT_PER_ENTRY_CHARS_KB,
  entryTextAfterRedlines,
  openGlobalStore,
  openProjectStore,
  panelWorkspaces,
  queryKb,
  readWorkspaces,
  renderHitLine,
  syncWorkspaces,
  type DocRecord,
  type HostWorkspaceRow,
  type KbEntry,
  type KbEntryId,
  type KbKind,
  type KbStore,
  type QueryHit,
  type SignalInput,
  type WorkspaceRecord,
  type WorkspaceSyncReport,
} from '@clue-harness/kb'
import {
  buildWorkLog,
  classifyChanges,
  escalatedModules,
  loadRenderSurfaceConfig,
  markEscalated,
  normalizeRelative,
  recordDoubt,
  runEvidenceLoop,
  suggestGeneralizations,
  type LoopReport,
} from '@clue-harness/kb-loop'
import { captureScreenshot, type ModuleNode } from '@clue-harness/evidence-render'
import {
  createFulltextRetriever,
  failureSignature,
  queryChunks as queryDocChunks,
  renderDetailView,
  renderRetrievalAssist,
  resolveChunkSources,
  type ChunkHit,
  type ChunkVectorState,
} from '@clue-harness/rag'
import { gateDecision, pickInspectPage, TurnTracker, type ModuleRef } from './turn-state.ts'
import { createRetrievalPlane } from './retrieval-plane.ts'
import { readRetrievalConfig } from './embedding-config.ts'

/** Plugin name (stable id in fibers and prompt sections). */
export const name = 'clue-kb'

/** Services required before the face mounts. */
export const inject = ['tools', 'systemPrompt']

/** Face configuration (validated defaults; schemastery schema arrives with M3c config UI). */
export interface Config {
  /** ClueHarness home override (default: CLUE_HOME or ~/.clue). */
  home?: string
  /**
   * Default KB anchor (default: process.cwd() at mount). M5: sessions
   * carrying a validated header cwd anchor to their OWN project root; this
   * remains the fallback and the host-plane service face (kb-web panels).
   * M9: the anchor is only ever a PATH — which central tier it names is a
   * pure derivation (`<home>/kb/<workspace-key>`), so panel, CLI and session
   * gate cannot read two different books for one workspace.
   */
  cwd?: string
  /** Retrieval top-K for pre-step injection and kb_search default. */
  topK?: number
  /** Character budget for the injected kb-context message. */
  injectMaxChars?: number
  /**
   * M9-0 配额制 (proposal §4 G4): per-entry character quota inside the
   * injected block. An entry whose body exceeds it is shown trimmed to this
   * many characters — the tail is what kb_detail is for. This is what stops
   * one long entry from monopolizing the budget (债#5).
   */
  injectPerEntryChars?: number
  /**
   * M9-0: an entry yields ENTIRELY (保广度弃深度) when the remainder of the
   * block budget cannot hold at least this much of it. Default 200 — below
   * that a line is a stub, and breadth beats a mutilated tail.
   */
  injectMinEntryChars?: number
  /** Include expired (annotated) entries in retrieval. Default false. */
  includeExpired?: boolean
  /** Enable the turn-stopping evidence gate. Default true. */
  gate?: boolean
  /** Gate injections (correction reports) per turn — the interrogation budget. */
  maxGateFiresPerTurn?: number
  /** Inspections (browser runs) per turn — the cost budget. Default 4. */
  maxInspectionsPerTurn?: number
  /** Auto-retrieve precedents by failure signature when the gate fires. Default true. */
  gateRetrieval?: boolean
  /** Volatile-region mask selectors for gate inspections. */
  maskSelectors?: string[]
  /** Fixed page to inspect (default: first changed .html). */
  page?: string
  /**
   * Scan for cross-project generalization proposals after a gate pass that
   * recorded objective evidence (M5, design §3.6 source ③). Default true.
   */
  generalizationScan?: boolean
  /**
   * Wire the message-feedback intake (M6 doubt counters). Needs the
   * dsh-message-feedback service in the composition (the web surface has it;
   * the CLI composition does not and the wiring silently no-ops). Default true.
   */
  doubtFeedback?: boolean
  /** Consecutive rejections that trip a doubt escalation (design: 2~3). Default 2. */
  doubtThreshold?: number
}

interface ResolvedConfig {
  home: string | undefined
  projectRoot: string
  topK: number
  injectMaxChars: number
  injectPerEntryChars: number
  injectMinEntryChars: number
  includeExpired: boolean
  gate: boolean
  maxGateFiresPerTurn: number
  maxInspectionsPerTurn: number
  gateRetrieval: boolean
  generalizationScan: boolean
  doubtFeedback: boolean
  doubtThreshold: number
  maskSelectors: string[]
  page: string | undefined
}

function resolveConfig(config: Config): ResolvedConfig {
  return {
    home: config.home,
    projectRoot: config.cwd ?? process.cwd(),
    topK: config.topK ?? 5,
    injectMaxChars: config.injectMaxChars ?? 2400,
    injectPerEntryChars: config.injectPerEntryChars ?? DEFAULT_INJECT_PER_ENTRY_CHARS_KB,
    injectMinEntryChars: config.injectMinEntryChars ?? DEFAULT_INJECT_MIN_ENTRY_CHARS,
    includeExpired: config.includeExpired ?? false,
    gate: config.gate ?? true,
    maxGateFiresPerTurn: config.maxGateFiresPerTurn ?? 1,
    maxInspectionsPerTurn: config.maxInspectionsPerTurn ?? 4,
    gateRetrieval: config.gateRetrieval ?? true,
    generalizationScan: config.generalizationScan ?? true,
    doubtFeedback: config.doubtFeedback ?? true,
    doubtThreshold: config.doubtThreshold ?? 2,
    maskSelectors: config.maskSelectors ?? [],
    page: config.page,
  }
}

/** The minimal llm face the image-capability probe needs. */
interface ImageProbeLlm {
  resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[] }>
}

/**
 * Whether the agent's EXACT routed model declares image input (决策 #19 的
 * 硬安全点 — the dsh tool-fs read-image gate posture: resolve the session's
 * latest routed provider/model, require an explicit `image` modality, and
 * treat unknown capability as NOT capable). A screenshot injected into a
 * text-only route would poison the session history permanently, so the
 * failure mode here is refusal, never optimism.
 * @param llm - the llm registry (ctx.llm), when the composition has one.
 * @param agent - the agent whose route decides.
 * @returns true only on an explicit image-input declaration.
 */
export async function routeSupportsImage(llm: ImageProbeLlm | undefined, agent: Agent): Promise<boolean> {
  if (llm === undefined) return false
  const routed = agent.session.requestHeader()?.config
  const provider = routed?.provider ?? agent.options.provider
  const model = routed?.model ?? agent.options.model
  if (provider === undefined || model === undefined) return false
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return info.inputModalities !== undefined && info.inputModalities.includes('image')
  } catch {
    // Unknown capability refuses (the read-image doctrine).
    return false
  }
}

/** The `ctx.kb` service surface (declaration-merged below). */
export interface ClueKb {
  /** Resolved project root this face anchors to. */
  readonly projectRoot: string
  /** Open (cached) project + global stores at the launch anchor. */
  stores(): Promise<{ project: KbStore; global: KbStore }>
  /** The same pair for ANY workspace root (M9: sessions route by their cwd). */
  storesFor(root: string): Promise<{ project: KbStore; global: KbStore }>
  /** The ClueHarness workspace roster (its own list — never dsh's workspaces). */
  workspaces(): Promise<WorkspaceRecord[]>
  /** The home every workspace path resolves against (kb-web passes it on). */
  readonly home: string
  /**
   * Reconcile the side table with the HOST's workspace registry (M9.1). This
   * is the face's job, not the web host's: the face owns the configured home,
   * and it is the plugin that knows whether a registry exists at all (the CLI
   * composition has none, and there a sync must be a no-op rather than a
   * mass-orphaning).
   */
  syncHostWorkspaces(): Promise<WorkspaceSyncReport>
  /** Which host workspace owns one session (the conversation drawer's address). */
  hostWorkspaceForSession(sessionId: string): Promise<HostWorkspaceRow | null>
  /** The rows the settings panel may show (live workspaces + orphan questions). */
  panelWorkspaces(): Promise<WorkspaceRecord[]>
  /** Retrieval with the face defaults applied (M9: pass `root` to search
   *  another workspace's tiers; absent = the launch anchor). */
  query(text: string, options?: { limit?: number; includeExpired?: boolean; root?: string }): Promise<QueryHit[]>
  /**
   * The SECOND level (M9-2): read the原文段 behind one entry — pure read,
   * writes nothing and records no signal (宪法 4). `entryId` addresses one
   * entry's mounted doc; `docIds` browses documents directly; an empty
   * `query` walks the document in order.
   */
  queryChunks(options: {
    entryId?: string
    docIds?: readonly string[]
    query?: string
    limit?: number
    maxChars?: number
    root?: string
  }): Promise<{ entryId: string | null; docIds: string[]; hits: ChunkHit[]; noDoc: boolean }>
  /** Every document snapshot of one tier (the panel's list). */
  docs(options?: { root?: string }): Promise<DocRecord[]>
  /** Model/human proposal — always lands as candidate. */
  propose(input: { kind: KbKind; title: string; text: string; tags?: string[]; bindings?: string[]; createdBy?: string }): Promise<KbEntry>
  /** Record one weighted signal. */
  signal(entryId: string, input: SignalInput, note?: string): Promise<void>
  /** Run the closed loop over an explicit worklog (M3a engine passthrough). */
  runLoop(worklog: Parameters<typeof runEvidenceLoop>[0]['worklog']): Promise<LoopReport>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The ClueHarness knowledge-base face, provided by the clue-kb plugin. */
    kb: ClueKb
  }
}

const KB_KINDS: KbKind[] = ['fact', 'decision', 'snippet', 'map', 'pitfall', 'asset']

/**
 * V3 (规划 §11): the two query-writing styles the A/B compares.
 *
 * `keywords` is what shipped through M9 — it teaches a keyword pile, which the
 * bigram tokenizer likes and an embedding cannot use. `intent` teaches one
 * complete sentence (subject–predicate–object, 15–40 characters) plus
 * identifiers only when they matter, which is exactly what the vector channel
 * was added for. The plan is explicit that this switch is measured BEFORE it
 * becomes the default, so both texts live here and the settings namespace picks.
 */
const QUERY_DOCTRINE_KEYWORDS = '检索词中英文均可,建议带上关键名词(系统同时做词法与语义匹配)。'
const QUERY_DOCTRINE_INTENT =
  '检索时给一句自然语言意图句(主谓宾完整,15–40 字),必要时再追加关键标识符;'
  + '系统同时做词法与语义匹配,不必自己拆关键词。'
  + '例如「chunker 版本号不一致时分片会怎样重建」优于「chunker 版本 重建」。'
const QUERY_GUIDANCE =
  '检索用的意图句(自然语言,15–40 字,主谓宾完整;必要时追加关键标识符)。'
  + '系统同时做词法与语义匹配,不必自己拆关键词——拆成关键词堆会削弱语义匹配。'

const SEARCH_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      hits: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            kind: { type: 'string', required: true },
            status: { type: 'string', required: true },
            needsReview: { type: 'boolean', required: true },
            score: { type: 'number', required: true },
            text: { type: 'string', required: true },
            /** M9-1: the entry has an immutable原文 snapshot on disk. */
            hasDoc: { type: 'boolean', required: true },
            /** M9-1: heading-addressable段数 of that snapshot (0 when none). */
            docHeadingCount: { type: 'number', required: true },
            annotations: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
      },
      total: { type: 'number', required: true },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

const PROPOSE_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      status: { type: 'string', required: true },
      note: { type: 'string', required: true },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

const CITE_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      cited: { type: 'array', required: true, items: { type: 'string' } },
      missing: { type: 'array', required: true, items: { type: 'string' } },
      note: { type: 'string', required: true },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

const DETAIL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      entryId: { type: 'string', required: true },
      noDoc: { type: 'boolean', required: true },
      docIds: { type: 'array', required: true, items: { type: 'string' } },
      hits: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            docId: { type: 'string', required: true },
            lines: { type: 'string', required: true },
            headingPath: { type: 'string', required: true },
            quoteAnchor: { type: 'string', required: true },
            score: { type: 'number', required: true },
            partialRedline: { type: 'boolean', required: true },
            excerpt: { type: 'string', required: true },
          },
        },
      },
      text: { type: 'string', required: true },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: (value as { text: string }).text }],
} as const

/** The M9-0 quota: each injected entry gets at most this much body text. */
export const DEFAULT_INJECT_PER_ENTRY_CHARS = DEFAULT_INJECT_PER_ENTRY_CHARS_KB

/**
 * Render injected KB context deterministically within a character budget.
 * @param hits - the ranked, annotated hits.
 * @param budget - the block's character budget.
 * @param quota - the per-entry body quota and the yield floor (M9-0).
 * @returns the block text.
 */
export function renderKbContext(
  hits: readonly QueryHit[],
  budget: number,
  quota: { perEntryChars?: number; minChars?: number } = {},
): string {
  const perEntryChars = quota.perEntryChars ?? DEFAULT_INJECT_PER_ENTRY_CHARS_KB
  const minChars = quota.minChars ?? DEFAULT_INJECT_MIN_ENTRY_CHARS
  const lines: string[] = ['<kb_context source="clue-kb">', '以下知识来自项目知识库(按本轮输入检索)。引用某条时请在回复中提及它的 id;与当前任务无关的条目直接忽略。']
  let used = lines.join('\n').length
  // The closing tag is reserved UP FRONT: a full block must still close.
  const cap = budget - '</kb_context>'.length - 1
  for (const hit of hits) {
    const line = renderHitLine(hit, perEntryChars, minChars, Math.max(0, cap - used))
    if (line === null) continue
    // The fit/trim decisions all live in the renderer; here the block only
    // refuses a line it literally cannot hold.
    if (line.length > cap - used) continue
    lines.push(line)
    used += line.length + 1
  }
  lines.push('</kb_context>')
  return lines.join('\n')
}

/** The gate's injected correction report (also what the model must act on). */
function renderGateReport(report: LoopReport): string {
  const lines: string[] = ['<render_evidence source="clue-kb">', '证据门禁:本轮改动了可渲染文件,自动渲染验证发现 error 级问题,修复前不应收尾。']
  if (report.outcome !== null) {
    for (const failure of report.outcome.failedAssertions.slice(0, 6)) lines.push(`✗ ${failure}`)
    for (const entry of report.outcome.errorEntrySummaries.slice(0, 6)) lines.push(`✗ ${entry}`)
  }
  for (const signal of report.recorded) lines.push(`已记信号: ${signal.entryId} ← ${signal.note}`)
  lines.push('请根据以上事实修复代码;修复后本轮会再次自动验证。', '</render_evidence>')
  return lines.join('\n')
}

/**
 * Walk the snapshot's module TREE (children plus repeat-group expansions)
 * into flat attribution references. The top-level list alone hides every
 * nested module — a marked form inside a marked main is a child node, and a
 * dislike on the form's checks must doubt the FORM, not just the page root.
 * @param modules - the snapshot's top-level modules.
 * @returns every module's id + marker fact, in tree order.
 */
export function collectModules(modules: readonly ModuleNode[]): ModuleRef[] {
  const refs: ModuleRef[] = []
  const walk = (nodes: readonly ModuleNode[]): void => {
    for (const node of nodes) {
      refs.push({ id: node.id, marked: node.moduleName !== null })
      walk(node.children)
      walk(node.repeat?.expanded ?? [])
    }
  }
  walk(modules)
  return refs
}

/**
 * Mount the KB face.
 * @param ctx - plugin context (tools + systemPrompt guaranteed by inject).
 * @param config - face configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const tracker = new TurnTracker()

  // Store pairs keyed by project root (M5 per-session anchoring): a web
  // surface's sessions each carry their own validated cwd, and the KB
  // follows the SESSION, not the launch directory. The launch anchor stays
  // the default root and the host-plane service face (kb-web panels).
  const storePairs = new Map<string, Promise<{ project: KbStore; global: KbStore }>>()
  const storesFor = (root: string): Promise<{ project: KbStore; global: KbStore }> => {
    let pair = storePairs.get(root)
    if (pair === undefined) {
      pair = Promise.all([
        openProjectStore(root, resolved.home),
        openGlobalStore(resolved.home),
      ]).then(([project, global]) => ({ project, global }))
      storePairs.set(root, pair)
    }
    return pair
  }
  // The launch-anchor pair (service face + sessions without a validated cwd).
  const stores = (): Promise<{ project: KbStore; global: KbStore }> => storesFor(resolved.projectRoot)
  const roster = (): Promise<WorkspaceRecord[]> => readWorkspaces(resolved.home)
  /** The host registry, when this composition has one (the web plane does). */
  interface HostRegistryLike {
    list(): Array<{ id: string; path: string; title: string; sessionIds: readonly string[] }>
  }
  const hostRegistry = (): HostRegistryLike | undefined =>
    ctx.get('workspaceRegistry') as HostRegistryLike | undefined
  const syncHostWorkspaces = async (): Promise<WorkspaceSyncReport> => {
    const registry = hostRegistry()
    if (registry === undefined) {
      // No registry (CLI/headless): nobody can have been "removed", so the
      // side table stands exactly as it is and the panel reads local rows.
      const rows = await panelWorkspaces(resolved.home)
      return { live: rows, newlyOrphaned: [], revived: [], cliOnly: rows.length }
    }
    const rows: HostWorkspaceRow[] = registry.list().map((row) => ({ id: row.id, path: row.path, title: row.title }))
    return syncWorkspaces(rows, resolved.home)
  }
  const hostWorkspaceForSession = async (sessionId: string): Promise<HostWorkspaceRow | null> => {
    const host = hostRegistry()?.list().find((row) => row.sessionIds.includes(sessionId))
    return host === undefined ? null : { id: host.id, path: host.path, title: host.title }
  }

  /**
   * The KB root of one agent's session: the validated header cwd when the
   * session carries one (dsh-session CreateSessionOptions.meta — the web
   * workspace picker and agentLoop.create both land there), else the launch
   * anchor.
   * @param agent - the acting agent, when the seam provides one.
   * @returns the project root this agent's KB operations anchor to.
   */
  const sessionRoot = (agent: Agent | undefined): string => {
    const cwd = agent?.session.header.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : resolved.projectRoot
  }

  /**
   * The tool channel's retriever (V0–V2, 规划 §3 决策 4).
   *
   * The plan wires ONLY this channel in the first three milestones: the
   * pre-step injection and the failure-signature gate keep the shipped
   * full-text retriever until V3 gives them their own profiles, so the first
   * ablation has clean attribution. The plane reads its configuration per call
   * (hot settings, per-operation credentials) and degrades to the lexical path
   * — annotated, never disguised — when no embedder is configured.
   */
  const plane = createRetrievalPlane(ctx, {
    // The store's own default is the same home; stating it here keeps the
    // shared embed cache and the ranklog in the tier's home even when a
    // composition passes no explicit one.
    home: resolved.home ?? clueHome(),
    onWarn: (message) => { console.warn(`clue-kb: ${message}`) },
  })
  const retrieveFor = async (
    root: string,
    text: string,
    options?: { limit?: number; includeExpired?: boolean },
  ): Promise<QueryHit[]> => {
    const stores = await storesFor(root)
    const result = await plane.retrieve(stores, text, {
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(options?.includeExpired !== undefined ? { includeExpired: options.includeExpired } : {}),
    })
    return result.hits
  }

  const queryFor = (root: string) => async (text: string, options?: { limit?: number; includeExpired?: boolean }): Promise<QueryHit[]> => {
    const { project, global } = await storesFor(root)
    return queryKb(project, global, {
      text,
      limit: options?.limit ?? resolved.topK,
      includeExpired: options?.includeExpired ?? resolved.includeExpired,
    })
  }
  const query = queryFor(resolved.projectRoot)

  /**
   * M9-2: the second-level read (纯读 — 宪法 4). Resolves the addressed
   * documents, ranks their derived chunks and returns anchors + excerpts.
   * An entry without a doc answers honestly (`noDoc`) instead of 404ing: "该
   * 知识无原文层,正文即全部" is a fact about the knowledge, not an error.
   */
  const chunksFor = async (options: {
    entryId?: string
    docIds?: readonly string[]
    query?: string
    limit?: number
    maxChars?: number
    root?: string
  }): Promise<{ entryId: string | null; docIds: string[]; hits: ChunkHit[]; noDoc: boolean; vector: ChunkVectorState | null }> => {
    const root = options.root ?? resolved.projectRoot
    const { project, global } = await storesFor(root)
    const entryId = options.entryId === undefined || options.entryId === '' ? null : options.entryId
    let entry: KbEntry | null = null
    if (entryId !== null) {
      entry = (await project.get(entryId as KbEntryId)) ?? (await global.get(entryId as KbEntryId))
      if (entry === null) throw new Error(`没有条目 "${entryId}"`)
    }
    const owner = entry !== null && entry.tier === 'global' ? global : project
    const sources = await resolveChunkSources(owner, {
      ...(entryId !== null ? { entryId } : {}),
      ...(options.docIds !== undefined ? { docIds: options.docIds } : {}),
    })
    // V4: when an embedder is configured, the second level fuses the lexical
    // and vector channels per document; otherwise it is exactly today's lexical
    // path (and `vectorState` says why).
    const vector = plane.chunkVector()
    let vectorState: ChunkVectorState | null = null
    const hits: ChunkHit[] = []
    const perSource = Math.max(1, options.limit ?? 5)
    for (const source of sources) {
      hits.push(...await queryDocChunks(source, {
        ...(options.query !== undefined ? { query: options.query } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
        ...(vector !== null && options.query !== undefined && options.query !== ''
          ? { vector: { ...vector, onState: (state) => { vectorState = state } } }
          : {}),
      }))
    }
    void perSource
    hits.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId) || a.seq - b.seq)
    return {
      entryId,
      docIds: sources.map((source) => source.docId),
      hits: options.limit === undefined ? hits : hits.slice(0, options.limit),
      noDoc: entry !== null && entry.doc === undefined && (options.docIds ?? []).length === 0,
      vector: vectorState,
    }
  }

  // ---- M6: message-feedback intake (the doubt counters' eyes) ----
  //
  // Contract fact (verified): dsh-message-feedback is a Typert Remote service
  // with NO cordis event emissions — there is nothing to listen to. The
  // sanctioned intake is therefore a turn-boundary POLL with a version diff
  // (bounded: one list call per session per boundary; idempotent: item
  // versions are opaque equality tokens). The design's "复用现成反馈机制,
  // 不另造交互" holds: the web 点踩 UI and its storage are dsh's; we only
  // consume. Latency: a dislike is counted at the session's next boundary.

  /** The minimal feedback-service face we consume (optional service). */
  interface MessageFeedbackLike {
    list(request: { sessionId: unknown }): Promise<
      | { ok: true; value: { items: readonly { messageId: unknown; rating: string; note?: string; version: string }[] } }
      | { ok: false }
    >
  }

  /** sessionId → messageId → last-seen version (the poll diff state). */
  const feedbackSeen = new Map<string, Map<string, string>>()

  /**
   * Resolve which turn one assistant message belongs to (walk the log's
   * turn/start markers). Null when unmappable (the attribution then falls
   * back to the session's latest tracked turn — the honest guess).
   * @param session - the session whose log to walk.
   * @param messageId - the disliked message.
   * @returns the turn number or null.
   */
  function turnOfMessage(session: Session, messageId: string): number | null {
    let currentTurn: number | null = null
    let found: number | null = null
    for (const event of session.events) {
      if (event.type === 'turn/start') currentTurn = event.data.turn
      else if (event.type === 'assistant/message') {
        const id = (event.data as { message?: { id?: unknown } }).message?.id
        if (id !== undefined && String(id) === messageId) found = currentTurn
      }
    }
    return found
  }

  /**
   * The module-ledger escalation (design §4.7 落地第 3 条): capture the L3
   * screenshot, commit it to the attachment store for humans, precipitate
   * the candidate knowledge ("该模块需要视觉确认"), and mark the ledger.
   * Every step is best-effort with an audited outcome — a missing browser
   * degrades the action text, never the escalation itself. MARKED modules
   * capture by locator; unmarked ones (structural ids have no locator) fall
   * back to the full page — honest evidence either way.
   * @param root - the session's project root.
   * @param project - its project store.
   * @param module - the doubted module reference.
   * @param page - page the module was last seen on (null = unknown).
   * @param count - open doubts at escalation time.
   * @param sessionId - audit anchor.
   */
  async function escalateModule(
    root: string, project: KbStore, module: ModuleRef, page: string | null, count: number, sessionId: string,
  ): Promise<void> {
    const moduleId = module.id
    let captureNote = '截图不可用(页面未知)'
    if (page !== null) {
      try {
        const capture = await captureScreenshot({
          projectRoot: root,
          page,
          ...(module.marked ? { moduleId } : {}),
          home: resolved.home,
        })
        captureNote = `截图 ${capture.sha256.slice(0, 12)}(${capture.bytes}B${capture.reused ? ',哈希复用' : ''}${module.marked ? '' : ',整页(模块无标记)'})`
        const attachments = ctx.get('attachments') as AttachmentStore | undefined
        if (attachments !== undefined) {
          const bytes = await readFile(capture.path)
          await attachments.saveImage({ data: new Uint8Array(bytes), mediaType: 'image/png', name: `doubt-${moduleId}.png` })
          captureNote += ' 已入附件库'
        }
      } catch (error) {
        captureNote = `截图失败(${error instanceof Error ? error.message : String(error)})`
      }
    }
    const title = `模块 ${moduleId} 需要视觉确认`
    const existing = (await project.list()).some((entry) =>
      entry.title === title && (entry.status === 'candidate' || entry.status === 'trusted'))
    let knowledgeNote = '同名候选知识已存在,不重复沉淀'
    if (!existing) {
      const entry = await project.add({
        kind: 'pitfall',
        title,
        text:
          `模块「${moduleId}」${page !== null ? `(页面 ${page})` : ''}的结构化检查(L1/L2)被用户连续 ${count} 次否定——`
          + '该模块光看结构化数据判断不了,渲染验证时应直接截图做视觉确认(L3 升级沉淀)。',
        tags: ['视觉确认', `模块:${moduleId}`],
        ...(page !== null ? { bindings: [page] } : {}),
        createdBy: 'doubt-escalation',
        note: `点踩升级沉淀(会话 ${sessionId})`,
      })
      knowledgeNote = `候选知识 ${entry.id}`
    }
    await markEscalated(project.dir, 'module', moduleId, count, `${captureNote};${knowledgeNote}`)
  }

  /**
   * Attribute one dislike to the two doubt ledgers (分开记,处理方式不同):
   * modules the disliked turn's gate looked at → module ledger (escalates to
   * a screenshot); entries the turn PRECISELY cited → entry ledger (escalates
   * to one user-reject signal, the heaviest negative). Exposure-only entries
   * are deliberately NOT doubted — the same precision discipline as failure
   * attribution: approximate evidence never punishes knowledge.
   * @param session - the session carrying the disliked message.
   * @param messageId - the rejected assistant message.
   * @param note - the user's optional one-line explanation.
   */
  async function handleDislike(session: Session, messageId: string, note: string | undefined): Promise<void> {
    const summary = tracker.turnContext(String(session.id), turnOfMessage(session, messageId))
    if (summary === undefined) return
    const cwd = session.header.cwd
    const root = typeof cwd === 'string' && cwd !== '' ? cwd : resolved.projectRoot
    const { project, global } = await storesFor(root)
    const why = note !== undefined && note !== '' ? `用户反馈: ${note}` : `消息 ${messageId} 被点踩`

    for (const module of summary.modules) {
      const count = await recordDoubt(project.dir, {
        kind: 'module', key: module.id, sessionId: String(session.id), turn: summary.turn, reason: why,
      })
      if (count >= resolved.doubtThreshold) {
        await escalateModule(root, project, module, summary.page, count, String(session.id))
      }
    }
    for (const entryId of summary.citedIds) {
      const count = await recordDoubt(project.dir, {
        kind: 'entry', key: entryId, sessionId: String(session.id), turn: summary.turn, reason: why,
      })
      if (count >= resolved.doubtThreshold) {
        const owner = (await project.get(entryId as never)) !== null ? project : global
        await owner.recordSignal(entryId as never, 'user-reject', `连续 ${count} 次点踩(${why})`)
        await markEscalated(project.dir, 'entry', entryId, count, 'user-reject 信号已记账')
      }
    }
  }

  /**
   * Poll one session's feedback and process NEW negative items (version
   * diff). Silent no-op without the message-feedback service (CLI surface)
   * or for sessions the service does not know (its honest rejection).
   * @param session - the session to poll.
   */
  async function pollFeedback(session: Session): Promise<void> {
    if (!resolved.doubtFeedback) return
    const feedback = ctx.get('messageFeedback') as MessageFeedbackLike | undefined
    if (feedback === undefined) return
    const result = await feedback.list({ sessionId: session.id })
    if (!result.ok) return
    let seen = feedbackSeen.get(String(session.id))
    if (seen === undefined) {
      seen = new Map()
      feedbackSeen.set(String(session.id), seen)
    }
    for (const item of result.value.items) {
      const key = String(item.messageId)
      const previous = seen.get(key)
      seen.set(key, item.version)
      if (item.rating !== 'negative' || previous === item.version) continue
      await handleDislike(session, key, item.note)
    }
  }

  // ---- 1) the ctx.kb seam ----
  const service: ClueKb = {
    projectRoot: resolved.projectRoot,
    stores,
    storesFor,
    workspaces: roster,
    home: resolved.home ?? clueHome(),
    syncHostWorkspaces,
    hostWorkspaceForSession,
    panelWorkspaces: () => panelWorkspaces(resolved.home),
    query: (text, options) => queryFor(options?.root ?? resolved.projectRoot)(text, options),
    queryChunks: chunksFor,
    docs: async (options) => (await storesFor(options?.root ?? resolved.projectRoot)).project.listDocs(),
    propose: async (input) => {
      const { project, global } = await stores()
      // Global-tier proposals are an M3c concern (human-only); the face
      // always proposes into the project tier.
      return project.add({
        kind: input.kind,
        title: input.title,
        text: input.text,
        tags: input.tags,
        bindings: input.bindings,
        createdBy: input.createdBy ?? 'agent',
      })
    },
    signal: async (entryId, input, note) => {
      const { project } = await stores()
      await project.recordSignal(entryId as never, input, note ?? '')
    },
    runLoop: (worklog) => runEvidenceLoop({ worklog, home: resolved.home, maskSelectors: resolved.maskSelectors }),
  }
  ctx.provide('kb', service)

  // ---- 2) model-facing tools ----
  ctx.tools.register(defineTool({
    name: 'kb_search',
    description:
      '检索项目知识库(约定/决策/踩坑/资产)。动手写涉及项目约定或曾出过问题的代码前先检索;'
      + '返回条目带 id、状态与标注(候选/过期/待复核)。检索本身不改变任何知识状态。'
      + '结果为截断摘要(每条正文可能被截断),细节用 kb_detail 按 entryId 下钻原文段(带 docId/行号锚点)。',
    parameters: {
      query: { type: 'string', required: true, description: QUERY_GUIDANCE },
      limit: { type: 'number', description: '返回条数上限(默认取插件配置)' },
    },
    output: SEARCH_OUTPUT,
    execute: async (args, exec) => {
      const hits = await retrieveFor(sessionRoot(exec.agent), String(args.query), args.limit === undefined ? undefined : { limit: Number(args.limit) })
      const sessionId = exec.agent?.session.id
      if (sessionId !== undefined) tracker.recordSurfaced(sessionId, hits.map((h) => h.entry.id))
      return {
        hits: hits.map((hit) => {
          // M9-4: the returned body is the text AFTER redlines (划除不只是遮
          // 显示:被作废的段不进任何一条返回路径). The raw text stays in the
          // entry file for governance (`clue kb show` prints it verbatim).
          const body = entryTextAfterRedlines(hit.entry)
          return {
            id: hit.entry.id,
            title: hit.entry.title,
            kind: hit.entry.kind,
            status: hit.entry.status,
            needsReview: hit.entry.needsReview,
            score: hit.score,
            text: body.length > 500 ? `${body.slice(0, 500)}…` : body,
            hasDoc: hit.entry.doc !== undefined,
            docHeadingCount: hit.docHeadingCount ?? 0,
            annotations: hit.annotations,
          }
        }),
        total: hits.length,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Search knowledge base', kind: 'read', rawInput: (args as { query?: unknown }).query }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_propose',
    description:
      '把一条新学到的项目知识提案入库(约定/决策/代码片段/结构地图/踩坑/资产)。'
      + '入库即候选状态;升为可信必须经人工批准,你不能自己提升。绑定源文件后,文件变更会自动触发待复核。',
    parameters: {
      kind: { type: 'string', required: true, description: `知识类型: ${KB_KINDS.join(' | ')}` },
      title: { type: 'string', required: true, description: '一句话标题(人话)' },
      text: { type: 'string', required: true, description: '知识正文:结论 + 触发条件/适用范围' },
      tags: { type: 'string', description: '逗号分隔的标签' },
      bindings: { type: 'string', description: '逗号分隔的项目相对路径(该知识绑定的源文件)' },
    },
    output: PROPOSE_OUTPUT,
    execute: async (args, exec) => {
      const kind = String(args.kind) as KbKind
      if (!KB_KINDS.includes(kind)) {
        return { id: '', status: 'rejected', note: `kind 必须是 ${KB_KINDS.join('|')} 之一,收到 "${String(args.kind)}"` }
      }
      const splitList = (raw: unknown): string[] | undefined => {
        const text = String(raw ?? '').trim()
        return text === '' ? undefined : text.split(',').map((s) => s.trim()).filter((s) => s !== '')
      }
      // Proposals land in the SESSION's project tier (per-session anchoring):
      // what an agent learns belongs to the project it worked in.
      const { project } = await storesFor(sessionRoot(exec.agent))
      const entry = await project.add({
        kind,
        title: String(args.title),
        text: String(args.text),
        tags: splitList(args.tags),
        bindings: splitList(args.bindings),
        createdBy: `agent:${exec.agent?.id ?? 'unknown'}`,
      })
      return { id: entry.id, status: entry.status, note: '已入候选;提升为可信需要人工批准(攒批提醒)' }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Propose knowledge', kind: 'other', rawInput: (args as { title?: unknown }).title }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_detail',
    description:
      '下钻到某条知识的原文层(二级检索):给出 docId + 行号 + heading 路径 + 段落摘录。'
      + '当 kb_search 的命中带"含原文 N 段,细节用 kb_detail 下钻"标注时,用本工具取理据原文;'
      + '可以带 query 只取相关段,留空则按顺序浏览。纯读取:不记信号、不改状态、不产生审批——'
      + '真正采用了某条知识才用 kb_cite 声明。没有原文层的条目会如实回报"正文即全部"。',
    parameters: {
      entryId: { type: 'string', description: '要下钻的条目 id(kb_search 返回的 id)' },
      query: { type: 'string', description: '相关段检索词;留空则按文档顺序返回段落' },
      docIds: { type: 'string', description: '逗号分隔的 docId(可选,直接浏览文档而不经过条目)' },
      limit: { type: 'number', description: '返回段数上限(默认 5)' },
      maxChars: { type: 'number', description: '每段摘录字符预算(默认 600)' },
    },
    output: DETAIL_OUTPUT,
    execute: async (args, exec) => {
      const entryId = args.entryId === undefined ? '' : String(args.entryId).trim()
      const docIds = String(args.docIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
      if (entryId === '' && docIds.length === 0) {
        return { entryId: '', noDoc: false, docIds: [], hits: [], text: '需要 entryId 或 docIds 之一(先用 kb_search 找到条目 id)。' }
      }
      const detail = await chunksFor({
        ...(entryId !== '' ? { entryId } : {}),
        ...(docIds.length > 0 ? { docIds } : {}),
        ...(args.query !== undefined ? { query: String(args.query) } : {}),
        ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
        ...(args.maxChars !== undefined ? { maxChars: Number(args.maxChars) } : {}),
        root: sessionRoot(exec.agent),
      })
      let title = ''
      if (entryId !== '') {
        const { project, global } = await storesFor(sessionRoot(exec.agent))
        const entry = (await project.get(entryId as KbEntryId)) ?? (await global.get(entryId as KbEntryId))
        title = entry?.title ?? ''
      }
      const view = renderDetailView({
        entryId: entryId === '' ? (detail.docIds[0] ?? '(直接浏览)') : entryId,
        title: title === '' ? '原文段' : title,
        docIds: detail.docIds,
        hits: detail.hits,
        noDoc: detail.noDoc,
      })
      // V4: the second level's channel state travels with the answer, so the
      // model can tell a semantic hit from a keyword one (不变量 5). Appended to
      // the rendered text because that is what the model actually reads.
      const vectorNote = detail.vector === null
        ? ''
        : detail.vector.status === 'used'
          ? `\n[分段检索] 语义通道已参与(${detail.vector.count ?? 0} 段向量)`
          : `\n[分段检索] ${detail.vector.note}`
      // Pure read: NO touch, NO signal, NO approval (宪法 4 — 查了 ≠ 用到).
      return {
        text: `${view.text}${vectorNote}`,
        entryId: view.entryId,
        noDoc: view.noDoc,
        docIds: view.docIds,
        hits: view.hits.map((hit) => ({
          docId: hit.docId,
          lines: `${hit.lines.start}-${hit.lines.end}`,
          headingPath: hit.headingPath,
          quoteAnchor: hit.quoteAnchor,
          score: hit.score,
          partialRedline: hit.partialRedline,
          excerpt: hit.excerpt,
        })),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Drill into source', kind: 'read', rawInput: (args as { entryId?: unknown }).entryId }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_cite',
    description:
      '声明你本次实际用作依据的知识库条目 id(逗号分隔)。基于某条知识写了代码或下了结论后调用;'
      + '证据归因与信号记账以引用为准——检索到过但没用上的不要引用,用了的不要漏引。声明本身不改变知识状态。',
    parameters: {
      entryIds: { type: 'string', required: true, description: '用作依据的条目 id,逗号分隔' },
      note: { type: 'string', description: '一句话说明这些知识如何被用到(进入归因备注,可审计)' },
    },
    output: CITE_OUTPUT,
    execute: async (args, exec) => {
      const ids = String(args.entryIds)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
      if (ids.length === 0) {
        return { cited: [], missing: [], note: '没有可记录的引用(entryIds 为空)' }
      }
      // Existence is verified so a hallucinated id is answered honestly
      // instead of silently polluting the worklog (missing ids are reported
      // by the loop, never fatal — same doctrine as purged-entry worklogs).
      const { project, global } = await storesFor(sessionRoot(exec.agent))
      const cited: string[] = []
      const missing: string[] = []
      for (const id of ids) {
        const found = (await project.get(id as never)) ?? (await global.get(id as never))
        if (found === null) missing.push(id)
        else cited.push(id)
      }
      const sessionId = exec.agent?.session.id
      if (sessionId !== undefined && cited.length > 0) {
        tracker.recordCited(sessionId, cited)
      }
      const note = args.note === undefined ? '' : String(args.note)
      return {
        cited,
        missing,
        note: missing.length > 0
          ? `已记录 ${cited.length} 条引用;${missing.length} 个 id 不存在(不要编造 id,先用 kb_search 确认)`
          : `已记录 ${cited.length} 条引用${note === '' ? '' : `: ${note}`}(归因与信号将按引用记账)`,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Cite knowledge', kind: 'other', rawInput: (args as { entryIds?: unknown }).entryIds }),
  }))

  // ---- 3) prompt guidance (stable section — prefix-safe) ----
  //
  // V3 (规划 §11): the query guidance moved from "关键词堆" to an INTENT
  // SENTENCE. The old line ("检索词,建议带上关键名词") taught the model to
  // emit keyword piles, which suits bigram matching and starves the embedding
  // of the one thing it is good at: the meaning of a whole question. The
  // variant in effect is read from the settings namespace, so the A/B harness
  // can measure both without a code change (`clue recall --prompt-ab`).
  const queryStyle = () => {
    try {
      return readRetrievalConfig(ctx).queryStyle
    } catch {
      return 'intent' as const
    }
  }
  ctx.systemPrompt.section({
    name: 'tool:kb',
    order: 115,
    text: () =>
      '知识库纪律:涉及项目约定、UI 修改或曾出过问题的区域,先用 kb_search 检索再动手;'
      + (queryStyle() === 'intent' ? QUERY_DOCTRINE_INTENT : QUERY_DOCTRINE_KEYWORDS)
      + '学到新的项目事实(约定/坑/决策)用 kb_propose 提案——你只能提案,提升为可信由人批准;'
      + '学到新的项目事实(约定/坑/决策)用 kb_propose 提案——你只能提案,提升为可信由人批准;'
      + '实际采用某条知识作为改动或结论的依据后,用 kb_cite 声明其 id——归因与信号按引用记账,检索到过但没用上的不要引用。'
      + '分工:代码现场真值走 glob/grep/read(这个函数长什么样、被谁调用);'
      + '历史判断与理据走 kb_search(哪条知识)→ kb_detail(原文哪一段,带 docId/行号锚点)。'
      + '一句话:**判断/理据在库,事实在码**。'
      + 'kb_search 返回的是截断摘要;命中标注"含原文 N 段,细节用 kb_detail 下钻"时,需要理据原文就下钻,'
      + '下钻是纯读取(不记信号、不改状态),真正用作依据仍要 kb_cite。'
      + '系统会在轮次收尾时对可渲染改动自动做渲染验证,验证失败的报告连同相关历史知识会注入到你的下一步输入,按报告修复。',
  })

  // ---- 4) turn tracking from the session firehose + feedback intake ----
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/start') return
    tracker.start(session.id, event.data.turn)
    // M6 intake: consume dislikes recorded since the last poll. Fire-and-
    // forget with a warn — feedback processing must never block or fail the
    // loop's turn machinery.
    void pollFeedback(session).catch((error) => {
      ctx.logger.warn(`kb: 反馈轮询失败(已忽略): ${error instanceof Error ? error.message : String(error)}`)
    })
  })

  // ---- 5) file-change tracking from successful fs writes ----
  ctx.on('tools/result', (exec, result) => {
    if (result.isError) return
    if (exec.name !== 'write' && exec.name !== 'edit') return
    const sessionId = exec.agent?.session.id
    if (sessionId === undefined) return
    const filePath = (exec.arguments as { file_path?: unknown } | null)?.file_path
    if (typeof filePath !== 'string' || filePath === '') return
    // Paths resolve against the SESSION's root: the same relative path means
    // different files in different workspaces (M5 anchoring).
    const root = sessionRoot(exec.agent)
    const absolute = path.resolve(root, filePath)
    const relative = path.relative(root, absolute)
    tracker.recordChangedFile(sessionId, normalizeRelative(relative))
  })

  // ---- 6) retrieval-first injection on the pre-step waterfall ----
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    // Only fresh human input triggers retrieval — tool-loop steps must not
    // re-inject the same context every step (token + noise discipline).
    const fresh = decision.messages.filter((message) => message.source.kind === 'user')
    if (fresh.length === 0) return decision
    const text = fresh
      .map((message) => message.content.filter((block) => block.type === 'text').map((block) => (block as { type: 'text'; text: string }).text).join('\n'))
      .join('\n')
      .trim()
    if (text === '') return decision
    // V3 (§7.3): the human's whole turn is a `pre-step` query — long,
    // multi-intent, code-heavy — so it gets its own profile (bounded length,
    // code fences stripped, semantic weight 0.6) instead of the tool channel's.
    const preStores = await storesFor(sessionRoot(payload.agent))
    const hits = (await plane.retrieve(preStores, text, { profile: 'pre-step' })).hits
    if (hits.length === 0) return decision
    tracker.recordSurfaced(payload.agent.session.id, hits.map((hit) => hit.entry.id))
    const context = createUserMessage({
      content: [{ type: 'text', text: renderKbContext(hits, resolved.injectMaxChars, {
        perEntryChars: resolved.injectPerEntryChars,
        minChars: resolved.injectMinEntryChars,
      }) }],
      source: { kind: 'plugin', plugin: name },
    })
    return { kind: 'enter', messages: [...decision.messages, context] }
  })

  // ---- 7) the turn-stopping evidence gate ----
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (!resolved.gate) return
    const state = tracker.get(agent.session.id)
    if (state === undefined) return
    // The gate works in the SESSION's project: surface config, worklog root,
    // stores, and inspection all anchor to the validated session cwd (M5).
    const root = sessionRoot(agent)
    const surface = await loadRenderSurfaceConfig(root, resolved.home)
    const { renderable } = classifyChanges([...state.changedFiles], surface)
    const decision = gateDecision(state, renderable, {
      gate: resolved.gate,
      maxInspectionsPerTurn: resolved.maxInspectionsPerTurn,
    })
    if (decision.act !== 'inspect') return
    if (signal.aborted) return

    const page = pickInspectPage(renderable, resolved.page)
    tracker.markInspected(agent.session.id)
    if (page === null) return // CSS-only change: honest skip, recorded in the reason chain

    // M4 precise attribution: entries the model CITED via kb_cite are the
    // worklog's referenced set; the exposure set (surfaced ids) remains the
    // documented fallback when the model cited nothing (M3b approximation —
    // its second gate, bindings ∩ changed files, still bounds failure blame).
    // M5: the mode travels IN the worklog — global entries' failure
    // attribution trusts only the precise mode (attribution.ts).
    const cited = state.citedIds.size > 0
    const report = await runEvidenceLoop({
      worklog: buildWorkLog({
        projectRoot: root,
        changedFiles: [...state.changedFiles],
        referencedEntryIds: cited ? [...state.citedIds] : [...state.surfacedIds],
        attributionMode: cited ? 'cited' : 'surfaced',
        page,
        note: `evidence-gate turn ${state.turn} (${cited ? 'cited' : 'surfaced fallback'})`,
      }),
      home: resolved.home,
      maskSelectors: resolved.maskSelectors,
    })
    if (report.outcome === null) return
    // M6: record what this inspection looked at — a later dislike attributes
    // to these modules (the module doubt ledger's input). Also poll feedback
    // here: mid-turn dislikes target earlier turns' messages, whose summaries
    // are already archived.
    if (report.inspection?.snapshot != null) {
      tracker.recordInspectionTargets(
        agent.session.id,
        page,
        collectModules(report.inspection.snapshot.modules),
      )
    }
    void pollFeedback(agent.session).catch((error) => {
      ctx.logger.warn(`kb: 反馈轮询失败(已忽略): ${error instanceof Error ? error.message : String(error)}`)
    })
    if (report.outcome.exitOk) {
      // M5 generalization trigger: a PASS that recorded objective evidence
      // means project knowledge was verified (again) — the moment to look
      // for similarly-verified siblings in OTHER projects and queue a
      // generalization proposal (design §3.6 source ③, decision #14's
      // "泛化提议必须人批" rides the existing promote queue). A failed scan
      // must never fail the turn.
      if (resolved.generalizationScan
        && report.recorded.some((record) => record.source === 'evidence' && record.polarity === 'positive')) {
        try {
          await suggestGeneralizations({ home: resolved.home })
        } catch (error) {
          ctx.logger.warn(`kb: 泛化扫描失败(已忽略): ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return
    }

    // Interrogation budget (M4 split): the failure evidence is ALREADY
    // recorded in the KB ledgers by the loop; a spent injection budget means
    // no further correction reports this turn — verification still ran.
    if (state.gateFires >= resolved.maxGateFiresPerTurn) return

    // Gate stage 2 (M4): retrieve precedents by the FAILURE SIGNATURE and
    // inject complaint + precedent as ONE message. The loop re-checks the
    // next-step inbox AFTER turn-stopping and continues the same turn —
    // verified against agent-loop source before relying on it.
    let assist = ''
    if (resolved.gateRetrieval) {
      const signature = failureSignature(report.outcome, renderable)
      if (signature !== '') {
        // V3 (§7.3): the failure signature is a `gate` query — assertions,
        // error text and FILE PATHS. Lexical is up-weighted to 1.3, the
        // semantic channel drops to 0.3, binding recall participates, and the
        // paths are kept out of the embedding (they are tokens, not meanings).
        const gateStores = await storesFor(root)
        const hits = (await plane.retrieve(gateStores, signature, {
          profile: 'gate',
          boostBindings: renderable,
          limit: resolved.topK,
        })).hits
        if (hits.length > 0) {
          tracker.recordSurfaced(agent.session.id, hits.map((hit) => hit.entry.id))
          assist = renderRetrievalAssist(hits, resolved.injectMaxChars, {
            perEntryChars: resolved.injectPerEntryChars,
            minChars: resolved.injectMinEntryChars,
          })
          // 拍板 3: the drill-down is HINTED, never automatic. The assist block
          // only runs一级 retrieval (budget + on-demand doctrine), so an entry
          // with a原文层 gets one line telling the model how to open it — the
          // model decides, and kb_detail records no signal either way.
          const drillable = hits.filter((hit) => hit.entry.doc !== undefined)
          if (drillable.length > 0 && assist !== '') {
            const hint = drillable
              .slice(0, 3)
              .map((hit) => `可下钻: kb_detail(entryId=${hit.entry.id}, query=${signature.slice(0, 12)})`)
              .join('\n')
            assist = `${assist}\n${hint}`
          }
        }
      }
    }

    // M6 pixel evidence: modules carrying ESCALATED doubt get their L3
    // capture attached to the correction ("下次遇到它直接截图" — the
    // escalation made the expensive action this module's default). The
    // route-capability probe (决策 #19) decides whether images ride in the
    // message or the capture stays in the attachment store for humans —
    // an image in a text-only route's history would poison the session.
    const imageBlocks: ImageBlock[] = []
    const captureNotes: string[] = []
    try {
      const snapshotModules = collectModules(report.inspection?.snapshot?.modules ?? [])
      if (snapshotModules.length > 0) {
        const { project } = await storesFor(root)
        const escalated = await escalatedModules(project.dir)
        const targets = snapshotModules.filter((module) => escalated.has(module.id)).slice(0, 2)
        if (targets.length > 0) {
          const imageCapable = await routeSupportsImage(ctx.get('llm') as ImageProbeLlm | undefined, agent)
          for (const target of targets) {
            const capture = await captureScreenshot({
              projectRoot: root,
              page,
              ...(target.marked ? { moduleId: target.id } : {}),
              home: resolved.home,
            })
            const attachments = ctx.get('attachments') as AttachmentStore | undefined
            if (attachments === undefined) {
              captureNotes.push(`模块 ${target.id} 的截图存于 ${capture.path}(无附件库,路径留给人查看)`)
              continue
            }
            const bytes = await readFile(capture.path)
            const ref = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType: 'image/png', name: `${target.id}.png` })
            if (imageCapable) imageBlocks.push({ type: 'image', attachment: ref })
            else captureNotes.push(`模块 ${target.id} 截图已存附件库(当前模型路由未声明图片输入,证据留给人看)`)
          }
        }
      }
    } catch (error) {
      // A failed capture degrades the evidence, never the correction itself.
      captureNotes.push(`怀疑模块截图失败(不影响修复要求): ${error instanceof Error ? error.message : String(error)}`)
    }

    tracker.markGateFired(agent.session.id)
    let text = renderGateReport(report)
    if (assist !== '') text = `${text}\n\n${assist}`
    if (captureNotes.length > 0) text = `${text}\n\n${captureNotes.join('\n')}`
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }, ...imageBlocks],
      source: { kind: 'plugin', plugin: name },
    }))
  })
}
