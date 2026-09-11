/**
 * The browser's client for the kb-web JSON routes (`/api/clue-kb`).
 *
 * Same-origin fetch over the webserver route the host plugin registered —
 * no transport of our own (the Typert Remote plane is dsh's build-time
 * codegen pipeline; see kb-web's module doc for the verified reasoning).
 * URL building and payload typing live here so components stay pure props
 * consumers and the house test runner can pin the query contract.
 *
 * @module @clue-harness/ui-kb/client/api
 */

/** The kb-web route prefix (mirrors @clue-harness/kb-web's API_PREFIX). */
export const KB_API = '/api/clue-kb'

/** One knowledge entry as the routes serialize it (KbEntry, plain JSON). */
export interface EntryPayload {
  version: number
  id: string
  tier: string
  kind: string
  title: string
  text: string
  tags: string[]
  bindings: { path: string; contentHash: string }[]
  provenance: { createdBy: string; createdAt: string; session?: { id: string; seq?: number }; note?: string }
  status: string
  needsReview: boolean
  reviewReason: string | null
  stats: { lastReferencedAt: string | null; referenceCount: number }
  history: { at: string; change: string; from: string | null; to: string | boolean | null; reason: string }[]
  discardedAt: string | null
}

/** One queued approval with its entry merged (the card's whole payload). */
export interface ApprovalCard {
  request: {
    id: string
    entryId: string
    action: string
    reason: string
    scoreAtRequest: number
    createdAt: string
    resolvedAt: string | null
    resolution: string | null
  }
  entry: EntryPayload | null
}

/** One signal ledger row. */
export interface SignalPayload {
  at: string
  entryId: string
  polarity: string
  source: string
  weight: number
  note: string
}

/** The window-score breakdown. */
export interface ScorePayload {
  score: number
  counted: number
  positive: number
  negative: number
  lastSignalAt: string | null
}

/** Per-tier status summary. */
export interface TierStatusPayload {
  tier: string
  total: number
  byStatus: Record<string, number>
  needsReview: number
  pendingApprovals: number
}

/** The /status payload. */
export interface StatusPayload {
  projectRoot: string
  /** The addressed workspace (null = the launch anchor / the global tier). */
  workspace: WorkspacePayload | null
  project: TierStatusPayload
  global: TierStatusPayload
}

/**
 * One workspace the panel may show (M9.1: the host's workspace list is the
 * roster; this is ClueHarness's side table row for it).
 */
export interface WorkspacePayload {
  key: string
  root: string
  label: string
  source: string
  origin?: string
  state?: 'live' | 'orphaned' | 'kept'
  addedAt: string
  lastSeenAt: string
  hostId?: string
  hostTitle?: string
  orphanedAt?: string
  orphanReason?: string
  purgedAt?: string
  renderSurface?: { extensions?: string[]; pathPrefixes?: string[] }
  /** Present only when /workspaces?stats=1 was asked for. */
  status?: TierStatusPayload | null
}

/** One moved piece of a purge (report-only). */
export interface PurgedPiece { kind: string; from: string; to: string }

/** One purged workspace's resting place (the trash is the undo path). */
export interface PurgeResult {
  moved: PurgedPiece[]
  trashRoot: string
}
interface LegacyPurgeResult {
  moved: Array<{ kind: string; from: string; to: string }>
  trashRoot: string
}

/** Which KB tier an operation addresses. */
export type KbScope = 'project' | 'global'

/**
 * The workspace a panel should open on (M9, pure so it is pinned by unit
 * tests rather than only by a browser demo): the workspace the surface was
 * LAUNCHED in when the roster knows it, else the first registered one, else
 * null (nothing to show — the caller falls back to the global tier).
 * @param workspaces - the roster rows.
 * @param defaultRoot - the surface's launch anchor.
 * @returns the key to select, or null.
 */
export function pickInitialWorkspace(
  workspaces: readonly { key: string; root: string }[],
  defaultRoot: string,
): string | null {
  const anchor = workspaces.find((row) => row.root === defaultRoot)
  if (anchor !== undefined) return anchor.key
  return workspaces[0]?.key ?? null
}

