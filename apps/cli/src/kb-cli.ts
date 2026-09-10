/**
 * `clue kb` — the M2 manual surface of the knowledge base ("手动增删查,
 * 跑通流程"). Every command is thin: parse → open store(s) → call the
 * engine → print. All lifecycle logic lives in packages/kb.
 *
 *   clue kb add --kind pitfall --title "…" --text "…" [--tag t]… [--bind rel]… [--global]
 *   clue kb list [--status s] [--kind k] [--review] [--global]
 *   clue kb show <id> [--global]
 *   clue kb query <词…> [--include-expired] [--no-global] [--limit n] [--no-touch]
 *   clue kb approvals [--all]
 *   clue kb approve <requestId> | clue kb reject <requestId>
 *   clue kb reverify <id> [--accept]
 *   clue kb signal <id> <human-confirm|evidence-pass|implicit-use|evidence-fail|user-reject> [--note n]
 *   clue kb sweep          (过期/遗弃/清退 + 提升建议入队)
 *   clue kb migrate        (旧中心布局迁入工作区 .clue/kb,决策 #6 修订)
 *   clue kb generalize [--dry-run] [--threshold n]  (跨项目泛化扫描)
 *   clue kb status
 *
 * Exit codes: 0 ok · 2 usage/engine failure (no evidence semantics here —
 * kb is not a gate; the render CLI owns exit code 1).
 *
 * @module @clue-harness/cli/kb
 */
import path from 'node:path'
import {
  KbEntryId,
  openGlobalStore,
  openProjectStore,
  queryKb,
  type KbKind,
  type KbStore,
  type SignalInput,
} from '@clue-harness/kb'
import { buildWorkLog, loadWorkLog, runEvidenceLoop, saveWorkLog, suggestGeneralizations } from '@clue-harness/kb-loop'
import { migrateLegacyProjectKbs } from '@clue-harness/kb'

const USAGE = `用法: clue kb <命令> [选项]

命令:
  add       --kind <fact|decision|snippet|map|pitfall|asset> --title <标题> --text <正文>
            [--tag <标签>]… [--bind <项目相对路径>]… [--note <备注>] [--global]
  list      [--status candidate|trusted|expired|discarded] [--kind k] [--review] [--global]
  show      <id> [--global]          条目全文 + 历史 + 窗口分数
  query     <词…> [--include-expired] [--no-global] [--limit n] [--no-touch]
  approvals [--all]                  待批队列(攒批审批的入口)
  approve   <requestId>              批准(提升/遗弃/捞回/重新激活)
  reject    <requestId>              否决(不记负信号:不批准≠知识错)
  reverify  <id> [--accept]          重验绑定;--accept 接受新内容并更新哈希
  signal    <id> <信号> [--note n]   手动记信号(五个档位见上)
  worklog   --changed <f>… --referenced <id>… [--page p.html] [--out w.json]
                                     生成闭环工单(M3b 起由 agent 自动生成)
  loop      --worklog <w.json> [--mask <sel>]… [--no-inspect] [--no-sweep]
                                     跑一遍证据闭环:分类→(触发才)渲染验证→归因→记信号→维护
  sweep                              维护:过期/强负遗弃/60天清退/提升建议入队
  migrate                            把旧 <home>/kb/<项目名> 布局迁入各工作区 .clue/kb(不覆盖,报告制)
  generalize [--dry-run] [--threshold n]
                                     跨项目泛化扫描:≥2 个项目验证过的同类知识
                                     → 全局候选 + 待批提升(审批后成全局可信)
  status                             总览:各状态计数/待复核/待批/库位置

通用: --project <dir>(默认当前目录;项目库就存在 <dir>/.clue/kb)
      --home <dir>(中心部分:全局库/注册表;默认 $CLUE_HOME 或 ~/.clue)`

const KINDS: KbKind[] = ['fact', 'decision', 'snippet', 'map', 'pitfall', 'asset']
const SIGNALS: SignalInput[] = ['human-confirm', 'evidence-pass', 'implicit-use', 'evidence-fail', 'user-reject']

interface Args {
  command: string
  positional: string[]
  flags: Map<string, string[]>
}

function parse(argv: string[]): Args {
  const command = argv[0] ?? ''
  const positional: string[] = []
  const flags = new Map<string, string[]>()
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const list = flags.get(name) ?? []
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        list.push(next)
        i += 1
      } else {
        list.push('true')
      }
      flags.set(name, list)
    } else {
      positional.push(arg)
    }
  }
  return { command, positional, flags }
}

