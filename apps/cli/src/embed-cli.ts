/**
 * `clue kb embed-config | embed | doctor | query --explain` — the CLI face of
 * the vector layer (V1/V2, 规划 §6/§9.8).
 *
 * The plan asks for CLI parity with the settings page (§9.8) and for the cost of
 * an index build to be visible BEFORE it is paid (§6). Both are the same design
 * idea: every command that can spend money prints the account first, and
 * `--dry-run` performs the whole accounting without a single call.
 *
 * Disciplines that show up in the code:
 *
 * - **The key never rides the command line** (§9.4-5): `embed-config key` reads
 *   stdin only. A `--key sk-…` argument would land in shell history and in the
 *   process table — two places a secret must never be.
 * - **Nothing prints a value**: `show` prints the reference NAME plus a status
 *   word; `test` prints dim/latency/norm. No command here ever holds a key
 *   except the one that stores it, so no formatting bug can leak one.
 * - **`doctor` never rebuilds** (§6): it reports health from metadata alone, so
 *   diagnosing an expensive layer cannot itself trigger an expensive act.
 * - **A query from the CLI records nothing**: it neither touches entries nor
 *   writes a ranklog row. Reading is not using (宪法 4), and a human's probe is
 *   not a model retrieval — labeling the two the same would poison the very
 *   annotation set the ranklog exists to collect.
 *
 * @module @clue-harness/cli/embed
 */
import {
  embedderVersion as embedderVersionOf,
  readVectorIndex,
  vectorIndexStatuses,
  type KbStore,
  type VectorTarget,
} from '@clue-harness/kb'
import {
  buildVectorIndex,
  createHybridRetriever,
  planEmbed,
  readRankLog,
  summarizeRankLog,
  type ChunkVectorConfig,
  type Embedder,
  type RecallChannels,
} from '@clue-harness/rag'
import {
  embeddingConfigSummary,
  embeddingReadinessNote,
  embeddingReady,
  readEmbeddingConfig,
  readRetrievalConfig,
  recordMeasuredDim,
  resolveEmbeddingKey,
  storeEmbeddingKey,
  unsetEmbeddingKey,
  writeEmbeddingConfig,
  type KeyStatus,
} from '@clue-harness/kb-face/embedding'
import type { EmbeddingHost } from '@clue-harness/kb-face/embedding-host'
import { createHttpEmbedder, testConnection } from '@clue-harness/kb-face/http-embedder'
import type { LlmRankPort } from '@clue-harness/rag'

/** The parsed CLI shape `kb-cli.ts` already uses (structurally identical). */
export interface EmbedArgs {
  positional: string[]
  flags: Map<string, string[]>
}

/** Everything one command needs: the tier pair, the ClueHarness home, and args. */
export interface EmbedContext {
  project: KbStore
  global: KbStore
  /** The ClueHarness home — where the shared embed cache lives. */
  home: string
  args: EmbedArgs
}

const flag = (args: EmbedArgs, name: string): string | undefined => args.flags.get(name)?.[0]
const multi = (args: EmbedArgs, name: string): string[] => args.flags.get(name)?.filter((value) => value !== 'true') ?? []
const has = (args: EmbedArgs, name: string): boolean => args.flags.has(name)

/** The three states the plan names for a key (规划 §9.4-3). */
function keyStateLabel(state: KeyStatus['state']): string {
  return state === 'configured' ? '已配置' : state === 'missing' ? '未配置' : state === 'unresolved' ? '解析失败' : '不可用'
}

/** The live HTTP embedder for the current configuration (null when not ready). */
export function embedderFrom(host: EmbeddingHost): Embedder | null {
  const config = readEmbeddingConfig(host.ctx)
  if (!embeddingReady(config)) return null
  const live = createHttpEmbedder({
    getConfig: () => {
      const current = readEmbeddingConfig(host.ctx)
      return {
        baseUrl: current.baseUrl,
        model: current.model,
        dim: current.dim,
        headers: current.headers,
        timeoutMs: current.timeoutMs,
        batchSize: current.batchSize,
      }
    },
    resolveKey: () => resolveEmbeddingKey(host.ctx, readEmbeddingConfig(host.ctx)),
  })
  return live
}

