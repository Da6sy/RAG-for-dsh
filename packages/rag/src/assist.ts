/**
 * The gate assist block (M4) — the retrieval half of "failure signature
 * injection". When the evidence gate fires, the correction report says WHAT
 * failed; the assist block says WHAT WE ALREADY KNOW about this failure
 * class, retrieved by the signature itself. One injected message carries
 * both (kb-face composes), so the model's next step sees complaint and
 * precedent together — the acceptance line "门禁拦 → 检索到踩坑知识 → 自行
 * 修好" without the model having to think to search.
 *
 * Rendering discipline mirrors the pre-step kb_context block exactly:
 * deterministic order, per-entry annotations verbatim (status/review flags
 * are product law, decision #10/#21), character budget with an honest
 * truncation marker, and the kb_cite instruction so citations stay
 * attributable.
 *
 * @module @clue-harness/rag/assist
 */
import type { QueryHit } from '@clue-harness/kb'

/**
 * Render the assist block for the gate's retrieved hits.
 * @param hits - the signature-retrieved knowledge (ranked, annotated).
 * @param budget - maximum block length in characters.
 * @returns the block text ('' when there are no hits — the gate then
 *   injects the bare correction report, same as M3b).
 */
export function renderRetrievalAssist(hits: readonly QueryHit[], budget: number): string {
  if (hits.length === 0) return ''
  const lines: string[] = [
    '<kb_assist source="clue-rag">',
    '以下为知识库中与本次验证失败自动匹配的条目(按失败签名检索)。修复时若实际采用了某条知识,调用 kb_cite 声明其 id;与本次失败无关的条目直接忽略。',
  ]
  let used = lines.join('\n').length
  for (const hit of hits) {
    const flags = [hit.entry.status, hit.entry.needsReview ? '⚠待复核' : ''].filter((f) => f !== '').join('|')
    const text = hit.entry.text.replace(/\s+/g, ' ')
    let line = `- [${hit.entry.id}|${flags}|${hit.entry.kind}] ${hit.entry.title}: ${text}`
    for (const annotation of hit.annotations) line += ` (${annotation})`
    if (used + line.length > budget) {
      const room = budget - used - 20
      if (room < 60) break
      line = `${line.slice(0, room)}…`
    }
    lines.push(line)
    used += line.length + 1
  }
  lines.push('</kb_assist>')
  return lines.join('\n')
}
