/**
 * The evaluation ports over the configured chat models (規劃 E2, kb-face 适配器).
 *
 * The engine (`packages/eval`) owns the prompts, the parsing and the metrics;
 * this file owns the two things an engine may not do: reach a model, and pay for
 * it. Same dependency inversion as `HttpEmbedder` and `chatRankPort`.
 *
 * Three disciplines, all measured rather than promised:
 *
 * 1. **Every call is counted** (calls / characters / milliseconds / failures) so
 *    a report can state its own cost — the real-endpoint round taught that a
 *    failed attempt is cost too.
 * 2. **Judgements are cached** under `evals/cache/<judgeVersion>/<sha256>.json`:
 *    re-running the same evaluation is free, which is what makes iterating on a
 *    report affordable.
 * 3. **Thinking is off** for judging (`reasoningEffort: 'off'`): judging is
 *    extraction, and a thinking phase would eat the answer's token budget.
 *
 * @module @clue-harness/kb-face/eval-ports
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
// The ports live in the engine's `judge` subpath (prompts and parsers with them).
import type { AnswerPort, ContextItem, JudgePort } from '@clue-harness/eval/judge'
import type { ChatHost } from './chat-host.ts'

/** The counters a report prints (規劃 纪律 4). */
export interface CallStats {
  calls: number
  failedCalls: number
  chars: number
  ms: number
}

/** What the adapters need: a chat host and where to keep the judge cache. */
export interface EvalPortsOptions {
  host: ChatHost
  /** Cache root (default `<repo>/evals/cache` passed by the caller). */
  cacheDir: string
  /** Judge prompt version — part of the cache key, so a prompt change re-judges. */
  judgeVersion: string
  /**
   * Optional route overrides. The plan's risk table asks for a judge from a
   * DIFFERENT family than the answerer (self-preference), which means overriding
   * the provider too — a model id alone is meaningless on the wrong route.
   */
  answerModel?: string
  answerProvider?: string
  judgeModel?: string
  judgeProvider?: string
  maxTokens?: number
}

/** The adapters plus their shared counters. */
export interface EvalPorts {
  answer: AnswerPort
  judge: JudgePort
  stats: CallStats
}

/**
 * Build the answer and judge ports over one chat host.
 * @param options - host, cache location, judge version and model overrides.
 * @returns the ports and a live cost counter.
 */
export function createEvalPorts(options: EvalPortsOptions): EvalPorts {
  const stats: CallStats = { calls: 0, failedCalls: 0, chars: 0, ms: 0 }

  /**
   * One judged call, cached by `judgeVersion + prompt`.
   * @param prompt - the built prompt.
   * @param model - optional model override.
   * @returns the model's answer.
   */
  const call = async (prompt: string, model?: string, provider?: string): Promise<string> => {
    const key = createHash('sha256').update(`${options.judgeVersion}\u0000${provider ?? ''}\u0000${model ?? ''}\u0000${prompt}`).digest('hex')
    const file = path.join(options.cacheDir, options.judgeVersion, `${key}.json`)
    const cached = await readFile(file, 'utf8').catch(() => null)
    if (cached !== null) return (JSON.parse(cached) as { text: string }).text
    const started = Date.now()
    try {
      const request = {
        prompt,
        maxTokens: options.maxTokens ?? 1500,
        timeoutMs: 120_000,
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider } : {}),
      }
      let response: Awaited<ReturnType<typeof options.host.ask>>
      try {
        response = await options.host.ask({ ...request, reasoningEffort: 'off' as const })
      } catch (error) {
        // Providers disagree about which effort levels a model accepts
        // (measured: `qwen/qwen3.8-max` rejects "off"). Judging should not be
        // tied to one vendor's effort vocabulary, so an unsupported level falls
        // back to the model's own default instead of failing the whole run.
        const message = error instanceof Error ? error.message : String(error)
        if (!/reasoning effort|UNSUPPORTED_REASONING_EFFORT/i.test(message)) throw error
        response = await options.host.ask(request)
      }
      stats.calls += 1
      stats.chars += prompt.length + response.text.length
      stats.ms += Date.now() - started
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify({ text: response.text, at: new Date().toISOString() })}\n`, 'utf8')
      return response.text
    } catch (error) {
      // A failed call is cost too — count it, then let the caller degrade.
      stats.calls += 1
      stats.failedCalls += 1
      stats.ms += Date.now() - started
      throw error
    }
  }

  return {
    stats,
    answer: {
      id: options.answerModel === undefined
        ? `${options.host.route.provider}/${options.host.route.model}`
        : `${options.answerProvider ?? options.host.route.provider}/${options.answerModel}`,
      async answer(question: string, contexts: readonly ContextItem[]): Promise<string> {
        const context = contexts.map((item, index) => `[${index + 1}] ${item.title}\n${item.text}`).join('\n\n')
        const prompt = `只根据下面给出的资料回答问题;资料里没有的,直接说"资料未提及",不要用你自己的知识补充。\n\n`
          + `资料:\n${context}\n\n问题:${question}`
        return call(prompt, options.answerModel, options.answerProvider)
      },
    },
    judge: {
      id: options.judgeModel === undefined
        ? `${options.host.route.provider}/${options.host.route.model}`
        : `${options.judgeProvider ?? options.host.route.provider}/${options.judgeModel}`,
      judge: (prompt: string) => call(prompt, options.judgeModel, options.judgeProvider),
    },
  }
}
