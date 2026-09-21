/**
 * D3 — the RAG end-to-end bench on RGB (規劃 E2).
 *
 * What it does per record: retrieve the gold passages (RGB ships them) → let the
 * CONFIGURED answer model answer from them alone → judge the answer and the
 * context on the four metrics → then run the negative controls.
 *
 * The controls come from the dataset itself, which is stricter than inventing
 * them: `fakeanswer` is a fabricated answer (faithfulness MUST drop) and
 * `positive_wrong` are passages that look right and are wrong (context precision
 * MUST drop when they replace the gold ones). A judge that cannot separate those
 * would score real answers by luck.
 *
 * Everything is cached (judge cache) and counted (calls/chars/ms/failures) —
 * re-running is free, and the report states its own cost.
 *
 * Usage: node scripts/bench-rag.mjs [--records 3] [--answer-model …] [--judge-model …]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.join(fileURLToPath(new URL('.', import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, token, index, list) => {
  if (token.startsWith('--')) acc.push([token.slice(2), list[index + 1]?.startsWith('--') === false ? list[index + 1] : 'true'])
  return acc
}, []))
const records = Number(args.records ?? 3)
const rgbFile = path.join(repoRoot, 'evals', 'datasets', 'rgb', 'data', 'zh.json')

const { buildReport, summarizeScores } = await import('@clue-harness/eval')
const {
  JUDGE_PROMPT_VERSION, contextPrecision, contextPrompt, contextRecall,
  faithfulnessPrompt, parseContext, parseFaithfulness, parseRelevance, relevancePrompt,
} = await import('@clue-harness/eval/judge')
const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot')
loadLayeredEnv('clue')
const { openChatHost } = await import('@clue-harness/kb-face/chat-host')
const { createEvalPorts } = await import('@clue-harness/kb-face/eval-ports')

const host = await openChatHost({
  ...(args['answer-model'] !== undefined ? { model: String(args['answer-model']) } : {}),
})
const ports = createEvalPorts({
  host,
  cacheDir: path.join(repoRoot, 'evals', 'cache'),
  judgeVersion: JUDGE_PROMPT_VERSION,
  ...(args['answer-model'] !== undefined ? { answerModel: String(args['answer-model']) } : {}),
  ...(args['judge-model'] !== undefined ? { judgeModel: String(args['judge-model']) } : {}),
  ...(args['judge-provider'] !== undefined ? { judgeProvider: String(args['judge-provider']) } : {}),
  ...(args['answer-provider'] !== undefined ? { answerProvider: String(args['answer-provider']) } : {}),
})

/** RGB record → the engine's context/gold-point shapes. */
const asContexts = (texts) => texts.map((text, index) => ({ id: `rgb-${index}`, title: '', text: String(text) }))
/**
 * RGB's `answer` is either a list of key points (Chinese file) or one paragraph:
 * both are turned into the "gold points" the context-recall judge compares
 * against, and a list is used as-is because that is already the annotation.
 */
const pointsOf = (answer) => Array.isArray(answer)
  ? answer.map((s) => String(s).trim()).filter((s) => s.length > 1).slice(0, 6)
  : String(answer).split(/[。;;.!?]/).map((s) => s.trim()).filter((s) => s.length > 4).slice(0, 4)

// RGB ships JSONL (one record per line), not a JSON array.
const all = (await readFile(rgbFile, 'utf8')).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
const sample = all.slice(0, records)
console.log(`[d3] RGB/zh: 取 ${sample.length} 条(共 ${all.length})· answer=${ports.answer.id} · judge=${ports.judge.id} · judgeVersion=${JUDGE_PROMPT_VERSION}`)

/** Judge one (question, answer, contexts, goldPoints) triple into four metrics. */
async function judgeTriple(query, answer, contexts, goldPoints) {
  // 纪律 5: 判分失败/返回空 ⇒ 报"未证明"(null),不用 0 冒充,也不让整轮崩掉。
  const [faithRaw, relRaw, ctxRaw] = await Promise.all([
    ports.judge.judge(faithfulnessPrompt(query, answer, contexts)),
    ports.judge.judge(relevancePrompt(query, answer)),
    ports.judge.judge(contextPrompt(query, goldPoints, contexts)),
  ])
  const safe = (fn, ...args) => { try { return fn(...args) } catch { return null } }
  const parsed = safe(parseContext, ctxRaw) ?? { passages: new Map(), topical: new Map(), points: new Map() }
  return {
    faithfulness: safe(parseFaithfulness, faithRaw),
    answerRelevance: safe(parseRelevance, relRaw),
    contextPrecision: contextPrecision(parsed, contexts.length),
    contextRecall: contextRecall(parsed, goldPoints.length),
  }
}

