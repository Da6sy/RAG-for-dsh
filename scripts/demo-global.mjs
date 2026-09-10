/**
 * M5 demo — the global-library acceptance line through the REAL CLI:
 *
 *   项目 A 的门禁验证过一条坑(evidence-pass) · 项目 B 四次人工确认攒批升为可信
 *   → `clue kb generalize` 发现同类知识跨项目验证 → 全局候选 + 泛化提议入队
 *   → 人批 → 全局可信 → 项目 C(从没见过这条知识)检索命中,带"来自全局库"标注。
 *
 * Every step is a real `clue kb` subprocess; the script parses ids out of the
 * command outputs and asserts the chain, then prints the transcript for the
 * M5 record. Keyless, browser-free, temp-home isolated.
 *
 * Run: node scripts/demo-global.mjs
 *
 * @module @clue-harness/scripts/demo-global
 */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const BIN = path.join(repoRoot, 'apps/cli/src/bin.ts')
const transcript = []

/**
 * Run one `clue kb ...` command, recording it into the transcript.
 * @param label - human step name.
 * @param args - kb subcommand + flags.
 * @returns stdout (trimmed).
 */
async function kb(label, args) {
  const { stdout } = await run(process.execPath, [BIN, 'kb', ...args], { timeout: 60_000 })
  const out = stdout.trim()
  transcript.push(`$ clue kb ${args.join(' ')}\n${out.split('\n').map((l) => `  ${l}`).join('\n')}`)
  console.log(`[demo-global] ${label}`)
  for (const line of out.split('\n').slice(0, 4)) console.log(`    ${line}`)
  if (out === '') throw new Error(`${label}: 命令无输出`)
  return out
}

const must = (condition, message) => {
  if (!condition) throw new Error(`断言失败: ${message}`)
}

const workdir = await mkdtemp(path.join(tmpdir(), 'clue-demo-global-'))
const projA = path.join(workdir, 'projA')
const projB = path.join(workdir, 'projB')
const projC = path.join(workdir, 'projC')
const home = path.join(workdir, 'clue-home')
for (const dir of [projA, projB, projC]) await mkdir(dir, { recursive: true })

try {
  // ── 项目 A: 一条被门禁客观验证过的坑 ─────────────────────────────────
  const addA = await kb('A: 入库踩坑知识', [
    'add', '--project', projA, '--home', home,
    '--kind', 'pitfall', '--title', '悬浮按钮别掉出 Tab 顺序',
    '--text', '本项目评审踩过三次:绝对定位的提交按钮必须检查键盘可达性。',
  ])
  const idA = /已入库\(候选\):\s+(\S+)/.exec(addA)?.[1]
  must(idA !== undefined, 'add 输出必须携带条目 id')
  await kb('A: 记录门禁复验通过(客观验证)', [
    'signal', idA, 'evidence-pass', '--project', projA, '--home', home, '--note', '门禁复验通过',
  ])

  // ── 项目 B: 同一条坑,走人工攒批升为可信 ──────────────────────────────
  const addB = await kb('B: 入库同类知识(措辞不同)', [
    'add', '--project', projB, '--home', home,
    '--kind', 'pitfall', '--title', '悬浮按钮别掉出 Tab 顺序',
    '--text', '浮动胶囊按钮要保留焦点顺序,键盘用户必须能到达提交按钮。',
  ])
  const idB = /已入库\(候选\):\s+(\S+)/.exec(addB)?.[1]
  must(idB !== undefined, 'add 输出必须携带条目 id')
  for (let i = 1; i <= 4; i += 1) {
    await kb(`B: 第 ${i} 次人工确认(阈值 ±20 需四次)`, [
      'signal', idB, 'human-confirm', '--project', projB, '--home', home, '--note', `第${i}次确认`,
    ])
  }
  const sweepB = await kb('B: sweep 生成提升建议', ['sweep', '--project', projB, '--home', home])
  must(sweepB.includes('待批提升'), 'sweep 应产生提升建议')
  const approvalsB = await kb('B: 查看待批队列', ['approvals', '--project', projB, '--home', home])
  const requestB = approvalsB.split('\n')[0].split(/\s+/)[0]
  await kb('B: 人工批准提升为可信', ['approve', requestB, '--project', projB, '--home', home])

  // ── 泛化扫描: 跨项目同类已验证知识 → 全局候选 + 提议 ──────────────────
  const general = await kb('泛化扫描', ['generalize', '--project', projA, '--home', home])
  must(general.includes('泛化提议'), '应产生泛化提议')
  const requestG = /已入待批队列\(([^)]+)\)/.exec(general)?.[1]
  must(requestG !== undefined, '泛化提议必须带审批请求 id')

  // ── 人批泛化(决策 #14: 泛化提议必须人批) ────────────────────────────
  const approvalsG = await kb('查看全局待批队列', ['approvals', '--project', projA, '--home', home])
  must(approvalsG.includes(requestG), '全局队列必须列出泛化提议')
  const approved = await kb('人工批准泛化', ['approve', requestG, '--project', projA, '--home', home])
  must(approved.includes('trusted'), '批准后全局条目必须是 trusted')

  // ── 第三个项目(从没见过这条知识)检索命中 ─────────────────────────────
  const hits = await kb('C: 检索(项目库为空)', ['query', '悬浮按钮 Tab 顺序', '--project', projC, '--home', home, '--no-touch'])
  must(hits.includes('全局'), 'C 项目必须命中全局层')
  must(hits.includes('来自全局库'), '命中必须带全局层标注')

  // ── 重复扫描不重复提案 ────────────────────────────────────────────────
  const again = await kb('重复泛化扫描(去重)', ['generalize', '--project', projA, '--home', home])
  must(again.includes('没有新的泛化提议') || again.includes('已存在'), '重复扫描不得重复提案')

  console.log('\n[demo-global] 演示成功: 两项目验证 → 泛化提议 → 人批 → 第三项目检索可见 → 去重成立')
} catch (error) {
  console.error('[demo-global] 失败:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  console.log('\n── 演示实录 ──')
  for (const block of transcript) console.log(block)
  await rm(workdir, { recursive: true, force: true })
  void pathToFileURL
}
