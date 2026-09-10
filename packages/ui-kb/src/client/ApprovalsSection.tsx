/**
 * The approval center (design §6.1 — the highest-priority page): the batched
 * queue where knowledge lifecycle decisions are made. Batched by decision #12
 * (never popups): proposals accumulate, the human clears them in one sitting.
 *
 * Every card carries the decision context the design named: the entry
 * content, its provenance (who taught us this), the score that queued it,
 * and the suggested action. Bulk verbs (全批准 / 全忽略) walk the queue
 * sequentially — each decision is its own audited route call, so a failure
 * mid-batch leaves the earlier decisions committed and the rest pending
 * (honest partial progress, no transaction illusion).
 *
 * Data discipline: this component owns LOCAL state only (fetch on mount,
 * refetch after actions and on demand) — nothing here is shared across
 * entries or survives remounts, so no store is declared (slot rule 5).
 *
 * @module @clue-harness/ui-kb/client/ApprovalsSection
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { kbApi, KbApiError, type ApprovalCard, type KbScope } from './api.ts'
import { actionCopy, shortId, stateBadge } from './parse.ts'

/**
 * Format an ISO instant for card display.
 * @param iso - the timestamp.
 * @returns a compact local rendering (or the raw text on a parse miss).
 */
function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/**
 * The approvals section body (a `settings.section` registrant).
 * @returns the approval center panel.
 */