/**
 * The chunk-level vector channel for a CLI invocation (V4).
 *
 * Returns null when no embedder is configured, which is the honest answer the
 * callers print — never a silently lexical-only result.
 * @param host - the opened settings/credentials host.
 * @param home - the ClueHarness home (the shared embed cache lives under it).
 * @returns the channel config, or null.
 */
export function planeChunkVector(host: EmbeddingHost, home: string): ChunkVectorConfig | null {
  const config = readEmbeddingConfig(host.ctx)
  if (!embeddingReady(config)) return null
  const embedder = embedderFrom(host)
  if (embedder === null) return null
  return { embedder, home, rebuildOnRead: true, maxUnitsPerBuild: config.maxUnitsPerBuild }
}

/** The targets one `--only` value addresses in one tier. */
export async function embedTargets(store: KbStore, only: string): Promise<VectorTarget[]> {
  const targets: VectorTarget[] = []
  if (only === 'entries' || only === 'all') targets.push({ kind: 'entries' })
  if (only === 'chunks' || only === 'all') {
    for (const doc of await store.listDocs()) targets.push({ kind: 'chunks', docId: String(doc.docId) })
  }
  return targets
}

/**
 * `clue kb embed-config show`
 * @param host - the opened settings/credentials host.
 * @param args - parsed flags (`--json`).
 * @returns the exit code.
 */
export async function embedConfigShow(host: EmbeddingHost, args: EmbedArgs): Promise<number> {
  const summary = await embeddingConfigSummary(host.ctx)
  if (has(args, 'json')) {
    console.log(JSON.stringify(summary, null, 2))
    return 0
  }
  console.log(`设置文档: ${host.documentPath ?? '(无)'}`)
  console.log(`启用: ${summary.enabled ? '是(向量层参与检索)' : '否(纯词法 + 明确标注"向量层未启用")'}`)
  console.log(`Base URL: ${summary.baseUrl || '(空)'}`)
  console.log(`Model:    ${summary.model || '(空)'}`)
  console.log(`维度 dim: ${summary.dim > 0 ? summary.dim : '(未实测 — 用 clue kb embed-config test 实测)'}`)
  // The reference NAME is printed; the value is not reachable from here at all
  // (规划 §9.4-3): this function never calls the resolver.
  console.log(`密钥引用 apiKeyEnv: ${summary.apiKeyEnv || '(空 — 走密钥库记录,或该端点无需鉴权)'}`)
  console.log(`密钥状态: ${keyStateLabel(summary.key.state)} — ${summary.key.detail}${summary.key.writable ? '' : '(只读,被环境变量遮蔽)'}`)
  console.log(`超时 ${summary.timeoutMs}ms · 批量 ${summary.batchSize} · 并发 ${summary.concurrency} · 单次预算 ${summary.maxUnitsPerBuild} · 量化 ${summary.quant}`)
  if (Object.keys(summary.headers).length > 0) console.log(`额外 headers: ${Object.keys(summary.headers).join(', ')}(值不回显)`)
  console.log(`embedderVersion: ${summary.embedderVersion || '(未就绪)'}`)
  return 0
}

/**
 * `clue kb embed-config set …`
 * @param host - the opened host.
 * @param args - parsed flags.
 * @returns the exit code.
 */