/**
 * The address of one operation (M9): a tier plus, for the project tier, WHICH
 * workspace's central library it means. `workspace` is the roster key; absent
 * keeps the historical meaning (the surface's launch anchor).
 */
export interface KbTarget {
  scope: KbScope
  workspace?: string | null
}

/** Filters for the entries listing. */
export interface EntriesQuery {
  scope?: KbScope
  /** M9: which workspace's tiers a search addresses (project tier) or filters. */
  workspace?: string | null
  status?: string
  kind?: string
  needsReview?: boolean
  q?: string
  limit?: number
}

/**
 * Build the /entries query string from filters (pure; pinned by tests).
 * @param query - the filter set; absent fields stay absent.
 * @returns the encoded query string including the leading '?'.
 */
export function buildEntriesQuery(query: EntriesQuery): string {
  const params = new URLSearchParams()
  if (query.scope !== undefined) params.set('scope', query.scope)
  if (typeof query.workspace === 'string' && query.workspace !== '') params.set('workspace', query.workspace)
  if (query.status !== undefined && query.status !== '') params.set('status', query.status)
  if (query.kind !== undefined && query.kind !== '') params.set('kind', query.kind)
  if (query.needsReview === true) params.set('needsReview', '1')
  if (query.q !== undefined && query.q.trim() !== '') params.set('q', query.q.trim())
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const encoded = params.toString()
  return encoded === '' ? '' : `?${encoded}`
}

/** One route failure with its HTTP status attached. */
export class KbApiError extends Error {
  /** The HTTP status the route answered with. */
  readonly status: number