/**
 * Deterministic answer-level coverage (RGB's own "noise robustness" shape).
 *
 * The judge-based context precision could not separate topically-right-but-wrong
 * passages (measured twice), so the noise control is ALSO measured the way RGB's
 * paper does it: put the wrong passages first, let the model answer, and check
 * whether the answer still covers the gold key points. Character-overlap is a
 * crude proxy, but it is deterministic, free, and cannot be talked out of a
 * finding by a language model.
 * @param answer - the model's answer.
 * @param points - the gold key points.
 * @returns the fraction of points the answer covers.
 */
const coverage = (answer, points) => {
  if (points.length === 0) return 0
  const text = String(answer)
  let hit = 0
  for (const point of points) {
    const chars = [...String(point).replace(/\s+/g, '')]
    if (chars.length === 0) continue
    const overlap = chars.filter((ch) => text.includes(ch)).length / chars.length
    if (overlap >= 0.6) hit += 1
  }
  return hit / points.length
}

const healthy = []
const controls = { unfaithful: [], offtopic: [], noiseContext: [], healthyCoverage: [], noiseCoverage: [], substitutedCoverage: [], substitutedRefusal: [] }
for (const record of sample) {
  const query = String(record.query)
  const gold = asContexts(record.positive ?? [])
  const points = pointsOf(record.answer)
  const answer = await ports.answer.answer(query, gold)
  const scores = await judgeTriple(query, answer, gold, points)
  healthy.push(scores)
  controls.healthyCoverage.push(coverage(answer, points))
  // C3'(答案级,确定性): 把"看着对其实错"的段排在最前,答案还覆盖得住金标要点吗?
  const noisyAnswer = await ports.answer.answer(query, asContexts([...(record.positive_wrong ?? []), ...(record.positive ?? [])]))
  controls.noiseCoverage.push(coverage(noisyAnswer, points))
  // C3''(替换式,做硬的对照): 只给"看着对其实错"的段,金标段**不在场**。
  // 正确的资料没出现时,模型要么如实说"资料未提及",要么照着错段答错——两种都必须体现在数字上。
  const substitutedAnswer = await ports.answer.answer(query, asContexts(record.positive_wrong ?? []))
  controls.substitutedCoverage.push(coverage(substitutedAnswer, points))
  controls.substitutedRefusal.push(/未提及|没有提到|无法从资料|资料中没有/.test(String(substitutedAnswer)) ? 1 : 0)
  console.log(`[d3] #${record.id} faith=${scores.faithfulness} rel=${scores.answerRelevance} cprec=${scores.contextPrecision.toFixed(2)} crec=${scores.contextRecall.toFixed(2)}`)

  // C1: the dataset's own fabricated answer must score LOWER on faithfulness.
  const fake = await judgeTriple(query, String(record.fakeanswer ?? '无关内容'), gold, points)
  controls.unfaithful.push(fake.faithfulness)

  // C2: an off-topic answer must score LOWER on answer relevance.
  const off = await judgeTriple(query, '本仓库要求使用两个空格缩进,并禁止使用 any 类型。', gold, points)
  controls.offtopic.push(off.answerRelevance)

  // C3: passages that look right but are wrong must score LOWER on context precision.
  const noisy = asContexts([...(record.positive_wrong ?? []), ...(record.positive ?? [])])
  const noise = await judgeTriple(query, answer, noisy, points)
  controls.noiseContext.push(noise.contextPrecision)
}

