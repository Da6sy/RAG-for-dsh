/**
 * The judging half of the evaluation engine (規劃 E2/E3) — ports, versioned
 * prompts, tolerant parsers, and the negative controls that keep a judge honest.
 *
 * The four metrics are the RAG triad plus context recall (the plan's §3 table):
 * `faithfulness` (are the answer's claims supported by the retrieved context?),
 * `answer relevance` (does it address the question? — orthogonal to faithfulness),
 * `context precision` (how much of what was retrieved was useful, rank-weighted),
 * `context recall` (how much of the gold answer the context supports).
 *
 * Three rules this file exists to enforce:
 *
 * 1. **A judge is a measured object, not an oracle.** Every prompt carries a
 *    {@link JUDGE_PROMPT_VERSION}; changing the prompt changes the metric's
 *    meaning, so the version rides in the report (like `embedderVersion` rides
 *    in the index).
 * 2. **Parsing is tolerant, scoring is not.** Models return prose, fences,
 *    missing ids; a parser that throws on that measures the parser. Everything
 *    is normalized to numbers in [0,1], and an unparsable answer is reported as
 *    "not proven" rather than as 0 (規劃 纪律 5).
 * 3. **Negative controls ship WITH the judge.** Three deliberately broken
 *    answers/contexts are constructed here; if the judge cannot separate them,
 *    its scores on real answers mean nothing.
 *
 * @module @clue-harness/eval/judge
 */

/** The judge prompt version — bump it whenever a prompt below changes. */
export const JUDGE_PROMPT_VERSION = 'judge-v2'

/** One retrieved context item handed to the answer model and the judge. */
export interface ContextItem {
  /** Stable id (the judge refers to these; the answer model does not need them). */
  id: string
  title: string
  text: string
}

/** The port an answer model must satisfy (host-injected: `chat-host` in kb-face). */
export interface AnswerPort {
  /** Stable id of the answering model (goes into the report). */
  readonly id: string
  /**
   * Answer one question from the retrieved context ALONE.
   * @param question - the user's question.
   * @param contexts - the retrieved passages, in rank order.
   * @returns the answer text.
   */
  answer(question: string, contexts: readonly ContextItem[]): Promise<string>
}

/** The port a judge model must satisfy. */
export interface JudgePort {
  /** Stable id of the judging model (ideally a different family than the answerer). */
  readonly id: string
  /**
   * Score one judgement task from a built prompt.
   * @param prompt - the fully built prompt (the port must not add instructions).
   * @returns the model's raw text.
   */
  judge(prompt: string): Promise<string>
}

/** The four metric values for one triple. */
export interface JudgeScores {
  faithfulness: number
  answerRelevance: number
  contextPrecision: number
  contextRecall: number
}

/** What the judge produced, or why it could not (規劃 纪律 5: "未证明" ≠ 0). */
export interface JudgeOutcome {
  ok: boolean
  scores: JudgeScores | null
  /** One line explaining a failure — printed verbatim by the runner. */
  note: string
  /** The raw answers (kept for the disagreement samples of a calibration run). */
  raw?: string[]
}

/** Pull the first JSON object out of a model answer that may wrap it in prose or fences. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error(`eval judge: no JSON found in model output: ${candidate.slice(0, 100)}`)
  return JSON.parse(candidate.slice(start, end + 1))
}

/**
 * Normalize a judge's number into [0,1].
 *
 * A judge asked for "a number between 0 and 1" sometimes answers `8` (out of
 * ten) or `80` (percent). Only WHOLE numbers above 1 are read as another scale —
 * `1.4` is a 0–1 answer that overshot and gets clamped, because dividing it by
 * 100 (as a naive ">1 means percent" rule would) turns a near-perfect score into
 * 0.014, which is a silent, enormous error.
 * @param value - the parsed value.
 * @returns the rate, or null when it is not a number.
 */
function asRate(value: unknown): number | null {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  let scaled = num
  if (num > 1 && Number.isInteger(num)) scaled = num > 10 ? num / 100 : num / 10
  return Math.max(0, Math.min(1, scaled))
}

/**
 * Prompt 1: faithfulness by claim extraction + support check (two-step in ONE
 * call: the model lists the claims and says whether the context supports each).
 * @param question - the question.
 * @param answer - the model answer under test.
 * @param contexts - the retrieved passages.
 * @returns the prompt.
 */
