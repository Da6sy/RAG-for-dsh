/**
 * Per-session turn tracking + the evidence-gate decision — PURE logic, no
 * dsh imports, fully unit-testable. The Cordis face feeds it observations
 * (session events, tool results) and asks it what to do at turn-stopping.
 *
 * @module @clue-harness/kb-face/turn-state
 */

/**
 * One inspected module's identity for feedback attribution (M6): the
 * snapshot-tree id plus whether it carries a data-module marker — marked
 * modules capture by locator, unmarked (structural-id) ones fall back to a
 * full-page shot.
 */
export interface ModuleRef {
  id: string
  marked: boolean
}

/** One session's in-flight turn bookkeeping. */
export interface TurnState {
  turn: number
  /** Project-relative files written/edited this turn (success results only). */
  changedFiles: Set<string>
  /** KB entry ids surfaced to the model this turn (pre-step injection or kb_search). */
  surfacedIds: Set<string>
  /**
   * KB entry ids the model CITED via kb_cite as actually used as basis
   * (M4 precise attribution; the worklog prefers these over surfacedIds).
   */
  citedIds: Set<string>
  /** An inspection already ran for this turn's changes. */
  inspected: boolean
  /** Inspections run this turn (browser runs — the cost budget). */
  inspections: number
  /** Gate injections already fired this turn (the interrogation budget). */
  gateFires: number
  /** Page the last inspection looked at (M6 feedback attribution). */
  page: string | null
  /** Modules seen by the last inspection (M6 feedback attribution). */
  modules: ModuleRef[]
}

/**
 * The archived summary of one finished turn — what feedback attribution
 * consults when a dislike lands after the turn that produced it (M6): the
 * modules the gate looked at and the knowledge the model leaned on.
 */
export interface TurnSummary {
  turn: number
  page: string | null
  modules: ModuleRef[]
  citedIds: string[]
  surfacedIds: string[]
}

/** How many finished-turn summaries a session keeps for attribution. */
const SUMMARY_RETENTION = 5

/** Derive the archivable summary of one live state. */
function summarize(state: TurnState): TurnSummary {
  return {
    turn: state.turn,
    page: state.page,
    modules: [...state.modules],
    citedIds: [...state.citedIds],
    surfacedIds: [...state.surfacedIds],
  }
}

/** Session-id-keyed tracker; one instance per plugin mount. */
export class TurnTracker {
  private readonly states = new Map<string, TurnState>()
  private readonly summaries = new Map<string, TurnSummary[]>()

  /** Open a fresh state for a new turn (turn/start), archiving the previous. */
  start(sessionId: string, turn: number): TurnState {
    const previous = this.states.get(sessionId)
    if (previous !== undefined) {
      const archived = this.summaries.get(sessionId) ?? []
      archived.push(summarize(previous))
      // Retention bound: attribution only ever needs the recent turns.
      this.summaries.set(sessionId, archived.slice(-SUMMARY_RETENTION))
    }
    const state: TurnState = {
      turn,
      changedFiles: new Set(),
      surfacedIds: new Set(),
      citedIds: new Set(),
      inspected: false,
      inspections: 0,
      gateFires: 0,
      page: null,
      modules: [],
    }
    this.states.set(sessionId, state)
    return state
  }

  get(sessionId: string): TurnState | undefined {
    return this.states.get(sessionId)
  }

  /** Forget a session's state (turn fully ended and gate settled, or disposal). */
  clear(sessionId: string): void {
    this.states.delete(sessionId)
    this.summaries.delete(sessionId)
  }

  recordChangedFile(sessionId: string, relativePath: string): void {
    const state = this.states.get(sessionId)
    if (state === undefined) return
    state.changedFiles.add(relativePath)
    // A NEW change invalidates "already verified": the gate must be able to
    // re-inspect after the model fixes something within the same turn
    // (bounded by maxInspectionsPerTurn, not by the inspected flag).
    state.inspected = false
  }

  recordSurfaced(sessionId: string, entryIds: readonly string[]): void {
    const state = this.states.get(sessionId)
    if (state === undefined) return
    for (const id of entryIds) state.surfacedIds.add(id)
  }

  recordCited(sessionId: string, entryIds: readonly string[]): void {
    const state = this.states.get(sessionId)
    if (state === undefined) return
    for (const id of entryIds) state.citedIds.add(id)
  }

  /**
   * Mark one inspection run (the flag AND the cost-budget counter). What the
   * inspection looked at is recorded separately by
   * {@link TurnTracker.recordInspectionTargets} once the snapshot exists.
   * @param sessionId - the session.
   */
  markInspected(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (state === undefined) return
    state.inspected = true
    state.inspections += 1
  }

  markGateFired(sessionId: string): void {
    const state = this.states.get(sessionId)
    if (state !== undefined) state.gateFires += 1
  }

