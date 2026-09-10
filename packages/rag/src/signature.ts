/**
 * Failure-signature extraction (M4).
 *
 * A signature is the retrieval query derived from WHAT ACTUALLY FAILED —
 * the assertion names, their measured values, and the diff's error entries —
 * plus the changed renderable files. This is the mechanism behind the
 * design's M4 acceptance line: the gate fails, the signature retrieves the
 * pitfall knowledge that explains this exact failure class, and the model
 * gets the fix instead of only the complaint.
 *
 * Deterministic by construction: same outcome + same files → same signature
 * → same retrieval. No timestamps, no ids, no run-scoped values.
 *
 * @module @clue-harness/rag/signature
 */

/** The evidence facts a signature is built from (EvidenceOutcome-compatible). */
export interface SignatureSource {
  /** Failed assertion lines, e.g. `按钮可被 Tab 选中(实际: 不在 Tab 顺序中)`. */
  failedAssertions: readonly string[]
  /** Error-severity diff summaries, e.g. `[attr] submit: tabindex 出现 -1`. */
  errorEntrySummaries: readonly string[]
}

/** Signature construction knobs. */
export interface SignatureOptions {
  /** Maximum facts folded into the signature (default 6). */
  maxFacts?: number
  /** Maximum signature length in characters (default 400). */
  maxLength?: number
}

const DEFAULT_MAX_FACTS = 6
const DEFAULT_MAX_LENGTH = 400

/**
 * Build the retrieval signature for one failed verification.
 *
 * Order is meaningful for retrieval weight: assertions first (they name the
 * violated rule in product vocabulary — "Tab 顺序", "对比度" — which is how
 * pitfall knowledge is titled), then diff entries (structural detail), then
 * the changed renderable files (binding-boost anchors and title matches).
 *
 * @param source - the failed outcome's facts.
 * @param changedRenderable - renderable files changed in this work unit.
 * @param options - fact and length caps.
 * @returns the signature text ('' when there is nothing to say).
 */
export function failureSignature(
  source: SignatureSource,
  changedRenderable: readonly string[],
  options: SignatureOptions = {},
): string {
  const maxFacts = options.maxFacts ?? DEFAULT_MAX_FACTS
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH
  const facts: string[] = []
  for (const assertion of source.failedAssertions) {
    if (facts.length >= maxFacts) break
    const line = assertion.trim()
    if (line !== '') facts.push(line)
  }
  for (const summary of source.errorEntrySummaries) {
    if (facts.length >= maxFacts) break
    const line = summary.trim()
    if (line !== '') facts.push(line)
  }
  for (const file of changedRenderable) {
    if (facts.length >= maxFacts) break
    const line = file.trim()
    if (line !== '') facts.push(line)
  }
  if (facts.length === 0) return ''
  // Deduplicate without reordering (a fact can appear as both assertion and
  // diff entry); the first occurrence keeps its priority position.
  const unique = [...new Set(facts)]
  let signature = unique.join(' ')
  if (signature.length > maxLength) signature = `${signature.slice(0, maxLength - 1)}…`
  return signature
}
