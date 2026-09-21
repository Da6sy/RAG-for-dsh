/**
 * Citation cards: the keyed `tool.call.toolview` occupants for `kb_search`
 * and `kb_propose`. A registered key REPLACES the generic tool row, so each
 * card renders its own complete row chrome — head (icon, title, summary,
 * state), and the expansion body (the hits / the proposal receipt).
 *
 * What the model saw is what the user sees: the card parses the SAME
 * structured outputs (SEARCH_OUTPUT / PROPOSE_OUTPUT) the tool returned,
 * shows every hit's id/title with its lifecycle badge, and — per the
 * retrieval contract — the annotations verbatim (expired / needs-review
 * knowledge must be visibly flagged wherever it surfaces, decision #21's
 * presentation half).
 *
 * @module @clue-harness/ui-kb/client/CitationCards
 */
import { useState } from 'react'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { IconCheckOutline14, IconLoadingOutline16, IconPlusOutline16, IconSearchOutline16, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  actionCopy, parseArgs, parseKbCiteResult, parseKbProposeResult, parseKbSearchResult,
  shortId, stateBadge, type TextishBlock,
} from './parse.ts'

/** The owner share these views consume (a subset of ToolCallViewProps). */
export interface KbViewProps {
  /** Wire tool name (keyed dispatch value). */
  toolName: string
  /** The frozen running call or settled result node. */
  block: ToolCallBlock
}

/**
 * Pull the call args text off either block form.
 * @param block - running call (args direct) or settled node (args on .call).
 * @returns the raw args JSON text ('' when the window lost the call head).
 */
function argsOf(block: ToolCallBlock): string {
  return ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
}

/**
 * One label chip from a derived badge.
 *
 * Renders dsh's own `Pill` so the conversation-side cards and the settings
 * pages share exactly one chip look (the `tone` argument is kept for the call
 * sites' vocabulary; dsh's Pill has a single visual family).
 */
function Chip({ label }: { label: string; tone?: string }) {
  return <Pill>{label}</Pill>
}

/**
 * The kb_search citation card.
 * @param props - the call identity and frozen block.
 * @returns the search row with its hit cards.
 */
export function KbSearchCard({ block }: KbViewProps) {
  const [open, setOpen] = useState(true)
  const running = !('kind' in block)
  const args = parseArgs(argsOf(block))
  const query = typeof args?.query === 'string' ? args.query : ''
  if (running) {
    return (
      <div className="clue-cite">
        <div className="clue-cite-head">
          <IconLoadingOutline16 size={14} />
          <strong>检索知识库…</strong>
          {query !== '' && <span className="clue-dim">「{query}」</span>}
        </div>
      </div>
    )
  }
  const failed = block.isError === true
  const result = failed ? null : parseKbSearchResult(block.content as readonly TextishBlock[])
  return (
    <div className="clue-cite">
      <button
        type="button"
        className="clue-cite-head clue-cite-toggle"
        onClick={() => { setOpen(value => !value) }}
        aria-expanded={open}
      >
        <IconSearchOutline16 size={14} />
        <strong>知识库检索</strong>
        {query !== '' && <span className="clue-dim">「{query}」</span>}
        <span className="clue-count">
          {failed ? '失败' : result === null ? '无结构化结果' : `命中 ${result.hits.length}/${result.total} 条`}
        </span>
        <span className="clue-dim">{open ? '▾' : '▸'}</span>
      </button>
      {open && result !== null && result.hits.length > 0 && (
        <div className="clue-cite-hits">
          {result.hits.map(hit => {
            const badge = stateBadge(hit.status, hit.needsReview)
            return (
              <div className="clue-cite-hit" key={hit.id}>
                <span className="clue-mono">{shortId(hit.id)}</span>
                <Chip label={badge.label} tone={badge.tone} />
                <span>{hit.title}</span>
                <span className="clue-dim">{hit.kind}</span>
                {hit.annotations.map(annotation => (
                  <span className="clue-cite-annot" key={annotation}>{annotation}</span>
                ))}
              </div>
            )
          })}
        </div>
      )}
      {open && !failed && result !== null && result.hits.length === 0 && (
        <div className="clue-dim">这次检索没有命中任何知识。</div>
      )}
    </div>
  )
}

/**
 * The kb_propose receipt card: the proposal landed as a CANDIDATE, and
 * promotion stays a human decision — the card says so verbatim.
 * @param props - the call identity and frozen block.
 * @returns the proposal row.
 */
export function KbProposeCard({ block }: KbViewProps) {
  const running = !('kind' in block)
  if (running) {
    return (
      <div className="clue-cite">
        <div className="clue-cite-head">
          <IconLoadingOutline16 size={14} />
          <strong>提案新知识…</strong>
        </div>
      </div>
    )
  }
  const args = parseArgs(argsOf(block))
  const title = typeof args?.title === 'string' ? args.title : ''
  const failed = block.isError === true
  const result = failed ? null : parseKbProposeResult(block.content as readonly TextishBlock[])
  return (
    <div className="clue-cite">
      <div className="clue-cite-head">
        <IconPlusOutline16 size={14} />
        <strong>知识提案</strong>
        {title !== '' && <span>「{title}」</span>}
        {failed
          ? <Chip label="提案失败" tone="bad" />
          : result === null
            ? <Chip label="无结构化结果" tone="warn" />
            : <Chip label={stateBadge(result.status, false).label} tone={stateBadge(result.status, false).tone} />}
      </div>
      {result !== null && (
        <div className="clue-dim">
          <span className="clue-mono">{shortId(result.id)}</span>
          {' '}已落入候选层 — 提升为可信需要你在审批中心批准。
          {result.note !== '' && <div>{result.note}</div>}
        </div>
      )}
      {result === null && !failed && <div className="clue-dim">{actionCopy('promote').summary}</div>}
    </div>
  )
}

/**
 * The kb_cite receipt card (M4): shows WHICH entries the model declared as
 * its basis — the attribution ledger's user-visible face. Missing ids render
 * as an honest warning (a hallucinated citation was answered, not swallowed).
 * @param props - the call identity and frozen block.
 * @returns the citation row.
 */
export function KbCiteCard({ block }: KbViewProps) {
  const running = !('kind' in block)
  if (running) {
    return (
      <div className="clue-cite">
        <div className="clue-cite-head">
          <IconLoadingOutline16 size={14} />
          <strong>引用知识…</strong>
        </div>
      </div>
    )
  }
  const failed = block.isError === true
  const result = failed ? null : parseKbCiteResult(block.content as readonly TextishBlock[])
  return (
    <div className="clue-cite">
      <div className="clue-cite-head">
        <IconCheckOutline14 size={14} />
        <strong>知识引用</strong>
        {failed
          ? <Chip label="调用失败" tone="bad" />
          : result === null
            ? <Chip label="无结构化结果" tone="warn" />
            : <Chip label={`已记账 ${result.cited.length} 条`} tone="ok" />}
        {result !== null && result.missing.length > 0 && (
          <Chip label={`${result.missing.length} 个 id 不存在`} tone="warn" />
        )}
      </div>
      {result !== null && result.cited.length > 0 && (
        <div className="clue-cite-hits">
          {result.cited.map(id => (
            <div className="clue-cite-hit" key={id}>
              <span className="clue-mono">{shortId(id)}</span>
              <span className="clue-dim">归因与信号将按此引用记账</span>
            </div>
          ))}
        </div>
      )}
      {result !== null && result.note !== '' && <div className="clue-dim">{result.note}</div>}
    </div>
  )
}
