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
import { DEFAULT_INJECT_MIN_ENTRY_CHARS, DEFAULT_INJECT_PER_ENTRY_CHARS, renderHitLine, type QueryHit } from '@clue-harness/kb'

/**
 * Render the assist block for the gate's retrieved hits.
 *
 * M9-0/§4 G4: the block obeys the SAME配额制 as the pre-step block — each hit
 * gets one line whose body is trimmed to `perEntryChars`, and a hit that cannot
 * fit the remaining budget with `minChars` of prose to spare yields its place
 * (保广度弃深度) so one long entry cannot monopolize the gate's correction
 * message. The M9-1 drill-down hint rides the line when the hit carries a
 * document, but it only PROMPTS: the gate never auto-drills (拍板 3, on-demand
 * + injection budget).
 * @param hits - the signature-retrieved knowledge (ranked, annotated).
 * @param budget - maximum block length in characters.
 * @param quota - per-entry body quota and the yield floor.
 * @returns the block text ('' when there are no hits — the gate then
 *   injects the bare correction report, same as M3b).
 */
export function renderRetrievalAssist(
  hits: readonly QueryHit[],
  budget: number,
  quota: { perEntryChars?: number; minChars?: number } = {},
): string {
  if (hits.length === 0) return ''
  const perEntryChars = quota.perEntryChars ?? DEFAULT_INJECT_PER_ENTRY_CHARS
  const minChars = quota.minChars ?? DEFAULT_INJECT_MIN_ENTRY_CHARS
  const lines: string[] = [
    '<kb_assist source="clue-rag">',
    '以下为知识库中与本次验证失败自动匹配的条目(按失败签名检索)。修复时若实际采用了某条知识,调用 kb_cite 声明其 id;与本次失败无关的条目直接忽略。',
  ]
  let used = lines.join('\n').length
  const cap = budget - '</kb_assist>'.length - 1
  for (const hit of hits) {
    const line = renderHitLine(hit, perEntryChars, minChars, Math.max(0, cap - used))
    if (line === null) continue
    // The fit/trim decisions all live in the renderer; here the block only
    // refuses a line it literally cannot hold.
    if (line.length > cap - used) continue
    lines.push(line)
    used += line.length + 1
  }
  lines.push('</kb_assist>')
  return lines.join('\n')
}