const flag = (args: Args, name: string): string | undefined => args.flags.get(name)?.[0]
const multi = (args: Args, name: string): string[] => args.flags.get(name)?.filter((v) => v !== 'true') ?? []
const has = (args: Args, name: string): boolean => args.flags.has(name)

async function stores(args: Args): Promise<{ project: KbStore; global: KbStore }> {
  const home = flag(args, 'home')
  const projectRoot = flag(args, 'project') ?? process.cwd()
  return {
    project: await openProjectStore(projectRoot, home),
    global: await openGlobalStore(home),
  }
}

function storeFor(args: Args, both: { project: KbStore; global: KbStore }): KbStore {
  return has(args, 'global') ? both.global : both.project
}

function entryLine(entry: { id: string; kind: string; title: string; status: string; needsReview: boolean; tier: string }): string {
  const review = entry.needsReview ? ' ⚑待复核' : ''
  return `${entry.id}  [${entry.status}${review}]  <${entry.kind}${entry.tier === 'global' ? ',全局' : ''}>  ${entry.title}`
}

/** CLI entry; returns the process exit code. */
export async function kbMain(argv: string[]): Promise<number> {
  const args = parse(argv)
  if (args.command === '' || has(args, 'help') || args.command === 'help') {
    console.log(USAGE)
    return 0
  }
  try {
    const both = await stores(args)
    const store = storeFor(args, both)
    switch (args.command) {
      case 'add': {
        const kind = flag(args, 'kind') as KbKind | undefined
        const title = flag(args, 'title')
        const text = flag(args, 'text')
        if (kind === undefined || !KINDS.includes(kind)) throw new Error(`--kind 必须是 ${KINDS.join('|')} 之一`)
        if (title === undefined || text === undefined) throw new Error('add 需要 --title 与 --text')
        const entry = await store.add({
          kind, title, text,
          tags: multi(args, 'tag'),
          bindings: multi(args, 'bind'),
          note: flag(args, 'note'),
        })
        console.log(`已入库(候选): ${entryLine(entry)}`)
        if (entry.bindings.length > 0) console.log(`  绑定: ${entry.bindings.map((b) => `${b.path}@${b.contentHash.slice(0, 8)}`).join(', ')}`)
        return 0
      }
      case 'list': {
        const status = flag(args, 'status')
        const kind = flag(args, 'kind')
        const entries = await store.list({
          ...(status !== undefined ? { status: status as never } : {}),
          ...(kind !== undefined ? { kind: kind as never } : {}),
          ...(has(args, 'review') ? { needsReview: true } : {}),
        })
        for (const entry of entries) console.log(entryLine(entry))
        console.log(`共 ${entries.length} 条(${store.tier === 'global' ? '全局库' : `项目库 ${store.dir}`})`)
        return 0
      }
      case 'show': {
        const id = args.positional[0]
        if (id === undefined) throw new Error('show 需要条目 id')
        const entry = await store.get(KbEntryId(id))
        if (entry === null) throw new Error(`条目不存在: ${id}`)
        const score = await store.score(entry.id)
        console.log(JSON.stringify({ ...entry, windowScore: score }, null, 2))
        return 0
      }
      case 'query': {
        const text = args.positional.join(' ')
        if (text.trim() === '') throw new Error('query 需要检索词')
        const hits = await queryKb(
          both.project,
          has(args, 'no-global') ? null : both.global,
          {
            text,
            includeExpired: has(args, 'include-expired'),
            limit: flag(args, 'limit') !== undefined ? Number(flag(args, 'limit')) : undefined,
            noTouch: has(args, 'no-touch'),
          },
        )
        if (hits.length === 0) { console.log('没有命中。'); return 0 }
        for (const hit of hits) {
          console.log(`▸ [${hit.score}] ${entryLine(hit.entry)}`)
          console.log(`  命中: ${hit.matched.join(', ')}`)
          for (const note of hit.annotations) console.log(`  ⚠ ${note}`)
        }
        return 0
      }
      case 'approvals': {
        const seen = new Set<string>()
        for (const tier of [both.project, both.global]) {
          const requests = await tier.listApprovals(!has(args, 'all'))
          for (const request of requests) {
            seen.add(request.id)
            const entry = await tier.get(request.entryId)
            console.log(`${request.id}  [${request.action}]  分数${request.scoreAtRequest}  ${request.reason}`)
            if (entry !== null) console.log(`  → ${entryLine(entry)}`)
          }
        }
        if (seen.size === 0) console.log(has(args, 'all') ? '队列为空。' : '没有待批请求(sweep 会按分数生成提升建议)。')
        return 0
      }
      case 'approve':
      case 'reject': {
        const requestId = args.positional[0]
        if (requestId === undefined) throw new Error(`${args.command} 需要请求 id`)
        for (const tier of [both.project, both.global]) {
          const pending = await tier.listApprovals(true)
          if (!pending.some((a) => a.id === requestId)) continue
          const { request, entry } = await tier.resolveApproval(requestId, args.command === 'approve')
          console.log(`${args.command === 'approve' ? '已批准' : '已否决'} [${request.action}] ${request.entryId}`)
          if (entry !== null) console.log(`  → ${entryLine(entry)}`)
          return 0
        }
        throw new Error(`待批请求不存在: ${requestId}`)
      }
      case 'reverify': {
        const id = args.positional[0]
        if (id === undefined) throw new Error('reverify 需要条目 id')
        const entry = await store.reverify(KbEntryId(id), has(args, 'accept'))
        console.log(`重验完成: ${entryLine(entry)}${entry.needsReview ? `(仍需复核: ${entry.reviewReason})` : ''}`)
        return 0
      }
      case 'signal': {
        const id = args.positional[0]
        const signal = args.positional[1] as SignalInput | undefined
        if (id === undefined || signal === undefined || !SIGNALS.includes(signal)) {
          throw new Error(`signal 需要 <id> <${SIGNALS.join('|')}>`)
        }
        const record = await store.recordSignal(KbEntryId(id), signal, flag(args, 'note') ?? '')
        const score = await store.score(KbEntryId(id))
        console.log(`已记信号 ${record.polarity}/${record.source} 权重${record.weight};当前窗口分数 ${score.score}(阈值 ±${store.config.trustThreshold})`)
        return 0
      }
      case 'worklog': {
        const changed = multi(args, 'changed')
        const referenced = multi(args, 'referenced')
        if (changed.length === 0) throw new Error('worklog 需要 --changed <文件>(可重复)')
        const log = buildWorkLog({
          projectRoot: flag(args, 'project') ?? process.cwd(),
          changedFiles: changed,
          referencedEntryIds: referenced,
          ...(flag(args, 'page') !== undefined ? { page: flag(args, 'page') } : {}),
          ...(flag(args, 'note') !== undefined ? { note: flag(args, 'note') } : {}),
        })
        const out = flag(args, 'out') ?? path.join(log.projectRoot, '.clue', `worklog-${Date.now().toString(36)}.json`)
        await saveWorkLog(out, log)
        console.log(`工单已写入: ${out}`)
        console.log(`  改动 ${log.changedFiles.length} 个文件 · 引用 ${log.referencedEntryIds.length} 条知识${log.page !== undefined ? ` · 页面 ${log.page}` : ''}`)
        console.log('  下一步: clue kb loop --worklog ' + out)
        return 0
      }
      case 'loop': {
        const file = flag(args, 'worklog')
        if (file === undefined) throw new Error('loop 需要 --worklog <文件>')
        const log = await loadWorkLog(file)
        const report = await runEvidenceLoop({
          worklog: has(args, 'no-inspect') ? { ...log, page: undefined } : log,
          home: flag(args, 'home'),
          maskSelectors: multi(args, 'mask'),
          noSweep: has(args, 'no-sweep'),
        })
        console.log(`分类: 可渲染 ${report.renderable.length} 个${report.renderable.length > 0 ? `(${report.renderable.join(', ')})` : ''} · 其它 ${report.other.length} 个`)
        if (report.renderable.length === 0) {
          console.log('触发规则: 本次改动不涉及可渲染文件 → 不做渲染验证(纯后端轮次不开浏览器)。')
        } else if (report.outcome === null) {
          console.log('未做渲染验证(工单没有 --page,或 --no-inspect)。')
        } else {
          const outcome = report.outcome
          console.log(`验证: ${outcome.exitOk ? '✓ 通过' : `✗ ${outcome.errorCount} 处 error 级证据`}`)
          for (const failure of outcome.failedAssertions.slice(0, 5)) console.log(`  ✗ ${failure}`)
          for (const entry of outcome.errorEntrySummaries.slice(0, 5)) console.log(`  ✗ ${entry}`)
        }
        for (const signal of report.recorded) {
          console.log(`信号: ${signal.entryId} ← ${signal.note}`)
        }
        for (const item of report.plan?.unattributed ?? []) {
          console.log(`不记信号: ${item.entryId} — ${item.reason}`)
        }
        for (const id of report.needsReviewRaised) console.log(`⚑ 自动待复核: ${id}`)
        if (report.sweep !== null) {
          const swept = report.sweep
          console.log(`维护: 过期 ${swept.expired.length} · 强负遗弃 ${swept.discarded.length} · 清退 ${swept.purged.length} · 新提升建议 ${swept.promotions.length}`)
          for (const request of swept.promotions) console.log(`  ⇧待批提升 ${request.entryId}(${request.reason})`)
        }
        return 0
      }
      case 'sweep': {
        const result = { project: await both.project.sweep(), global: await both.global.sweep() }
        for (const [tierName, swept] of Object.entries(result)) {
          console.log(`[${tierName}] 过期 ${swept.expired.length} · 强负遗弃 ${swept.discarded.length} · 清退 ${swept.purged.length} · 新提升建议 ${swept.promotions.length}`)
          for (const id of swept.expired) console.log(`  ↓过期 ${id}`)
          for (const id of swept.discarded) console.log(`  ↓遗弃 ${id}`)
          for (const id of swept.purged) console.log(`  ✗清退(超过保留期) ${id}`)
          for (const request of swept.promotions) console.log(`  ⇧待批提升 ${request.entryId}(${request.reason})`)
        }
        console.log('提示: 用 clue kb approvals 查看待批队列,approve/reject 处理。')
        return 0
      }
      case 'generalize': {
        // M5: cross-project scan — same knowledge verified in ≥2 projects
        // becomes a global candidate + a promote approval (决策 #14 泛化提议).
        const threshold = flag(args, 'threshold')
        const scan = await suggestGeneralizations({
          home: flag(args, 'home'),
          ...(threshold !== undefined ? { threshold: Number(threshold) } : {}),
          ...(has(args, 'dry-run') ? { dryRun: true } : {}),
        })
        console.log(`扫描了 ${scan.projectsScanned} 个项目库(相似阈值 ${threshold ?? 0.5})`)
        for (const proposal of scan.proposals) {
          const sources = proposal.sources.map((s) => `${s.entryId}@${path.basename(s.projectRoot)}`).join(' + ')
          if (proposal.created !== undefined) {
            console.log(`⇧泛化提议 「${proposal.draft.title}」 ← ${sources}`)
            console.log(`  全局候选 ${proposal.created.entry.id} 已入待批队列(${proposal.created.request.id})`)
          } else {
            console.log(`⇧[dry-run] 泛化提议 「${proposal.draft.title}」 ← ${sources}`)
          }
        }
        for (const reason of scan.skipped) console.log(`· 跳过: ${reason}`)
        if (scan.proposals.length === 0) console.log('没有新的泛化提议(需要 ≥2 个项目各自验证过同类知识)。')
        else console.log('提示: 用 clue kb approvals 查看待批队列(两层都会列出),approve 后成为全局可信知识。')
        return 0
      }
      case 'migrate': {
        // M8 workspace binding (decision #6 revision): import the legacy
        // central layout into each workspace's .clue/kb. Never overwrites;
        // a vanished project is reported and left alone.
        const report = await migrateLegacyProjectKbs(flag(args, 'home'))
        for (const item of report) console.log(`${item.moved ? '✔ 迁入' : '· 保持'} ${item.from}${item.to ? ` → ${item.to}` : ''} —— ${item.reason}`)
        const moved = report.filter((r) => r.moved).length
        console.log(`共 ${moved} 项迁入工作区,${report.length - moved} 项保持原样。`)
        return 0
      }
      case 'status': {
        for (const tier of [both.project, both.global]) {
          const entries = await tier.list()
          const byStatus = entries.reduce<Record<string, number>>((acc, e) => { acc[e.status] = (acc[e.status] ?? 0) + 1; return acc }, {})
          const review = entries.filter((e) => e.needsReview).length
          const pending = (await tier.listApprovals(true)).length
          console.log(`[${tier.tier === 'global' ? '全局库' : '项目库'}] ${tier.dir}`)
          console.log(`  条目 ${entries.length}: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' ') || '(空)'} · 待复核 ${review} · 待批 ${pending}`)
        }
        return 0
      }
      default:
        throw new Error(`未知命令: ${args.command}\n\n${USAGE}`)
    }
  } catch (error) {
    console.error(`clue kb: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}