export async function embedConfigSet(host: EmbeddingHost, args: EmbedArgs): Promise<number> {
  const patch: Record<string, unknown> = {}
  if (flag(args, 'base-url') !== undefined) patch.baseUrl = flag(args, 'base-url')
  if (flag(args, 'model') !== undefined) patch.model = flag(args, 'model')
  if (flag(args, 'api-key-env') !== undefined) patch.apiKeyEnv = flag(args, 'api-key-env')
  if (flag(args, 'timeout-ms') !== undefined) patch.timeoutMs = Number(flag(args, 'timeout-ms'))
  if (flag(args, 'batch-size') !== undefined) patch.batchSize = Number(flag(args, 'batch-size'))
  if (flag(args, 'concurrency') !== undefined) patch.concurrency = Number(flag(args, 'concurrency'))
  if (flag(args, 'max-units') !== undefined) patch.maxUnitsPerBuild = Number(flag(args, 'max-units'))
  if (has(args, 'enable')) patch.enabled = true
  if (has(args, 'disable')) patch.enabled = false
  const headers = multi(args, 'header')
  if (headers.length > 0) {
    const parsed: Record<string, string> = {}
    for (const entry of headers) {
      const at = entry.indexOf('=')
      if (at <= 0) throw new Error(`--header 需要 k=v 形式,收到 "${entry}"`)
      parsed[entry.slice(0, at).trim()] = entry.slice(at + 1).trim()
    }
    patch.headers = { ...readEmbeddingConfig(host.ctx).headers, ...parsed }
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('embed-config set 需要至少一个字段(--base-url/--model/--api-key-env/--enable/--disable/--timeout-ms/--batch-size/--concurrency/--max-units/--header)')
  }
  const result = await writeEmbeddingConfig(host.ctx, patch)
  if (!result.ok) {
    for (const error of result.errors) console.error(`✗ ${error.field}: ${error.message}`)
    return 2
  }
  console.log(`已写入 ${host.documentPath ?? '设置文档'}`)
  for (const [key, value] of Object.entries(patch)) {
    console.log(`  ${key} = ${key === 'headers' ? '(已更新,值不回显)' : String(value)}`)
  }
  console.log('提示: 维度由 clue kb embed-config test 实测写入;改 model/dim 会作废重建向量层,只改 url/key 不会。')
  return 0
}

/**
 * `clue kb embed-config key --stdin` — the ONLY secret entry point.
 * @param host - the opened host.
 * @param args - parsed flags.
 * @returns the exit code.
 */
export async function embedConfigKey(host: EmbeddingHost, args: EmbedArgs): Promise<number> {
  if (!has(args, 'stdin')) {
    throw new Error('embed-config key 只从标准输入读取(避免密钥进 shell 历史与进程表):printf %s "$KEY" | clue kb embed-config key --stdin')
  }
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
  const value = Buffer.concat(chunks).toString('utf8').trim()
  if (value === '') throw new Error('embed-config key: 标准输入为空')
  const where = await storeEmbeddingKey(host.ctx, value)
  // Report the TARGET and the length (a safe sanity signal), never the value.
  console.log(`已写入密钥: ${where}(${value.length} 字符,不回显)`)
  return 0
}

/**
 * `clue kb embed-config unset-key`
 * @param host - the opened host.
 * @returns the exit code.
 */
export async function embedConfigUnsetKey(host: EmbeddingHost): Promise<number> {
  const where = await unsetEmbeddingKey(host.ctx)
  console.log(`已清除密钥: ${where}`)
  console.log('提示: 向量层保留,只是后续嵌入会解析失败而退回纯词法(并如实标注);要用回请重新写入密钥。')
  return 0
}

/**
 * `clue kb embed-config auto [--dry-run]`
 *
 * The zero-configuration path: probe the providers this composition ALREADY
 * names (with the credential references it already resolves), and enable the
 * first one that answers an embeddings call. The user re-types nothing.
 * @param host - the opened host.
 * @param context - home/tiers/flags.
 * @returns the exit code.
 */
export async function embedConfigAuto(host: EmbeddingHost, context: EmbedContext): Promise<number> {
  const { autoDetectEmbedder } = await import('@clue-harness/kb-face/embedding-catalog')
  const result = await autoDetectEmbedder(host.ctx, { dryRun: has(context.args, 'dry-run') })
  for (const probe of result.probes) {
    if (probe.skipped !== undefined) console.log(`· 跳过 ${probe.route}/${probe.model}: ${probe.skipped}`)
    else if (probe.ok) console.log(`✓ ${probe.route}/${probe.model} 可用(dim=${probe.dim},${probe.ms}ms)`)
    else console.log(`✗ ${probe.route}/${probe.model}: ${probe.error ?? '失败'}`)
  }
  console.log(result.summary)
  return result.applied === null ? 2 : 0
}

/**
 * `clue kb embed-config test [--no-record]`
 *
 * The CLI's equivalent of the page's 「测试连接」+ 保存: measuring the dimension
 * IS the save step, because a hand-typed dimension is refused everywhere else.
 * @param host - the opened host.
 * @param context - tiers, home and flags.
 * @returns the exit code.
 */
