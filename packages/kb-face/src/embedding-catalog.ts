/**
 * The embedder catalog (V1 follow-up, 原规划 §9.3/§9.5) — the settings page's
 * "pick a model" list.
 *
 * The first edition of the page had a free-text Model field, which asked the
 * user to know three things that the product already knew or could look up: an
 * embedding model's id, the OpenAI-compatible base URL of the provider that
 * serves it, and the name of the environment reference that provider's key
 * lives behind. The user's own report is the requirement: *"最好设置里可以选择
 * embedder 的模型"* — and the point of a picker here is not convenience, it is
 * that the three values must agree, and a hand-typed mismatch is exactly what
 * produces a 404 that looks like a broken endpoint.
 *
 * Two sources are merged, and the difference is visible in the answer:
 *
 * 1. **The composition's own providers** (`llm-pi-ai.providers`): each route's
 *    `baseURL` and `apiKeyEnv` come from the user's settings document, so a
 *    provider they already configured — and whose key is already resolvable —
 *    appears with its real address and a live key-status badge. This is what
 *    "直接使用已经配置好的模型" means in practice.
 * 2. **A built-in table of KNOWN embedding models**: a chat provider's route
 *    says nothing about whether it serves embeddings, and no published API
 *    lists that, so the table carries the ones we can name, each with the note
 *    that the DIMENSION IS STILL MEASURED by the connection test (never typed).
 *
 * What the table deliberately also carries is the honest negative: DeepSeek's
 * official endpoint has no embeddings route (verified: `POST /v1/embeddings`
 * → 404, and `/v1/models` lists chat models only). Listing it as unusable —
 * with that evidence — is worth more than leaving the user to rediscover it.
 *
 * @module @clue-harness/kb-face/embedding-catalog
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** One selectable embedder. */
export interface EmbeddingCandidate {
  /** Stable id (`<route>:<model>`) — the UI's option value. */
  id: string
  /** The provider route it belongs to (a settings key, or 'builtin'/'local'). */
  route: string
  /** Human label for the option. */
  label: string
  /** OpenAI-compatible base URL (the adapter appends `/embeddings`). */
  baseUrl: string
  /** The model id to send. */
  model: string
  /** The environment reference the key lives behind ('' = no key needed). */
  apiKeyEnv: string
  /** Published dimension when we can name one (the test still measures it). */
  dimHint: number | null
  /** Whether this entry can actually serve embeddings. */
  usable: boolean
  /** Why not, or what to watch out for. */
  note?: string
}

/** One provider group in the picker. */
export interface EmbeddingCandidateGroup {
  route: string
  label: string
  baseUrl: string
  apiKeyEnv: string
  /** `已配置 / 未配置 / 解析失败` — never a value (原规划 §9.4-3). */
  keyState: 'configured' | 'missing' | 'unresolved' | 'unknown'
  keyDetail: string
  /** True when the key is currently resolvable (the entry can be tried). */
  keyReady: boolean
  candidates: EmbeddingCandidate[]
}

/** Everything the picker needs, in one read. */
export interface EmbeddingCatalog {
  groups: EmbeddingCandidateGroup[]
  /** The chat route the model reranker will use (V5), for the page's readout. */
  chat: { provider: string; model: string } | null
  notices: string[]
}

/**
 * Known embedding models per provider host.
 *
 * Keyed by a substring of the base URL so a route configured with a slightly
 * different spelling still matches. `dimHint` is public documentation, NOT a
 * promise: the page writes the dimension only from 「测试连接」's measurement.
 */
const KNOWN_MODELS: Array<{ match: string; models: Array<{ model: string; dimHint: number | null }>; note: string }> = [
  {
    match: 'dashscope.aliyuncs.com',
    models: [
      { model: 'text-embedding-v4', dimHint: 1024 },
      { model: 'text-embedding-v3', dimHint: 1024 },
      { model: 'text-embedding-v2', dimHint: 1536 },
    ],
    note: '阿里云百炼(dashscope 兼容模式):同一把 key 同时供 chat 与 embedding,无需另开服务',
  },
  {
    match: 'volces.com',
    models: [
      { model: 'doubao-embedding-large-text-240915', dimHint: 2048 },
      { model: 'doubao-embedding-text-240715', dimHint: 2560 },
    ],
    note: '火山方舟(ark):需在控制台开通对应的 embedding 接入点;模型名以方舟控制台为准',
  },
  {
    match: 'ai-pixel.online',
    models: [],
    note: '该网关未见公开的嵌入模型清单:若它转发 OpenAI,可填 text-embedding-3-small 这类名字试一次「测试连接」',
  },
  {
    match: 'maas.aliyuncs.com',
    models: [],
    note: '该 Maas 端点以 chat 为主:嵌入模型名未知,可试 text-embedding-v3;「测试连接」会告诉你行不行',
  },
]