export function faithfulnessPrompt(question: string, answer: string, contexts: readonly ContextItem[]): string {
  const ctx = contexts.map((item, index) => `[${index + 1}] ${item.title}\n${item.text}`).join('\n\n')
  return `你在核对一个回答是否"有依据"。只根据下面给出的资料判断,不要用你自己的知识补充。\n\n`
    + `资料:\n${ctx}\n\n问题:${question}\n\n回答:${answer}\n\n`
    + `请把回答拆成若干条 claim(陈述),逐条判断能否被资料支持。只输出 JSON:\n`
    + `{"claims":[{"claim":"…","supported":true|false}]}`
}

/**
 * Prompt 2: answer relevance, scored against the question alone (no context —
 * a faithful answer can still be off-topic, which is exactly what this catches).
 */
export function relevancePrompt(question: string, answer: string): string {
  return `判断下面的回答是否正面回应了问题(不看它对不对,只看它切不切题)。\n\n`
    + `问题:${question}\n\n回答:${answer}\n\n`
    + `只输出 JSON:{"relevance":0到1之间的小数,"reason":"一句话"}`
}

/**
 * Prompt 3: context precision AND recall in one call.
 *
 * Precision is judged per passage and the aggregation is rank-weighted in
 * {@link contextPrecision} (a useful passage at rank 1 must count for more than
 * one at rank 10); recall compares the gold answer's key points against what the
 * passages support.
 *
 * V2 (measured, not hypothetical): the first version asked only "is this passage
 * USEFUL for answering?" and therefore scored a topically-right-but-factually-
 * WRONG passage as useful — the noise negative control (`positive_wrong` in RGB)
 * passed the judge unnoticed. Precision now requires **support for the gold key
 * points**, so a passage that is on topic and contradicts the answer no longer
 * counts. The version bump is what keeps old cached judgements out of the new
 * numbers.
 */
export function contextPrompt(question: string, goldPoints: readonly string[], contexts: readonly ContextItem[]): string {
  const ctx = contexts.map((item, index) => `[${index + 1}] ${item.title}\n${item.text}`).join('\n\n')
  const points = goldPoints.map((point, index) => `${index + 1}. ${point}`).join('\n')
  return `下面是从知识库里检索回来的资料,以及一份标准答案的要点。逐条判断。\n\n`
    + `问题:${question}\n\n资料:\n${ctx}\n\n标准答案要点:\n${points}\n\n`
    + `passages 里每条都要给两个判断:\n`
    + `  - "useful": 这条资料对回答这个问题有没有帮助(是否切题);\n`
    + `  - "supportsGold": 这条资料是否**支持**上面标准答案的要点(主题对但说法与标准答案冲突、或答的是别的事,都算 false)。\n`
    + `只输出 JSON:{"passages":[{"index":1,"useful":true|false,"supportsGold":true|false}],"points":[{"index":1,"supported":true|false}]}`
}

/**
 * Parse the faithfulness answer into a rate.
 * @param raw - the model's answer.
 * @returns claims-supported / total claims, or null when unparsable.
 */
export function parseFaithfulness(raw: string): number | null {
  const parsed = extractJson(raw) as { claims?: Array<{ supported?: unknown }> }
  const claims = parsed.claims
  if (!Array.isArray(claims) || claims.length === 0) return null
  const supported = claims.filter((claim) => claim.supported === true).length
  return supported / claims.length
}

/** Parse the relevance answer into a rate. */
export function parseRelevance(raw: string): number | null {
  const parsed = extractJson(raw) as { relevance?: unknown; score?: unknown }
  return asRate(parsed.relevance ?? parsed.score)
}

/** One parsed context judgement. */
export interface ParsedContext {
  /** 1-based passage index → does it support the gold answer's points? (what precision counts) */
  passages: Map<number, boolean>
  /** 1-based passage index → merely on topic? (fallback when the judge omitted `supportsGold`) */
  topical: Map<number, boolean>
  /** 1-based gold point index → supported? */
  points: Map<number, boolean>
}

