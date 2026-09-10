/**
 * M4 demo — the FULL evidence loop with a REAL model (M3b's deferred debt ①).
 *
 * The keyless gate-loop test proves the mechanics with a scripted model;
 * this script proves the PRODUCT LINE with a real one:
 *
 *   真实模型收到"悬浮胶囊按钮"需求 → pre-step 检索先注入踩坑知识
 *   → 模型若仍写坏:门禁真浏览器验证拦下 → 失败签名检索先例 → 报告+知识
 *     注入同轮续跑 → 模型修复(期望它 kb_cite) → 复验通过
 *   → 模型若一次写对:门禁放行,注入的知識就是它写对的原因(同样是赢)
 *
 * Both outcomes are reported honestly — the script asserts ledger/log
 * consistency for whichever path the model took, and finishes by re-inspecting
 * the final page with the real browser (the last word is evidence, not text).
 *
 * Needs: DEEPSEEK_API_KEY (env or .env layer — the CLI composition's
 * llm-deepseek adapter) + playwright chromium. Self-skips without the key.
 *
 * Run: node scripts/demo-gate.mjs
 *
 * @module @clue-harness/scripts/demo-gate
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const log = (...parts) => console.log('[demo-gate]', ...parts)

// Isolation: CLUE_HOME + cwd are temp; DSH_HOME is ASSIGNED the ClueHarness
// host home (~/.clue/host, CLUE_HOST_HOME overrides) exactly like bin/web do
// — never inherited, so the demo runs on clue's own migrated settings and
// credentials, independent of dsh's ~/.dsh.
const workdir = await mkdtemp(path.join(tmpdir(), 'clue-demo-gate-'))
const project = path.join(workdir, 'proj')
await mkdir(project, { recursive: true })
process.chdir(project)
process.env.CLUE_HOME = path.join(workdir, 'clue-home')
{
  const { clueHostHome } = await import('@clue-harness/util')
  process.env.DSH_HOME = process.env.CLUE_HOST_HOME ?? clueHostHome()
}

try {
  const { loadLayeredEnv, installFailLoud } = await import('@deepseek-ai/dsh-app-boot')
  loadLayeredEnv('clue')
  if ((process.env.DEEPSEEK_API_KEY ?? '') === '') {
    log('跳过: 未找到 DEEPSEEK_API_KEY(env 或 .env 层)。配好 key 后重跑即转真实模型演示。')
    process.exitCode = 0
    throw new Error('__skip__')
  }
  installFailLoud('clue')

  // ── seed: page + the trusted pitfall the model is about to need ────────
  const PAGE_GOOD = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>注册</title></head>
<body><main>
<form data-module="signup">
  <input type="email" placeholder="邮箱">
</form>
</main></body></html>
`
  await writeFile(path.join(project, 'page.html'), PAGE_GOOD)
  const { openProjectStore, readSignals } = await import('@clue-harness/kb')
  const store = await openProjectStore(project, process.env.CLUE_HOME)
  const pitfall = await store.add({
    kind: 'pitfall',
    title: '悬浮按钮的可访问性',
    text: '浮动定位的操作按钮不要移出焦点顺序(不要加 tabindex=-1),键盘用户必须能 Tab 到达它;修复:回到文档流或用可见焦点样式。',
    tags: ['按钮', '可访问性'],
    bindings: ['page.html'],
    createdBy: 'agent:earlier-session',
  })
  await store.transition(pitfall.id, 'trusted', 'approve-promote', '演示前置:已批准为可信')
  log(`种子: 可信踩坑知识「悬浮按钮的可访问性」(${pitfall.id}),绑定 page.html`)

  // ── boot the real CLI composition and a real-model agent ───────────────
  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  const { createUserMessage, SessionId } = await import('@clue-harness/compat')
  const configPath = path.join(repoRoot, 'apps/cli/src/clue.cordis.yml')
  const ctx = await boot('clue-demo-gate', configPath)
  const agent = ctx.agentLoop.create(
    SessionId('demo-gate-m4'),
    { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    { cwd: project },
  )
  const idle = new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '给注册表单加一个提交按钮,做成右下角悬浮胶囊样式,注意不要抢占焦点。改 page.html。' }],
    source: { kind: 'user' },
  }))
  log('真实模型开跑(deepseek-v4-flash)…等轮次收尾(含可能的门禁续跑)')
  await Promise.race([
    idle,
    new Promise((_, reject) => setTimeout(() => reject(new Error('轮次超时(5 分钟)')), 300_000)),
  ])

  // ── what happened? the log is the truth ────────────────────────────────
  const events = [...agent.session.events]
  const pluginTexts = events
    .filter((e) => e.type === 'user/message' && e.data.source?.kind === 'plugin')
    .map((e) => e.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'))
  const preStep = pluginTexts.find((text) => text.includes('<kb_context'))
  const gateFired = pluginTexts.filter((text) => text.includes('<render_evidence'))
  const toolCalls = events.filter((e) => e.type === 'tool/call').map((e) => e.data.name ?? e.data.toolName)
  const turnEnd = events.findLast((e) => e.type === 'turn/end')

  log(`pre-step 检索注入: ${preStep !== undefined ? `命中(含踩坑条目: ${preStep.includes(String(pitfall.id))})` : '未命中'}`)
  log(`工具调用序列: ${toolCalls.join(' → ')}`)
  if (gateFired.length === 0) {
    log('路径 A: 门禁未触发 — 模型一次写对(注入的知识起了作用,或它本来就没踩坑)')
  } else {
    log(`路径 B: 门禁触发 ${gateFired.length} 次(拦截 → 注入报告+先例 → 同轮续跑修复)`)
    const first = gateFired[0]
    log(`  注入含失败断言: ${first.includes('Tab')},含先例块: ${first.includes('<kb_assist')},含踩坑条目: ${first.includes(String(pitfall.id))}`)
  }
  log(`kb_cite 调用: ${toolCalls.includes('kb_cite') ? '有(精确归因)' : '无(归因走曝光集回退)'}`)
  log(`turn 收尾: ${JSON.stringify(turnEnd?.data?.reason)}`)

  // ── the last word is EVIDENCE: re-inspect the final page ───────────────
  const { inspectPage } = await import('@clue-harness/evidence-render')
  const final = await inspectPage({ projectRoot: project, page: 'page.html', mode: 'show' })
  log(`终态渲染验证: exitOk=${final.exitOk}(assertions: ${final.snapshot?.assertions.filter((a) => !a.pass).length ?? 0} 项未过)`)

  const signals = (await readSignals(path.join(store.dir, 'signals.jsonl'))).filter((s) => s.entryId === pitfall.id)
  log(`踩坑条目信号账本: ${signals.map((s) => `${s.polarity}/${s.source}(${s.weight > 0 ? '+' : ''}${s.weight})`).join(', ') || '(空)'}`)
  const after = await store.get(pitfall.id)
  log(`条目终态: status=${after.status} needsReview=${after.needsReview}(修复改写了绑定文件 → 待复核是诚实的)`)
  log(`最终 page.html 提交按钮行: ${(await readFile(path.join(project, 'page.html'), 'utf8')).split('\n').filter((l) => l.includes('button')).map((l) => l.trim()).join(' / ')}`)

  // Consistency gate for the demo itself: whichever path ran, the final
  // page must pass and the turn must have completed.
  const ok = final.exitOk && turnEnd?.data?.reason?.kind === 'completed'
  log(ok ? '演示成功: 证据链闭环(最终页面通过真实浏览器验证)' : '演示异常: 终态未通过或轮次未正常收尾')
  await ctx.fiber.dispose()
  process.exitCode = ok ? 0 : 1
} catch (error) {
  if (error instanceof Error && error.message === '__skip__') { /* skip path, exit code already 0 */ }
  else {
    console.error('[demo-gate] 失败:', error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
} finally {
  process.chdir(repoRoot)
  await rm(workdir, { recursive: true, force: true })
}