export async function embedConfigTest(host: EmbeddingHost, context: EmbedContext): Promise<number> {
  const stored = await readVectorIndex(context.project.dir, { kind: 'entries' })
  const current = readEmbeddingConfig(host.ctx)
  const result = await testConnection(
    {
      getConfig: () => {
        const live = readEmbeddingConfig(host.ctx)
        return {
          baseUrl: live.baseUrl,
          model: live.model,
          dim: live.dim,
          headers: live.headers,
          timeoutMs: live.timeoutMs,
          batchSize: live.batchSize,
        }
      },
      resolveKey: () => resolveEmbeddingKey(host.ctx, readEmbeddingConfig(host.ctx)),
    },
    stored?.meta.dim ?? 0,
    stored?.meta.count ?? 0,
  )
  if (!result.ok) {
    console.error(`✗ ${result.status}: ${result.message}`)
    if (result.status === 'unauthorized') {
      console.error('  提示:写密钥 printf %s "$KEY" | clue kb embed-config key --stdin,或用 --api-key-env 指向环境变量名。')
    }
    return 2
  }
  console.log(`✓ ${result.message}`)
  if (result.rebuildNotice !== undefined) console.log(`⚠ ${result.rebuildNotice}`)
  if (has(context.args, 'no-record')) {
    console.log(`实测维度 ${result.dim};已跳过写入(--no-record)。写入请去掉该开关,或在设置页保存。`)
    return 0
  }
  if (result.dim === undefined || (result.dim === current.dim && current.dim > 0)) {
    console.log(`维度未变(dim=${current.dim}),无需写入。`)
    return 0
  }
  const recorded = await recordMeasuredDim(host.ctx, result.dim)
  console.log(`已写入实测维度 dim=${recorded.dim}${recorded.rebuildImplied ? `(此前 ${recorded.previousDim},向量层将作废重建:下一步跑 clue kb embed --rebuild)` : ''}`)
  return 0
}

/**
 * `clue kb embed [--dry-run] [--only entries|chunks|all] [--rebuild]`
 *
 * Prints the account per target and then pays it. `--dry-run` stops after the
 * account — zero calls, zero cost (V1 acceptance).
 * @param host - the opened host.
 * @param context - tiers, home and flags.
 * @returns the exit code.
 */
