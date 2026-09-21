/**
 * `llmRerank` — the optional model-based rerank (V5, 规划 §8.4).
 *
 * Shipped **off by default**, and deliberately so. The plan's whole ranking
 * decision (拍板 2) was hand-built features: deterministic, explainable,
 * rollback-able, zero-dependency. A model reranker is the opposite on all four
 * axes, so it may only ever be an ADDITION that a human turns on to compare —
 * never the path a product answer depends on.
 *
 * Four rules, straight from §8.4:
 *
 * 1. **No signal is recorded.** A rerank is a read; 宪法 4 forbids a query from
 *    changing knowledge, and "the model liked this ordering" is not evidence
 *    about the knowledge.
 * 2. **Timeout degrades to the deterministic order.** A slow or broken model
 *    may not be able to make a retrieval worse, only fail to improve it.
 * 3. **The difference is the product.** The outcome carries the deterministic
 *    order AND the model order plus a per-hit move, so an evaluation can report
 *    "what did the model change", which is the only way this feature earns its
 *    way on.
 * 4. **It is bounded.** At most `topK` candidates (default 10) and each one's
 *    text is truncated, because a rerank prompt that grows with the library is
 *    a cost bug waiting for a big library.
 *
 * The engine owns the prompt, the parser and the diff; the integration layer
 * owns the model call (`kb-face`'s chat host), because engines never open a
 * socket (不变量 6).
 *
 * @module @clue-harness/rag/llm-rerank
 */

/** One candidate as the model sees it. */
export interface RerankPromptCandidate {
  /** Stable id the answer must use (never the title: titles repeat). */
  id: string
  title: string
  /** A truncated body excerpt (the budget). */
  excerpt: string
  /** The deterministic reranker's score — given to the model as context. */
  score: number
}

/** The seam a host implements (the model call). */
export interface LlmRankPort {
  /**
   * Ask the model to reorder the candidates.
   * @param prompt - the fully built prompt (the port must not add instructions).
   * @param signal - cancellation.
   * @returns the model's raw text answer.
   */
  rank(prompt: string, signal?: AbortSignal): Promise<string>
}

/** One candidate's move between the two orderings. */
export interface RerankMove {
  id: string
  /** 1-based position in the deterministic order. */
  from: number
  /** 1-based position in the model's order. */
  to: number
}

/** The outcome of one model rerank attempt. */
export interface LlmRerankOutcome {
  /** The ids in the model's order (always a permutation of the candidates given). */
  order: string[]
  /** The deterministic order the model was shown. */
  baseline: string[]
  /** Per-candidate moves (only for ids whose position changed). */
  moves: RerankMove[]
  /** The model's raw answer (for the evaluation report, truncated by the caller). */
  raw: string
  ms: number
}

/** The shipped bounds. */
export const LLM_RERANK_MAX_CANDIDATES = 10

/** The per-candidate excerpt budget in the prompt. */
export const LLM_RERANK_EXCERPT_CHARS = 240

/**
 * Build the rerank prompt.
 *
 * The instructions are explicit about the failure modes a model has here:
 * inventing ids, dropping candidates, and explaining instead of answering. The
 * output shape is JSON because parsing prose reliably is not a thing.
 * @param query - the user's query.
 * @param candidates - the candidates, in the deterministic order.
 * @returns the prompt text.
 */
export function buildRerankPrompt(query: string, candidates: readonly RerankPromptCandidate[]): string {
  const items = candidates.map((candidate, index) => {
    const excerpt = candidate.excerpt.replace(/\s+/g, ' ').slice(0, LLM_RERANK_EXCERPT_CHARS)
    return `${index + 1}. id=${candidate.id} | 标题: ${candidate.title} | 摘录: ${excerpt}`
  }).join('\n')
  return `你在给一次知识库检索做重排。只能重排给定的候选,不要新增、不要删除、不要编造 id。\n\n`
    + `用户查询: ${query}\n\n候选(已按确定性特征精排排好,序号即当前名次):\n${items}\n\n`
    + `请按"哪条最可能是用户真正需要的知识"重新排序,只输出 JSON:\n`
    + `{"order":["id1","id2",...]}\n`
    + `order 必须恰好包含上面每个 id 一次,不要解释、不要输出别的字段。`
}

