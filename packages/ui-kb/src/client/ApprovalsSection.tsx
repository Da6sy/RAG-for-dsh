/**
 * The approval workbench (design §6.1 — the highest-priority page, and since
 * 2026-09-15 a real workbench rather than a queue viewer).
 *
 * Why it grew: the queue only ever holds EVIDENCE-driven proposals
 * (`suggestPromotions` needs `windowScore ≥ trustThreshold`, redline-review
 * needs a >40% redline), so a library whose entries were never cited shows an
 * empty queue forever while 20+ candidates sit undecided — the page looked
 * "unused" because it WAS unused, not because there was nothing to decide.
 * The human's own judgment therefore gets first-class buckets here, next to
 * the queue:
 *
 * | 桶 | 内容 | 行内动作(全部是人权入口,模型无路径) |
 * |---|---|---|
 * | 待批 | 队列请求(证据驱动) | 批准/忽略 + AI 润色 |
 * | ⚑待复核 | needsReview 标记 | 复核通过(重绑当前内容) / 不再成立(转过期,需理由) |
 * | 候选待提升 | status=candidate | 提升为可信 / 不再成立(转过期,需理由) |
 * | 已退出 | expired / discarded | 重新激活 / 捞回候选 |
 *
 * Discipline kept from the queue days: batched, never popups; each decision is
 * its own audited route call (a mid-batch failure leaves earlier decisions
 * committed); bulk verbs exist ONLY for the queue (「全批准」ing 23 candidates
 * would be a rubber stamp, not a decision). Verdicts that need a why open an
 * inline draft instead of firing on the first click.
 *
 * Data discipline: local state only (fetch on mount/action) — nothing shared
 * across entries, so no store is declared (slot rule 5).
 *
 * @module @clue-harness/ui-kb/client/ApprovalsSection
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  describeKbError, kbApi,
  type ApprovalCard, type EntryPayload, type KbTarget,
} from './api.ts'
import { actionCopy, shortId, stateBadge } from './parse.ts'
import { GLOBAL_VALUE, targetOf, WorkspacePicker } from './WorkspacePicker.tsx'

/** The four decision buckets of the workbench. */
type Bucket = 'queue' | 'review' | 'candidate' | 'retired'

/** The inline draft form (one open at a time — a decision, not a form page). */
interface Draft {
  id: string
  kind: 'promote' | 'retire'
  reason: string
}

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
 * @returns the approval workbench.
 */
