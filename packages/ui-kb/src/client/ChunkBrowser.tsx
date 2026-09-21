/**
 * The原文/分片 browser (M9-5, proposal §8) — the panel's half of二级检索.
 *
 * Three things live here, in the order a human actually needs them:
 *
 * 1. **徽章** — "原文 N 段" (the same fact kb_search annotates, so the panel and
 *    the model read one truth);
 * 2. **分片浏览器** — the derived chunks with their `docId 行 a-b · heading`
 *    anchors and excerpts, searchable (`query` empty walks the document);
 * 3. **人权按钮** — 划除 (redline a line range with a mandatory reason) and
 *    拆分 (split into drafts, old entry → superseded). These are the ONLY
 *    paths to those acts: no tool and no route exposes them to a model, which
 *    is the 反自我豁免 red line made structural.
 *
 * @module @clue-harness/ui-kb/client/ChunkBrowser
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  kbApi, KbApiError,
  type ChunkHitPayload, type ChunkRecordPayload, type DocPayload, type DocVectorPayload,
  type EntryPayload, type KbTarget,
} from './api.ts'

/** The browser's own view of the原文层 for one entry. */
interface DocState {
  docId: string
  record: DocPayload | null
  chunks: ChunkRecordPayload[]
  hits: ChunkHitPayload[]
  needsRebuild: boolean
  /** V4: this snapshot's derived vector index (null = 未建). */
  vector: DocVectorPayload | null
}

/**
 * One chunk row: anchor line + excerpt, with redlined lines already marked by
 * the server (the ✂ prefix comes from buildExcerpt, not from the client).
 * @param props - the hit and the redline callback.
 * @returns the row.
 */
function ChunkRow({ hit, busy, onRedline }: {
  hit: ChunkHitPayload
  busy: boolean
  onRedline: (lines: [number, number]) => void
}) {
  return (
    <div className="clue-chunk">
      <div className="clue-chunk-head">
        <span className="clue-mono clue-dim">
          {hit.docId} 行 {hit.lines.start}-{hit.lines.end} · {hit.headingPath === '' ? '(无标题)' : hit.headingPath}
        </span>
        {hit.score > 0 && <span className="clue-dim"> · 相关度 {hit.score}</span>}
        {hit.partialRedline && <Pill>部分划除</Pill>}
        <span className="clue-spacer" />
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => { onRedline([hit.lines.start, hit.lines.end]) }}
        >
          划除本段
        </Button>
      </div>
      <pre className="clue-excerpt">{hit.excerpt}</pre>
      {hit.partialRedline && hit.redlines.length > 0 && (
        <div className="clue-dim">
          本段含作废内容({hit.redlines.map(redline => redline.reason).join(';')}),标 ✂ 的行已从显示与评分中移除。
        </div>
      )}
    </div>
  )
}

/**
 * The chunk browser + the two human acts for ONE entry.
 * @param props - the addressed tier, the entry and a change callback.
 * @returns the browser block.
 */
