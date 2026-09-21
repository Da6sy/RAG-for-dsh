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
  /** M9: the immutable原文 snapshot this entry's evidence lives in. */
  doc?: { docId: string; anchor?: { headingPath?: string; lines?: [number, number]; quoteAnchor: string } }
  /** M9-4: human redlines (段-level retractions; display + scoring filter). */
  redlines?: {
    target: 'doc' | 'text'
    docId?: string
    lines?: [number, number]
    chars?: [number, number]
    quoteAnchor: string
    headingPath?: string
    reason: string
    at: string
    by: string
  }[]
  /** M9-4: where a split sent this (superseded) entry's knowledge. */
  splitInto?: string[]
}

/** V4: one snapshot's derived vector state (`/doc`), null when never built. */
export interface DocVectorPayload {
  stem: string
  embedderVersion: string
  dim: number
  count: number
  builtAt: string
  missing: number
  stale: boolean
  unreadable: boolean
}

/** M9-1: one immutable document snapshot as `/doc` serializes it. */
export interface DocPayload {
  version: number
  docId: string
  sourcePath: string
  contentHash: string
  sourceHash: string
  sizeChars: number
  lineCount: number
  ingestedAt: string
  supersedes?: string
  /** Present only in the list form: which entries mount this evidence. */
  mountedEntryIds?: string[]
  /** V4: present in the list and single-doc forms; null when no vector index. */
  vector?: DocVectorPayload | null
}

/** M9-2: one derived chunk row (`/doc?docId=`). */
export interface ChunkRecordPayload {
  seq: number
  headingPath: string
  startLine: number
  endLine: number
  chars: number
  quoteAnchor: string
  overlapWith?: number
  chunkerVersion: string
}

