/**
 * The conversation-side knowledge drawer (M9.1).
 *
 * Design §6 put the approval center and the KB browser in settings, but the
 * moment a model cites a pitfall you cannot see, the useful question is
 * "which library is THIS conversation working from?" — a settings page is the
 * wrong place to answer it. So the conversation itself gets one button in the
 * session header (the additive `conversation.session.header.actions` seat,
 * which is why it does not disturb dsh's own title/tabs) opening a right-side
 * drawer scoped to the current session's workspace:
 *
 * - the workspace is resolved HOST-side (`/workspace-for-session?sessionId=`),
 *   i.e. from the registry's own session accounting — the client never guesses
 *   a workspace from a path string;
 * - two tabs: 知识 (browse, with the lifecycle/⚑ pills and the tier annotation)
 *   and 待批 (the batched queue, approvable IN PLACE — each decision is the same
 *   audited route call the settings page makes, so there is no weaker second
 *   implementation of approval);
 * - the button carries the pending count, so "there is something to look at"
 *   is visible without opening anything.
 *
 * It is a drawer, not a modal: reading your own knowledge base should not
 * block the conversation you are reading it about.
 *
 * @module @clue-harness/ui-kb/client/SessionKbDrawer
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { kbApi, KbApiError, type ApprovalCard, type EntryPayload, type WorkspacePayload } from './api.ts'
import { actionCopy, shortId, stateBadge } from './parse.ts'

/** The drawer's two views. */
type Tab = 'knowledge' | 'approvals'

/**
 * Format an ISO instant for a compact row.
 * @param iso - the timestamp.
 * @returns a short local date (or the raw text on a parse miss).
 */
function day(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

/**
 * The session-header button that opens the drawer (one seat occupant, so the
 * header's own layout is untouched).
 * @param props - the framework's session kit (`sessionId` is what we need).
 * @returns the header action.
 */
export function SessionKbAction(props: { sessionId?: string }): React.ReactNode {
  const sessionId = props.sessionId
  const [open, setOpen] = useState(false)
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (sessionId === undefined) return
    try {
      const addressed = await kbApi.workspaceForSession(sessionId)
      setWorkspace(addressed.record)
      const target = { scope: 'project' as const, workspace: addressed.record?.key ?? null }
      const queue = await kbApi.approvals(target)
      setPending(queue.approvals.length)
    } catch (cause) {
      // An unreachable host face degrades the button, never the conversation.
      setError(cause instanceof KbApiError ? cause.message : String(cause))
      setPending(null)
    }
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh, open])

  // No session, no seat: the drawer is meaningless outside a conversation.
  if (sessionId === undefined) return null
  const label = workspace !== null ? workspace.hostTitle ?? workspace.label : '知识库'
  return (
    <>
      <Button
        size="sm"
        variant={open ? 'primary' : 'ghost'}
        aria-label={`打开本会话工作区「${label}」的知识库与审批`}
        onClick={() => { setOpen((previous) => !previous) }}
      >
        <span className="clue-kbbtn-mark" aria-hidden>◆</span>
        <span className="clue-kbbtn-text">知识库</span>
        {pending !== null && pending > 0 && <span className="clue-kbbtn-count">{String(pending)}</span>}
      </Button>
      {open && (
        <KbDrawer
          sessionId={sessionId}
          workspace={workspace}
          error={error}
          onClose={() => { setOpen(false) }}
          onDecided={() => { void refresh() }}
        />
      )}
    </>
  )
}

/**
 * The drawer body: this workspace's knowledge and its pending queue.
 * @param props.sessionId - the conversation whose workspace is shown.
 * @param props.workspace - the resolved workspace row (null = unresolved).
 * @param props.error - a resolution failure to surface inline.
 * @param props.onClose - dismiss the drawer.
 * @param props.onDecided - called after an approval decision (refresh counts).
 * @returns the drawer panel.
 */