export async function embedRun(host: EmbeddingHost, context: EmbedContext): Promise<number> {
  const args = context.args
  const embedder = embedderFrom(host)
  const config = readEmbeddingConfig(host.ctx)
  if (embedder === null) {
    console.error('嵌入未配置或未就绪 ⇒ 不建立向量层;检索仍走纯词法(不会被伪装成语义命中)。')
    console.error(`  现状: ${embeddingReadinessNote(config)} · baseUrl ${config.baseUrl || '(空)'} · model ${config.model || '(空)'} · dim ${config.dim || '(未实测)'}`)
    console.error('  步骤: clue kb embed-config set --base-url … --model … [--api-key-env NAME] → 写密钥 → clue kb embed-config test')
    return 2
  }
  const only = flag(args, 'only') ?? 'entries'
  if (!['entries', 'chunks', 'all'].includes(only)) throw new Error('--only 只能是 entries|chunks|all')
  const dryRun = has(args, 'dry-run')
  const rebuild = has(args, 'rebuild')
  const version = embedderVersionOf({ modelId: config.model, dim: config.dim })
  console.log(`${dryRun ? '[dry-run] ' : ''}embedderVersion: ${version}`)
  console.log(`配置: 批量 ${config.batchSize} · 并发 ${config.concurrency} · 单次预算 ${config.maxUnitsPerBuild} · 超时 ${config.timeoutMs}ms`)

  let units = 0
  let cacheHits = 0
  let calls = 0
  let chars = 0
  let missing = 0
  let skipped = 0
  for (const [tierName, store] of [['项目库', context.project], ['全局库', context.global]] as const) {
    for (const target of await embedTargets(store, only)) {
      const label = `${tierName} ${target.kind === 'entries' ? 'entries' : `chunks ${target.docId}`}`
      const options = {
        home: context.home,
        embedder,
        target,
        batchSize: config.batchSize,
        concurrency: config.concurrency,
        maxUnitsPerBuild: config.maxUnitsPerBuild,
        rebuild,
      }
      const plan = await planEmbed(store, options)
      if (plan.upToDate) {
        console.log(`· ${label}: 已是最新(${plan.units} 条),不动文件`)
        units += plan.units
        continue
      }
      console.log(`· ${label}: 单元 ${plan.units} · 命中缓存 ${plan.cacheHits} · 待嵌入 ${plan.toEmbed} · 预算内 ${plan.withinBudget} · 批次 ${plan.batches} · 字符 ${plan.chars}${plan.budgetHit ? ' ⚠ 超预算:本轮只做预算内的部分' : ''}`)
      units += plan.units
      cacheHits += plan.cacheHits
      if (dryRun) continue
      const report = await buildVectorIndex(store, options)
      calls += report.calls
      chars += report.chars
      missing += report.missing
      skipped += report.skipped
      if (report.upToDate) continue
      console.log(`  ✓ 落盘 ${report.rows} 行 · 调用 ${report.calls} 次 · 字符 ${report.chars}${report.missing > 0 ? ` · ⚠ 缺 ${report.missing} 条(标 partial)` : ''}`)
    }
  }
  if (dryRun) {
    console.log(`dry-run 合计: 单元 ${units} · 命中缓存 ${cacheHits} · 待嵌入 ${units - cacheHits}(零调用零花费)`)
    return 0
  }
  console.log(`合计: 单元 ${units} · 命中缓存 ${cacheHits} · 调用 ${calls} 次 · 字符 ${chars}${missing > 0 ? ` · 缺 ${missing} 条(下次重试)` : ''}${skipped > 0 ? ` · 预算外跳过 ${skipped} 条(下轮继续)` : ''}`)
  return 0
}

/**
 * `clue kb doctor` — the vector layer's health, from metadata alone.
 * @param host - the opened host.
 * @param context - tiers, home and flags.
 * @returns the exit code.
 */
export async function doctorRun(host: EmbeddingHost, context: EmbedContext): Promise<number> {
  const args = context.args
  const config = readEmbeddingConfig(host.ctx)
  const tuning = readRetrievalConfig(host.ctx)
  const ready = embeddingReady(config)
  const version = ready ? embedderVersionOf({ modelId: config.model, dim: config.dim }) : null
  const status = await embeddingConfigSummary(host.ctx, version ?? undefined)

  const tiers: Array<{ name: string; store: KbStore }> = [
    { name: '项目库', store: context.project },
    { name: '全局库', store: context.global },
  ]
  const rows: Array<{ tier: string; status: Awaited<ReturnType<typeof vectorIndexStatuses>>[number] }> = []
  for (const tier of tiers) {
    for (const row of await vectorIndexStatuses(tier.store.dir, version)) rows.push({ tier: tier.name, status: row })
  }
  const ranklog = await summarizeRankLog(context.project.dir, [])

  if (has(args, 'json')) {
    console.log(JSON.stringify({
      config: status,
      indexes: rows.map((row) => ({ tier: row.tier, ...row.status })),
      ranklog,
      ranklogRows: (await readRankLog(context.project.dir)).length,
    }, null, 2))
    return 0
  }

  console.log('[嵌入配置]')
  console.log(`  启用 ${config.enabled ? '是' : '否'} · ${embeddingReadinessNote(config)}`)
  console.log(`  baseUrl ${config.baseUrl || '(空)'} · model ${config.model || '(空)'} · dim ${config.dim || '(未实测)'}`)
  console.log(`  密钥 ${keyStateLabel(status.key.state)} — ${status.key.detail}`)
  console.log(`  embedderVersion ${version ?? '(未就绪 ⇒ 检索走纯词法并如实标注)'}`)

  console.log('[向量层]')
  if (rows.length === 0) console.log('  尚未建立(首次 clue kb embed 或首次检索会自动建,受 maxUnitsPerBuild 护栏约束)')
  for (const row of rows) {
    const notes: string[] = []
    if (row.status.stale) notes.push(version === null ? '嵌入未配置 ⇒ 语义通道停用' : '版本过期 ⇒ 下次使用会重建')
    if (row.status.unreadable) notes.push('文件缺失/长度不符 ⇒ 会重建')
    if (row.status.missing > 0) notes.push(`partial: 缺 ${row.status.missing} 条`)
    console.log(`  ${row.tier} ${row.status.stem}: ${row.status.count} 行 × ${row.status.dim} 维 · 建于 ${row.status.builtAt}${notes.length > 0 ? ` · ⚠ ${notes.join(' · ')}` : ' · ✓'}`)
  }

  console.log('[检索调优]')
  console.log(`  融合 ${tuning.fusion}(k=${tuning.rrfK}) · 通道权重 词法 ${tuning.channelWeights.lexical} / 语义 ${tuning.channelWeights.vector}`)
  console.log(`  召回深度 ${tuning.recallDepth} · 精排候选 ${tuning.rerankCandidates} · 精排 ${tuning.rerank ? '开' : '关(--rerank off 复现今日排序)'}`)
  console.log(`  ranklog ${tuning.ranklog ? '开' : '关'}: ${ranklog.rows} 行 / ${ranklog.queries} 个不同查询`)
  console.log('提示: 这里只读元数据,不重建任何东西(诊断本身不该花钱)。')
  return 0
}