/** M9-2: one ranked chunk hit (`/chunks`). */
export interface ChunkHitPayload {
  docId: string
  seq: number
  headingPath: string
  lines: { start: number; end: number }
  quoteAnchor: string
  chars: number
  score: number
  matched: string[]
  excerpt: string
  partialRedline: boolean
  redlines: { lines?: [number, number]; reason: string; by: string; at: string }[]
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
 * Turn a thrown failure into copy a human can act on.
 *
 * The one case worth special-casing: the browser bundle refreshes by itself
 * (the host hashes it per request), while HOST routes load once at boot — so
 * an unknown-endpoint answer means the running web process predates this
 * button, and "方法不匹配" would be a riddle. A route's own "没有条目" 404
 * keeps its message.
 *
 * @param cause - whatever was thrown.
 * @returns the message to show in the panel.
 */
export function describeKbError(cause: unknown): string {
  if (cause instanceof KbApiError) {
    if (cause.status === 404 && /方法不匹配|未知端点/.test(cause.message)) {
      return '宿主侧还没有这条路由:重启 clue web / dsh web 后刷新页面再试一次。'
    }
    return cause.message
  }
  return String(cause)
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
 * Post one JSON body and return the ANSWER even when it is an error status.
 *
 * Needed for routes whose refusals carry structure the form must render: a
 * field-level validation failure answers 400 with `{ ok: false, errors: [...] }`,
 * and throwing that away in favour of "HTTP 400" would turn the plan's
 * "就地指名哪个字段" back into the generic failure it exists to replace (§9.2).
 * @param path - the route path under the prefix.
 * @param body - the JSON-serializable payload.
 * @returns the status and the parsed payload (never throws on 4xx).
 */
export async function postKbRaw<T>(path: string, body: unknown): Promise<{ status: number; payload: T }> {
  let response: Response
  try {
    response = await fetch(`${KB_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    throw new KbApiError(`无法连接知识库服务: ${error instanceof Error ? error.message : String(error)}`, 0)
  }
  const text = await response.text()
  let payload: unknown = null
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { error: text.slice(0, 200) }
    }
  }
  return { status: response.status, payload: payload as T }
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
  /**
   * The human promote act (人权入口,candidate → trusted). The queue only holds
   * evidence-driven proposals, so this is the human's own judgment put on the
   * record — reason lands in the entry's history, and any queued promote
   * request for the same entry is settled by the same call.
   */
  promote: (target: KbTarget, id: string, reason?: string): Promise<{ entry: EntryPayload }> =>
    postJson<{ entry: EntryPayload }>(
      '/entry/promote',
      targetBody(target, { id, ...(reason !== undefined && reason.trim() !== '' ? { reason } : {}) }),
    ),
  /**
   * The human verdict "this no longer holds" (候选/可信 → 过期). The reason is
   * REQUIRED by the route: a verdict without its why is not auditable, and
   * expired keeps the entry readable while pulling it out of the write-basis.
   */
  retire: (target: KbTarget, id: string, reason: string): Promise<{ entry: EntryPayload }> =>
    postJson<{ entry: EntryPayload }>('/entry/retire', targetBody(target, { id, reason })),
  /** Bring an EXPIRED entry back to candidate (trust must be re-earned). */
  reactivate: (target: KbTarget, id: string, reason?: string): Promise<{ entry: EntryPayload }> =>
    postJson<{ entry: EntryPayload }>(
      '/entry/reactivate',
      targetBody(target, { id, ...(reason !== undefined && reason.trim() !== '' ? { reason } : {}) }),
    ),
  /** Bring a DISCARDED entry back to candidate (never straight to trusted). */
  rescue: (target: KbTarget, id: string, reason?: string): Promise<{ entry: EntryPayload }> =>
    postJson<{ entry: EntryPayload }>(
      '/entry/rescue',
      targetBody(target, { id, ...(reason !== undefined && reason.trim() !== '' ? { reason } : {}) }),
    ),
  /** Run tier maintenance. */
  sweep: (target: KbTarget): Promise<{ scope: string; result: Record<string, unknown[]> }> =>
    postJson<{ scope: string; result: Record<string, unknown[]> }>('/sweep', targetBody(target)),
  /** One-shot AI rewrite of an entry's body (returns text, writes nothing). */
  polish: (target: KbTarget, id: string): Promise<{ polished: string; provider: string; model: string; original: string }> =>
    postJson<{ polished: string; provider: string; model: string; original: string }>('/polish', targetBody(target, { id })),
  /** Adopt an edited/polished body (audited history event). */
  updateText: (target: KbTarget, id: string, text: string, reason?: string): Promise<{ entry: EntryPayload }> =>
    postJson<{ entry: EntryPayload }>('/entry/text', targetBody(target, { id, text, ...(reason !== undefined ? { reason } : {}) })),
  /** M9-1: the addressed tier's原文快照 list (with mount counts). */
  docs: (target: KbTarget): Promise<{ scope: string; workspace: string | null; docs: DocPayload[] }> =>
    fetchKb<{ scope: string; workspace: string | null; docs: DocPayload[] }>(`/doc${targetParams(target)}`),
  /** M9-1: one snapshot's record + its derived chunk ledger. */
  doc: (target: KbTarget, docId: string): Promise<{
    scope: string
    doc: DocPayload
    chunks: ChunkRecordPayload[]
    needsRebuild: boolean
    vector: DocVectorPayload | null
  }> => fetchKb<{ scope: string; doc: DocPayload; chunks: ChunkRecordPayload[]; needsRebuild: boolean; vector: DocVectorPayload | null }>(
    `/doc${targetParams(target, { docId })}`,
  ),
  /** M9-2: the second level — ranked原文段 with anchors (pure read). */
  chunks: (
    target: KbTarget,
    address: { docId?: string; entryId?: string; query?: string; limit?: number },
  ): Promise<{ scope: string; docIds: string[]; hits: ChunkHitPayload[] }> => {
    const extra: Record<string, string> = {}
    if (address.docId !== undefined && address.docId !== '') extra.docId = address.docId
    if (address.entryId !== undefined && address.entryId !== '') extra.entryId = address.entryId
    if (address.query !== undefined && address.query !== '') extra.query = address.query
    if (address.limit !== undefined) extra.limit = String(address.limit)
    return fetchKb<{ scope: string; docIds: string[]; hits: ChunkHitPayload[] }>(`/chunks${targetParams(target, extra)}`)
  },
  /** M9-4: the human redline act (text range or原文 line range). */
  redline: (
    target: KbTarget,
    id: string,
    range: { chars?: [number, number]; lines?: [number, number] },
    reason: string,
  ): Promise<{ entry: EntryPayload; ratio: number; proposal: { id: string; reason: string } | null }> =>
    postJson<{ entry: EntryPayload; ratio: number; proposal: { id: string; reason: string } | null }>(
      '/entry/redline',
      targetBody(target, { id, reason, ...range }),
    ),
  /** M9-4: the human split act (old entry → superseded, successors → candidate). */
  split: (
    target: KbTarget,
    id: string,
    drafts: { kind?: string; title: string; text: string }[],
    reason?: string,
  ): Promise<{ old: EntryPayload; created: EntryPayload[] }> =>
    postJson<{ old: EntryPayload; created: EntryPayload[] }>(
      '/entry/split',
      targetBody(target, { id, drafts, ...(reason !== undefined ? { reason } : {}) }),
    ),

  // ── V1: the embedding plane (规划 §9.5) ─────────────────────────────────
  /**
   * V1 follow-up: probe the providers this composition already names and enable
   * the first one that answers an embeddings call. The user re-types nothing.
   */
  embeddingAuto: (dryRun = false): Promise<{
    probes: Array<{ route: string; model: string; ok: boolean; dim?: number; ms?: number; error?: string; skipped?: string }>
    applied: { id: string; baseUrl: string; model: string; apiKeyEnv: string; dim: number } | null
    written: boolean
    summary: string
  }> => postKbRaw('/embedding/auto', { dryRun }).then(({ payload }) => payload as never),
  /** V1 follow-up: the embedder picker's options (configured providers + built-ins). */
  embeddingCandidates: (): Promise<EmbeddingCatalogPayload> =>
    fetchKb<EmbeddingCatalogPayload>('/embedding/candidates'),
  /** Everything the「知识检索与向量」page renders, in one read. */
  embedding: (workspace?: string | null): Promise<EmbeddingConfigPayload> =>
    fetchKb<EmbeddingConfigPayload>(`/embedding/config${workspace !== undefined && workspace !== null && workspace !== '' ? `?workspace=${encodeURIComponent(workspace)}` : ''}`),
  /** Write non-secret provider fields (one revision-fenced patch). */
  embeddingSet: async (
    patch: Record<string, unknown>,
    revision?: number,
  ): Promise<{ ok: boolean; errors: { field: string; message: string }[]; config: EmbeddingProviderPayload; retrieval?: RetrievalTuningPayload; status: number }> => {
    // The answer is read even on a refusal: a 400 here is a FIELD verdict.
    const { status, payload } = await postKbRaw<{
      ok: boolean
      errors: { field: string; message: string }[]
      config: EmbeddingProviderPayload
      retrieval?: RetrievalTuningPayload
    }>('/embedding/config', { patch, ...(revision !== undefined ? { revision } : {}) })
    return { ...payload, status }
  },
  /** Store the key: browser → host → credentials. The answer never echoes it. */
  embeddingKey: (value: string): Promise<{ ok: boolean; stored: string; key: KeyStatusPayload }> =>
    postJson('/embedding/key', { value }),
  /** Forget the stored key (the vector layer itself is untouched). */
  embeddingKeyClear: (): Promise<{ ok: boolean; cleared: string; key: KeyStatusPayload }> =>
    postJson('/embedding/key/clear', {}),
  /** One probe call: dim / latency / normalized norm, or a classified failure. */
  embeddingTest: (record: boolean, workspace?: string | null): Promise<ConnectionTestPayload> =>
    postJson('/embedding/test', { record, ...(workspace !== undefined && workspace !== null && workspace !== '' ? { workspace } : {}) }),
  /** Build (or dry-run) the vector layer for the addressed workspace. */
  embeddingBuild: (options: { dryRun?: boolean; only?: 'entries' | 'chunks' | 'all'; rebuild?: boolean; workspace?: string | null }): Promise<{
    ok: boolean
    dryRun: boolean
    reports: unknown[]
    vector?: VectorFactsPayload
    error?: string
  }> => postJson('/embedding/build', {
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.only !== undefined ? { only: options.only } : {}),
    ...(options.rebuild !== undefined ? { rebuild: options.rebuild } : {}),
    ...(options.workspace !== undefined && options.workspace !== null && options.workspace !== '' ? { workspace: options.workspace } : {}),
  }),
  /** Clear the shared text cache (a diagnostic that costs real money later). */
  embeddingClearCache: (all = false): Promise<{ ok: boolean; cleared: string[] }> =>
    postJson('/embedding/cache/clear', { all }),
  /** The ranklog summary (how much LTR annotation has accumulated). */
  embeddingRanklog: (workspace?: string | null): Promise<RankLogSummaryPayload> =>
    fetchKb<RankLogSummaryPayload>(`/embedding/ranklog${workspace !== undefined && workspace !== null && workspace !== '' ? `?workspace=${encodeURIComponent(workspace)}` : ''}`),
}

/** V1 follow-up: one selectable embedder in the settings page's picker. */
export interface EmbeddingCandidatePayload {
  id: string
  route: string
  label: string
  baseUrl: string
  model: string
  apiKeyEnv: string
  dimHint: number | null
  usable: boolean
  note?: string
}

/** V1 follow-up: candidates grouped by provider, with that provider's key state. */
export interface EmbeddingCandidateGroupPayload {
  route: string
  label: string
  baseUrl: string
  apiKeyEnv: string
  keyState: 'configured' | 'missing' | 'unresolved' | 'unknown'
  keyDetail: string
  keyReady: boolean
  candidates: EmbeddingCandidatePayload[]
}

/** V1 follow-up: the whole picker payload. */
export interface EmbeddingCatalogPayload {
  groups: EmbeddingCandidateGroupPayload[]
  chat: { provider: string; model: string } | null
  notices: string[]
  /** The candidate the stored configuration currently matches (or null). */
  selected: string | null
}

/** V1: the provider configuration as the routes serialize it (never a secret). */
export interface EmbeddingProviderPayload {
  enabled: boolean
  baseUrl: string
  /** The reference NAME (an env-var name), never a value. */
  apiKeyEnv: string
  model: string
  /** 0 = not measured yet; only the connection test writes it. */
  dim: number
  headers: Record<string, string>
  timeoutMs: number
  batchSize: number
  concurrency: number
  maxUnitsPerBuild: number
  quant: string
}

/** V1: the key's state, as a surface may show it (规划 §9.4-3). */
export interface KeyStatusPayload {
  state: 'configured' | 'missing' | 'unresolved' | 'unreachable'
  detail: string
  writable: boolean
}

/** V1: the retrieval-tuning section (§9.3 B). */
export interface RetrievalTuningPayload {
  fusion: string
  rrfK: number
  channelWeights: { lexical: number; vector: number }
  recallDepth: number
  rerankCandidates: number
  rerank: boolean
  llmRerank: boolean
  ranklog: boolean
  featureWeights: Record<string, number>
  /**
   * D1/D2/D3 of `docs/修复方案-精排量纲与语义名次.md`: the SCALE switches.
   *
   * They are in the payload (not only in the schema) because the page has to be
   * able to show which档位 is in force — a switch nobody can see is how the F0
   * "phantom knob" happened.
   */
  lexicalNormalization: 'candidates' | 'absolute'
  semanticScale: 'raw' | 'calibrated'
  semanticFloor: number
  semanticCeil: number
  missingFeatureMode: 'zero' | 'absent'
}

/** V1: one derived index's health. */
export interface VectorIndexPayload {
  tier: string
  stem: string
  embedderVersion: string
  dim: number
  count: number
  builtAt: string
  missing: number
  stale: boolean
  unreadable: boolean
}

/** V1: the vector layer's facts for one workspace. */
export interface VectorFactsPayload {
  embedderVersion: string | null
  indexes: VectorIndexPayload[]
  cachedVectors: number
  ranklog: RankLogSummaryPayload
}

/** V1: how much LTR annotation the ranklog holds (§8.4). */
export interface RankLogSummaryPayload {
  rows: number
  queries: number
  perProfile: Record<string, number>
  labeledRows: number
  positiveLabels: number
  negativeLabels: number
  lastAt: string | null
}

/** V1: one connection test's outcome (§9.6). */
export interface ConnectionTestPayload {
  ok: boolean
  status: string
  message: string
  dim?: number
  model?: string
  latencyMs?: number
  norm?: number
  rebuildNotice?: string
  recorded?: { previousDim: number; dim: number; rebuildImplied: boolean } | null
  endpoint?: string
  host?: string
}

/** V1: the whole page payload. */
export interface EmbeddingConfigPayload {
  config: EmbeddingProviderPayload
  retrieval: RetrievalTuningPayload
  ready: boolean
  note: string
  key: KeyStatusPayload
  /** False when the host mounted no settings/credentials service. */
  available: boolean
  documentPath: string | null
  revisions: Record<string, number>
  vector: VectorFactsPayload
}