export function KbDrawer(props: {
  sessionId: string
  workspace: WorkspacePayload | null
  error: string | null
  onClose: () => void
  onDecided: () => void
}) {
  const { workspace, error, onClose, onDecided } = props
  const [tab, setTab] = useState<Tab>('knowledge')
  const [entries, setEntries] = useState<EntryPayload[] | null>(null)
  const [cards, setCards] = useState<ApprovalCard[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const target = useMemo(() => ({ scope: 'project' as const, workspace: workspace?.key ?? null }), [workspace])

  const load = useCallback(async (): Promise<void> => {
    setNote(null)
    try {
      const listed = await kbApi.entries({ ...target, limit: 100 })
      setEntries((listed.entries as EntryPayload[]) ?? [])
      const queue = await kbApi.approvals(target)
      setCards(queue.approvals)
    } catch (cause) {
      setNote(cause instanceof KbApiError ? cause.message : String(cause))
      setEntries(null)
      setCards(null)
    }
  }, [target])

  useEffect(() => { void load() }, [load])

  // Escape dismisses; an outside pointer does NOT (a drawer you can lose by
  // accident while reading a citation is a worse product than a modal).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  /** Decide one queued request in place (the same audited route as settings). */
  const decide = async (requestId: string, approved: boolean): Promise<void> => {
    setBusy(requestId)
    setNote(null)
    try {
      await kbApi.resolve(target, requestId, approved)
      await load()
      onDecided()
    } catch (cause) {
      setNote(cause instanceof KbApiError ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="clue-drawer-scrim" role="presentation">
      <aside
        className="clue-drawer"
        ref={panelRef}
        role="complementary"
        aria-label={`工作区 ${workspace?.hostTitle ?? workspace?.label ?? '知识库'}`}
      >
        <header className="clue-drawer-head">
          <div className="clue-drawer-title">
            <span className="clue-dim">本会话的工作区</span>
            <h3>{workspace !== null ? workspace.hostTitle ?? workspace.label : '正在定位本会话的工作区…'}</h3>
            <code>{workspace !== null ? `~/.clue/kb/${workspace.key}` : '尚未确定'}</code>
          </div>
          <Button size="sm" variant="ghost" aria-label="关闭知识库抽屉" onClick={onClose}>✕</Button>
        </header>

        <nav className="clue-drawer-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'knowledge'} className={tab === 'knowledge' ? 'clue-tab-on' : ''} onClick={() => { setTab('knowledge') }}>
            知识 {entries !== null ? `(${String(entries.length)})` : ''}
          </button>
          <button role="tab" aria-selected={tab === 'approvals'} className={tab === 'approvals' ? 'clue-tab-on' : ''} onClick={() => { setTab('approvals') }}>
            待批 {cards !== null ? `(${String(cards.length)})` : ''}
          </button>
          <span className="clue-spacer" />
          <Button size="sm" variant="ghost" onClick={() => { void load() }}>刷新</Button>
        </nav>

        {(error !== null || note !== null) && <div className="clue-err">{error ?? note}</div>}
        {workspace === null && tab === 'knowledge' && (
          <div className="clue-dim">还没有为这个会话所在目录建立知识库（空库也是库:第一条提案进来就会创建）。</div>
        )}

        {tab === 'knowledge' && (
          <div className="clue-drawer-body">
            {entries === null
              ? <div className="clue-dim">读取中…</div>
              : entries.length === 0
                ? <div className="clue-empty">这个工作区还没有知识。模型学到东西时会用 kb_propose 提案,入库即候选。</div>
                : entries.map((entry) => {
                  const badge = stateBadge(entry.status, entry.needsReview)
                  return (
                    <article className="clue-drow" key={entry.id}>
                      <div className="clue-drow-head">
                        <Pill>{badge.label}</Pill>
                        <span className="clue-card-title">{entry.title}</span>
                        <span className="clue-mono clue-dim">{shortId(entry.id)}</span>
                      </div>
                      <div className="clue-drow-text">{entry.text}</div>
                      <div className="clue-dim">
                        {entry.kind} · {entry.provenance.createdBy} · {day(entry.provenance.createdAt)}
                        {entry.stats.referenceCount > 0 && ` · 被引用 ${String(entry.stats.referenceCount)} 次`}
                        {entry.needsReview && entry.reviewReason !== null && ` · ⚑ ${entry.reviewReason}`}
                      </div>
                    </article>
                  )
                })}
          </div>
        )}

        {tab === 'approvals' && (
          <div className="clue-drawer-body">
            {cards === null
              ? <div className="clue-dim">读取中…</div>
              : cards.length === 0
                ? <div className="clue-empty">没有待批提案。要清得完整一些,可以去 设置 → 知识库审批。</div>
                : cards.map((card) => {
                  const badge = card.entry === null ? null : stateBadge(card.entry.status, card.entry.needsReview)
                  const copy = actionCopy(card.request.action)
                  return (
                    <article className="clue-drow" key={card.request.id}>
                      <div className="clue-drow-head">
                        {badge !== null && <Pill>{badge.label}</Pill>}
                        <Pill>{copy.summary}</Pill>
                        <span className="clue-card-title">{card.entry?.title ?? '(条目已清退)'}</span>
                      </div>
                      {card.entry !== null && <div className="clue-drow-text">{card.entry.text}</div>}
                      <div className="clue-dim">分数 {String(card.request.scoreAtRequest)} · {card.request.reason}</div>
                      <div className="clue-actions">
                        <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => { void decide(card.request.id, true) }}>
                          {busy === card.request.id ? '处理中…' : copy.approve}
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void decide(card.request.id, false) }}>
                          忽略
                        </Button>
                      </div>
                    </article>
                  )
                })}
          </div>
        )}

        <footer className="clue-drawer-foot">
          <span className="clue-dim">审批与提案都写入同一本账(条目历史 + signals.jsonl),这里没有第二套实现。</span>
        </footer>
      </aside>
    </div>
  )
}