/** Local, key-free embedders worth offering as a first try. */
const LOCAL_ENTRIES: Array<{ baseUrl: string; model: string; dimHint: number | null; note: string }> = [
  { baseUrl: 'http://127.0.0.1:11434/v1', model: 'nomic-embed-text', dimHint: 768, note: '本地 Ollama(需先 `ollama pull nomic-embed-text`);不花钱、不需要密钥' },
  { baseUrl: 'http://127.0.0.1:11434/v1', model: 'bge-m3', dimHint: 1024, note: '本地 Ollama 的中文友好选项(`ollama pull bge-m3`)' },
]

/** The one provider we can name as NOT embedding-capable, with its evidence. */
const UNSUPPORTED: Array<{ route: string; label: string; baseUrl: string; apiKeyEnv: string; note: string }> = [
  {
    route: 'deepseek-official',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    note: '实测无嵌入端点:POST /v1/embeddings → 404,GET /v1/models 只列 chat 模型。对话模型请用于「模型重排」,不要用来做嵌入',
  },
]

/** The probe text (one short call — the smallest thing that proves the endpoint). */
export const CONNECTION_PROBE_TEXT = '连接测试'

/** Loose shape of the `llm-pi-ai` settings section we read. */
interface PiAiSection {
  providers?: Record<string, {
    apiKeyEnv?: string
    baseURL?: string
    name?: string
    models?: Array<{ id?: string }>
  }>
}

/**
 * Build the picker's catalog.
 *
 * @param ctx - a context with `ctx.settings` (and optionally `ctx.credentials`).
 * @returns the provider groups plus the chat route for the rerank readout.
 */