/**
 * Parse a model's rerank answer into a permutation.
 *
 * Defensive by design: a model that returns a partial list, an unknown id, a
 * duplicate, or prose around the JSON must not be able to drop a candidate from
 * the result. Everything it did not mention keeps its deterministic position at
 * the end, in its original relative order.
 * @param raw - the model's answer.
 * @param baseline - the ids in the deterministic order.
 * @returns the reordered ids (always a permutation of `baseline`).
 * @throws when no JSON object/array can be found at all.
 */
export function parseRerankAnswer(raw: string, baseline: readonly string[]): string[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const text = (fenced?.[1] ?? raw).trim()
  let parsed: unknown
  const objectStart = text.indexOf('{')
  const arrayStart = text.indexOf('[')
  try {
    if (objectStart !== -1 && (arrayStart === -1 || objectStart < arrayStart)) {
      parsed = JSON.parse(text.slice(objectStart, text.lastIndexOf('}') + 1))
    } else if (arrayStart !== -1) {
      parsed = JSON.parse(text.slice(arrayStart, text.lastIndexOf(']') + 1))
    } else {
      throw new Error('没有 JSON')
    }
  } catch {
    throw new Error(`模型没有返回可解析的重排结果: ${text.slice(0, 120)}`)
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { order?: unknown; ranking?: unknown }).order ?? (parsed as { ranking?: unknown }).ranking
  if (!Array.isArray(list)) throw new Error('模型返回里没有 order 数组')
  const known = new Set(baseline)
  const seen = new Set<string>()
  const order: string[] = []
  for (const item of list) {
    const id = typeof item === 'string' ? item.trim() : String((item as { id?: unknown })?.id ?? '').trim()
    if (id === '' || !known.has(id) || seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }
  for (const id of baseline) if (!seen.has(id)) order.push(id)
  return order
}

/**
 * Ask a model to rerank, with the plan's guards around it.
 *
 * @param port - the host's model call.
 * @param query - the user's query.
 * @param candidates - the deterministic order (already truncated by the caller to `maxCandidates`).
 * @param options - bounds and the clock.
 * @returns the outcome, or null when the call failed/timed out (caller keeps the deterministic order).
 */
export async function llmRerank(
  port: LlmRankPort,
  query: string,
  candidates: readonly RerankPromptCandidate[],
  options: {
    timeoutMs?: number
    maxCandidates?: number
    now?: () => number
    /**
     * Called with the reason when the rerank could not be applied. The caller
     * keeps its deterministic order either way (规划 §8.4 超时降级), but "it
     * didn't run" and "it ran and broke" look identical from outside — and a
     * user debugging a missing credential deserves to know which one happened.
     */
    onError?: (reason: string) => void
  } = {},
): Promise<LlmRerankOutcome | null> {
  const max = options.maxCandidates ?? LLM_RERANK_MAX_CANDIDATES
  const shown = candidates.slice(0, max)
  if (shown.length < 2) return null
  const baseline = shown.map((candidate) => candidate.id)
  const now = options.now ?? (() => Date.now())
  const started = now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)
  try {
    const raw = await port.rank(buildRerankPrompt(query, shown), controller.signal)
    const order = parseRerankAnswer(raw, baseline)
    const position = new Map(order.map((id, index) => [id, index + 1]))
    const moves: RerankMove[] = []
    baseline.forEach((id, index) => {
      const to = position.get(id) ?? index + 1
      if (to !== index + 1) moves.push({ id, from: index + 1, to })
    })
    return { order, baseline, moves, raw, ms: now() - started }
  } catch (error) {
    // Rule 2: a failed rerank may not make retrieval worse — the caller keeps
    // the deterministic order, and no signal is recorded either way (rule 1).
    options.onError?.(error instanceof Error ? error.message : String(error))
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Render the diff one evaluation prints (the "并列输出差异" of §8.4).
 * @param outcome - the rerank outcome.
 * @param label - a label for one id (usually the title).
 * @returns the printable lines.
 */
export function describeRerankDiff(outcome: LlmRerankOutcome, label: (id: string) => string): string[] {
  const lines: string[] = [`确定性精排 → 模型重排(${outcome.ms}ms,${outcome.moves.length} 处变动)`]
  outcome.order.forEach((id, index) => {
    const before = outcome.baseline.indexOf(id) + 1
    const arrow = before === index + 1 ? '  ' : `↑${before}`
    lines.push(`  ${String(index + 1).padStart(2)}. [${arrow.padStart(3)}] ${label(id)}`)
  })
  return lines
}