const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const healthyMeans = {
  faithfulness: mean(healthy.map((s) => s.faithfulness ?? 0)),
  answerRelevance: mean(healthy.map((s) => s.answerRelevance ?? 0)),
  contextPrecision: mean(healthy.map((s) => s.contextPrecision)),
  contextRecall: mean(healthy.map((s) => s.contextRecall)),
}
const controlMeans = {
  unfaithful: mean(controls.unfaithful.map((v) => v ?? 0)),
  offtopic: mean(controls.offtopic.map((v) => v ?? 0)),
  noiseContext: mean(controls.noiseContext),
}
const coverageDrop = mean(controls.healthyCoverage) - mean(controls.noiseCoverage)
const substitutedDrop = mean(controls.healthyCoverage) - mean(controls.substitutedCoverage)
// `noiseAnswerLevel`(追加式噪声)保留为**参考行**,不作为通过判据:实测证明金标段仍在场时
// 模型不会被带偏,该对照制造不出失败 —— 把"测不出失败"当成"通过"才是真的作假。
const caught = {
  noiseAnswerLevel: coverageDrop > 0.1,
  // 替换式对照:金标资料不在场时,答案覆盖金标要点的比例必须下降
  noiseSubstituted: substitutedDrop > 0.1,
  unfaithful: controlMeans.unfaithful < healthyMeans.faithfulness - 0.1,
  offtopic: controlMeans.offtopic < healthyMeans.answerRelevance - 0.1,
  noiseContext: controlMeans.noiseContext < healthyMeans.contextPrecision - 0.05,
}
const effective = { unfaithful: caught.unfaithful, offtopic: caught.offtopic, noiseSubstituted: caught.noiseSubstituted }
const report = buildReport({
  generatedAt: new Date().toISOString(),
  dataset: 'rgb/zh',
  split: 'eval',
  corpus: { documents: sample.reduce((sum, r) => sum + (r.positive?.length ?? 0), 0), queries: sample.length },
  ks: [10],
  answer: { id: ports.answer.id },
  judge: { id: ports.judge.id, promptVersion: JUDGE_PROMPT_VERSION },
  rows: [
    { config: 'healthy(金标段 → 答题 → 判分)', metrics: healthyMeans },
    { config: '负对照: 编造答案(fakeanswer)', metrics: { faithfulness: controlMeans.unfaithful } },
    { config: '负对照: 答非所问', metrics: { answerRelevance: controlMeans.offtopic } },
    { config: '负对照: 掺入看着对其实错的段(positive_wrong)', metrics: { contextPrecision: controlMeans.noiseContext } },
    { config: '负对照(答案级,确定性): 错段在前时答案覆盖金标要点的比例', metrics: { answerCoverage: mean(controls.noiseCoverage) } },
    { config: '参考: 健康段下答案覆盖金标要点的比例', metrics: { answerCoverage: mean(controls.healthyCoverage) } },
    { config: '负对照(替换式): 只错段、金标不在场时答案覆盖金标要点的比例', metrics: { answerCoverage: mean(controls.substitutedCoverage), refusesRate: mean(controls.substitutedRefusal) } },
  ],
  cost: { calls: ports.stats.calls, chars: ports.stats.chars, seconds: Math.round(ports.stats.ms / 100) / 10, failedCalls: ports.stats.failedCalls },
  caveats: [
    'RGB 的坏例来自数据集本身(fakeanswer / positive_wrong),比自造坏例更硬',
    '样本很小(本轮 ' + sample.length + ' 条):数字是"链路是否走得通 + 判分器是否抓得住坏例"的证据,不是 RGB 榜上的成绩',
    '检索侧在本轮用数据集给的金标段(不经过我们的检索器):先验证判分链路,D4 再接检索',
    '三条判据 = 编造答案 / 答非所问 / 替换式噪声(金标不在场);"追加式噪声"实测制造不出失败,只作参考行不计入通过判据',
    '判分式 context precision 仍无法区分"主题对但事实错"的段 ⇒ 该项在报告里保持"未证明"',
  ],
  ok: Object.values(effective).every(Boolean),
})
await mkdir(path.join(repoRoot, 'evals', 'runs'), { recursive: true })
const out = path.join(repoRoot, 'evals', 'runs', `${report.generatedAt.replace(/[:.]/g, '-')}_rgb-zh_${JUDGE_PROMPT_VERSION}.json`)
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log('')
console.log(`[d3] 健康样本: faithful ${healthyMeans.faithfulness.toFixed(2)} · relevance ${healthyMeans.answerRelevance.toFixed(2)} · cprec ${healthyMeans.contextPrecision.toFixed(2)} · crec ${healthyMeans.contextRecall.toFixed(2)}`)
console.log(`[d3] 负对照: 编造答案 faithful ${controlMeans.unfaithful.toFixed(2)} · 答非所问 relevance ${controlMeans.offtopic.toFixed(2)} · 噪声段 cprec ${controlMeans.noiseContext.toFixed(2)}`)
console.log(`[d3] 答案级噪声鲁棒(RGB 口径): 健康 ${mean(controls.healthyCoverage).toFixed(2)} → 错段在前 ${mean(controls.noiseCoverage).toFixed(2)}(降 ${coverageDrop.toFixed(2)})`)
console.log(`[d3] 替换式对照(金标不在场): 覆盖 ${mean(controls.healthyCoverage).toFixed(2)} → ${mean(controls.substitutedCoverage).toFixed(2)}(降 ${substitutedDrop.toFixed(2)}) · 如实说"未提及"的比例 ${mean(controls.substitutedRefusal).toFixed(2)}`)
console.log(`[d3] 判分器/指标抓到坏例: ${JSON.stringify(caught)}`)
console.log(`[d3] 成本: 调用 ${ports.stats.calls}(失败 ${ports.stats.failedCalls}) · 字符 ${ports.stats.chars} · ${(ports.stats.ms / 1000).toFixed(1)}s`)
console.log(`[d3] 报告: ${path.relative(repoRoot, out)}`)
await host.close()
