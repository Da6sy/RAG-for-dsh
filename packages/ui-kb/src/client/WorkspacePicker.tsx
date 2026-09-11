/**
 * The workspace picker (M9.1: the host's workspace list IS the roster).
 *
 * What changed from the first M9 cut, and why: ClueHarness used to keep its own
 * list of workspaces, seeded from every directory its CLI had touched. The
 * panel therefore showed directories the sidebar had never offered, and a
 * workspace deleted in the sidebar kept a row forever. The user's own words:
 * 「设置当中查看的知识库同样与侧边栏显示的工作区绑定，若工作区被删除，设置当中
 * 也将对应条目去除」— so visibility now belongs to the host registry, and this
 * component only renders what that registry says.
 *
 * Three behaviours live here:
 * 1. a themed dropdown (MenuSelect, not a native select) listing the live
 *    workspaces plus the 全局库 pseudo-row, with the central library path as a
 *    second line so "where does this live" is always answerable;
 * 2. the ORPHAN QUESTION: when the registry dropped a workspace, ask whether to
 *    delete its knowledge base too — 一并删除 routes through
 *    `RiskConfirmation` (a deliberate acknowledgement) into
 *    `~/.clue/trash/<stamp>/<key>/`; 保留 just stops asking;
 * 3. first-load adoption: the panel opens on the workspace the surface was
 *    launched in, never on an empty global queue.
 *
 * Manual add/rename/remove are gone from the panel on purpose: they would be a
 * second list. `clue kb workspace add` still exists for scripting, and its rows
 * stay visible there — they just no longer masquerade as sidebar workspaces.
 *
 * @module @clue-harness/ui-kb/client/WorkspacePicker
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives'
import { kbApi, KbApiError, pickInitialWorkspace, type KbScope, type KbTarget, type WorkspacePayload } from './api.ts'
import { MenuSelect } from './MenuSelect.tsx'

/** The special roster value meaning "the global tier" (no workspace addressed). */
export const GLOBAL_VALUE = 'global'

/**
 * Turn a picker selection into the address every API call takes.
 * @param value - `global` or a workspace key.
 * @returns the KbTarget for that selection.
 */
export function targetOf(value: string): KbTarget {
  return value === GLOBAL_VALUE ? { scope: 'global' } : { scope: 'project', workspace: value }
}

/**
 * The workspace dropdown plus the orphan question.
 * @param props.value - current selection (`global` or a workspace key).
 * @param props.onChange - called with the new selection.
 * @param props.scopeHint - when 'project', the 全局库 row is not offered.
 * @param props.stats - ask the host for per-workspace counts (the panel does).
 * @returns the picker UI.
 */
