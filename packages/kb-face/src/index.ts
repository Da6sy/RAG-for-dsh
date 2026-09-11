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
  openGlobalStore,
  openProjectStore,
  panelWorkspaces,
  queryKb,
  readWorkspaces,
  syncWorkspaces,
  type HostWorkspaceRow,
  type KbEntry,
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
import { createFulltextRetriever, failureSignature, renderRetrievalAssist } from '@clue-harness/rag'
import { gateDecision, pickInspectPage, TurnTracker, type ModuleRef } from './turn-state.ts'

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

/** Render injected KB context deterministically within a character budget. */
function renderKbContext(hits: readonly QueryHit[], budget: number): string {
  const lines: string[] = ['<kb_context source="clue-kb">', '以下知识来自项目知识库(按本轮输入检索)。引用某条时请在回复中提及它的 id;与当前任务无关的条目直接忽略。']
  let used = lines.join('\n').length
  for (const hit of hits) {
    const flags = [hit.entry.status, hit.entry.needsReview ? '⚠待复核' : ''].filter((f) => f !== '').join('|')
    let text = hit.entry.text.replace(/\s+/g, ' ')
    let line = `- [${hit.entry.id}|${flags}|${hit.entry.kind}] ${hit.entry.title}: ${text}`
    for (const annotation of hit.annotations) line += ` (${annotation})`
    if (used + line.length > budget) {
      const room = budget - used - 20
      if (room < 60) break
      line = `${line.slice(0, room)}…`
    }
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

  const queryFor = (root: string) => async (text: string, options?: { limit?: number; includeExpired?: boolean }): Promise<QueryHit[]> => {
    const { project, global } = await storesFor(root)
    return queryKb(project, global, {
      text,
      limit: options?.limit ?? resolved.topK,
      includeExpired: options?.includeExpired ?? resolved.includeExpired,
    })
  }
  const query = queryFor(resolved.projectRoot)

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
      + '返回条目带 id、状态与标注(候选/过期/待复核)。检索本身不改变任何知识状态。',
    parameters: {
      query: { type: 'string', required: true, description: '检索词(中英文均可,建议带上关键名词)' },
      limit: { type: 'number', description: '返回条数上限(默认取插件配置)' },
    },
    output: SEARCH_OUTPUT,
    execute: async (args, exec) => {
      const hits = await queryFor(sessionRoot(exec.agent))(String(args.query), args.limit === undefined ? undefined : { limit: Number(args.limit) })
      const sessionId = exec.agent?.session.id
      if (sessionId !== undefined) tracker.recordSurfaced(sessionId, hits.map((h) => h.entry.id))
      return {
        hits: hits.map((hit) => ({
          id: hit.entry.id,
          title: hit.entry.title,
          kind: hit.entry.kind,
          status: hit.entry.status,
          needsReview: hit.entry.needsReview,
          score: hit.score,
          text: hit.entry.text.length > 500 ? `${hit.entry.text.slice(0, 500)}…` : hit.entry.text,
          annotations: hit.annotations,
        })),
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
  ctx.systemPrompt.section({
    name: 'tool:kb',
    order: 115,
    text:
      '知识库纪律:涉及项目约定、UI 修改或曾出过问题的区域,先用 kb_search 检索再动手;'
      + '学到新的项目事实(约定/坑/决策)用 kb_propose 提案——你只能提案,提升为可信由人批准;'
      + '实际采用某条知识作为改动或结论的依据后,用 kb_cite 声明其 id——归因与信号按引用记账,检索到过但没用上的不要引用。'
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
    const hits = await queryFor(sessionRoot(payload.agent))(text)
    if (hits.length === 0) return decision
    tracker.recordSurfaced(payload.agent.session.id, hits.map((hit) => hit.entry.id))
    const context = createUserMessage({
      content: [{ type: 'text', text: renderKbContext(hits, resolved.injectMaxChars) }],
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
        const { project, global } = await storesFor(root)
        const retriever = createFulltextRetriever(project, global, { topK: resolved.topK })
        const hits = await retriever.retrieve(signature, { boostBindings: renderable })
        if (hits.length > 0) {
          tracker.recordSurfaced(agent.session.id, hits.map((hit) => hit.entry.id))
          assist = renderRetrievalAssist(hits, resolved.injectMaxChars)
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
