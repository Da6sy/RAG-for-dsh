/**
 * Pure parsing/derivation for the KB surfaces — no React, no fetch, no DOM.
 * Everything a citation card or panel row derives from wire payloads lives
 * here so the house test runner (node --test, strip-types) can pin it.
 *
 * Wire shapes are the kb-face tool outputs (SEARCH_OUTPUT/PROPOSE_OUTPUT
 * schemas) and the kb-web JSON routes — both plain data, both defensive to
 * parse: a tool call's argsRaw may be mid-stream truncated JSON, and a
 * result block may be an error string instead of the structured payload.
 *
 * @module @clue-harness/ui-kb/client/parse
 */

/** One kb_search hit exactly as the model saw it (SEARCH_OUTPUT item). */
export interface KbSearchHit {
  id: string
  title: string
  kind: string
  status: string
  needsReview: boolean
  score: number
  text: string
  annotations: string[]
}

/** The kb_search structured result. */
export interface KbSearchResult {
  hits: KbSearchHit[]
  total: number
}

/** The kb_propose structured result. */
export interface KbProposeResult {
  id: string
  status: string
  note: string
}

/** The kb_cite structured result (M4 precise-attribution receipt). */
export interface KbCiteResult {
  cited: string[]
  missing: string[]
  note: string
}

/** The minimal content-block shape the parse helpers accept. */
export interface TextishBlock {
  type?: string
  text?: string
}

/** Badge tone → presentation vocabulary (pill classes map from these). */
export type BadgeTone = 'ok' | 'muted' | 'warn' | 'bad'

/** One derived display badge for an entry/hit state. */
export interface StateBadge {
  label: string
  tone: BadgeTone
}

const STATUS_LABELS: Record<string, { label: string; tone: BadgeTone }> = {
  trusted: { label: '可信', tone: 'ok' },
  candidate: { label: '候选', tone: 'muted' },
  expired: { label: '过期', tone: 'warn' },
  discarded: { label: '遗弃', tone: 'bad' },
  // M9-4: the split's terminal state — historical, still readable, never purged.
  superseded: { label: '已拆分替代', tone: 'muted' },
}

/**
 * Derive the display badge for a status + the orthogonal needs-review flag.
 * The review marker PREFIXES the status label and escalates the tone to at
 * least warn — the M2 acceptance line ("改绑定文件 → 自动 ⚑待复核") made the
 * flag a first-class visible fact, and the retrieval contract says
 * annotations MUST be shown alongside hits.
 * @param status - the four-state lifecycle value.
 * @param needsReview - the orthogonal freshness flag.
 * @returns the badge to render.
 */
export function stateBadge(status: string, needsReview: boolean): StateBadge {
  const base = STATUS_LABELS[status] ?? { label: status, tone: 'muted' as BadgeTone }
  if (!needsReview) return base
  const tone: BadgeTone = base.tone === 'bad' ? 'bad' : 'warn'
  return { label: `⚑待复核·${base.label}`, tone }
}

/**
 * Parse tool-call args JSON tolerantly.
 * @param argsRaw - the streamed args text (possibly truncated mid-flight).
 * @returns the parsed object, or null when absent/unparsable.
 */
export function parseArgs(argsRaw: string | null | undefined): Record<string, unknown> | null {
  if (argsRaw === null || argsRaw === undefined || argsRaw.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    // Mid-stream truncation or malformed model JSON: the card degrades to
    // its generic summary rather than throwing inside render.
    return null
  }
}

/**
 * Extract the concatenated text of a tool-result's content blocks.
 * @param content - the result content blocks.
 * @returns the joined text ('' when there is none).
 */
export function resultText(content: readonly TextishBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type?: string; text: string } =>
      typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * Parse a kb_search result payload.
 * @param content - the tool-result content blocks.
 * @returns hits + total, or null when the payload is not the structured output.
 */
export function parseKbSearchResult(content: readonly TextishBlock[] | undefined): KbSearchResult | null {
  const text = resultText(content).trim()
  if (text === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as { hits?: unknown; total?: unknown }
  if (!Array.isArray(candidate.hits)) return null
  const hits: KbSearchHit[] = []
  for (const raw of candidate.hits) {
    if (typeof raw !== 'object' || raw === null) continue
    const hit = raw as Partial<KbSearchHit>
    if (typeof hit.id !== 'string' || typeof hit.title !== 'string') continue
    hits.push({
      id: hit.id,
      title: hit.title,
      kind: typeof hit.kind === 'string' ? hit.kind : '',
      status: typeof hit.status === 'string' ? hit.status : 'candidate',
      needsReview: hit.needsReview === true,
      score: typeof hit.score === 'number' ? hit.score : 0,
      text: typeof hit.text === 'string' ? hit.text : '',
      annotations: Array.isArray(hit.annotations) ? hit.annotations.filter((a): a is string => typeof a === 'string') : [],
    })
  }
  return { hits, total: typeof candidate.total === 'number' ? candidate.total : hits.length }
}

/**
 * Parse a kb_propose result payload.
 * @param content - the tool-result content blocks.
 * @returns the proposal summary, or null when unparsable.
 */
export function parseKbProposeResult(content: readonly TextishBlock[] | undefined): KbProposeResult | null {
  const text = resultText(content).trim()
  if (text === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as { id?: unknown; status?: unknown; note?: unknown }
  if (typeof candidate.id !== 'string') return null
  return {
    id: candidate.id,
    status: typeof candidate.status === 'string' ? candidate.status : 'candidate',
    note: typeof candidate.note === 'string' ? candidate.note : '',
  }
}

/**
 * Parse a kb_cite result payload.
 * @param content - the tool-result content blocks.
 * @returns the citation receipt, or null when the payload is not structured.
 */
export function parseKbCiteResult(content: readonly TextishBlock[] | undefined): KbCiteResult | null {
  const text = resultText(content).trim()
  if (text === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as { cited?: unknown; missing?: unknown; note?: unknown }
  if (!Array.isArray(candidate.cited)) return null
  return {
    cited: candidate.cited.filter((id): id is string => typeof id === 'string'),
    missing: Array.isArray(candidate.missing)
      ? candidate.missing.filter((id): id is string => typeof id === 'string')
      : [],
    note: typeof candidate.note === 'string' ? candidate.note : '',
  }
}

/** The human label for one approval action verb. */
const ACTION_LABELS: Record<string, { approve: string; summary: string }> = {
  promote: { approve: '批准提升为可信', summary: '提升为可信' },
  discard: { approve: '批准遗弃', summary: '遗弃' },
  rescue: { approve: '批准捞回候选', summary: '捞回候选' },
  reactivate: { approve: '批准重新激活', summary: '重新激活' },
}

/**
 * Display copy for one approval action.
 * @param action - the queued action verb.
 * @returns the approve-button label and the one-word summary.
 */
export function actionCopy(action: string): { approve: string; summary: string } {
  return ACTION_LABELS[action] ?? { approve: `批准(${action})`, summary: action }
}

/**
 * Shorten an entry id for chip display (ids are `kb-<tier>-<hash>`-ish).
 * @param id - the full entry id.
 * @returns the leading segment plus a short tail, or the id when already short.
 */
export function shortId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}