export function WorkspacePicker(props: {
  value: string
  onChange: (value: string) => void
  scopeHint?: KbScope
  stats?: boolean
}) {
  const { value, onChange, scopeHint, stats } = props
  const [rows, setRows] = useState<WorkspacePayload[]>([])
  const [orphans, setOrphans] = useState<WorkspacePayload[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmPurge, setConfirmPurge] = useState<WorkspacePayload | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // The selection starts on the global tier ONLY until the first roster read
  // has adopted the launched workspace: before that it is not a user choice.
  const adopted = useRef(false)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const payload = await kbApi.workspaces(stats === true)
      setRows(payload.workspaces)
      setOrphans(payload.orphans ?? [])
      if (!adopted.current) {
        adopted.current = true
        const key = pickInitialWorkspace(payload.workspaces, payload.defaultRoot)
        if (key !== null && key !== value) onChange(key)
      } else if (value !== GLOBAL_VALUE && !payload.workspaces.some((row) => row.key === value)) {
        // The addressed workspace is gone (removed in the sidebar, or answered
        // "delete it"): fall back rather than stare at a dead address.
        onChange(pickInitialWorkspace(payload.workspaces, payload.defaultRoot) ?? GLOBAL_VALUE)
      }
    } catch (cause) {
      setError(cause instanceof KbApiError ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [onChange, stats, value])

  useEffect(() => { void load() }, [load])

  /** Answer "delete it": the whole workspace state goes to the trash. */
  const doPurge = async (record: WorkspacePayload): Promise<void> => {
    setBusy(true)
    setError(null)
    setConfirmPurge(null)
    setAcknowledged(false)
    try {
      const result = await kbApi.purgeWorkspace(record.key)
      setNotice(`已清退「${record.hostTitle ?? record.label}」的知识库与基准 → ${result.trashRoot}（回收目录，可手工移回）`)
      await load()
    } catch (cause) {
      setError(cause instanceof KbApiError ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  /** Answer "keep it": stop asking, touch nothing. */
  const doKeep = async (record: WorkspacePayload): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await kbApi.keepWorkspace(record.key)
      setNotice(`已保留「${record.hostTitle ?? record.label}」的知识库（不再询问；把工作区加回侧边栏即恢复显示）`)
      await load()
    } catch (cause) {
      setError(cause instanceof KbApiError ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const current = rows.find((row) => row.key === value)
  const options = [
    ...(scopeHint === 'project' ? [] : [{ id: GLOBAL_VALUE, label: '全局库（跨项目）', hint: '~/.clue/kb/_global' }]),
    ...rows.map((row) => ({
      id: row.key,
      label: row.hostTitle ?? row.label,
      hint: `~/.clue/kb/${row.key}`,
    })),
  ]
  const counts = (row: WorkspacePayload): string => row.status == null
    ? ''
    : ` · ${String(row.status.total)} 条知识 · ${String(row.status.pendingApprovals)} 待批`

  return (
    <div className="clue-workspace-bar">
      <span className="clue-field-label">工作区</span>
      <MenuSelect
        value={value}
        options={options}
        ariaLabel="选择要查看的工作区知识库"
        placeholder={busy ? '读取工作区名单…' : '（侧边栏还没有工作区）'}
        onChange={onChange}
        portal
      />
      <span className="clue-dim">
        {current !== undefined
          ? `${current.root}${counts(current)} · 最近可见 ${current.lastSeenAt.slice(0, 10)}`
          : value === GLOBAL_VALUE
            ? '全局知识库，不属于任何单个工作区'
            : '—'}
      </span>
      <span className="clue-spacer" />
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void load() }}>刷新</Button>

      {notice !== null && <div className="clue-notice">{notice}</div>}
      {error !== null && <div className="clue-err">{error}</div>}

      {orphans.map((orphan) => (
        <div className="clue-orphan" key={orphan.key}>
          <span className="clue-pill clue-pill-warn">工作区已移除</span>
          <span>
            侧边栏里已没有「{orphan.hostTitle ?? orphan.label}」。它的知识库仍在
            {' '}<code>~/.clue/kb/{orphan.key}</code>，要一并删除吗？
          </span>
          <span className="clue-spacer" />
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void doKeep(orphan) }}>
            保留知识库
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => { setConfirmPurge(orphan); setAcknowledged(false) }}
          >
            一并删除…
          </Button>
        </div>
      ))}

      <RiskConfirmation
        open={confirmPurge !== null}
        title={`删除「${confirmPurge !== null ? confirmPurge.hostTitle ?? confirmPurge.label : ''}」的知识库？`}
        description="该工作区的知识条目、信号账本、审批队列与渲染基准会整体移入 ~/.clue/trash/<时间戳>/<键>。回收目录里的内容可以手工移回，但界面上不再有恢复入口。"
        acknowledgeLabel="我确认这些数据无需保留"
        cancelLabel="取消"
        confirmLabel="移入回收目录"
        acknowledged={acknowledged}
        disabled={busy}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setConfirmPurge(null); setAcknowledged(false) }}
        onConfirm={() => { if (confirmPurge !== null) void doPurge(confirmPurge) }}
      />
    </div>
  )
}
