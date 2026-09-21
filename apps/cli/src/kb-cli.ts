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
 *   clue kb workspace <list|add|rename|remove>   (M9: 工作区名单,ClueHarness 自己的)
 *   clue kb migrate        (把工作区里的 .clue/kb 收回到中心 ~/.clue,决策 #6 再修订)
 *   clue kb generalize [--dry-run] [--threshold n]  (跨项目泛化扫描)
 *   clue kb ingest <file> [--as rel] [--dry-run]    (M9-3: 原文入库,写入时切片)
 *   clue kb doc <list|attach|show>                  (M9-1: 原文快照与挂载)
 *   clue kb chunks <docId> [--query q] [--limit n]  (M9-2: 二级检索/浏览分片)
 *   clue kb detail <entryId> [--query q]            (M9-2: 按条目下钻原文段,纯读)
 *   clue kb redline <id> (--chars a-b | --lines a-b) --reason r   (M9-4: 人工划除)
 *   clue kb split <id> --into <drafts.json>         (M9-4: 人工拆分 → superseded)
 *   clue kb status
 *
 * Exit codes: 0 ok · 2 usage/engine failure (no evidence semantics here —
 * kb is not a gate; the render CLI owns exit code 1).
 *
 * @module @clue-harness/cli/kb
 */
import path from 'node:path'
import { mkdir, readFile } from 'node:fs/promises'
import {
  KbEntryId,
  addWorkspace,
  entryTextAfterRedlines,
  migrateWorkspaceKbsToCentral,
  openGlobalStore,
  openProjectStore,
  queryKb,
  readWorkspaces,
  registerWorkspace,
  removeWorkspace,
  renameWorkspace,
  type DocAnchor,
  type KbKind,
  type KbStore,
  type SignalInput,
} from '@clue-harness/kb'
import { buildWorkLog, loadWorkLog, runEvidenceLoop, saveWorkLog, suggestGeneralizations } from '@clue-harness/kb-loop'
import { anchorLabel, ingestFile, queryChunks, renderDetailView, resolveChunkSources, type ChunkSource, type ChunkVectorState } from '@clue-harness/rag'
import { clueHome } from '@clue-harness/util'

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
  promote   <id> [--reason <为什么>] [--global]
                                     人权入口:把候选直接提升为可信(不需要攒够窗口分)。
                                     留履历 + 人工确认信号,并结清该条在队的提升请求
  retire    <id> --reason <为什么> [--global]
                                     人权入口:人工判定"不再成立" → 过期(仍可读、可复归),
                                     撤掉 ⚑ 标记;遗弃仍是证据/审批的决定
  reactivate <id> [--reason <为什么>] [--global]
                                     人权入口:过期 → 候选(要重新挣得可信)
  rescue    <id> [--reason <为什么>] [--global]
                                     人权入口:已遗弃 → 候选(捞回即停 60 天清退倒计时)
  reverify  <id> [--accept]          重验绑定;--accept 接受新内容并更新哈希
  signal    <id> <信号> [--note n]   手动记信号(五个档位见上)
  worklog   --changed <f>… --referenced <id>… [--page p.html] [--out w.json]
                                     生成闭环工单(M3b 起由 agent 自动生成)
  loop      --worklog <w.json> [--mask <sel>]… [--no-inspect] [--no-sweep]
                                     跑一遍证据闭环:分类→(触发才)渲染验证→归因→记信号→维护
  sweep                              维护:过期/强负遗弃/60天清退/提升建议入队
  migrate                            把旧的工作区内布局(<项目>/.clue/kb 与 render-baselines)
                                     迁入中心库 <home>/kb/<工作区键>(不覆盖,报告制)
  generalize [--dry-run] [--threshold n]
                                     跨项目泛化扫描:≥2 个项目验证过的同类知识
                                     → 全局候选 + 待批提升(审批后成全局可信)
  ingest    <文件.md|.html> [--as <项目相对路径>] [--dry-run]
                                     原文入库:sha256 落盘不可变快照 + 写入时切片(800/600)
                                     --dry-run 只预览分段(heading/锚点/字数),不写任何字节
  doc       list [--global]          原文快照清单(docId/来源/字数/挂载条目数)
  doc       attach <id> --doc <docId> [--lines a-b] [--heading <路径>] [--quote <段首>]
                                     把证据锚点挂到条目上(entry 仍是治理主体)
  doc       show <docId> [--global]  快照元数据 + 分片清单(不打印全文)
  chunks    <docId> [--query q] [--limit n] [--max-chars n] [--global]
                                     二级检索/浏览:按段返回行号 + heading + 摘录
  detail    <entryId> [--query q] [--limit n] [--global]
                                     按条目下钻原文段(纯读取:不记信号、不改状态)
  redline   <id> (--chars a-b | --lines a-b) --reason <原因> [--global]
                                     人工划除:该段同时退出显示与评分;占比 >40% 自动入队审批提案
  split     <id> --into <草稿.json> [--reason r] [--global]
                                     人工拆分:原条目 → superseded(终态),新条目从 candidate 起步,
                                     证据可继承、治理不继承(信号零随迁)
  status                             总览:各状态计数/待复核/待批/库位置
  ltr                                离线 LTR:读 ranklog + 信号标注,报就绪度;够量时离线拟合并与手工权重对照
                                     (默认只报告,不改任何配置)

向量与精排(V0–V2):
  embed-config show [--json]         嵌入提供者配置(打印引用名与密钥状态,永不回显密钥值)
  embed-config set [--base-url u] [--model m] [--api-key-env NAME] [--enable|--disable]
                   [--timeout-ms n] [--batch-size n] [--concurrency n] [--max-units n]
                   [--header k=v]…   写非密配置(dim 不接受手填,由 test 实测写入)
  embed-config key --stdin           从标准输入写入密钥(密钥库/引用;不进 shell 历史、不回显)
  embed-config unset-key             清除密钥(向量层保留,只影响后续调用)
  embed-config test [--no-record]    测试连接:回显 dim/延迟/归一化模长,并写入实测维度
  embed-config auto [--dry-run]      零配置:逐个探测"已配置的 provider"里哪些真能嵌入,
                                     第一个成功的直接启用(含实测维度),你不用再填任何东西
  embed                              建立/更新向量层;--dry-run 只算账(零调用零花费),
                                     --only entries|chunks|all,--rebuild 强制重建
  doctor [--json]                    向量层健康度(缺失/过期/partial/维度不符/未配置)+ 调优项 + ranklog
  query <词…> --explain              混合检索 + 分数分解(--channel/--rerank/--profile/--limit)
  query <词…> --llm-rerank           额外跑一次模型重排,并把与确定性精排的差异打出来(V5,默认关)

通用: --project <dir>(默认当前目录;决定用哪个工作区的库,项目目录里零残留)
      --home <dir>(中心库根:各工作区库/全局库/注册表都在这里;默认 $CLUE_HOME 或 ~/.clue)`

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

/**
 * Resolve the tier that OWNS one entry id (project first, then global) unless
 * --global pins it. Governance acts (attach/redline/split/detail) must reach
 * the entry's own store: the same id never lives in two tiers, and guessing
 * the wrong tier would silently no-op or create a second truth.
 * @param args - parsed CLI args.
 * @returns the owning store.
 */
async function entryStore(args: Args): Promise<{ store: KbStore; both: { project: KbStore; global: KbStore } }> {
  const both = await stores(args)
  if (has(args, 'global')) return { store: both.global, both }
  const id = args.positional[0]
  if (id === undefined) return { store: both.project, both }
  if (await both.project.get(KbEntryId(id)) !== null) return { store: both.project, both }
  if (await both.global.get(KbEntryId(id)) !== null) return { store: both.global, both }
  // Unknown id: fail in the addressed tier (the caller's next get() throws the
  // honest "条目不存在" instead of a confusing tier error).
  return { store: both.project, both }
}

/** Parse an `a-b` (or single `a`) inclusive range flag. */
function parseRange(value: string, label: string): [number, number] {
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(value.trim())
  if (match === null) throw new Error(`${label} 需要 a-b 或单个行/字符号,收到 "${value}"`)
  const from = Number(match[1])
  const to = match[2] === undefined ? from : Number(match[2])
  if (from < 1 || to < from) throw new Error(`${label} 区间非法: ${value}`)
  return [from, to]
}

/** The quote anchor of one snapshot line (a human-readable anchor). */
async function quoteFromDoc(store: KbStore, docId: string, line: number): Promise<string> {
  const { readDocText } = await import('@clue-harness/kb')
  const text = await readDocText(store.dir, docId)
  if (text === null) return ''
  return (text.split('\n')[line - 1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
}

function entryLine(entry: { id: string; kind: string; title: string; status: string; needsReview: boolean; tier: string }): string {
  const review = entry.needsReview ? ' ⚑待复核' : ''
  return `${entry.id}  [${entry.status}${review}]  <${entry.kind}${entry.tier === 'global' ? ',全局' : ''}>  ${entry.title}`
}

/** CLI entry; returns the process exit code. */
export async function kbMain(argv: string[]): Promise<number> {  const args = parse(argv)
  if (args.command === '' || has(args, 'help') || args.command === 'help') {
    console.log(USAGE)
    return 0
  }
  try {
    // Lazy anchors: the store pair is opened by the commands that actually
    // address a tier — `workspace`, `migrate` and `generalize` do not (they
    // work on the roster and the home), and eagerly opening it made them die
    // on an unwritable/absent launch anchor before doing any work at all.
    let cache: { project: KbStore; global: KbStore } | null = null
    const both = async (): Promise<{ project: KbStore; global: KbStore }> => cache ??= await stores(args)
    const store = async (): Promise<KbStore> => storeFor(args, await both())
    switch (args.command) {
      case 'add': {
        const kind = flag(args, 'kind') as KbKind | undefined
        const title = flag(args, 'title')
        const text = flag(args, 'text')
        if (kind === undefined || !KINDS.includes(kind)) throw new Error(`--kind 必须是 ${KINDS.join('|')} 之一`)
        if (title === undefined || text === undefined) throw new Error('add 需要 --title 与 --text')
        const entry = await (await store()).add({
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
        const entries = await (await store()).list({
          ...(status !== undefined ? { status: status as never } : {}),
          ...(kind !== undefined ? { kind: kind as never } : {}),
          ...(has(args, 'review') ? { needsReview: true } : {}),
        })
        for (const entry of entries) console.log(entryLine(entry))
        const addressed = await store()
        console.log(`共 ${entries.length} 条(${addressed.tier === 'global' ? '全局库' : `项目库 ${addressed.dir}`})`)
        return 0
      }
      case 'show': {
        const id = args.positional[0]
        if (id === undefined) throw new Error('show 需要条目 id')
        const entry = await (await store()).get(KbEntryId(id))
        if (entry === null) throw new Error(`条目不存在: ${id}`)
        const score = await (await store()).score(entry.id)
        console.log(JSON.stringify({ ...entry, windowScore: score }, null, 2))
        return 0
      }
      case 'query': {
        const text = args.positional.join(' ')
        if (text.trim() === '') throw new Error('query 需要检索词')
        // V2: `--explain` shows the score decomposition, which only the hybrid
        // plane can produce — so this flag routes through the SAME retriever
        // the model's kb_search uses, with the same settings.
        if (has(args, 'explain') || has(args, 'channel') || has(args, 'rerank') || has(args, 'profile') || has(args, 'llm-rerank')) {
          const { openEmbeddingHost } = await import('@clue-harness/kb-face/embedding-host')
          const cli = await import('./embed-cli.ts')
          const host = await openEmbeddingHost()
          try {
            const anchors = await both()
            return await cli.queryExplainRun(host, { ...anchors, home: flag(args, 'home') ?? clueHome(), args })
          } finally {
            await host.close()
          }
        }
        const anchors = await both()
        const hits = await queryKb(
          anchors.project,
          has(args, 'no-global') ? null : anchors.global,
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
          // M9-4: what a reader sees here is what the model sees — redlined
          // segments are gone from BOTH. The raw text stays available through
          // `clue kb show` for the human doing the governance.
          const body = entryTextAfterRedlines(hit.entry).replace(/\s+/g, ' ').trim()
          if (body !== '') console.log(`  正文: ${body.length > 300 ? `${body.slice(0, 300)}…` : body}`)
          if (hit.entry.doc !== undefined) console.log(`  原文: ${hit.entry.doc.docId}(下钻: clue kb detail ${hit.entry.id} --query <词>)`)
          for (const note of hit.annotations) console.log(`  ⚠ ${note}`)
        }
        return 0
      }
      case 'approvals': {
        const seen = new Set<string>()
        const anchors = await both()
        for (const tier of [anchors.project, anchors.global]) {
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
        const anchors = await both()
        for (const tier of [anchors.project, anchors.global]) {
          const pending = await tier.listApprovals(true)
          if (!pending.some((a) => a.id === requestId)) continue
          const { request, entry } = await tier.resolveApproval(requestId, args.command === 'approve')
          console.log(`${args.command === 'approve' ? '已批准' : '已否决'} [${request.action}] ${request.entryId}`)
          if (entry !== null) console.log(`  → ${entryLine(entry)}`)
          return 0
        }
        throw new Error(`待批请求不存在: ${requestId}`)
      }
      case 'promote': {
        const id = args.positional[0]
        if (id === undefined) throw new Error('promote 需要条目 id')
        // Governance act → the entry's OWN tier (entryStore), never a guess.
        const { store: addressed } = await entryStore(args)
        const reason = flag(args, 'reason')
        const { entry, requests } = await addressed.promote(KbEntryId(id), {
          by: 'cli',
          ...(reason !== undefined ? { reason } : {}),
        })
        console.log(`已提升为可信: ${entryLine(entry)}`)
        console.log(`  理由: ${entry.history[entry.history.length - 1]?.reason ?? '(未记)'}`)
        if (requests.length > 0) {
          console.log(`  同时结清在队提升请求 ${requests.length} 条: ${requests.map((r) => r.id).join(', ')}`)
        }
        return 0
      }
      case 'retire':
      case 'reactivate':
      case 'rescue': {
        const id = args.positional[0]
        if (id === undefined) throw new Error(`${args.command} 需要条目 id`)
        const { store: addressed } = await entryStore(args)
        const reason = flag(args, 'reason')
        const input = { by: 'cli', ...(reason !== undefined ? { reason } : {}) }
        const { entry, requests } = args.command === 'retire'
          ? await addressed.retire(KbEntryId(id), input)
          : args.command === 'reactivate'
            ? await addressed.reactivate(KbEntryId(id), input)
            : await addressed.rescue(KbEntryId(id), input)
        const verb = args.command === 'retire' ? '已判定不再成立(转过期)' : args.command === 'reactivate' ? '已重新激活(回过候选)' : '已捞回候选'
        console.log(`${verb}: ${entryLine(entry)}`)
        console.log(`  理由: ${entry.history[entry.history.length - 1]?.reason ?? '(未记)'}`)
        if (requests.length > 0) {
          console.log(`  同时结清在队请求 ${requests.length} 条: ${requests.map((r) => r.id).join(', ')}`)
        }
        return 0
      }
      case 'reverify': {
        const id = args.positional[0]
        if (id === undefined) throw new Error('reverify 需要条目 id')
        const entry = await (await store()).reverify(KbEntryId(id), has(args, 'accept'))
        console.log(`重验完成: ${entryLine(entry)}${entry.needsReview ? `(仍需复核: ${entry.reviewReason})` : ''}`)
        return 0
      }
      case 'signal': {
        const id = args.positional[0]
        const signal = args.positional[1] as SignalInput | undefined
        if (id === undefined || signal === undefined || !SIGNALS.includes(signal)) {
          throw new Error(`signal 需要 <id> <${SIGNALS.join('|')}>`)
        }
        const addressed = await store()
        const record = await addressed.recordSignal(KbEntryId(id), signal, flag(args, 'note') ?? '')
        const score = await addressed.score(KbEntryId(id))
        console.log(`已记信号 ${record.polarity}/${record.source} 权重${record.weight};当前窗口分数 ${score.score}(阈值 ±${addressed.config.trustThreshold})`)
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
        const out = flag(args, 'out')
          ?? path.join(flag(args, 'home') ?? clueHome(), 'worklogs', `worklog-${Date.now().toString(36)}.json`)
        if (flag(args, 'out') === undefined) await mkdir(path.dirname(out), { recursive: true })
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
        const anchors = await both()
        const result = { project: await anchors.project.sweep(), global: await anchors.global.sweep() }
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
      case 'workspace': {
        // M9: the roster is ClueHarness's OWN workspace list (settings panel
        // and generalize scan both read it) — dsh's workspace service is never
        // consulted; a path is the only input taken from outside.
        const home = flag(args, 'home')
        const verb = args.positional[0] ?? 'list'
        if (verb === 'list') {
          const records = await readWorkspaces(home)
          for (const record of records) {
            console.log(`${record.key}  [${record.label}]  ${record.root}  (${record.source}, 最近可见 ${record.lastSeenAt})`)
            if (record.renderSurface !== undefined) console.log(`  渲染面覆盖: ${JSON.stringify(record.renderSurface)}`)
          }
          console.log(`共 ${records.length} 个工作区(中心库 ${path.join(home ?? clueHome(), 'kb')})。`)
          return 0
        }
        if (verb === 'add') {
          const target = args.positional[1]
          if (target === undefined) throw new Error('workspace add 需要 <目录>')
          const record = await addWorkspace(target, args.positional[2], home)
          const store = await openProjectStore(record.root, home)
          console.log(`已登记: ${record.key} [${record.label}] ${record.root}`)
          console.log(`  中心库: ${store.dir}`)
          return 0
        }
        if (verb === 'rename') {
          const key = args.positional[1]
          const label = args.positional.slice(2).join(' ')
          if (key === undefined || label === '') throw new Error('workspace rename 需要 <key> <标签>')
          const record = await renameWorkspace(key, label, home)
          console.log(`已改名: ${record.key} → [${record.label}]`)
          return 0
        }
        if (verb === 'remove') {
          const key = args.positional[1]
          if (key === undefined) throw new Error('workspace remove 需要 <key>')
          const { record, kbDir, baselinesDir } = await removeWorkspace(key, home)
          console.log(`已解除登记: ${record.key} [${record.label}] ${record.root}`)
          console.log(`  数据未删: ${kbDir} · ${baselinesDir}(该目录再被用到会自动重新登记)`)
          return 0
        }
        throw new Error(`未知 workspace 子命令: ${verb}(list|add|rename|remove)`)
      }
      case 'migrate': {
        // M9 (decision #6 re-revision): pull the M8 workspace-bound state back
        // into the central home. Never overwrites; leftovers are reported.
        const report = await migrateWorkspaceKbsToCentral({
          home: flag(args, 'home'),
          roots: multi(args, 'root'),
          ...(has(args, 'dry-run') ? { dryRun: true } : {}),
        })
        for (const item of report) {
          console.log(`${item.moved ? '✔ 收回' : '· 保持'} [${item.kind}] ${item.from}${item.to ? ` → ${item.to}` : ''} —— ${item.reason}`)
        }
        const moved = report.filter((r) => r.moved).length
        if (report.length === 0) console.log('没有需要收回的工作区状态(中心式布局已就位,或工作区里没有 .clue)。')
        else console.log(`共 ${moved} 项收回中心,${report.length - moved} 项保持原样。`)
        // Roots named by the legacy registry get re-registered even when their
        // .clue is already gone, so `workspace list` reflects the truth.
        for (const root of multi(args, 'root')) await registerWorkspace(root, { home: flag(args, 'home'), source: 'manual' })
        return 0
      }
      case 'ingest': {
        // M9-3: the ONE moment knowledge text is sliced. The report is the
        // user's evidence — every段's heading path, anchor and size, printed
        // before anything is mounted (mounting is `kb doc attach`, a human act).
        const file = args.positional[0]
        if (file === undefined) throw new Error('ingest 需要 <文件.md|.html>')
        const addressed = await store()
        const report = await ingestFile({
          store: addressed,
          file: path.resolve(flag(args, 'project') ?? process.cwd(), file),
          ...(flag(args, 'as') !== undefined ? { sourcePath: flag(args, 'as') as string } : {}),
          ...(has(args, 'dry-run') ? { dryRun: true } : {}),
        })
        console.log(`${report.dryRun ? '[dry-run] ' : ''}原文: ${report.sourcePath}(${report.format}, ${report.bytes} 字节 → ${report.chars} 字, ${report.lineCount} 行)`)
        console.log(`切片: ${report.chunks.length} 段 · chunker ${report.chunkerVersion}`)
        for (const note of report.notes) console.log(`  · ${note}`)
        for (const chunk of report.chunks) {
          const overlap = chunk.overlapWith === undefined ? '' : ` · 重叠自段${chunk.overlapWith}`
          console.log(`  段${chunk.seq} 行 ${chunk.lines.start}-${chunk.lines.end} · ${chunk.chars} 字 · ${chunk.headingPath === '' ? '(无标题)' : chunk.headingPath}${overlap}`)
          console.log(`      锚点: “${chunk.quoteAnchor}”`)
        }
        if (report.dryRun) {
          console.log('dry-run:未写入任何字节。去掉 --dry-run 即落盘为不可变快照。')
        } else if (report.doc !== undefined) {
          console.log(`快照: ${report.doc.docId}${report.reused ? '(同字节复用,未产生副本)' : ''}${report.doc.supersedes !== undefined ? ` · 替代 ${report.doc.supersedes}` : ''}`)
          console.log(`下一步: clue kb doc attach <条目id> --doc ${report.doc.docId} --lines <a-b>(证据挂载,条目生成不自动)`)
        }
        return 0
      }
      case 'doc': {
        const verb = args.positional[0] ?? 'list'
        if (verb === 'list') {
          const addressed = await store()
          const docs = await addressed.listDocs()
          const entries = await addressed.list()
          for (const doc of docs) {
            const mounted = entries.filter((entry) => entry.doc !== undefined && String(entry.doc.docId) === String(doc.docId))
            console.log(`${doc.docId}  ${doc.sourcePath}  ${doc.sizeChars} 字/${doc.lineCount} 行  ${doc.ingestedAt}${doc.supersedes !== undefined ? `  替代 ${doc.supersedes}` : ''}`)
            console.log(`  挂载条目 ${mounted.length}${mounted.length > 0 ? `: ${mounted.map((entry) => entry.id).join(', ')}` : '(无——原文有了但还没挂到知识上)'}`)
          }
          if (docs.length === 0) console.log('没有原文快照。用 clue kb ingest <文件> 导入。')
          return 0
        }
        if (verb === 'show') {
          const docId = args.positional[1]
          if (docId === undefined) throw new Error('doc show 需要 <docId>')
          const addressed = await store()
          const record = await addressed.getDoc(docId)
          if (record === null) throw new Error(`文档不存在: ${docId}`)
          const chunks = await addressed.getChunks(docId)
          console.log(JSON.stringify(record, null, 2))
          console.log(`分片 ${chunks.length} 段${await addressed.chunksNeedRebuild(docId) ? '(版本不匹配,下次查询会重建)' : ''}:`)
          for (const chunk of chunks) {
            console.log(`  段${chunk.seq} 行 ${chunk.startLine}-${chunk.endLine} · ${chunk.chars} 字 · ${chunk.headingPath === '' ? '(无标题)' : chunk.headingPath}`)
          }
          return 0
        }
        if (verb === 'attach') {
          const id = args.positional[1]
          const docId = flag(args, 'doc')
          if (id === undefined || docId === undefined) throw new Error('doc attach 需要 <条目id> --doc <docId>')
          const addressed = await entryStore(args)
          const lines = flag(args, 'lines')
          let anchor: DocAnchor | undefined
          if (lines !== undefined) {
            const range = parseRange(lines, '--lines')
            const quote = flag(args, 'quote') ?? await quoteFromDoc(addressed.store, docId, range[0])
            anchor = {
              lines: range,
              quoteAnchor: quote,
              ...(flag(args, 'heading') !== undefined ? { headingPath: flag(args, 'heading') as string } : {}),
            }
          }
          const entry = await addressed.store.attachDoc(KbEntryId(id), docId, anchor)
          console.log(`已挂载证据: ${entryLine(entry)}`)
          if (entry.doc?.anchor !== undefined) console.log(`  锚点: ${entry.doc.anchor.lines?.join('-') ?? ''} · “${entry.doc.anchor.quoteAnchor}”`)
          console.log('  提示: 条目仍是唯一治理主体;原文改动只会让本条待复核,不会改写快照。')
          return 0
        }
        throw new Error(`未知 doc 子命令: ${verb}(list|show|attach)`)
      }
      case 'chunks': {
        const docId = args.positional[0]
        if (docId === undefined) throw new Error('chunks 需要 <docId>(或 --entry <id>)')
        const addressed = await store()
        // V4: when an embedder is configured, the second level fuses the lexical
        // and vector channels; otherwise this is exactly the old lexical path.
        const { openEmbeddingHost } = await import('@clue-harness/kb-face/embedding-host')
        const { planeChunkVector } = await import('./embed-cli.ts')
        const embedHost = await openEmbeddingHost()
        let vector = null
        try {
          vector = planeChunkVector(embedHost, flag(args, 'home') ?? clueHome())
        } finally {
          if (vector === null) await embedHost.close()
        }
        // A holder rather than a `let`: the state is assigned inside a callback,
        // which TypeScript's control-flow analysis does not follow (a plain
        // variable narrows to `never`).
        const stateRef: { current: ChunkVectorState | null } = { current: null }
        const source: ChunkSource = { store: addressed, docId }
        const hits = await queryChunks(source, {
          ...(vector !== null ? { vector: { ...vector, onState: (v: ChunkVectorState) => { stateRef.current = v } } } : {}),
          query: args.positional.slice(1).join(' ') || (flag(args, 'query') ?? ''),
          limit: flag(args, 'limit') !== undefined ? Number(flag(args, 'limit')) : undefined,
          maxChars: flag(args, 'max-chars') !== undefined ? Number(flag(args, 'max-chars')) : undefined,
        })
        if (vector !== null) await embedHost.close()
        if (stateRef.current !== null && stateRef.current.status !== 'used') console.log(`  ⚠ ${stateRef.current.note}`)
        if (hits.length === 0) { console.log('没有命中。'); return 0 }
        for (const hit of hits) {
          // A browsing pass (no query) has no relevance to report — printing a
          // 0 would read as "irrelevant" instead of "no query was given".
          const score = hit.score > 0 ? ` [${hit.score}]` : ''
          console.log(`▸${score} ${anchorLabel(hit)}${hit.partialRedline ? ' ⚠部分划除' : ''}`)
          for (const line of hit.excerpt.split('\n')) console.log(`    | ${line}`)
        }
        return 0
      }
      case 'detail': {
        const id = args.positional[0]
        if (id === undefined) throw new Error('detail 需要 <条目id>')
        const addressed = await entryStore(args)
        const entry = await addressed.store.get(KbEntryId(id))
        if (entry === null) throw new Error(`条目不存在: ${id}`)
        const sources = await resolveChunkSources(addressed.store, { entryId: id })
        const hits: Awaited<ReturnType<typeof queryChunks>> = []
        for (const source of sources) {
          hits.push(...await queryChunks(source, {
            query: flag(args, 'query') ?? '',
            limit: flag(args, 'limit') !== undefined ? Number(flag(args, 'limit')) : undefined,
          }))
        }
        const view = renderDetailView({
          entryId: entry.id,
          title: entry.title,
          docIds: sources.map((source) => source.docId),
          hits,
          noDoc: entry.doc === undefined,
        })
        console.log(view.text)
        return 0
      }
      case 'redline': {
        // M9-4 5a: 人工划除。No model path reaches this — the CLI is one of the
        // two human surfaces (web panel is the other).
        const id = args.positional[0]
        const reason = flag(args, 'reason')
        if (id === undefined || reason === undefined) {
          throw new Error('redline 需要 <id> --reason <原因>,并给 --chars a-b(正文)或 --lines a-b(原文)之一')
        }
        const chars = flag(args, 'chars')
        const lines = flag(args, 'lines')
        if ((chars === undefined) === (lines === undefined)) {
          throw new Error('redline 需要 --chars a-b 与 --lines a-b 中的恰好一个')
        }
        const addressed = await entryStore(args)
        const result = chars !== undefined
          ? await addressed.store.redlineText(KbEntryId(id), { chars: parseRange(chars, '--chars'), reason, by: 'cli' })
          : await addressed.store.redlineDocLines(KbEntryId(id), {
            lines: parseRange(lines as string, '--lines'),
            reason,
            by: 'cli',
            ...(flag(args, 'heading') !== undefined ? { headingPath: flag(args, 'heading') as string } : {}),
          })
        const { entry, ratio, proposal } = result
        console.log(`已划除(${chars !== undefined ? '正文' : '原文'}): ${entryLine(entry)}`)
        console.log(`  被划除占比 ${(ratio * 100).toFixed(1)}% · 扣分与显示同时生效;原文层细节用 kb detail ${entry.id}`)
        if (proposal !== null) console.log(`  ⇧已入队审批提案 ${proposal.id}: ${proposal.reason}(系统提议,人执行:clue kb split 或遗弃)`)
        return 0
      }
      case 'split': {
        // M9-4 5b: 人工拆分。Inheritance boundary: evidence yes, governance no.
        const id = args.positional[0]
        const into = flag(args, 'into')
        if (id === undefined || into === undefined) throw new Error('split 需要 <id> --into <草稿.json>')
        const raw = JSON.parse(await readFile(into, 'utf8')) as unknown
        const list = Array.isArray(raw) ? raw : (raw as { drafts?: unknown }).drafts
        if (!Array.isArray(list) || list.length === 0) throw new Error('草稿文件需要是数组,或 { drafts: [...] }(至少一条)')
        const drafts = list.map((item, index) => {
          const draft = item as { kind?: KbKind; title?: unknown; text?: unknown; tags?: unknown; anchor?: DocAnchor }
          if (typeof draft.title !== 'string' || typeof draft.text !== 'string') {
            throw new Error(`草稿[${index}] 需要 title 与 text(string)`)
          }
          return {
            ...(draft.kind !== undefined ? { kind: draft.kind } : {}),
            title: draft.title,
            text: draft.text,
            ...(Array.isArray(draft.tags) ? { tags: draft.tags.map(String) } : {}),
            ...(draft.anchor !== undefined ? { anchor: draft.anchor } : {}),
          }
        })
        const addressed = await entryStore(args)
        const reason = flag(args, 'reason') ?? '人工拆分'
        const { old, created } = await addressed.store.splitEntry(KbEntryId(id), drafts, reason)
        console.log(`已拆分: ${entryLine(old)} → superseded(终态,永不清退)`)
        for (const child of created) {
          console.log(`  新条目: ${entryLine(child)}${child.doc !== undefined ? ` · 证据沿用 ${child.doc.docId}` : ''}`)
        }
        console.log('  治理不继承:新条目从 candidate 起步,信号/审批/划除均从零开始(反漂白)。')
        return 0
      }
      case 'ltr': {
        // V5 (规划 §8.4): the OFFLINE half of learning-to-rank. It reads the
        // ranklog the retrievals have been writing, joins it against the signal
        // ledger for labels, reports readiness, and — only when the data is
        // enough — fits a logistic model and compares it with the shipped hand
        // weights. Nothing here runs at retrieval time.
        const addressed = await store()
        const rag = await import('@clue-harness/rag')
        const { readSignals } = await import('@clue-harness/kb')
        const rows = await rag.readRankLog(addressed.dir)
        const signals = await readSignals(path.join(addressed.dir, 'signals.jsonl'))
        const training = rag.buildTrainingSet(rows, signals)
        const readiness = rag.ltrReadiness(training)
        console.log(`ranklog ${rows.length} 行 · 标注样本 ${training.length} 条(正 ${readiness.positives} / 负 ${readiness.negatives})· 有标注查询 ${readiness.queries}`)
        console.log(`就绪: ${readiness.ready ? '是' : '否'} — ${readiness.reason}`)
        if (!readiness.ready) {
          console.log('提示: 标注来自信号账本(kb_cite/human-confirm/evidence-pass 为正,user-reject/evidence-fail 为负),')
          console.log('      在检索后 7 天内落账才算这条检索的标注;继续用并 cite 知识即可攒数据。')
          return 0
        }
        const model = rag.trainLogistic(training)
        const hand = rag.evaluateWeights(training, rag.handWeights())
        const learned = rag.evaluateWeights(training, model.weights)
        console.log('')
        console.log(`离线拟合(${model.epochs} 轮,loss ${model.loss.toFixed(4)}) vs 出厂手工权重 —— 同一批标注上的对照:`)
        console.log(`  手工权重 : P@1 ${(hand.precisionAt1 * 100).toFixed(1)}% · MRR ${hand.mrr.toFixed(3)}(${hand.queries} 条查询)`)
        console.log(`  学到的权重: P@1 ${(learned.precisionAt1 * 100).toFixed(1)}% · MRR ${learned.mrr.toFixed(3)}(${learned.queries} 条查询)`)
        console.log('  (同一批数据上的对照只是下限证据;真要上线要先做按查询分组的留出集)')
        console.log(`  学到的权重: ${Object.entries(model.weights).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(' ')}`)
        console.log('提示: 本命令只报告,不会改写设置里的特征权重(规划 §8.4:先离线实验,再人决定)。')
        return 0
      }
      case 'status': {
        const roster = await readWorkspaces(flag(args, 'home'))
        if (roster.length > 0) {
          console.log(`[工作区名单] ${roster.length} 个`)
          for (const record of roster) console.log(`  ${record.key}  [${record.label}]  ${record.root}`)
        }
        const anchors = await both()
        for (const tier of [anchors.project, anchors.global]) {
          const entries = await tier.list()
          const byStatus = entries.reduce<Record<string, number>>((acc, e) => { acc[e.status] = (acc[e.status] ?? 0) + 1; return acc }, {})
          const review = entries.filter((e) => e.needsReview).length
          const pending = (await tier.listApprovals(true)).length
          console.log(`[${tier.tier === 'global' ? '全局库' : '项目库'}] ${tier.dir}`)
          console.log(`  条目 ${entries.length}: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' ') || '(空)'} · 待复核 ${review} · 待批 ${pending}`)
        }
        return 0
      }
      case 'embed-config': {
        // Loaded lazily: `clue kb list` must not pay for the cordis/settings
        // stack these commands need (the bin's whole dispatch design).
        const { openEmbeddingHost } = await import('@clue-harness/kb-face/embedding-host')
        const cli = await import('./embed-cli.ts')
        const host = await openEmbeddingHost()
        try {
          const verb = args.positional[0] ?? 'show'
          const anchors = await both()
          if (verb === 'show') return await cli.embedConfigShow(host, args)
          if (verb === 'set') return await cli.embedConfigSet(host, args)
          if (verb === 'key') return await cli.embedConfigKey(host, args)
          if (verb === 'unset-key') return await cli.embedConfigUnsetKey(host)
          if (verb === 'test') return await cli.embedConfigTest(host, { ...anchors, home: flag(args, 'home') ?? clueHome(), args })
          if (verb === 'auto') return await cli.embedConfigAuto(host, { ...anchors, home: flag(args, 'home') ?? clueHome(), args })
          throw new Error(`未知 embed-config 子命令: ${verb}(show|set|key|unset-key|test)`)
        } finally {
          await host.close()
        }
      }
      case 'embed': {
        const { openEmbeddingHost } = await import('@clue-harness/kb-face/embedding-host')
        const cli = await import('./embed-cli.ts')
        const host = await openEmbeddingHost()
        try {
          const anchors = await both()
          return await cli.embedRun(host, { ...anchors, home: flag(args, 'home') ?? clueHome(), args })
        } finally {
          await host.close()
        }
      }
      case 'doctor': {
        const { openEmbeddingHost } = await import('@clue-harness/kb-face/embedding-host')
        const cli = await import('./embed-cli.ts')
        const host = await openEmbeddingHost()
        try {
          const anchors = await both()
          return await cli.doctorRun(host, { ...anchors, home: flag(args, 'home') ?? clueHome(), args })
        } finally {
          await host.close()
        }
      }
      default:
        throw new Error(`未知命令: ${args.command}\n\n${USAGE}`)
    }
  } catch (error) {
    console.error(`clue kb: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}
