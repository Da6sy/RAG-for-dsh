/**
 * The knowledge-base panel (design §6.2): browse both tiers, filter by
 * lifecycle state, search, and open one entry's FULL dossier — who taught
 * it (provenance incl. the session anchor), what it binds (files + drift
 * flag), how often it was referenced, its scored signal window, and its
 * audited history ledger. Maintenance verbs live here too: reverify a
 * drifted binding and run the tier sweep.
 *
 * Data discipline: local state only (fetch on open/action) — same reasoning
 * as the approval center; no cross-entry shared facts, so no store.
 *
 * @module @clue-harness/ui-kb/client/KbSection
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, IconSearchOutline16, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  kbApi, KbApiError,
  type EntryPayload, type KbScope, type KbTarget, type ScorePayload, type SignalPayload,
} from './api.ts'
import { shortId, stateBadge } from './parse.ts'
import { GLOBAL_VALUE, targetOf, WorkspacePicker } from './WorkspacePicker.tsx'
import { MenuSelect } from './MenuSelect.tsx'

/** The lifecycle filter vocabulary (plus 'all' and the orthogonal flag). */
const STATUS_FILTERS = [
  { value: '', label: '全部状态' },
  { value: 'candidate', label: '候选' },
  { value: 'trusted', label: '可信' },
  { value: 'expired', label: '过期' },
  { value: 'discarded', label: '遗弃' },
] as const

/** The entry-detail dossier payload. */
interface Dossier {
  entry: EntryPayload
  score: ScorePayload
  signals: SignalPayload[]
}

/**
 * Format an ISO instant compactly.
 * @param iso - the timestamp.
 * @returns local month-day hour-minute (or the raw text on a miss).
 */
function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/**
 * Render one entry's dossier pane.
 * @param dossier - entry + score + signals.
 * @param busy - whether an action is in flight.
 * @param onReverify - resolve the needs-review flag (accept/reject).
 * @returns the detail pane.
 */