export function ApprovalsSection() {
  const [scope, setScope] = useState<KbScope>('project')
  const [cards, setCards] = useState<ApprovalCard[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  // M6 AI polish (M5 review decision): per-request rewrite drafts. The route
  // RETURNS text and writes nothing; adoption is an explicit second call —
  // the human stays the approver, the model stays the typist.
  const [polish, setPolish] = useState<Record<string, { loading?: boolean; text?: string; error?: string }>>({})

  const load = useCallback(async (tier: KbScope) => {
    setLoading(true)
    setError(null)
    try {
      const payload = await kbApi.approvals(tier)
      setCards(payload.approvals)
    } catch (cause) {
      setCards(null)
      setError(cause instanceof KbApiError ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(scope) }, [scope, load])

  /**
   * Resolve one request, then refresh the queue.
   * @param requestId - the queued request.
   * @param approved - the decision.
   */
  const decide = async (requestId: string, approved: boolean): Promise<void> => {
    setBusy(requestId)
    setError(null)
    try {
      await kbApi.resolve(scope, requestId, approved)
      await load(scope)
    } catch (cause) {
      setError(cause instanceof KbApiError ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  /** Walk the whole pending queue with one decision (sequential, audited). */
  const decideAll = async (approved: boolean): Promise<void> => {
    const queue = cards ?? []
    setBusy('*')
    setError(null)
    for (const card of queue) {
      try {
        await kbApi.resolve(scope, card.request.id, approved)
      } catch (cause) {
        // A mid-batch failure is reported, earlier decisions stay committed.
        setError(`批量处理在 ${card.request.id} 中断: ${cause instanceof KbApiError ? cause.message : String(cause)}`)
        break
      }
    }
    setBusy(null)
    await load(scope)
  }

  /**
   * Request the one-shot AI rewrite of one card's entry body.
   * @param requestId - the card being polished.
   * @param entryId - the entry to rewrite.
   */
  const requestPolish = async (requestId: string, entryId: string): Promise<void> => {
    setPolish((previous) => ({ ...previous, [requestId]: { loading: true } }))
    try {
      const result = await kbApi.polish(scope, entryId)
      setPolish((previous) => ({ ...previous, [requestId]: { text: result.polished } }))
    } catch (cause) {
      const message = cause instanceof KbApiError ? cause.message : String(cause)
      setPolish((previous) => ({ ...previous, [requestId]: { error: message } }))
    }
  }

  /**
   * Adopt the (possibly hand-edited) polished draft as the entry's body.
   * @param requestId - the card being updated.
   * @param entryId - the entry to rewrite.
   * @param text - the adopted body text.
   */
  const adoptPolish = async (requestId: string, entryId: string, text: string): Promise<void> => {
    setBusy(requestId)
    setError(null)
    try {
      await kbApi.updateText(scope, entryId, text, '审批中心采纳 AI 润色稿')
      setPolish((previous) => {
        const next = { ...previous }
        delete next[requestId]
        return next
      })
      await load(scope)
    } catch (cause) {
      setError(cause instanceof KbApiError ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const pending = cards ?? []
  return (
    <div className="clue-sec">
      <div className="clue-heading">
        <div><div className="clue-eyebrow">CLUE / REVIEW QUEUE</div><h2>知识审批中心</h2><p>把跨项目沉淀的经验，变成可追溯、可复核的团队资产。</p></div>
        <div className="clue-counter">{loading ? '—' : pending.length}<small>待处理</small></div>
      </div>
      <div className="clue-toolbar">
        <Button size="sm" variant={scope === 'project' ? 'primary' : 'outline'} onClick={() => { setScope('project') }}>
          项目库
        </Button>
        <Button size="sm" variant={scope === 'global' ? 'primary' : 'outline'} onClick={() => { setScope('global') }}>
          全局库
        </Button>
        <span className="clue-count">
          {loading ? '加载中…' : `待批 ${pending.length} 条`}
        </span>
        <span className="clue-spacer" />
        <Button size="sm" variant="ghost" disabled={loading || pending.length === 0 || busy !== null} onClick={() => { void load(scope) }}>
          刷新
        </Button>
        <Button size="sm" variant="primary" disabled={pending.length === 0 || busy !== null} onClick={() => { void decideAll(true) }}>
          全批准
        </Button>
        <Button size="sm" variant="outline" disabled={pending.length === 0 || busy !== null} onClick={() => { void decideAll(false) }}>
          全忽略
        </Button>
      </div>

      {error !== null && <div className="clue-err">{error}</div>}

      {!loading && pending.length === 0 && error === null && (
        <div className="clue-empty">
          没有待批的知识提案。
          <div className="clue-dim">模型只能提案(kb_propose),提升/遗弃/捞回都会攒批到这里等你决定。</div>
        </div>
      )}

      {pending.map(card => {
        const entry = card.entry
        const badge = entry === null ? null : stateBadge(entry.status, entry.needsReview)
        const copy = actionCopy(card.request.action)
        const isBusy = busy !== null
        const draft = polish[card.request.id]
        return (
          <div className="clue-card" key={card.request.id}>
            <div className="clue-card-head">
              {badge !== null && <span className={`clue-pill clue-pill-${badge.tone}`}>{badge.label}</span>}
              <span className="clue-card-title">{entry?.title ?? '(条目已被清退)'}</span>
              <span className="clue-dim">建议动作: {copy.summary}</span>
              {entry !== null && <span className="clue-mono clue-dim">{shortId(entry.id)}</span>}
              {entry !== null && entry.provenance.createdBy === 'generalization' && (
                <span className="clue-pill clue-pill-ok">泛化提议</span>
              )}
            </div>
            {entry !== null && <div className="clue-card-text">{entry.text}</div>}
            <div className="clue-dim">
              排队原因: {card.request.reason} · 窗口分 {card.request.scoreAtRequest} · {when(card.request.createdAt)}
              {entry !== null && (
                <>
                  {' '}· 来源 {entry.provenance.createdBy}
                  {entry.provenance.session !== undefined && <> · 会话 {String(entry.provenance.session.id).slice(0, 12)}…</>}
                  {entry.bindings.length > 0 && <> · 绑定 {entry.bindings.map(binding => binding.path).join(', ')}</>}
                </>
              )}
            </div>
            {entry !== null && draft !== undefined && (
              <div className="clue-polish">
                {draft.loading === true && <div className="clue-dim">模型润色中…</div>}
                {draft.error !== undefined && <div className="clue-err">{draft.error}</div>}
                {draft.text !== undefined && (
                  <>
                    <div className="clue-dim">润色稿(可直接编辑,采纳即替换正文并留审计痕迹):</div>
                    <textarea
                      className="clue-polish-text"
                      rows={4}
                      value={draft.text}
                      onChange={event => {
                        const text = event.target.value
                        setPolish(previous => ({ ...previous, [card.request.id]: { text } }))
                      }}
                    />
                    <div className="clue-actions">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={isBusy || (draft.text ?? '').trim() === ''}
                        onClick={() => { void adoptPolish(card.request.id, entry.id, draft.text ?? '') }}
                      >
                        采纳润色稿
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isBusy}
                        onClick={() => {
                          setPolish(previous => {
                            const next = { ...previous }
                            delete next[card.request.id]
                            return next
                          })
                        }}
                      >
                        放弃
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="clue-actions">
              <Button
                size="sm"
                variant="primary"
                disabled={isBusy}
                onClick={() => { void decide(card.request.id, true) }}
              >
                {busy === card.request.id ? '处理中…' : copy.approve}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={isBusy}
                onClick={() => { void decide(card.request.id, false) }}
              >
                忽略
              </Button>
              {entry !== null && draft === undefined && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isBusy}
                  onClick={() => { void requestPolish(card.request.id, entry.id) }}
                >
                  AI 润色
                </Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