export function ApprovalsSection() {
  // The addressed library: a workspace key, or the global tier. Initialised to
  // the global tier and immediately re-pointed by the picker at the workspace
  // this surface was launched in (M9: the roster is the source of truth).
  const [address, setAddress] = useState<string>(GLOBAL_VALUE)
  const target: KbTarget = targetOf(address)
  const [bucket, setBucket] = useState<Bucket>('queue')
  const [cards, setCards] = useState<ApprovalCard[]>([])
  const [review, setReview] = useState<EntryPayload[]>([])
  const [candidates, setCandidates] = useState<EntryPayload[]>([])
  const [expired, setExpired] = useState<EntryPayload[]>([])
  const [discarded, setDiscarded] = useState<EntryPayload[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  // M6 AI polish (M5 review decision): per-request rewrite drafts. The route
  // RETURNS text and writes nothing; adoption is an explicit second call —
  // the human stays the approver, the model stays the typist.
  const [polish, setPolish] = useState<Record<string, { loading?: boolean; text?: string; error?: string }>>({})

  const load = useCallback(async (where: KbTarget) => {
    setLoading(true)
    setError(null)
    try {
      // One round trip per bucket, in parallel: the page's whole job is to
      // answer "what needs me right now" for the addressed library.
      const [queue, flagged, pending, retired, dead] = await Promise.all([
        kbApi.approvals(where),
        kbApi.entries({ ...where, needsReview: true }),
        kbApi.entries({ ...where, status: 'candidate' }),
        kbApi.entries({ ...where, status: 'expired' }),
        kbApi.entries({ ...where, status: 'discarded' }),
      ])
      setCards(queue.approvals)
      setReview((flagged as { entries: EntryPayload[] }).entries)
      setCandidates((pending as { entries: EntryPayload[] }).entries)
      setExpired((retired as { entries: EntryPayload[] }).entries)
      setDiscarded((dead as { entries: EntryPayload[] }).entries)
    } catch (cause) {
      setCards([])
      setReview([])
      setCandidates([])
      setExpired([])
      setDiscarded([])
      setError(describeKbError(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(target) }, [address, load])

  /**
   * Run one decision, then refresh every bucket (an act moves an entry between
   * buckets, so a partial refresh would leave a stale count on screen).
   * @param key - the row being acted on (drives the busy state).
   * @param run - the route call.
   */
  const act = async (key: string, run: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      await run()
      setDraft(null)
      await load(target)
    } catch (cause) {
      setError(describeKbError(cause))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Resolve one queued request, then refresh the queue.
   * @param requestId - the queued request.
   * @param approved - the decision.
   */
  const decide = async (requestId: string, approved: boolean): Promise<void> => {
    setBusy(requestId)
    setError(null)
    try {
      await kbApi.resolve(target, requestId, approved)
      await load(target)
    } catch (cause) {
      setError(describeKbError(cause))
    } finally {
      setBusy(null)
    }
  }

  /** Walk the whole pending queue with one decision (sequential, audited). */
  const decideAll = async (approved: boolean): Promise<void> => {
    const queue = cards
    setBusy('*')
    setError(null)
    for (const card of queue) {
      try {
        await kbApi.resolve(target, card.request.id, approved)
      } catch (cause) {
        // A mid-batch failure is reported, earlier decisions stay committed.
        setError(`批量处理在 ${card.request.id} 中断: ${describeKbError(cause)}`)
        break
      }
    }
    setBusy(null)
    await load(target)
  }

  /**
   * Request the one-shot AI rewrite of one card's entry body.
   * @param requestId - the card being polished.
   * @param entryId - the entry to rewrite.
   */
  const requestPolish = async (requestId: string, entryId: string): Promise<void> => {
    setPolish((previous) => ({ ...previous, [requestId]: { loading: true } }))
    try {
      const result = await kbApi.polish(target, entryId)
      setPolish((previous) => ({ ...previous, [requestId]: { text: result.polished } }))
    } catch (cause) {
      setPolish((previous) => ({ ...previous, [requestId]: { error: describeKbError(cause) } }))
    }
  }

  /**
   * Adopt the (possibly hand-edited) polished draft as the entry's body.
   * @param requestId - the card being updated.
   * @param entryId - the entry to rewrite.
   * @param text - the adopted body text.
   */
  const adoptPolish = async (requestId: string, entryId: string, text: string): Promise<void> => {
    await act(requestId, () => kbApi.updateText(target, entryId, text, '审批中心采纳 AI 润色稿'))
    setPolish((previous) => {
      const next = { ...previous }
      delete next[requestId]
      return next
    })
  }

  const queueCount = cards.length
  const reviewCount = review.length
  const candidateCount = candidates.length
  const retiredCount = expired.length + discarded.length
  const actionable = queueCount + reviewCount + candidateCount

  const tabs: Array<{ id: Bucket; label: string }> = [
    { id: 'queue', label: `待批请求 ${queueCount}` },
    { id: 'review', label: `⚑待复核 ${reviewCount}` },
    { id: 'candidate', label: `候选待提升 ${candidateCount}` },
    { id: 'retired', label: `已退出 ${retiredCount}` },
  ]

  /**
   * The inline reason form — the second half of a consequential verdict.
   * @param reasonRequired - whether an empty reason blocks the confirm.
   * @param confirm - the confirm button label.
   * @param onConfirm - the act to run with the typed reason.
   * @returns the form row.
   */
  const draftForm = (reasonRequired: boolean, confirm: string, onConfirm: (reason: string) => void) => (
    <div className="clue-inline-form" style={{ marginTop: 8 }}>
      <Input
        className="clue-search"
        placeholder={reasonRequired ? '为什么判定不再成立(必填,记入履历)…' : '为什么提升为可信(可选,记入履历)…'}
        value={draft?.reason ?? ''}
        onChange={(event) => {
          const reason = event.target.value
          setDraft((previous) => (previous === null ? previous : { ...previous, reason }))
        }}
      />
      <Button
        size="sm"
        variant="primary"
        disabled={busy !== null || (reasonRequired && (draft?.reason ?? '').trim() === '')}
        onClick={() => { onConfirm(draft?.reason ?? '') }}
      >
        {confirm}
      </Button>
      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { setDraft(null) }}>
        取消
      </Button>
    </div>
  )

  return (
    <div className="clue-sec">
      <div className="clue-heading">
        <div>
          <h2 className="clue-sec-title">知识审批中心</h2>
          <p className="clue-sec-intro">
            一个库里的全部待决之事:证据攒出来的提案、挂 ⚑ 的漂移、你自己确信的候选,以及退出现役但可复归的条目。
            <span className="clue-dim"> · {loading ? '载入中' : `${actionable} 项待处理`}</span>
          </p>
        </div>
      </div>
      <WorkspacePicker value={address} onChange={setAddress} stats />
      <div className="clue-toolbar">
        {tabs.map(tab => (
          <Button
            key={tab.id}
            size="sm"
            variant={bucket === tab.id ? 'primary' : 'ghost'}
            onClick={() => { setBucket(tab.id); setDraft(null) }}
          >
            {tab.label}
          </Button>
        ))}
        <span className="clue-spacer" />
        <Button size="sm" variant="ghost" disabled={loading || busy !== null} onClick={() => { void load(target) }}>
          刷新
        </Button>
        {bucket === 'queue' && (
          <>
            <Button size="sm" variant="primary" disabled={queueCount === 0 || busy !== null} onClick={() => { void decideAll(true) }}>
              全批准
            </Button>
            <Button size="sm" variant="outline" disabled={queueCount === 0 || busy !== null} onClick={() => { void decideAll(false) }}>
              全忽略
            </Button>
          </>
        )}
      </div>

      {error !== null && <div className="clue-err">{error}</div>}

      {/* ── 待批: the evidence-driven queue (semantics unchanged) ─────────── */}
      {bucket === 'queue' && (
        <>
          {!loading && queueCount === 0 && error === null && (
            <div className="clue-empty">
              没有待批的知识提案:队列只收"窗口分达标"的系统提议。
              <div className="clue-dim">
                其余待决之事在另外三个桶里——要提升的候选看「候选待提升」,挂 ⚑ 的看「待复核」。
                模型只能提案(kb_propose),提升/遗弃/捞回都攒批到这里等你决定。
              </div>
            </div>
          )}
          {cards.map(card => {
            const entry = card.entry
            const badge = entry === null ? null : stateBadge(entry.status, entry.needsReview)
            const copy = actionCopy(card.request.action)
            const isBusy = busy !== null
            const handled = polish[card.request.id]
            return (
              <div className="clue-card" key={card.request.id}>
                <div className="clue-card-head">
                  {badge !== null && <Pill>{badge.label}</Pill>}
                  <span className="clue-card-title">{entry?.title ?? '(条目已被清退)'}</span>
                  <span className="clue-dim">建议动作: {copy.summary}</span>
                  {entry !== null && <span className="clue-mono clue-dim">{shortId(entry.id)}</span>}
                  {entry !== null && entry.provenance.createdBy === 'generalization' && (
                    <Pill>泛化提议</Pill>
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
                {entry !== null && handled !== undefined && (
                  <div className="clue-polish">
                    {handled.loading === true && <div className="clue-dim">模型润色中…</div>}
                    {handled.error !== undefined && <div className="clue-err">{handled.error}</div>}
                    {handled.text !== undefined && (
                      <>
                        <div className="clue-dim">润色稿(可直接编辑,采纳即替换正文并留审计痕迹):</div>
                        <textarea
                          className="clue-polish-text"
                          rows={4}
                          value={handled.text}
                          onChange={event => {
                            const text = event.target.value
                            setPolish(previous => ({ ...previous, [card.request.id]: { text } }))
                          }}
                        />
                        <div className="clue-actions">
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={isBusy || (handled.text ?? '').trim() === ''}
                            onClick={() => { void adoptPolish(card.request.id, entry.id, handled.text ?? '') }}
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
                  {entry !== null && handled === undefined && (
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
        </>
      )}

      {/* ── ⚑待复核: the drift flag, resolved by a human ─────────────────── */}
      {bucket === 'review' && (
        <>
          {!loading && reviewCount === 0 && error === null && (
            <div className="clue-empty">没有挂着 ⚑待复核 的条目(绑定文件与原文快照都和记录一致)。</div>
          )}
          {review.map(entry => {
            const badge = stateBadge(entry.status, entry.needsReview)
            return (
              <div className="clue-card" key={entry.id}>
                <div className="clue-card-head">
                  <Pill>{badge.label}</Pill>
                  <span className="clue-card-title">{entry.title}</span>
                  <span className="clue-mono clue-dim">{shortId(entry.id)}</span>
                  <span className="clue-dim">{entry.kind}</span>
                </div>
                <div className="clue-card-text">{entry.text}</div>
                <div className="clue-dim">
                  标记原因: {entry.reviewReason ?? '(未说明)'}
                  {' '}· 引用 {entry.stats.referenceCount} 次
                  {entry.bindings.length > 0 && <> · 绑定 {entry.bindings.map(binding => binding.path).join(', ')}</>}
                </div>
                <div className="clue-actions">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy !== null}
                    onClick={() => { void act(entry.id, () => kbApi.reverify(target, entry.id, true)) }}
                  >
                    {busy === entry.id ? '处理中…' : '复核通过(重绑当前内容)'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => { setDraft({ id: entry.id, kind: 'retire', reason: '' }) }}
                  >
                    不再成立…
                  </Button>
                </div>
                {draft?.id === entry.id && draft.kind === 'retire'
                  && draftForm(true, '确认转入过期', reason => { void act(entry.id, () => kbApi.retire(target, entry.id, reason)) })}
              </div>
            )
          })}
        </>
      )}

      {/* ── 候选待提升: the human's own judgment (no score gate) ─────────── */}
      {bucket === 'candidate' && (
        <>
          {!loading && candidateCount === 0 && error === null && (
            <div className="clue-empty">没有候选条目(候选是知识的起点:模型提案与你手写入库的条目都从这里开始)。</div>
          )}
          {candidates.map(entry => {
            const badge = stateBadge(entry.status, entry.needsReview)
            return (
              <div className="clue-card" key={entry.id}>
                <div className="clue-card-head">
                  <Pill>{badge.label}</Pill>
                  <span className="clue-card-title">{entry.title}</span>
                  <span className="clue-mono clue-dim">{shortId(entry.id)}</span>
                  <span className="clue-dim">{entry.kind}</span>
                  {entry.doc !== undefined && <Pill>原文层</Pill>}
                </div>
                <div className="clue-card-text">{entry.text}</div>
                <div className="clue-dim">
                  来源 {entry.provenance.createdBy} · {when(entry.provenance.createdAt)}
                  {' '}· 引用 {entry.stats.referenceCount} 次
                  {entry.bindings.length > 0 && <> · 绑定 {entry.bindings.map(binding => binding.path).join(', ')}</>}
                </div>
                <div className="clue-actions">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy !== null}
                    onClick={() => { setDraft({ id: entry.id, kind: 'promote', reason: '' }) }}
                  >
                    提升为可信
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => { setDraft({ id: entry.id, kind: 'retire', reason: '' }) }}
                  >
                    不再成立…
                  </Button>
                </div>
                {draft?.id === entry.id && draft.kind === 'promote'
                  && draftForm(false, '确认提升', reason => { void act(entry.id, () => kbApi.promote(target, entry.id, reason)) })}
                {draft?.id === entry.id && draft.kind === 'retire'
                  && draftForm(true, '确认转入过期', reason => { void act(entry.id, () => kbApi.retire(target, entry.id, reason)) })}
              </div>
            )
          })}
        </>
      )}

      {/* ── 已退出: expired / discarded, both recoverable by a human ─────── */}
      {bucket === 'retired' && (
        <>
          {!loading && retiredCount === 0 && error === null && (
            <div className="clue-empty">没有过期或遗弃的条目。</div>
          )}
          {expired.map(entry => (
            <div className="clue-card" key={entry.id}>
              <div className="clue-card-head">
                <Pill>过期</Pill>
                <span className="clue-card-title">{entry.title}</span>
                <span className="clue-mono clue-dim">{shortId(entry.id)}</span>
                <span className="clue-dim">{entry.kind}</span>
              </div>
              <div className="clue-card-text">{entry.text}</div>
              <div className="clue-dim">
                最后一条履历: {entry.history.slice(-1)[0]?.reason ?? '(未记)'} · 引用 {entry.stats.referenceCount} 次
              </div>
              <div className="clue-actions">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy !== null}
                  onClick={() => { void act(entry.id, () => kbApi.reactivate(target, entry.id, '审批中心人工重新激活')) }}
                >
                  {busy === entry.id ? '处理中…' : '重新激活(回到候选)'}
                </Button>
              </div>
            </div>
          ))}
          {discarded.map(entry => (
            <div className="clue-card" key={entry.id}>
              <div className="clue-card-head">
                <Pill>遗弃</Pill>
                <span className="clue-card-title">{entry.title}</span>
                <span className="clue-mono clue-dim">{shortId(entry.id)}</span>
                <span className="clue-dim">{entry.kind}</span>
              </div>
              <div className="clue-card-text">{entry.text}</div>
              <div className="clue-dim">
                最后一条履历: {entry.history.slice(-1)[0]?.reason ?? '(未记)'}
                {entry.discardedAt !== null && <> · {when(entry.discardedAt)}</>}
                {' '}· 60 天后清退(捞回即保住)
              </div>
              <div className="clue-actions">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy !== null}
                  onClick={() => { void act(entry.id, () => kbApi.rescue(target, entry.id, '审批中心人工捞回')) }}
                >
                  {busy === entry.id ? '处理中…' : '捞回候选'}
                </Button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