function EntryDossier({ dossier, busy, onReverify }: {
  dossier: Dossier
  busy: boolean
  onReverify: (accept: boolean) => void
}) {
  const { entry, score, signals } = dossier
  const badge = stateBadge(entry.status, entry.needsReview)
  return (
    <div className="clue-card">
      <div className="clue-card-head">
        <span className={`clue-pill clue-pill-${badge.tone}`}>{badge.label}</span>
        <span className="clue-card-title">{entry.title}</span>
        <span className="clue-mono clue-dim">{shortId(entry.id)}</span>
      </div>
      <div className="clue-card-text">{entry.text}</div>
      {entry.tags.length > 0 && (
        <div className="clue-tags">
          {entry.tags.map(tag => <span className="clue-pill clue-pill-muted" key={tag}>#{tag}</span>)}
        </div>
      )}
      <div className="clue-dim">
        来源: {entry.provenance.createdBy} · {when(entry.provenance.createdAt)}
        {entry.provenance.session !== undefined && <> · 学自会话 {String(entry.provenance.session.id).slice(0, 16)}…</>}
        {entry.provenance.note !== undefined && entry.provenance.note !== '' && <> · {entry.provenance.note}</>}
      </div>
      <div className="clue-dim">
        引用 {entry.stats.referenceCount} 次
        {entry.stats.lastReferencedAt !== null && <> · 最近 {when(entry.stats.lastReferencedAt)}</>}
        {' '}· 窗口分 {score.score}(计 {score.counted} 条信号: +{score.positive} / −{score.negative})
      </div>
      {entry.needsReview && (
        <div className="clue-err">
          绑定文件已改动,该条知识可能不再成立: {entry.reviewReason ?? '(未说明)'}
          <div className="clue-actions" style={{ marginTop: 8 }}>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => { onReverify(true) }}>
              复核通过(重绑当前内容)
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { onReverify(false) }}>
              不再成立(转入过期)
            </Button>
          </div>
        </div>
      )}
      {entry.bindings.length > 0 && (
        <div className="clue-dim">
          绑定文件:
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {entry.bindings.map(binding => (
              <li key={binding.path} className="clue-mono">{binding.path} <span className="clue-dim">@{binding.contentHash.slice(0, 8)}</span></li>
            ))}
          </ul>
        </div>
      )}
      {signals.length > 0 && (
        <details>
          <summary className="clue-dim">信号账本({signals.length} 条)</summary>
          <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
            {signals.slice(-20).map((signal, index) => (
              <li key={`${signal.at}-${index}`} className="clue-dim">
                <span className={signal.polarity === 'positive' ? 'clue-signal-pos' : 'clue-signal-neg'}>
                  {signal.weight > 0 ? `+${signal.weight}` : signal.weight}
                </span>
                {' '}{signal.source}/{signal.polarity} · {when(signal.at)}{signal.note !== '' && ` · ${signal.note}`}
              </li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary className="clue-dim">履历({entry.history.length} 条)</summary>
        <div className="clue-history" style={{ marginTop: 6 }}>
          {entry.history.slice().reverse().map((event, index) => (
            <div className="clue-dim" key={`${event.at}-${index}`}>
              {when(event.at)} · {event.change}
              {event.from !== null && <> {String(event.from)}</>}
              {event.to !== null && <> → {String(event.to)}</>}
              {' '}· {event.reason}
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}

/**
 * The KB panel body (a `settings.section` registrant).
 * @returns the browsing panel.
 */
export function KbSection() {
  // M9: WHICH library is addressed first (a workspace key or the global tier),
  // then what inside it is filtered. The roster is ClueHarness's own.
  const [address, setAddress] = useState<string>(GLOBAL_VALUE)
  const [status, setStatus] = useState('')
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false)
  const [q, setQ] = useState('')
  const [entries, setEntries] = useState<EntryPayload[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [dossier, setDossier] = useState<Dossier | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (where: KbTarget, statusFilter: string, reviewOnly: boolean, query: string) => {
    const tier = where.scope
    setLoading(true)
    setError(null)
    try {
      if (query.trim() !== '') {
        // Retrieval mode answers across tiers with ranking; the scope toggle
        // still narrows (the route filters hits by tier when scope is set).
        const payload = await kbApi.entries({ ...where, q: query, limit: 100 }) as {
          entries: { entry: EntryPayload }[]
        }
        setEntries(payload.entries.map(hit => hit.entry))
      } else {
        const payload = await kbApi.entries({
          ...where,
          ...(statusFilter !== '' ? { status: statusFilter } : {}),
          ...(reviewOnly ? { needsReview: true } : {}),
        }) as { entries: EntryPayload[] }
        setEntries(payload.entries)
      }
    } catch (cause) {
      setEntries(null)
      setError(cause instanceof KbApiError ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setSelected(null)
    setDossier(null)
    void load(targetOf(address), status, needsReviewOnly, q)
  }, [address, status, needsReviewOnly, load]) // q rides the search button/Enter, not keystrokes

  /**
   * Open one entry's dossier.
   * @param id - the entry to open.
   */
  const open = async (id: string): Promise<void> => {
    setSelected(id)
    setDossier(null)
    setError(null)
    try {
      setDossier(await kbApi.entry(targetOf(address), id))
    } catch (cause) {
      setError(cause instanceof KbApiError ? cause.message : String(cause))
    }
  }

  /**
   * Resolve the needs-review flag on the open entry, then reload both panes.
   * @param accept - whether the new binding content is accepted.
   */
  const reverify = async (accept: boolean): Promise<void> => {
    if (selected === null) return
    setBusy(true)
    try {
      await kbApi.reverify(targetOf(address), selected, accept)
      setDossier(await kbApi.entry(targetOf(address), selected))
      await load(targetOf(address), status, needsReviewOnly, q)
    } catch (cause) {
      setError(cause instanceof KbApiError ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  /** Run the tier sweep and surface its buckets. */
  const sweep = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await kbApi.sweep(targetOf(address))
      const summary = ['expired', 'discarded', 'purged', 'promotions']
        .map(bucket => `${bucket}: ${result.result[bucket]?.length ?? 0}`)
        .join(' · ')
      setError(null)
      window.alert(`清扫完成 — ${summary}`)
      await load(targetOf(address), status, needsReviewOnly, q)
    } catch (cause) {
      setError(cause instanceof KbApiError ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const list = entries ?? []
  return (
    <div className="clue-sec">
      <div className="clue-heading">
        <div><div className="clue-eyebrow">CLUE / KNOWLEDGE GRAPH</div><h2>知识库</h2><p>浏览项目经验、全局规则和它们被验证过的完整轨迹。</p></div>
        <div className="clue-counter">{loading ? '—' : list.length}<small>条知识</small></div>
      </div>
      <WorkspacePicker value={address} onChange={setAddress} />
      <div className="clue-toolbar">
        <MenuSelect
          value={status}
          options={STATUS_FILTERS.map(filter => ({ id: filter.value || 'all', label: filter.label }))}
          onChange={(id) => { setStatus(id === 'all' ? '' : id) }}
          ariaLabel="按生命周期状态筛选"
        />
        <label className="clue-dim" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={needsReviewOnly} onChange={event => { setNeedsReviewOnly(event.target.checked) }} />
          仅待复核
        </label>
        <Input
          className="clue-search"
          icon={<IconSearchOutline16 size={14} />}
          placeholder="检索(回车)…"
          value={q}
          onChange={event => { setQ(event.target.value) }}
          onKeyDown={event => {
            if (event.key === 'Enter') void load(targetOf(address), status, needsReviewOnly, q)
          }}
        />
        <Button size="sm" variant="outline" onClick={() => { void load(targetOf(address), status, needsReviewOnly, q) }}>检索</Button>
        <span className="clue-spacer" />
        <span className="clue-count">{loading ? '加载中…' : `${list.length} 条`}</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void sweep() }}>清扫(sweep)</Button>
      </div>

      {error !== null && <div className="clue-err">{error}</div>}

      <div className="clue-split">
        <div className="clue-list">
          {!loading && list.length === 0 && <div className="clue-empty">这个视图下没有知识条目。</div>}
          {list.map(entry => {
            const badge = stateBadge(entry.status, entry.needsReview)
            return (
              <div
                className={`clue-row${selected === entry.id ? ' clue-row-active' : ''}`}
                key={entry.id}
                role="button"
                tabIndex={0}
                onClick={() => { void open(entry.id) }}
                onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') void open(entry.id) }}
              >
                <span className={`clue-pill clue-pill-${badge.tone}`}>{badge.label}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.title}</span>
                <span className="clue-dim">{entry.kind}</span>
              </div>
            )
          })}
        </div>
        <div>
          {selected === null && <div className="clue-empty">点开左侧条目查看完整履历。</div>}
          {selected !== null && dossier === null && error === null && <div className="clue-empty">加载中…</div>}
          {dossier !== null && <EntryDossier dossier={dossier} busy={busy} onReverify={accept => { void reverify(accept) }} />}
        </div>
      </div>
    </div>
  )
}
