/**
 * KB dogfood harness — does the knowledge base actually work on a real repo?
 *
 * Rounds run against ~/app/dogfood-playground (a scratch project; its KB
 * lives in clue-harness/.dogfood-home, isolated from your real ~/.clue):
 *
 *   round 1 (学习): 诱导模型把提交按钮做成悬浮胶囊(大概率加 tabindex=-1)
 *          → 门禁拦 → 注入判例 → 修复 → (期望)kb_propose 提案 → 脚本批准
 *   round 2..N (使用): 换目标复现同类场景(邮箱框悬浮)
 *          U1 检索注入: 新会话的 <kb_context> 里必须出现 round-1 学到的条目 id
 *          U2 最终页面: 真浏览器复验必须干净(无 tabindex 违规)
 *          U3 主动性:   模型是否真的调用了 kb_search / kb_cite
 *
 * Modes:
 *   --mock   scripted model (no API calls, no cost): pins the HARNESS —
 *            gates, injections, approvals, assertions all fire correctly.
 *   (default) real model through the real web composition (your dsh-home
 *            settings/credentials); sessions/storage/persistence redirected
 *            into .dogfood-home. --provider/--model override the default.
 *
 * Usage:
 *   node scripts/dogfood-kb.mjs --mock
 *   node scripts/dogfood-kb.mjs --rounds 3 --provider <route> --model <id>
 *   --fresh  wipe .dogfood-home first
 *
 * @module @clue-harness/scripts/dogfood-kb
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const playground = path.join(repoRoot, '..', 'dogfood-playground') // 只读的基准页来源
const dh = path.join(repoRoot, '.dogfood-home')
// M8 (workspace-bound KB): the script works in its OWN scratch project inside
// .dogfood-home — its KB lands at <scratch>/.clue/kb and --fresh wipes it all.
// The shared playground keeps exclusively the user's manual-round knowledge.

// ── args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flagOf = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const MOCK = argv.includes('--mock')
const LIST = argv.includes('--list')
const FRESH = argv.includes('--fresh')
const ROUNDS = Math.max(2, Number(flagOf('rounds') ?? '2'))
const PROVIDE = flagOf('provider')
const MODEL = flagOf('model')

if (!existsSync(path.join(playground, 'index.pristine.html'))) {
  console.error('缺靶场基准页: ~/app/dogfood-playground/index.pristine.html')
  process.exit(2)
}
if (FRESH && existsSync(dh)) await rm(dh, { recursive: true, force: true })
await mkdir(path.join(dh, 'logs'), { recursive: true })

const log = (...p) => console.log('[dogfood]', ...p)
const now = () => new Date().toISOString()
process.on('uncaughtException', (e) => { console.error('[dogfood][uncaught]', e); process.exit(3) })
process.on('unhandledRejection', (e) => { console.error('[dogfood][unhandled]', e); process.exit(4) })

// ── prompts & fixtures ─────────────────────────────────────────────────────
const LEARN_PROMPT =
  '修改 index.html:把提交按钮做成固定在右下角的悬浮胶囊样式,并且不要让它抢走键盘焦点(改之前先读一下文件)。'
  + '若这次改动暴露了值得长期记住的可访问性坑,用 kb_propose 提案入库(绑定 index.html)。'
const USE_PROMPT =
  '再改一下 index.html:把邮箱输入框也做成右下角悬浮小工具条的一部分,同样别抢键盘焦点(先读后改)。'
const MOCK_BAD = (base) => base.replace(
  '<button data-module="submit-btn" type="submit">提交</button>',
  '<button data-module="submit-btn" type="submit" tabindex="-1" style="position:fixed;right:24px;bottom:24px;border-radius:999px">提交</button>',
)
const MOCK_GOOD = (base) => base.replace(
  '<button data-module="submit-btn" type="submit">提交</button>',
  '<button data-module="submit-btn" type="submit" style="position:fixed;right:24px;bottom:24px;border-radius:999px">提交</button>',
)

// ── environment BEFORE any dsh-app-boot import ─────────────────────────────
const pristine = await readFile(path.join(playground, 'index.pristine.html'), 'utf8')
await mkdir(path.join(dh, 'proj'), { recursive: true })
process.chdir(path.join(dh, 'proj'))
if (MOCK) {
  process.env.DSH_HOME = path.join(dh, 'dsh-home')
  process.env.CLUE_HOME = path.join(dh, 'kb-mock')
} else {
  // real mode keeps the REAL DSH_HOME (settings + credentials for the model);
  // the KB and session logs go to .dogfood-home.
  process.env.CLUE_HOME = path.join(dh, 'kb')
}
delete process.env.DSH_TELEMETRY_DISABLED // base config governs

const { boot, loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot')
const { CallId, createUserMessage, LlmAdapter, SessionId } = await import('@clue-harness/compat')
const { openProjectStore } = await import('@clue-harness/kb')
const { inspectPage } = await import('@clue-harness/evidence-render')

// CLI composition (the proven agent-loop posture of gate-loop.test); durable
// sessions redirect into .dogfood-home so the playground stays clean.
loadLayeredEnv('clue')
const configPath = fileURLToPath(new URL('../apps/cli/src/clue.cordis.yml', import.meta.url))
const ctx = await boot('clue-dogfood', configPath, [
  { id: 'persistence', config: { root: path.join(dh, 'sessions') } },
])
log(`组合已启动 (${MOCK ? 'MOCK' : 'REAL'}),会话/账本隔离于 .dogfood-home`)

if (LIST) {
  for (const p of ctx.llm.listProviders()) console.log(`provider 路线: ${p.provider ?? p.name ?? JSON.stringify(p)}`)
  console.log('模型 id 在 ~/.dsh/settings.yaml 的 llm-pi-ai: 段(或 clue web 模型选择器)可查。')
  await ctx.fiber.dispose()
  process.exit(0)
}

let releaseAdapter = () => {}
if (MOCK) {
  class ScriptedAdapter extends LlmAdapter {
    constructor(calls) { super(); this.calls = calls; this.index = 0 }
    stream() {
      const spec = this.calls[Math.min(this.index, this.calls.length - 1)]
      this.index += 1
      return (async function* () {
        if ('toolCall' in spec) {
          const block = { type: 'tool-call', id: CallId(spec.toolCall.id), name: spec.toolCall.name, arguments: JSON.stringify(spec.toolCall.args) }
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block }
          yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: spec.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: spec.text } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
  }
  // The adapter per round is installed right before that round's agent runs.
  globalThis.__mockAdapter = (script) => {
    releaseAdapter()
    releaseAdapter = ctx.llm.registerAdapter(['mock-dogfood'], new ScriptedAdapter(script))
    return { provider: 'mock-dogfood', model: 'mock' }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
const projectRoot = path.join(dh, 'proj')
await mkdir(projectRoot, { recursive: true })
process.chdir(projectRoot)
const kbStore = await openProjectStore(projectRoot, process.env.CLUE_HOME)

function waitForIdle(agent, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`轮次超时(${timeoutMs / 1000}s)——真实模型慢或路由不对?用 --provider/--model 指定`)) }, timeoutMs)
    const off = ctx.on('agent/status', ({ agent: a, status }) => {
      if (a === agent && status === 'idle') { clearTimeout(timer); off(); resolve() }
    })
  })
}
function pluginTexts(agent) {
  const out = []
  for (const e of agent.session.events) {
    if (e.type !== 'user/message') continue
    const d = e.data
    if (d?.source?.kind !== 'plugin') continue
    out.push((d.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'))
  }
  return out
}
function toolCallNames(agent) {
  const names = []
  for (const e of agent.session.events) {
    if (e.type !== 'assistant/message') continue
    // The call model: tool-call blocks ride the assistant message itself
    // (the tool/call event line exists only in the surface envelope).
    for (const b of (e.data?.message?.content ?? [])) {
      if (b?.type === 'tool-call' && typeof b.name === 'string') names.push(b.name)
    }
  }
  return names
}
async function resetPage() { await writeFile(path.join(projectRoot, 'index.html'), pristine) }
async function dumpLog(r, agent) {
  await writeFile(path.join(dh, 'logs', `round-${r}.json`),
    JSON.stringify([...agent.session.events].map(({ type, data }) => ({ type, data })), null, 1))
}

// ── rounds ─────────────────────────────────────────────────────────────────
const results = []
let learnedIds = []
let hadModelError = false

for (let r = 1; r <= ROUNDS; r += 1) {
  await resetPage()
  const role = r === 1 ? 'learn' : 'use'
  const before = (await kbStore.list()).filter((e) => e.provenance.createdBy.startsWith('agent:'))

  let route
  if (MOCK) {
    route = globalThis.__mockAdapter(role === 'learn' ? [
      { toolCall: { id: `r${r}rd`, name: 'read', args: { file_path: 'index.html' } } },
      { toolCall: { id: `r${r}w1`, name: 'write', args: { file_path: 'index.html', content: MOCK_BAD(pristine) } } },
      { text: '悬浮胶囊做完了,用了 tabindex=-1 防止抢焦点。' },
      { toolCall: { id: `r${r}w2`, name: 'write', args: { file_path: 'index.html', content: MOCK_GOOD(pristine) } } },
      { toolCall: { id: `r${r}p1`, name: 'kb_propose', args: {
        kind: 'pitfall', title: '悬浮按钮别掉出 Tab 顺序',
        text: '用 position:fixed 做悬浮控件时不要加 tabindex=-1:那会让它掉出 Tab 顺序,键盘用户不可达;用 CSS 悬浮 + 可见焦点样式。',
        bindings: 'index.html',
      } } },
      { text: '已按门禁报告修复,并把坑提案入库。' },
    ] : [
      { toolCall: { id: `r${r}s1`, name: 'kb_search', args: { query: '悬浮 键盘 焦点 tabindex' } } },
      { toolCall: { id: `r${r}rd`, name: 'read', args: { file_path: 'index.html' } } },
      { toolCall: { id: `r${r}w1`, name: 'write', args: { file_path: 'index.html', content: MOCK_GOOD(pristine) } } },
      { text: '悬浮工具条完成,保留键盘可达,无 tabindex。' },
    ])
  } else {
    route = { provider: PROVIDE ?? ctx.get('agentDefaultModel')?.provider, model: MODEL ?? ctx.get('agentDefaultModel')?.model }
  }
  if (!route.provider || !route.model) { console.error('无可用模型路由:用 --provider/--model 指定'); process.exit(2) }

  const agent = ctx.agentLoop.create(SessionId(`dogfood-${r}-${Date.now()}`), { provider: route.provider, model: route.model }, { cwd: projectRoot })
  const prompt = role === 'learn' ? LEARN_PROMPT : USE_PROMPT
  log(`── round ${r} (${role}) 开始 [${route.provider}/${route.model}]`)
  const t0 = Date.now()
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  log(`round ${r}: followup 已投递,等待 idle…`)
  let error = null
  try { await waitForIdle(agent, MOCK ? 60_000 : 900_000) } catch (e) { error = String(e.message ?? e) }
  log(`round ${r}: waitForIdle 返回 (error=${error ?? 'none'})`)
  const secs = ((Date.now() - t0) / 1000).toFixed(0)

  const texts = pluginTexts(agent)
  const gateFired = texts.some((t) => t.includes('<render_evidence'))
  // Error-turn detection: a 429/auth/timeout turn must NEVER masquerade as
  // a clean run (the first real round taught us: quota exhaustion looked
  // like "gate didn't fire, page stayed pristine" — vacuously green).
  const turnErrors = [...agent.session.events].filter((e) => e.type === 'turn/end' && e.data?.reason?.kind === 'error')
  if (turnErrors.length > 0) {
    hadModelError = true
    log(`  ⚠ 模型调用错误 ×${turnErrors.length}: ${String(turnErrors[0].data?.reason?.error?.message ?? '').slice(0, 160)}`)
  }
  const after = (await kbStore.list()).filter((e) => e.provenance.createdBy.startsWith('agent:'))
  const proposed = after.filter((e) => !before.some((b) => b.id === e.id))

  if (role === 'learn') {
    if (process.env.DOGFOOD_TRACE) {
      const pageNow = await readFile(path.join(projectRoot, 'index.html'), 'utf8')
      const chk = await inspectPage({ projectRoot, page: 'index.html', mode: 'show' })
      log(`  [diag] page 含 tabindex="-1": ${pageNow.includes('tabindex="-1"')} | 手工检验 exitOk=${chk.exitOk} 失败断言=${chk.snapshot?.assertions?.filter((a) => !a.pass).map((a) => a.name).join(',') ?? 'n/a'}`)
    }
    // Approve whatever round-1 proposed (the 审批中心 step, automated).
    for (const entry of proposed.filter((e) => e.status === 'candidate')) {
      const req = await kbStore.requestApproval(entry.id, 'promote', 'dogfood 自动批准(手动轮请在审批中心点)', 0)
      await kbStore.resolveApproval(req.id, true)
      learnedIds.push(String(entry.id))
    }
    log(`round ${r} (${secs}s): 门禁拦截=${gateFired ? '是' : '否'} 提案=${proposed.length} 已批=${learnedIds.length}`)
    if (proposed.length === 0) log('  ⚠ 模型未提案——kb_propose 纪律在真实提示词下的服从度信号')
  } else {
    const injected = texts.find((t) => t.includes('<kb_context')) ?? ''
    const u1 = learnedIds.length === 0 ? null : learnedIds.some((id) => injected.includes(id))
    const finalCheck = await inspectPage({ projectRoot, page: 'index.html', mode: 'show' })
    const u2 = finalCheck.exitOk === true
    const u3 = toolCallNames(agent).some((n) => n === 'kb_search' || n === 'kb_cite')
    results.push({ r, u1, u2, u3 })
    log(`round ${r} (${secs}s): U1 检索注入=${u1 === null ? 'n/a' : u1 ? 'PASS' : 'FAIL'} U2 最终页干净=${u2 ? 'PASS' : 'FAIL'} U3 主动检索/引用=${u3 ? 'PASS' : 'FAIL'}`)
    if (learnedIds.length === 0) log('  ⚠ 无已学知识可注入:学习轮未产出或被跳过——使用轮 U1 无意义')
  }
  if (error) log(`  ⚠ 轮次异常: ${error}`)
  await dumpLog(r, agent)
  log(`  会话日志 → .dogfood-home/logs/round-${r}.json`)
}

// ── summary ────────────────────────────────────────────────────────────────
console.log('\n════════ dogfood 汇总 ════════')
console.log(`模式: ${MOCK ? 'MOCK(验仪表)' : 'REAL(真模型)'}  轮数: ${ROUNDS}  学习并批准的条目: ${learnedIds.length}`)
for (const x of results) {
  console.log(`round ${x.r}: U1(检索注入带所学id)=${x.u1 ?? 'n/a'}  U2(最终页复验干净)=${x.u2}  U3(主动用 kb 工具)=${x.u3}`)
}
// A verdict is only earned with a healthy model AND learned knowledge:
// error turns or an empty learning round make the use-round assertions moot.
const verdict = hadModelError ? 'error' : learnedIds.length === 0 ? 'inconclusive'
  : results.length > 0 && results.every((x) => x.u1 === true && x.u2 === true) ? 'pass' : 'fail'
if (MOCK) {
  console.log(verdict === 'pass'
    ? '\n[mock] 仪表自检通过:门禁/注入/审批/断言全链路工作。'
    : `\n[mock] 仪表自检失败(${verdict})——这是 harness 的 bug,请查看 logs。`)
} else {
  console.log({
    error: '\n[real] 本轮无效:模型调用出错(配额/鉴权/超时)——KB 结论不作数,换路线或等配额后重跑。',
    inconclusive: '\n[real] 不确定:学习轮未产出被批准的知识,U1 没有前提。查 round-1 日志:模型没踩坑(也是信号)还是没提案?',
    pass: '\n[real] 知识库在真模型上正确运作:学到的坑被自动检索注入,使用轮产物干净。',
    fail: '\n[real] 有未通过项——按 logs 定位:没注入?注入未命中?最终页不干净?',
  }[verdict])
}

releaseAdapter()
await ctx.fiber.dispose()
process.exitCode = verdict === 'pass' ? 0 : 1