  /**
   * Record WHAT the latest inspection looked at (page + module tree) without
   * touching the budget counters — called after the loop returns its
   * snapshot, so a later dislike can be attributed to concrete modules (M6).
   * @param sessionId - the session.
   * @param page - inspected page (project-relative).
   * @param modules - the walked snapshot modules (id + marker fact).
   */
  recordInspectionTargets(sessionId: string, page: string | null, modules: readonly ModuleRef[]): void {
    const state = this.states.get(sessionId)
    if (state === undefined) return
    state.page = page
    state.modules = [...modules]
  }

  /**
   * Resolve the attribution context of one turn (M6 feedback intake):
   * 1. the turn's own summary (live state when current, else archived);
   * 2. EMPTY contexts (a text-only turn: nothing inspected, nothing cited)
   *    walk BACKWARD to the nearest turn that did work — a dislike on a
   *    "收到" reply is about the last real output, not about the echo;
   * 3. an unmappable message (turn null / unknown) falls back to the newest
   *    context-bearing turn — the honest guess;
   * 4. undefined only when the session tracked nothing at all.
   * @param sessionId - the session.
   * @param turn - the turn the disliked message belongs to (null = unknown).
   * @returns the summary to attribute against.
   */
  turnContext(sessionId: string, turn: number | null): TurnSummary | undefined {
    const current = this.states.get(sessionId)
    const archived = this.summaries.get(sessionId) ?? []
    const all: TurnSummary[] = [...archived]
    if (current !== undefined) all.push(summarize(current))
    if (all.length === 0) return undefined
    const hasContext = (summary: TurnSummary): boolean =>
      summary.modules.length > 0 || summary.citedIds.length > 0 || summary.surfacedIds.length > 0
    if (turn !== null) {
      const index = all.findLastIndex((summary) => summary.turn === turn)
      if (index >= 0) {
        for (let i = index; i >= 0; i -= 1) if (hasContext(all[i])) return all[i]
      }
    }
    for (let i = all.length - 1; i >= 0; i -= 1) if (hasContext(all[i])) return all[i]
    return all[all.length - 1]
  }
}

/** The gate's answer at turn-stopping. */
export type GateDecision =
  | { act: 'skip'; reason: string }
  | { act: 'inspect'; reason: string }

/**
 * Decide whether the turn-stopping evidence gate should inspect.
 *
 * The rule chain (each step a documented decision):
 * 1. gate disabled → skip;
 * 2. nothing changed → skip (backend-only or read-only turns NEVER open a
 *    browser — decision #25);
 * 3. no RENDERABLE change → skip (same decision, second half);
 * 4. already inspected this turn → skip (the loop already produced evidence);
 * 5. inspection budget spent → skip (maxInspectionsPerTurn bounds BROWSER
 *    RUNS — the cost face);
 * 6. otherwise → inspect.
 *
 * M4 semantics fix (verification budget ≠ interrogation budget): the
 * injection cap (maxGateFiresPerTurn) is enforced by the face AT INJECT
 * TIME, not here. The old rule 5 skipped the INSPECTION once the fire budget
 * was spent, which made post-fix re-verification impossible at the default
 * cap (fire 1 → model fixes → skip): a passing inspection injects nothing,
 * so letting it run is free of interrogation and is exactly the acceptance
 * line "修复 → 复验通过". Bounding browser runs moves to its own counter.
 *
 * @param state - the turn's bookkeeping (undefined = nothing tracked).
 * @param renderableChanged - changed files that intersect the render surface.
 * @param options - gate enabled flag + per-turn inspection cap.
 * @returns the decision with a human-readable reason (goes into reports).
 */
export function gateDecision(
  state: TurnState | undefined,
  renderableChanged: readonly string[],
  options: { gate: boolean; maxInspectionsPerTurn: number },
): GateDecision {
  if (!options.gate) return { act: 'skip', reason: '证据门禁未启用' }
  if (state === undefined) return { act: 'skip', reason: '本轮没有跟踪状态' }
  if (state.changedFiles.size === 0) return { act: 'skip', reason: '本轮没有文件改动' }
  if (renderableChanged.length === 0) return { act: 'skip', reason: '改动不涉及可渲染文件(纯后端轮次)' }
  if (state.inspected) return { act: 'skip', reason: '本轮已完成渲染验证' }
  if (state.inspections >= options.maxInspectionsPerTurn) {
    return { act: 'skip', reason: `本轮已验证 ${state.inspections} 次(上限 ${options.maxInspectionsPerTurn})` }
  }
  return { act: 'inspect', reason: `可渲染改动未验证: ${renderableChanged.join(', ')}` }
}

/**
 * Pick the page to inspect from the renderable change set: an explicitly
 * configured page wins; else the first changed .html/.htm (deterministic:
 * sorted); CSS-only changes have no page to open and skip inspection with
 * an honest reason.
 * @param renderableChanged - normalized relative renderable paths.
 * @param configuredPage - optional fixed page from plugin config.
 * @returns the page path or null.
 */
export function pickInspectPage(renderableChanged: readonly string[], configuredPage?: string): string | null {
  if (configuredPage !== undefined && configuredPage !== '') return configuredPage
  const html = renderableChanged.filter((f) => f.toLowerCase().endsWith('.html') || f.toLowerCase().endsWith('.htm')).sort()
  return html[0] ?? null
}
