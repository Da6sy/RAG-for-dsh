/**
 * `kb_detail`'s answer shape (M9-2, proposal §4/§14): the second-level drill
 * down from "this Entry is relevant" to "原文第 18–24 行".
 *
 * The rendering carries three facts a model must not have to infer:
 *
 * - the ANCHOR (`docId 行 a-b · heading · “quote”`) — evidence location, and
 *   the thing a human can open in a second;
 * - the redline state (`partialRedline`) — "part of this段 was retracted" is
 *   knowledge about the evidence, not noise;
 * - the receipt when there is no document at all (`该知识无原文层,正文即全部`)
 *   — an honest empty answer beats a fabricated段.
 *
 * Rendering only: this module reads nothing and writes nothing (宪法 4 — the
 * query path never touches knowledge state).
 *
 * @module @clue-harness/rag/detail
 */
import type { ChunkHit } from './chunks.ts'

/** The drill-down's budget (proposal §4: 默认预算 3000). */
export const DEFAULT_DETAIL_MAX_CHARS = 3000

/** The default per-chunk excerpt budget of a drill-down. */
export const DEFAULT_DETAIL_EXCERPT_CHARS = 600

/** One rendered drill-down. */
export interface DetailView {
  /** The entry the drill-down started from. */
  entryId: string
  /** The entry's title (context for the段 being shown). */
  title: string
  /** The documents that were read (empty ⇒ the no-doc receipt). */
  docIds: string[]
  hits: ChunkHit[]
  /** True when the entry carries no document (正文即全部). */
  noDoc: boolean
  /** The rendered text (what a tool result or the CLI prints). */
  text: string
}

/**
 * Render one chunk hit as a block: anchor line, then the excerpt.
 * @param hit - the ranked chunk hit.
 * @param index - 1-based position (for the reader's orientation).
 * @returns the block text.
 */
export function renderChunkBlock(hit: ChunkHit, index: number): string {
  const heading = hit.headingPath === '' ? '(无标题)' : hit.headingPath
  const lines: string[] = [
    `▸ [${index}] ${hit.docId} 行 ${hit.lines.start}-${hit.lines.end} · ${heading}`
    + ` · ${hit.chars} 字 · 相关度 ${hit.score}`,
    `  锚点: “${hit.quoteAnchor}”`,
  ]
  if (hit.partialRedline && hit.redlines.length > 0) {
    const reasons = [...new Set(hit.redlines.map((redline) => redline.reason))].join('; ')
    lines.push(`  ✂ 部分划除(标 ✂ 的行已被人工作废,勿作为依据): ${reasons}`)
  }
  for (const line of hit.excerpt.split('\n')) lines.push(`  | ${line}`)
  return lines.join('\n')
}

/**
 * Render the drill-down answer within a character budget.
 *
 * Budget discipline mirrors the injection blocks: blocks are added while they
 * fit, and the honest truncation marker says so — a truncated answer never
 * pretends to be complete.
 * @param input - the entry identity, the hits and whether a doc existed.
 * @param maxChars - the total budget.
 * @returns the rendered text.
 */
export function renderDetailView(
  input: { entryId: string; title: string; docIds: readonly string[]; hits: readonly ChunkHit[]; noDoc: boolean },
  maxChars: number = DEFAULT_DETAIL_MAX_CHARS,
): DetailView {
  const head = input.noDoc
    ? `# ${input.entryId} · ${input.title}\n该知识无原文层(entry 未挂载 doc),正文即全部内容。`
    : `# ${input.entryId} · ${input.title}\n原文: ${input.docIds.join(', ')} · 命中 ${input.hits.length} 段(纯读取,不记信号、不改状态)`
  const lines: string[] = [head]
  let used = head.length
  let shown = 0
  for (const hit of input.hits) {
    const block = renderChunkBlock(hit, shown + 1)
    if (used + block.length + 1 > maxChars) {
      lines.push(`…(预算 ${maxChars} 字已满,余下 ${input.hits.length - shown} 段未展开)`)
      break
    }
    lines.push(block)
    used += block.length + 1
    shown += 1
  }
  if (!input.noDoc && input.hits.length === 0) {
    lines.push('原文中没有与该查询相关的段(可用空 query 浏览全部段)。')
  }
  return {
    entryId: input.entryId,
    title: input.title,
    docIds: [...input.docIds],
    hits: [...input.hits],
    noDoc: input.noDoc,
    text: lines.join('\n'),
  }
}