/** Parse the context answer (tolerating missing entries). */
export function parseContext(raw: string): ParsedContext {
  const parsed = extractJson(raw) as { passages?: Array<{ index?: unknown; useful?: unknown; supportsGold?: unknown }>; points?: Array<{ index?: unknown; supported?: unknown }> }
  const passages = new Map<number, boolean>()
  const topical = new Map<number, boolean>()
  for (const row of parsed.passages ?? []) {
    const index = Number(row.index)
    if (!Number.isInteger(index) || index < 1) continue
    // A judge that answers the v2 question but omits `supportsGold` is not
    // penalized into zero: fall back to its topical verdict, and say so by
    // filling both maps with the same value. Silently scoring 0 would turn a
    // terse judge into a fake -100%.
    const supports = row.supportsGold === true || (row.supportsGold === undefined && row.useful === true)
    passages.set(index, supports)
    topical.set(index, row.useful === true)
  }
  const points = new Map<number, boolean>()
  for (const row of parsed.points ?? []) {
    const index = Number(row.index)
    if (Number.isInteger(index) && index >= 1) points.set(index, row.supported === true)
  }
  return { passages, topical, points }
}

/**
 * Rank-weighted context precision (MAP-style): a useful passage at rank 1 counts
 * fully, one at rank 10 counts 1/10 — retrieving the right段 late is worth less
 * than retrieving it first, and a plain proportion would hide that.
 * @param parsed - the judge's per-passage verdicts.
 * @param retrieved - how many passages were shown.
 * @returns precision in [0,1] (0 when nothing was judged useful).
 */
export function contextPrecision(parsed: ParsedContext, retrieved: number): number {
  if (retrieved === 0) return 0
  let weighted = 0
  let useful = 0
  for (let rank = 1; rank <= retrieved; rank += 1) {
    if (parsed.passages.get(rank) === true) {
      useful += 1
      weighted += 1 / Math.log2(rank + 1)
    }
  }
  const ideal = dcgIdeal(useful, retrieved)
  return ideal === 0 ? 0 : weighted / ideal
}

/** The weighted value if every useful passage had been ranked first. */
function dcgIdeal(useful: number, retrieved: number): number {
  let sum = 0
  for (let rank = 1; rank <= Math.min(useful, retrieved); rank += 1) sum += 1 / Math.log2(rank + 1)
  return sum
}

/** Gold-point coverage from the judge's verdicts. */
export function contextRecall(parsed: ParsedContext, goldPoints: number): number {
  if (goldPoints === 0) return 0
  let supported = 0
  for (let index = 1; index <= goldPoints; index += 1) if (parsed.points.get(index) === true) supported += 1
  return supported / goldPoints
}

/** One negative control: a deliberately broken input plus what the judge must show. */
export interface NegativeControl {
  id: string
  /** What is broken, in one line (goes into the report). */
  broken: string
  /** The metric that must move in the expected direction. */
  metric: keyof JudgeScores
  /** The direction the metric must move. */
  expect: 'drop' | 'rise'
  question: string
  answer: string
  contexts: readonly ContextItem[]
  goldPoints: readonly string[]
}

/**
 * The three negative controls the plan demands (規劃 E2 §3).
 *
 * They are constructed, not downloaded: a synthetic bad case we control is the
 * only way to say "the judge caught it" rather than "the dataset happened to
 * contain it". A judge that cannot separate these scores real answers by luck.
 * @param contexts - the healthy retrieved context to corrupt.
 * @param goldPoints - the real gold points for the question.
 * @returns the three controls.
 */
export function negativeControls(contexts: readonly ContextItem[], goldPoints: readonly string[]): NegativeControl[] {
  const question = '这份规范对分片重建是怎么规定的?'
  const healthy = contexts.length > 0 ? contexts : [{ id: 'c1', title: '规范', text: 'chunker 版本号不一致时分片会重建。' }]
  return [
    {
      id: 'unfaithful-answer',
      broken: '答案编造了一条资料里没有的规定(faithfulness 必须下降)',
      metric: 'faithfulness',
      expect: 'drop',
      question,
      answer: '规范要求分片必须每 24 小时强制重建一次,并且必须写进 CI 门禁。',
      contexts: healthy,
      goldPoints: [...goldPoints],
    },
    {
      id: 'off-topic-answer',
      broken: '答案忠实但答非所问(answer relevance 必须下降)',
      metric: 'answerRelevance',
      expect: 'drop',
      question,
      answer: '本仓库的代码风格要求使用两个空格缩进,并且禁止使用 any 类型。',
      contexts: healthy,
      goldPoints: [...goldPoints],
    },
    {
      id: 'gold-at-last',
      broken: '把最相关的那段排到最后(context precision 必须下降)',
      metric: 'contextPrecision',
      expect: 'drop',
      question,
      answer: '按资料,分片会在版本号不一致时重建。',
      contexts: [...healthy].reverse(),
      goldPoints: [...goldPoints],
    },
  ]
}