/**
 * `clue kb query <词…> --explain [--channel …] [--rerank on|off] [--profile …]`
 *
 * Runs the SAME hybrid retriever the tool channel runs, so a disagreement
 * between what a human sees here and what the model sees is a bug rather than a
 * configuration difference.
 * @param host - the opened host.
 * @param context - tiers, home and flags.
 * @returns the exit code.
 */
export async function queryExplainRun(host: EmbeddingHost, context: EmbedContext): Promise<number> {
  const args = context.args
  const text = args.positional.join(' ')
  if (text.trim() === '') throw new Error('query 需要检索词')
  const config = readEmbeddingConfig(host.ctx)
  const tuning = readRetrievalConfig(host.ctx)
  const channelFlag = flag(args, 'channel')
  const channels = (channelFlag ?? (embeddingReady(config) ? 'hybrid' : 'lexical')) as RecallChannels
  if (!['lexical', 'vector', 'hybrid'].includes(channels)) throw new Error('--channel 只能是 lexical|vector|hybrid')
  const rerankFlag = flag(args, 'rerank')
  const rerank = rerankFlag === undefined ? tuning.rerank : rerankFlag === 'on'
  const limit = flag(args, 'limit') !== undefined ? Number(flag(args, 'limit')) : 5
  const embedder = channels === 'lexical' ? null : embedderFrom(host)
  // V5 (规划 §8.4): the model reranker is opt-in per call (`--llm-rerank`) or
  // by setting, and its result is printed as a DIFF against the deterministic
  // order rather than replacing it silently.
  const wantLlmRerank = has(args, 'llm-rerank') || tuning.llmRerank
  let llmPort: LlmRankPort | null = null
  let chatHost: Awaited<ReturnType<typeof import('@clue-harness/kb-face/chat-host').openChatHost>> | null = null
  let llmRerankError: string | null = null
  // The engine reports the reason for a skipped/failed rerank through this
  // hook; the CLI surfaces it verbatim instead of a bare "未生效".
  const rerankDiagnostics: string[] = []
  if (wantLlmRerank) {
    const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot')
    loadLayeredEnv('clue')
    const { openChatHost, chatRankPort } = await import('@clue-harness/kb-face/chat-host')
    // Kept for the whole call and disposed at the end: the host owns the llm
    // runtime, and a leaked one keeps the process alive after the command.
    chatHost = await openChatHost({
      ...(flag(args, 'provider') !== undefined ? { provider: flag(args, 'provider') as string } : {}),
      ...(flag(args, 'model') !== undefined ? { model: flag(args, 'model') as string } : {}),
    })
    // Capture the failure reason: `llmRerank` deliberately degrades to the
    // deterministic order on any error (规划 §8.4), so without this the user
    // would see "未生效" and never learn WHY — a missing credential looks
    // exactly like a timeout from the outside.
    const inner = chatRankPort(chatHost)
    llmPort = {
      rank: async (prompt, signal) => {
        try {
          return await inner.rank(prompt, signal)
        } catch (error) {
          llmRerankError = error instanceof Error ? error.message : String(error)
          throw error
        }
      },
    }
  }

  const retriever = createHybridRetriever(context.project, context.global, {
    channels,
    rerank,
    llmRerank: wantLlmRerank,
    topK: limit,
    profile: flag(args, 'profile') ?? 'tool',
    recallDepth: tuning.recallDepth,
    rerankCandidates: tuning.rerankCandidates,
    rrfK: tuning.rrfK,
    channelWeights: tuning.channelWeights,
    featureWeights: tuning.featureWeights,
    // 不变量 2 (D 规划 §6): `--explain` 必须解释**线上那一份配置**的每一分。
    // 这些旋钮此前没转发,于是把设置页里的档位改掉之后,explain 打印的仍是默认档位的算式
    // —— 解释与产物不一致,比没有解释更糟。
    lexicalScorer: tuning.lexicalScorer,
    lexicalNormalization: tuning.lexicalNormalization,
    semanticScale: tuning.semanticScale,
    semanticFloor: tuning.semanticFloor,
    semanticCeil: tuning.semanticCeil,
    missingFeatureMode: tuning.missingFeatureMode,
    trustThreshold: context.project.config.trustThreshold,
    home: context.home,
    ...(embedder !== null ? { embedder } : {}),
    ...(llmPort !== null ? { llmRerankPort: llmPort } : {}),
    ...(llmPort !== null ? { llmRerankTimeoutMs: 30_000, llmRerankErrorSink: (reason: string) => { llmRerankError = reason } } : {}),
  })
  let detailed: Awaited<ReturnType<typeof retriever.retrieveDetailed>>
  try {
    detailed = await retriever.retrieveDetailed(text, {
      limit,
      ...(has(args, 'include-expired') ? { includeExpired: true } : {}),
      // An inspection surface: reading is not using (宪法 4).
      noTouch: true,
    })
  } finally {
    // The chat host owns an llm runtime; leaving it up keeps the process alive
    // after the command prints its answer.
    if (chatHost !== null) await chatHost.close()
    chatHost = null
  }
  console.log(`查询「${text}」 · 通道 ${channels} · 精排 ${rerank ? 'on' : 'off'} · profile ${detailed.profile.name}${wantLlmRerank ? ' · 模型重排 on' : ''}`)
  console.log(`召回: 词法 ${detailed.recalled.lexical} · 语义 ${detailed.recalled.vector} · 融合 ${detailed.fused} · 语义通道 ${detailed.vector.status}`)
  if (detailed.vector.status !== 'used') console.log(`  ⚠ ${detailed.vector.note}`)
  if (detailed.hits.length === 0) {
    console.log('没有命中。')
    return 0
  }
  if (wantLlmRerank) {
    if (detailed.llmRerank === undefined || detailed.llmRerank === null) {
      console.log(`  模型重排: 未生效 ⇒ 保留确定性精排序${llmRerankError === null ? '(候选不足)' : `(原因: ${llmRerankError})`}`)
    } else {
      const { describeRerankDiff } = await import('@clue-harness/rag')
      for (const line of describeRerankDiff(detailed.llmRerank, (id) => detailed.hits.find((hit) => String(hit.entry.id) === id)?.entry.title ?? id)) {
        console.log(`  ${line}`)
      }
    }
  }
  for (const hit of detailed.hits) {
    console.log('')
    console.log(`▸ [${hit.score}] ${hit.entry.id} <${hit.entry.kind},${hit.entry.status}${hit.entry.tier === 'global' ? ',全局' : ''}> ${hit.entry.title}`)
    if (hit.explain !== undefined) {
      for (const line of hit.explain.lines) console.log(`    · ${line}`)
      const ranks = Object.entries(hit.explain.channels).map(([name, rank]) => `${name} #${rank}`).join(' ')
      if (ranks !== '') console.log(`    · 通道名次 ${ranks}`)
    }
    for (const note of hit.annotations) console.log(`    ⚠ ${note}`)
  }
  return 0
}
