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
  project: TierStatusPayload
  global: TierStatusPayload
}

/** Which KB tier an operation addresses. */
export type KbScope = 'project' | 'global'

/** Filters for the entries listing. */
export interface EntriesQuery {
  scope?: KbScope
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

/** The typed KB API surface the sections consume. */
export const kbApi = {
  /** Both tiers summarized. */
  status: (): Promise<StatusPayload> => fetchKb<StatusPayload>('/status'),
  /** The pending approval queue of one tier. */
  approvals: (scope: KbScope): Promise<{ scope: string; approvals: ApprovalCard[] }> =>
    fetchKb<{ scope: string; approvals: ApprovalCard[] }>(`/approvals?scope=${scope}`),
  /** One approval decision. */
  resolve: (scope: KbScope, requestId: string, approved: boolean): Promise<{ entry: EntryPayload | null }> =>
    postJson<{ entry: EntryPayload | null }>('/approvals/resolve', { scope, requestId, approved }),
  /** Filtered listing or retrieval (when q is set). */
  entries: (query: EntriesQuery): Promise<{ scope: string; entries: unknown[] }> =>
    fetchKb<{ scope: string; entries: unknown[] }>(`/entries${buildEntriesQuery(query)}`),
  /** One entry with score and signal ledger. */
  entry: (scope: KbScope, id: string): Promise<{ entry: EntryPayload; score: ScorePayload; signals: SignalPayload[] }> =>
    fetchKb<{ entry: EntryPayload; score: ScorePayload; signals: SignalPayload[] }>(
      `/entry?scope=${scope}&id=${encodeURIComponent(id)}`,
    ),
  /** Resolve the needs-review flag. */
  reverify: (scope: KbScope, id: string, accept: boolean): Promise<{ entry: EntryPayload }> =>
    postJson<{ entry: EntryPayload }>('/entry/reverify', { scope, id, accept }),
  /** Run tier maintenance. */
  sweep: (scope: KbScope): Promise<{ scope: string; result: Record<string, unknown[]> }> =>
    postJson<{ scope: string; result: Record<string, unknown[]> }>('/sweep', { scope }),
  /** One-shot AI rewrite of an entry's body (returns text, writes nothing). */
  polish: (scope: KbScope, id: string): Promise<{ polished: string; provider: string; model: string; original: string }> =>
    postJson<{ polished: string; provider: string; model: string; original: string }>('/polish', { scope, id }),
  /** Adopt an edited/polished body (audited history event). */
  updateText: (scope: KbScope, id: string, text: string, reason?: string): Promise<{ entry: EntryPayload }> =>
    postJson<{ entry: EntryPayload }>('/entry/text', { scope, id, text, ...(reason !== undefined ? { reason } : {}) }),
}