export function ChunkBrowser({ target, entry, busy, onChanged, onError }: {
  target: KbTarget
  entry: EntryPayload
  busy: boolean
  onChanged: () => void | Promise<void>
  onError: (message: string | null) => void
}) {
  const [state, setState] = useState<DocState | null>(null)
  const [query, setQuery] = useState('')
  const [reason, setReason] = useState('')
  const [splitting, setSplitting] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftText, setDraftText] = useState('')

  const docId = entry.doc?.docId ?? null

  const load = useCallback(async (text: string) => {
    if (docId === null) return
    try {
      const [doc, hits] = await Promise.all([
        kbApi.doc(target, docId),
        kbApi.chunks(target, { docId, query: text, limit: 20 }),
      ])
      setState({
        docId,
        record: doc.doc,
        chunks: doc.chunks,
        hits: hits.hits,
        needsRebuild: doc.needsRebuild,
        vector: doc.vector ?? null,
      })
    } catch (cause) {
      onError(cause instanceof KbApiError ? cause.message : String(cause))
    }
  }, [docId, target.scope, target.workspace]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setState(null)
    setQuery('')
    void load('')
  }, [docId, load])

  /** 划除: a mandatory reason, then the range (both are the human's call). */
  const redline = async (lines: [number, number]): Promise<void> => {
    if (docId === null) return
    if (reason.trim() === '') {
      onError('划除必须写明原因(它是账本的一部分)。')
      return
    }
    try {
      const result = await kbApi.redline(target, entry.id, { lines }, reason.trim())
      onError(null)
      if (result.proposal !== null) {
        window.alert(`已划除 ${(result.ratio * 100).toFixed(0)}%。\n该条目已自动入队一条审批提案:${result.proposal.reason}\n(系统提议,人执行:请用「拆分」或遗弃来处理整条。)`)
      }
      setReason('')
      await load(query)
      await onChanged()
    } catch (cause) {
      onError(cause instanceof KbApiError ? cause.message : String(cause))
    }
  }

  /** 拆分: one or more drafts; the old entry becomes superseded. */
  const split = async (): Promise<void> => {
    if (draftTitle.trim() === '' || draftText.trim() === '') {
      onError('拆分需要至少一条草稿(标题 + 正文)。')
      return
    }
    try {
      const result = await kbApi.split(target, entry.id, [{ title: draftTitle.trim(), text: draftText.trim() }], '网页人工拆分')
      onError(null)
      window.alert(`已拆分:${entry.id} → superseded(终态,永不清退)\n新候选 ${result.created.map(child => child.id).join(', ')}\n治理不继承:新条目从候选起步、信号从零开始。`)
      setSplitting(false)
      setDraftTitle('')
      setDraftText('')
      await onChanged()
    } catch (cause) {
      onError(cause instanceof KbApiError ? cause.message : String(cause))
    }
  }

  if (docId === null) {
    return (
      <div className="clue-dim">
        该知识无原文层(正文即全部)。用 <span className="clue-mono">clue kb ingest &lt;文件&gt;</span> 导入规范原文后可挂载证据锚点。
      </div>
    )
  }

  const redlines = entry.redlines ?? []
  return (
    <div className="clue-docblock">
      <div className="clue-dochead">
        <Pill>原文 {state?.chunks.length ?? '…'} 段</Pill>
        <span className="clue-mono clue-dim">{docId}</span>
        {state?.record !== null && state !== null && (
          <span className="clue-dim"> · {state.record.sourcePath} · {state.record.lineCount} 行</span>
        )}
        {state?.needsRebuild === true && <span className="clue-dim"> · 分片版本待重建</span>}
        {/* V4: the「向量 N 段」badge. It reports the DERIVED index's state, so a
            reader can tell a semantic hit from a keyword one — and a stale
            index says so instead of silently ranking by an old model. */}
        {state !== undefined && state !== null && (
          state.vector === null
            ? <Pill title="尚未建立分段向量层(检索只走词法)">向量待建</Pill>
            : state.vector.unreadable || state.vector.stale || state.vector.missing > 0
              ? <Pill title={`维度 ${state.vector.dim} · 建于 ${state.vector.builtAt}${state.vector.missing > 0 ? ` · 缺 ${state.vector.missing} 段` : ''}`}>向量 {state.vector.count} 段 ⚠</Pill>
              : <Pill title={`维度 ${state.vector.dim} · 建于 ${state.vector.builtAt}`}>向量 {state.vector.count} 段 ✓</Pill>
        )}
      </div>
      {redlines.length > 0 && (
        <div className="clue-dim">
          已划除 {redlines.length} 处:
          {redlines.map((redline, index) => (
            <div key={`${redline.at}-${index}`} className="clue-dim">
              · {redline.target === 'doc'
                ? `${redline.docId} 行 ${redline.lines?.[0]}-${redline.lines?.[1]}`
                : `正文 ${redline.chars?.[0]}-${redline.chars?.[1]}`}
              {' '}“{redline.quoteAnchor}” — {redline.reason}({redline.by})
            </div>
          ))}
        </div>
      )}
      <div className="clue-toolbar">
        <Input
          className="clue-search"
          placeholder="在原文里找一段(回车)…"
          value={query}
          onChange={event => { setQuery(event.target.value) }}
          onKeyDown={event => { if (event.key === 'Enter') void load(query) }}
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void load(query) }}>查段</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setQuery(''); void load('') }}>浏览全部</Button>
      </div>
      <Input
        placeholder="划除原因(必填,进账本)"
        value={reason}
        onChange={event => { setReason(event.target.value) }}
      />
      {state === null && <div className="clue-empty">加载分片…</div>}
      {state !== null && state.hits.length === 0 && <div className="clue-empty">没有命中的段。</div>}
      {state?.hits.map(hit => (
        <ChunkRow key={`${hit.docId}-${hit.seq}`} hit={hit} busy={busy} onRedline={lines => { void redline(lines) }} />
      ))}
      <div className="clue-actions">
        {!splitting && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { setSplitting(true) }}>
            拆分该条目(superseded)
          </Button>
        )}
        {splitting && (
          <div style={{ display: 'grid', gap: 6, width: '100%' }}>
            <div className="clue-dim">拆分 = 原条目转 superseded(终态),新条目从候选起步;证据可继承,信号/审批/划除不继承。</div>
            <Input placeholder="新条目标题" value={draftTitle} onChange={event => { setDraftTitle(event.target.value) }} />
            <Input placeholder="新条目正文" value={draftText} onChange={event => { setDraftText(event.target.value) }} />
            <div className="clue-actions">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => { void split() }}>确认拆分</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setSplitting(false) }}>取消</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