export async function buildEmbeddingCatalog(ctx: Context): Promise<EmbeddingCatalog> {
  const notices: string[] = []
  const groups: EmbeddingCandidateGroup[] = []
  const settings = ctx.get('settings')
  const credentials = ctx.get('credentials')

  /** Describe one key reference without reading its value. */
  const describeKey = async (env: string): Promise<{ state: EmbeddingCandidateGroup['keyState']; detail: string; ready: boolean }> => {
    if (env === '') return { state: 'configured', detail: '无需密钥', ready: true }
    if (credentials === undefined) return { state: 'unknown', detail: '本上下文没有凭据服务', ready: false }
    try {
      const ref: CredentialRef = credentialRef(env)
      const info = await credentials.describe(ref)
      return info.configured
        ? { state: 'configured', detail: `引用 ${env}(来源 ${info.source ?? '未知'})`, ready: true }
        : { state: 'missing', detail: `引用 ${env} 未配置`, ready: false }
    } catch {
      return { state: 'unresolved', detail: `引用 ${env} 无法解析`, ready: false }
    }
  }

  // ── 1) the composition's own providers ──────────────────────────────────
  // Namespaces are branded; the pi-ai section is registered by ITS plugin in the
  // full composition, so this read is best-effort (an absent namespace just
  // means we fall back to the built-in catalog).
  const piAi = settings?.get(settingsNamespace('llm-pi-ai')) as PiAiSection | undefined
  const configured = piAi?.providers ?? {}
  if (Object.keys(configured).length === 0) {
    notices.push('没有读到已配置的 `llm-pi-ai` provider(该命名空间未注册或文档里没有这一节)——下面只列内置目录与本地选项')
  }
  for (const [route, profile] of Object.entries(configured)) {
    const baseUrl = String(profile.baseURL ?? '')
    const apiKeyEnv = String(profile.apiKeyEnv ?? '')
    const known = KNOWN_MODELS.find((entry) => baseUrl.includes(entry.match))
    const key = await describeKey(apiKeyEnv)
    const candidates: EmbeddingCandidate[] = (known?.models ?? []).map((entry) => ({
      id: `${route}:${entry.model}`,
      route,
      label: `${entry.model}${entry.dimHint === null ? '' : ` (${entry.dimHint} 维)`}`,
      baseUrl,
      model: entry.model,
      apiKeyEnv,
      dimHint: entry.dimHint,
      usable: true,
      ...(known?.note !== undefined ? { note: known.note } : {}),
    }))
    groups.push({
      route,
      label: `${route}${profile.name === undefined ? '' : ` · ${profile.name}`}`,
      baseUrl,
      apiKeyEnv,
      keyState: key.state,
      keyDetail: key.detail,
      keyReady: key.ready,
      candidates,
    })
  }

  // ── 2) the honest negative, so nobody repeats the experiment ────────────
  for (const entry of UNSUPPORTED) {
    const key = await describeKey(entry.apiKeyEnv)
    groups.push({
      route: entry.route,
      label: entry.label,
      baseUrl: entry.baseUrl,
      apiKeyEnv: entry.apiKeyEnv,
      keyState: key.state,
      keyDetail: key.detail,
      keyReady: false,
      candidates: [{
        id: `${entry.route}:none`,
        route: entry.route,
        label: '无嵌入模型(不可用于向量层)',
        baseUrl: entry.baseUrl,
        model: '',
        apiKeyEnv: entry.apiKeyEnv,
        dimHint: null,
        usable: false,
        note: entry.note,
      }],
    })
  }

  // ── 3) local, key-free options ──────────────────────────────────────────
  groups.push({
    route: 'local',
    label: '本地(Ollama,无需密钥)',
    baseUrl: LOCAL_ENTRIES[0]?.baseUrl ?? '',
    apiKeyEnv: '',
    keyState: 'configured',
    keyDetail: '无需密钥',
    keyReady: true,
    candidates: LOCAL_ENTRIES.map((entry) => ({
      id: `local:${entry.model}`,
      route: 'local',
      label: `${entry.model}${entry.dimHint === null ? '' : ` (${entry.dimHint} 维)`}`,
      baseUrl: entry.baseUrl,
      model: entry.model,
      apiKeyEnv: '',
      dimHint: entry.dimHint,
      usable: true,
      note: entry.note,
    })),
  })

  // ── 4) the chat route the model reranker will use (V5) ──────────────────
  let chat: { provider: string; model: string } | null = null
  const defaultModel = settings?.get(settingsNamespace('agent-default-model')) as { provider?: string; model?: string } | undefined
  if (typeof defaultModel?.provider === 'string' && typeof defaultModel.model === 'string') {
    chat = { provider: defaultModel.provider, model: defaultModel.model }
  }
  return { groups, chat, notices }
}

/**
 * The candidate one configuration currently matches (for the picker's selected
 * state), or null when the stored values came from somewhere else.
 * @param catalog - the built catalog.
 * @param config - the resolved provider configuration.
 * @returns the matching candidate id, or null.
 */
export function matchCandidate(catalog: EmbeddingCatalog, config: { baseUrl: string; model: string }): string | null {
  for (const group of catalog.groups) {
    for (const candidate of group.candidates) {
      if (candidate.model !== '' && candidate.model === config.model && sameBase(candidate.baseUrl, config.baseUrl)) return candidate.id
    }
  }
  return null
}

/** Compare two base URLs ignoring a trailing slash. */
function sameBase(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '')
}

/** One candidate's probe outcome. */
export interface CandidateProbe {
  id: string
  route: string
  model: string
  baseUrl: string
  ok: boolean
  /** The measured dimension (the ONLY writer of `dim`). */
  dim?: number
  /** Round-trip time of the probe. */
  ms?: number
  /** Why it failed (status + host only — never a key). */
  error?: string
  /** Skipped before any call: no key resolvable, or not an embedding model. */
  skipped?: string
}

/** The auto-detect outcome. */
export interface AutoDetectResult {
  probes: CandidateProbe[]
  /** The candidate that worked and was saved (null when nothing worked). */
  applied: { id: string; baseUrl: string; model: string; apiKeyEnv: string; dim: number } | null
  /** Set when the write happened (dryRun=false). */
  written: boolean
  /** The one line a page or CLI prints verbatim. */
  summary: string
}

/**
 * Find a working embedder among the candidates, using keys that ALREADY exist.
 *
 * This is the answer to "为什么还要我再配一遍": the composition already names
 * providers and their credential references, so the only unknown is WHICH of
 * them serves an embedding model — and that question is answered by one cheap
 * call, not by asking the user. Probes run in order (key-ready first, then
 * known-model-before-unknown, then local), stop at the first success, and the
 * winner is saved with its MEASURED dimension.
 *
 * Bounded on purpose: at most `maxCandidates` calls, each with its own timeout,
 * so a misconfigured endpoint cannot turn one click into a long hang.
 *
 * @param ctx - a context with settings (and credentials for the keys).
 * @param options - dry run, caps, and an injectable fetch (tests).
 * @returns every probe's outcome plus what was applied.
 */