  /**
   * @param message - the route's error text (or a transport failure summary).
   * @param status - the HTTP status.
   */
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/**
 * One JSON round-trip against the KB API.
 * @param path - the route path under the prefix (leading slash).
 * @param init - fetch options (POST calls set method/body).
 * @returns the parsed payload.
 * @throws {KbApiError} on any non-2xx, carrying the route's error text.
 */
export async function fetchKb<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${KB_API}${path}`, init)
  } catch (error) {
    throw new KbApiError(`无法连接知识库服务: ${error instanceof Error ? error.message : String(error)}`, 0)
  }
  const text = await response.text()
  let payload: unknown = null
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      // Non-JSON on an error status (a proxy hiccup): report raw, truncated.
      payload = { error: text.slice(0, 200) }
    }
  }
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `HTTP ${response.status}`
    throw new KbApiError(message, response.status)
  }
  return payload as T
}

/**
 * Post one JSON body.
 * @param path - the route path under the prefix.
 * @param body - the JSON-serializable payload.
 * @returns the parsed response.
 */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  return fetchKb<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The query string of an addressed tier: scope + workspace key when named. */
function targetParams(target: KbTarget, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ scope: target.scope, ...extra })
  if (target.scope === 'project' && typeof target.workspace === 'string' && target.workspace !== '') {
    params.set('workspace', target.workspace)
  }
  return `?${params.toString()}`
}

/** The body of an addressed call: scope + workspace key when named. */
function targetBody(target: KbTarget, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: target.scope,
    ...(target.scope === 'project' && typeof target.workspace === 'string' && target.workspace !== ''
      ? { workspace: target.workspace }
      : {}),
    ...extra,
  }
}

/** The typed KB API surface the sections consume. */
export const kbApi = {
  /** Both tiers summarized for one addressed workspace. */
  status: (target: KbTarget = { scope: 'project' }): Promise<StatusPayload> =>
    fetchKb<StatusPayload>(`/status${targetParams(target)}`),
  /** The host's workspaces (synced server-side) plus any orphan questions. */
  workspaces: (stats = false): Promise<{
    workspaces: WorkspacePayload[]
    orphans: WorkspacePayload[]
    defaultRoot: string
  }> => fetchKb<{ workspaces: WorkspacePayload[]; orphans: WorkspacePayload[]; defaultRoot: string }>(
    `/workspaces${stats ? '?stats=1' : ''}`,
  ),
  /** Which workspace one conversation lives in (the drawer's address). */
  workspaceForSession: (sessionId: string): Promise<{ record: WorkspacePayload | null; root: string; source: string }> =>
    fetchKb<{ record: WorkspacePayload | null; root: string; source: string }>(
      `/workspace-for-session?sessionId=${encodeURIComponent(sessionId)}`,
    ),
  /** Answer an orphan question with "delete it" (moves to the trash). */
  purgeWorkspace: (key: string): Promise<PurgeResult> =>
    postJson<PurgeResult>('/workspaces/purge', { key }),
  /** Answer an orphan question with "keep it" (stops asking, keeps data). */
  keepWorkspace: (key: string): Promise<{ record: WorkspacePayload }> =>
    postJson<{ record: WorkspacePayload }>('/workspaces/keep', { key }),
  /** Batch answer: every orphan to the trash, under one timestamp. */
  purgeAllOrphans: (): Promise<{ trashRoot: string; keys: string[]; moved: PurgedPiece[] }> =>
    postJson<{ trashRoot: string; keys: string[]; moved: PurgedPiece[] }>('/workspaces/purge-all', {}),
  /** Register a workspace directory by hand. */
  addWorkspace: (root: string, label?: string): Promise<{ record: WorkspacePayload; kbDir: string }> =>
    postJson<{ record: WorkspacePayload; kbDir: string }>('/workspaces/add', { root, ...(label !== undefined ? { label } : {}) }),
  /** Rename a workspace's display label (data and key untouched). */
  renameWorkspace: (key: string, label: string): Promise<{ record: WorkspacePayload }> =>
    postJson<{ record: WorkspacePayload }>('/workspaces/rename', { key, label }),
  /** Unregister a workspace (its central library stays where it is). */
  removeWorkspace: (key: string): Promise<{ record: WorkspacePayload; kbDir: string; baselinesDir: string }> =>
    postJson<{ record: WorkspacePayload; kbDir: string; baselinesDir: string }>('/workspaces/remove', { key }),
  /** The pending approval queue of one addressed tier. */
  approvals: (target: KbTarget): Promise<{ scope: string; workspace: string | null; approvals: ApprovalCard[] }> =>
    fetchKb<{ scope: string; workspace: string | null; approvals: ApprovalCard[] }>(`/approvals${targetParams(target)}`),
  /** One approval decision. */
  resolve: (target: KbTarget, requestId: string, approved: boolean): Promise<{ entry: EntryPayload | null }> =>
    postJson<{ entry: EntryPayload | null }>('/approvals/resolve', targetBody(target, { requestId, approved })),
  /** Filtered listing or retrieval (when q is set). */
  entries: (query: EntriesQuery): Promise<{ scope: string; workspace?: string | null; entries: unknown[] }> =>
    fetchKb<{ scope: string; workspace?: string | null; entries: unknown[] }>(`/entries${buildEntriesQuery(query)}`),
  /** One entry with score and signal ledger. */
  entry: (target: KbTarget, id: string): Promise<{ entry: EntryPayload; score: ScorePayload; signals: SignalPayload[] }> =>
    fetchKb<{ entry: EntryPayload; score: ScorePayload; signals: SignalPayload[] }>(
      `/entry${targetParams(target, { id })}`,
    ),
  /** Resolve the needs-review flag. */
  reverify: (target: KbTarget, id: string, accept: boolean): Promise<{ entry: EntryPayload }> =>
    postJson<{ entry: EntryPayload }>('/entry/reverify', targetBody(target, { id, accept })),
  /** Run tier maintenance. */
  sweep: (target: KbTarget): Promise<{ scope: string; result: Record<string, unknown[]> }> =>
    postJson<{ scope: string; result: Record<string, unknown[]> }>('/sweep', targetBody(target)),
  /** One-shot AI rewrite of an entry's body (returns text, writes nothing). */
  polish: (target: KbTarget, id: string): Promise<{ polished: string; provider: string; model: string; original: string }> =>
    postJson<{ polished: string; provider: string; model: string; original: string }>('/polish', targetBody(target, { id })),
  /** Adopt an edited/polished body (audited history event). */
  updateText: (target: KbTarget, id: string, text: string, reason?: string): Promise<{ entry: EntryPayload }> =>
    postJson<{ entry: EntryPayload }>('/entry/text', targetBody(target, { id, text, ...(reason !== undefined ? { reason } : {}) })),
}