export async function autoDetectEmbedder(
  ctx: Context,
  options: { dryRun?: boolean; maxCandidates?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<AutoDetectResult> {
  const { createHttpEmbedder } = await import('./http-embedder.ts')
  const credentials = ctx.get('credentials')
  const catalog = await buildEmbeddingCatalog(ctx)
  const maxCandidates = options.maxCandidates ?? 6
  const timeoutMs = options.timeoutMs ?? 15_000
  const probes: CandidateProbe[] = []

  // Probe order: a candidate whose key resolves and whose model we can name is
  // far more likely to work than a guess, so it goes first; local options last
  // (they cost nothing but usually are not installed).
  const flat = catalog.groups
    .flatMap((group) => group.candidates.map((candidate) => ({ candidate, group })))
    .filter((row) => row.candidate.usable && row.candidate.model !== '')
    .sort((a, b) => {
      const score = (row: typeof a): number => (row.group.keyReady ? 0 : 4) + (row.group.route === 'local' ? 2 : 0) + (row.candidate.dimHint === null ? 1 : 0)
      return score(a) - score(b)
    })

  let applied: AutoDetectResult['applied'] = null
  for (const { candidate, group } of flat.slice(0, maxCandidates)) {
    if (!group.keyReady) {
      probes.push({ id: candidate.id, route: candidate.route, model: candidate.model, baseUrl: candidate.baseUrl, ok: false, skipped: group.keyDetail })
      continue
    }
    const started = Date.now()
    try {
      const embedder = createHttpEmbedder({
        getConfig: () => ({ baseUrl: candidate.baseUrl, model: candidate.model, dim: 0, headers: {}, timeoutMs, batchSize: 1 }),
        resolveKey: async () => {
          if (candidate.apiKeyEnv === '') return null
          if (credentials === undefined) return null
          const hit = await credentials.resolve(credentialRef(candidate.apiKeyEnv))
          return hit?.value ?? null
        },
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      })
      const [vector] = await embedder.embed([CONNECTION_PROBE_TEXT])
      const dim = vector?.length ?? 0
      if (dim <= 0) throw new Error('embedding probe: the endpoint returned an empty vector')
      probes.push({ id: candidate.id, route: candidate.route, model: candidate.model, baseUrl: candidate.baseUrl, ok: true, dim, ms: Date.now() - started })
      if (applied === null) {
        applied = { id: candidate.id, baseUrl: candidate.baseUrl, model: candidate.model, apiKeyEnv: candidate.apiKeyEnv, dim }
      }
      break
    } catch (error) {
      probes.push({
        id: candidate.id, route: candidate.route, model: candidate.model, baseUrl: candidate.baseUrl, ok: false,
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (applied === null) {
    return { probes, applied: null, written: false, summary: '没有探测到可用的嵌入端点:检查 provider 的密钥引用是否已配置(设置页会显示引用的名字)' }
  }
  if (options.dryRun === true) {
    return { probes, applied, written: false, summary: `[dry-run] ${applied.model} @ ${applied.baseUrl} 可用(dim=${applied.dim}),未写入` }
  }
  const { writeEmbeddingConfig, recordMeasuredDim } = await import('./embedding-config.ts')
  const written = await writeEmbeddingConfig(ctx, {
    enabled: true,
    baseUrl: applied.baseUrl,
    model: applied.model,
    apiKeyEnv: applied.apiKeyEnv,
  })
  if (!written.ok) {
    const detail = written.errors.map((error) => `${error.field}: ${error.message}`).join('; ')
    return { probes, applied, written: false, summary: `探测成功但写入被拒(${detail})` }
  }
  await recordMeasuredDim(ctx, applied.dim)
  return {
    probes,
    applied,
    written: true,
    summary: `已启用嵌入:${applied.model} @ ${applied.baseUrl}(dim=${applied.dim} 实测)${applied.apiKeyEnv === '' ? ' · 无需密钥' : ` · 密钥引用 ${applied.apiKeyEnv}`}。下一步:重建向量层。`,
  }
}
