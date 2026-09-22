/**
 * The embedding configuration plane (V1, 规划 §9) — one namespace, one
 * credential reference, and NO secret in any file of ours.
 *
 * The plan's §9.1 reasoning is the whole design: this configuration contains a
 * SECRET, so it may not live in a plaintext JSON of ours, may not be echoed to a
 * page, may not reach a log, and may not be committed. dsh already solved that
 * with two mechanisms, and we use both instead of inventing a third:
 *
 * - **Non-secret fields** live in the dsh settings document (`settings.yaml`
 *   under `$DSH_HOME`) in the namespaces `clue.kb.embedding` and
 *   `clue.kb.retrieval`. `ctx.settings.register` validates them against the
 *   schemastery schema declared HERE, so the host, the CLI and the settings page
 *   cannot disagree about what a valid configuration is.
 * - **The secret** is never a field. A configuration carries either a
 *   REFERENCE (`apiKeyEnv`, a POSIX identifier such as `SILICONFLOW_API_KEY`,
 *   resolved through `ctx.credentials.resolve`) or nothing at all — in which
 *   case the value lives in the credential STORE as a record under
 *   `credentialKey('clue-kb-face', 'embedding')`. Both roads are dsh's; which
 *   one is in use is reported as a STATUS, never as a value.
 *
 * Four disciplines that show up as code below:
 *
 * 1. **Resolved per operation** (不变量 11): {@link resolveEmbeddingKey} runs at
 *    the start of every embedding call and caches nothing, so rotating a key
 *    reaches the very next call without restarting the host.
 * 2. **Never echoed** (规划 §9.4-3): every reporting path returns
 *    `已配置 / 未配置 / 解析失败` plus the reference NAME. Nothing in this file
 *    hands a value to a surface; the only value-returning function is
 *    {@link resolveEmbeddingKey}, whose callers are the embedder itself.
 * 3. **Validated where the user is looking** (规划 §9.3):
 *    {@link validateEmbeddingPatch} names the exact field that failed, because
 *    "保存失败" without a field name is a bug report nobody can act on.
 * 4. **`dim` cannot be typed** (规划 §15.3, recommended and taken): it is
 *    measured by the connection test and written only through
 *    {@link recordMeasuredDim}. A hand-typed dimension silently poisons the
 *    version stamp and every cosine after it, so the field is refused rather
 *    than trusted.
 *
 * @module @clue-harness/kb-face/embedding-config
 */
import z from '@deepseek-ai/schemastery'
import {
  credentialKey,
  credentialRef,
  isCredentialRefName,
  type CredentialKey,
  type CredentialRef,
} from '@deepseek-ai/dsh-credentials'
import { settingsNamespace, type SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import { embedderVersion } from '@clue-harness/kb'
import { DEFAULT_FEATURE_WEIGHTS, RETRIEVAL_DEFAULTS, type RerankFeatureWeights } from '@clue-harness/rag'

/**
 * The provider namespace (规划 §9.2/§9.3 A) — with one RECORDED DEVIATION.
 *
 * The plan writes it as `clue.kb.embedding`. A dsh settings namespace is
 * validated against `/^[a-z][a-z0-9-]*$/` (`dsh-settings`: `settingsNamespace`),
 * so dots are illegal and the dotted spelling cannot be registered at all. The
 * contract wins (house rule: 文档与代码冲突时以代码为准并记录差异), and the legal
 * equivalent is used unchanged everywhere — one casing, one separator.
 */
export const EMBEDDING_NAMESPACE = settingsNamespace('clue-kb-embedding')

/** The retrieval-tuning namespace (规划 §9.3 B; same dot→dash deviation as above). */
export const RETRIEVAL_NAMESPACE = settingsNamespace('clue-kb-retrieval')

/** Our plugin's registered name — the SCOPE of the credential record. */
export const CREDENTIAL_SCOPE = 'clue-kb-face'

/** The credential store id of the embedding key (dsh: key = `<scope>/<id>`). */
export const EMBEDDING_CREDENTIAL_ID = 'embedding'

/** The shipped provider defaults (规划 §9.3 A). */
export const DEFAULT_EMBEDDING_CONFIG = {
  enabled: false,
  baseUrl: '',
  apiKeyEnv: '',
  model: '',
  /** 0 = not measured yet; only the connection test writes this. */
  dim: 0,
  headers: {} as Record<string, string>,
  timeoutMs: 15000,
  batchSize: 32,
  concurrency: 1,
  maxUnitsPerBuild: 2000,
  quant: 'fp32' as const,
}

/** The resolved provider configuration (what the embedder reads). */
export type EmbeddingConfig = typeof DEFAULT_EMBEDDING_CONFIG

/** The shipped retrieval defaults (规划 §9.3 B). */
export const DEFAULT_RETRIEVAL_CONFIG = {
  ...RETRIEVAL_DEFAULTS,
  fusion: RETRIEVAL_DEFAULTS.fusion as 'rrf',
  channelWeights: { ...RETRIEVAL_DEFAULTS.channelWeights },
  featureWeights: DEFAULT_FEATURE_WEIGHTS as RerankFeatureWeights,
}

/** The resolved retrieval-tuning configuration. */
export type RetrievalConfig = typeof DEFAULT_RETRIEVAL_CONFIG

/**
 * The provider schema.
 *
 * `dim` is declared but is NOT user-writable (§15.3): the validation layer
 * refuses a patch that carries it, so its presence here exists to serialize the
 * measured value to the settings document and to the page.
 */
export const EmbeddingSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default(''),
  apiKeyEnv: z.string().default(''),
  model: z.string().default(''),
  dim: z.natural().default(0),
  headers: z.dict(z.string()).default({}),
  timeoutMs: z.natural().default(15000),
  batchSize: z.natural().default(32),
  concurrency: z.natural().default(1),
  maxUnitsPerBuild: z.natural().default(2000),
  quant: z.union([z.const('fp32'), z.const('int8')]).default('fp32'),
})

/** The retrieval-tuning schema. */
export const RetrievalSchema = z.object({
  fusion: z.union([z.const('rrf'), z.const('weighted')]).default(RETRIEVAL_DEFAULTS.fusion),
  rrfK: z.natural().default(RETRIEVAL_DEFAULTS.rrfK),
  channelWeights: z.object({
    lexical: z.number().default(RETRIEVAL_DEFAULTS.channelWeights.lexical),
    vector: z.number().default(RETRIEVAL_DEFAULTS.channelWeights.vector),
  }).default({ ...RETRIEVAL_DEFAULTS.channelWeights }),
  recallDepth: z.natural().default(RETRIEVAL_DEFAULTS.recallDepth),
  rerankCandidates: z.natural().default(RETRIEVAL_DEFAULTS.rerankCandidates),
  rerank: z.boolean().default(RETRIEVAL_DEFAULTS.rerank),
  llmRerank: z.boolean().default(RETRIEVAL_DEFAULTS.llmRerank),
  ranklog: z.boolean().default(RETRIEVAL_DEFAULTS.ranklog),
  /**
   * V3 (规划 §11): which query-writing doctrine the `tool:kb` prompt teaches.
   * `intent` is the plan's target; `keywords` is the pre-V3 text, kept because
   * the A/B has to be able to run both and because a deployment can pin the
   * old behavior while it evaluates.
   */
  queryStyle: z.union([z.const('intent'), z.const('keywords')]).default(RETRIEVAL_DEFAULTS.queryStyle),
  /**
   * R2 of `docs/开发记录.md`: which first-level ranking formula
   * ships. `bm25` is the new default; `weights` reproduces the pre-R2 order
   * exactly (the rollback switch, pinned by a test).
   */
  lexicalScorer: z.union([z.const('bm25'), z.const('weights')]).default(RETRIEVAL_DEFAULTS.lexicalScorer),
  /**
   * D1/D2's scale switches, `auto` by default (落地计划 §2-2): the
   * absolute/calibrated scales apply when the semantic channel really
   * participates (`hybrid`) and stay off for a pure-lexical run. An explicit
   * value always wins — that is the switch a single-variable A/B and a rollback
   * use (落地计划 §5-4).
   */
  lexicalNormalization: z.union([z.const('auto'), z.const('candidates'), z.const('absolute')]).default(RETRIEVAL_DEFAULTS.lexicalNormalization),
  /** D2: semantic feature scale. */
  semanticScale: z.union([z.const('auto'), z.const('raw'), z.const('calibrated')]).default(RETRIEVAL_DEFAULTS.semanticScale),
  /** D2's calibration bounds (per embedder family, not per corpus). */
  semanticFloor: z.number().default(RETRIEVAL_DEFAULTS.semanticFloor),
  semanticCeil: z.number().default(RETRIEVAL_DEFAULTS.semanticCeil),
  /**
   * F4② (落地计划 §2-4): `presence` (shipped) or `count` — real term
   * frequencies, with the length basis moving with them.
   */
  termFrequency: z.union([z.const('presence'), z.const('count')]).default(RETRIEVAL_DEFAULTS.termFrequency),
  /** F4① (落地计划 §2-3): subword expansion of identifiers; default off. */
  identifierSubtokens: z.boolean().default(RETRIEVAL_DEFAULTS.identifierSubtokens),
  /** F2 (落地计划 §2-5): 向量独有候选的配额上限;0 = 不限(今天)。 */
  maxVectorOnly: z.natural().default(RETRIEVAL_DEFAULTS.maxVectorOnly),
  /** F3 (落地计划 §2-5): 通道权重的含义 —— `fusion`(今天) 或 `quota`(A 案)。 */
  channelWeightMode: z.union([z.const('fusion'), z.const('quota')]).default(RETRIEVAL_DEFAULTS.channelWeightMode),
  /** D3: `zero` (today) folds "not recalled" into 0; `absent` keeps the tri-state. */
  missingFeatureMode: z.union([z.const('zero'), z.const('absent')]).default(RETRIEVAL_DEFAULTS.missingFeatureMode),
  featureWeights: z.object({
    bm25ish: z.number().default(DEFAULT_FEATURE_WEIGHTS.bm25ish),
    exactPhrase: z.number().default(DEFAULT_FEATURE_WEIGHTS.exactPhrase),
    semantic: z.number().default(DEFAULT_FEATURE_WEIGHTS.semantic),
    specificity: z.number().default(DEFAULT_FEATURE_WEIGHTS.specificity),
    bindingOverlap: z.number().default(DEFAULT_FEATURE_WEIGHTS.bindingOverlap),
    redlinePenalty: z.number().default(DEFAULT_FEATURE_WEIGHTS.redlinePenalty),
    freshness: z.number().default(DEFAULT_FEATURE_WEIGHTS.freshness),
    signalScore: z.number().default(DEFAULT_FEATURE_WEIGHTS.signalScore),
    docMountBonus: z.number().default(DEFAULT_FEATURE_WEIGHTS.docMountBonus),
    // D4 (docs/开发记录.md §3): rank features. They SHIP at 0 —
    // the plan requires an A/B with numbers on disk before they count.
    semanticRank: z.number().default(DEFAULT_FEATURE_WEIGHTS.semanticRank),
    fusedRank: z.number().default(DEFAULT_FEATURE_WEIGHTS.fusedRank),
    // D3's missing-value indicator — also 0.
    semanticAbsent: z.number().default(DEFAULT_FEATURE_WEIGHTS.semanticAbsent),
  }).default({ ...DEFAULT_FEATURE_WEIGHTS }),
})

/** Whether the settings seam is reachable from this context. */
export function hasSettings(ctx: Context): boolean {
  return ctx.get('settings') !== undefined
}

/**
 * Register both namespaces on one context.
 *
 * Idempotent by namespace: a context that already carries them (the host plugin
 * and a CLI pass over the same composition) is left alone instead of failing
 * the duplicate registration. `base` is the shipped default, so a settings
 * document with no section resolves to the product's defaults rather than to
 * `undefined`.
 * @param ctx - a context with `ctx.settings` (host, CLI, or test harness).
 */
export function registerEmbeddingSettings(ctx: Context): void {
  const settings = ctx.get('settings')
  if (settings === undefined) return
  // Asked every time rather than remembered in a module flag: a provider's
  // service appears asynchronously, so an early call (a plugin's `apply`) can
  // legitimately find nothing — and a flag set at that moment would make the
  // namespace unregisterable forever. `describe()` is an in-memory read.
  const namespaces = new Set(settings.describe().map((descriptor: SettingsDescriptor) => String(descriptor.ns)))
  if (!namespaces.has(String(EMBEDDING_NAMESPACE))) {
    settings.register(EMBEDDING_NAMESPACE, EmbeddingSchema, { base: { ...DEFAULT_EMBEDDING_CONFIG }, applies: 'live' })
  }
  if (!namespaces.has(String(RETRIEVAL_NAMESPACE))) {
    settings.register(RETRIEVAL_NAMESPACE, RetrievalSchema, { base: { ...DEFAULT_RETRIEVAL_CONFIG }, applies: 'live' })
  }
}

/**
 * The resolved provider configuration.
 *
 * Reading goes through `ctx.settings.get`, so the layering (schema defaults →
 * composition base → user document) is dsh's, not ours: a deployment can ship
 * an endpoint in the composition and let the user override one field.
 * @param ctx - a context with `ctx.settings`.
 * @returns the resolved configuration (defaults when nothing is stored).
 */
export function readEmbeddingConfig(ctx: Context): EmbeddingConfig {
  // A read REGISTERS the namespace when it can: the schema and its reader ship
  // together, so no consumer can read a namespace nobody declared.
  registerEmbeddingSettings(ctx)
  const settings = ctx.get('settings')
  if (settings === undefined) return { ...DEFAULT_EMBEDDING_CONFIG, headers: {} }
  const value = settings.get(EMBEDDING_NAMESPACE) as Partial<EmbeddingConfig> | undefined
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...(value ?? {}),
    headers: { ...(value?.headers ?? {}) },
  }
}

/** The resolved retrieval-tuning configuration. */
export function readRetrievalConfig(ctx: Context): RetrievalConfig {
  registerEmbeddingSettings(ctx)
  const settings = ctx.get('settings')
  if (settings === undefined) return { ...DEFAULT_RETRIEVAL_CONFIG }
  const value = settings.get(RETRIEVAL_NAMESPACE) as Partial<RetrievalConfig> | undefined
  if (value === undefined) return { ...DEFAULT_RETRIEVAL_CONFIG }
  return {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...value,
    channelWeights: { ...DEFAULT_RETRIEVAL_CONFIG.channelWeights, ...(value.channelWeights ?? {}) },
    featureWeights: { ...DEFAULT_FEATURE_WEIGHTS, ...(value.featureWeights ?? {}) },
  }
}

/** One field-level validation failure (规划 §9.3: 就地指出是哪个字段). */
export interface FieldError {
  field: string
  message: string
}

/** Header names that would smuggle a secret past the reference mechanism. */
const SECRET_HEADER = /^(authorization|proxy-authorization|api[-_]?key|x-api[-_]?key)$/i

/** Whether a string is an http(s) URL (the adapter appends `/embeddings` itself). */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Validate a configuration patch, naming every failing field.
 *
 * The rules are the plan's §9.3 table, and each one exists because of a failure
 * it prevents: a missing baseUrl is a dead page; a non-URL baseUrl produces a
 * confusing adapter error instead of a field error; a hand-typed `dim` poisons
 * every stored vector's comparability; an `Authorization` header would put a
 * secret in a plaintext settings document, which is exactly what the reference
 * mechanism exists to prevent.
 *
 * @param patch - the fields the caller wants to write.
 * @param resolved - the configuration the patch would produce (merged).
 * @returns the failures, empty when the patch is acceptable.
 */
export function validateEmbeddingPatch(patch: Record<string, unknown>, resolved: EmbeddingConfig): FieldError[] {
  const errors: FieldError[] = []
  if ('dim' in patch) {
    errors.push({ field: 'dim', message: 'dim 由「测试连接」实测写入,不接受手填(手填错维度会污染版本号与所有向量)' })
  }
  if ('baseUrl' in patch) {
    const value = String(patch.baseUrl ?? '').trim()
    if (value !== '' && !isHttpUrl(value)) errors.push({ field: 'baseUrl', message: 'baseUrl 必须是 http(s) 开头的完整地址(适配器自己拼 /embeddings)' })
  }
  if ('apiKeyEnv' in patch) {
    const value = String(patch.apiKeyEnv ?? '').trim()
    if (value !== '' && !isCredentialRefName(value)) {
      errors.push({ field: 'apiKeyEnv', message: 'apiKeyEnv 必须是环境变量名(POSIX 标识符,如 SILICONFLOW_API_KEY);留空表示该端点无需鉴权或改用密钥库' })
    }
  }
  if ('headers' in patch && patch.headers !== null && typeof patch.headers === 'object') {
    for (const name of Object.keys(patch.headers as Record<string, unknown>)) {
      if (SECRET_HEADER.test(name)) {
        errors.push({ field: `headers.${name}`, message: '密钥只能走 apiKeyEnv 引用或密钥库,不得写进明文 headers' })
      }
    }
  }
  if ('quant' in patch && patch.quant !== 'fp32') {
    errors.push({ field: 'quant', message: 'int8 需评测通过才允许启用(规划的默认仍是 fp32)' })
  }
  if ('timeoutMs' in patch) {
    const value = Number(patch.timeoutMs)
    if (!Number.isFinite(value) || value < 1000 || value > 120000) errors.push({ field: 'timeoutMs', message: 'timeoutMs 需在 1000–120000 之间' })
  }
  if ('batchSize' in patch) {
    const value = Number(patch.batchSize)
    if (!Number.isInteger(value) || value < 1 || value > 256) errors.push({ field: 'batchSize', message: 'batchSize 需在 1–256 之间' })
  }
  if ('concurrency' in patch) {
    const value = Number(patch.concurrency)
    if (!Number.isInteger(value) || value < 1 || value > 4) errors.push({ field: 'concurrency', message: 'concurrency 需在 1–4 之间' })
  }
  if ('maxUnitsPerBuild' in patch) {
    const value = Number(patch.maxUnitsPerBuild)
    if (!Number.isInteger(value) || value < 1) errors.push({ field: 'maxUnitsPerBuild', message: 'maxUnitsPerBuild 需为 ≥1 的整数(预算护栏)' })
  }
  if (resolved.enabled) {
    if (String(resolved.baseUrl).trim() === '') errors.push({ field: 'baseUrl', message: '启用嵌入时 baseUrl 必填' })
    if (String(resolved.model).trim() === '') errors.push({ field: 'model', message: '启用嵌入时 model 必填' })
  }
  return errors
}

/** What one settings write did. */
export interface ConfigWriteResult {
  ok: boolean
  /** Populated on refusal — one entry per failing field, plus a whole-section error. */
  errors: FieldError[]
  config: EmbeddingConfig
  /**
   * The retrieval section after the write (it has its OWN namespace, so a patch
   * that mixes both sections has two results — see {@link writeEmbeddingConfig}).
   */
  retrieval?: RetrievalConfig
}

/**
 * The keys that belong to the RETRIEVAL namespace, not the embedding one.
 *
 * This list exists because of a measured defect: the page's「保存」button sends
 * ONE patch (`rerank`, `channelWeights`, `featureWeights`, …) to
 * `/embedding/config`, and the writer put the WHOLE patch into
 * `clue-kb-embedding`. Every retrieval-tuning save from the UI was therefore a
 * silent no-op — `readRetrievalConfig` reads `clue-kb-retrieval` and kept
 * answering with the defaults while the settings document accumulated orphan
 * keys under the embedding section. A round-trip test now pins both halves.
 */
export const RETRIEVAL_PATCH_KEYS: readonly string[] = Object.keys(RetrievalSchema.dict ?? {})

/** Split a mixed patch into its two namespaces (unlisted keys stay embedding-side). */
export function splitRetrievalPatch(patch: Record<string, unknown>): {
  retrievalPatch: Record<string, unknown>
  embeddingPatch: Record<string, unknown>
} {
  const retrievalPatch: Record<string, unknown> = {}
  const embeddingPatch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (RETRIEVAL_PATCH_KEYS.includes(key)) retrievalPatch[key] = value
    else embeddingPatch[key] = value
  }
  return { retrievalPatch, embeddingPatch }
}

/**
 * Write a provider configuration patch.
 *
 * Refusals happen BEFORE anything persists (field validation, then the seam's
 * own schema validation), so a rejected save never leaves a half-applied
 * section. The caller's `expectedRevision` is passed through unchanged: a
 * concurrent write from another tab becomes a refusal (dsh's
 * `SettingsConflictError`), never a silent overwrite (规划 §9.2).
 * @param ctx - a context with `ctx.settings`.
 * @param patch - the fields to write.
 * @param expectedRevision - the revision the caller's view was based on.
 * @returns the outcome (validation failures included).
 * @throws when the settings seam is absent — a write with nowhere to go must
 *   fail loud rather than pretend.
 */
export async function writeEmbeddingConfig(
  ctx: Context,
  patch: Record<string, unknown>,
  expectedRevision?: number,
): Promise<ConfigWriteResult> {
  const settings = ctx.get('settings')
  if (settings === undefined) throw new Error('写入嵌入配置失败: 该上下文没有 settings 服务(宿主未挂载设置文档)')
  const { retrievalPatch, embeddingPatch } = splitRetrievalPatch(patch)
  const merged = { ...readEmbeddingConfig(ctx), ...embeddingPatch } as EmbeddingConfig
  const errors = validateEmbeddingPatch(embeddingPatch, merged)
  if (errors.length > 0) return { ok: false, errors, config: readEmbeddingConfig(ctx), retrieval: readRetrievalConfig(ctx) }
  // Both sections are validated BEFORE either is written: a patch that is half
  // acceptable must not leave the document half updated (規劃 §9.2).
  if (Object.keys(retrievalPatch).length > 0) {
    // Schemastery validates by CALLING the schema (there is no `safeParse`), and
    // a throw here is a field-level refusal: the section would not parse.
    try {
      RetrievalSchema({ ...readRetrievalConfig(ctx), ...retrievalPatch })
    } catch (error) {
      return {
        ok: false,
        errors: [{ field: '(整个 section)', message: error instanceof Error ? error.message : String(error) }],
        config: readEmbeddingConfig(ctx),
        retrieval: readRetrievalConfig(ctx),
      }
    }
  }
  try {
    if (Object.keys(embeddingPatch).length > 0) await settings.update(EMBEDDING_NAMESPACE, embeddingPatch, expectedRevision)
    if (Object.keys(retrievalPatch).length > 0) {
      // The revision belongs to the section being written: the caller passes the
      // embedding revision for provider fields and the retrieval one for tuning.
      await settings.update(RETRIEVAL_NAMESPACE, retrievalPatch, expectedRevision)
    }
  } catch (error) {
    return {
      ok: false,
      errors: [{ field: '(整个 section)', message: error instanceof Error ? error.message : String(error) }],
      config: readEmbeddingConfig(ctx),
      retrieval: readRetrievalConfig(ctx),
    }
  }
  return { ok: true, errors: [], config: readEmbeddingConfig(ctx), retrieval: readRetrievalConfig(ctx) }
}

/**
 * Record the dimension the endpoint actually reported (规划 §9.6/§15.3).
 *
 * The ONLY writer of `dim`. If the measured value differs from the stored one,
 * the returned configuration carries the new value and the caller must tell the
 * user that every stored vector is about to be rebuilt — the version stamp
 * changes with the dimension, and pretending otherwise would leave the index
 * claiming comparability it does not have.
 * @param ctx - a context with `ctx.settings`.
 * @param dim - the measured dimension (positive integer).
 * @returns the configuration before and after, plus whether a rebuild is implied.
 */
export async function recordMeasuredDim(
  ctx: Context,
  dim: number,
): Promise<{ previousDim: number; dim: number; rebuildImplied: boolean }> {
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`recordMeasuredDim: 维度必须是正整数,收到 ${dim}`)
  const settings = ctx.get('settings')
  if (settings === undefined) throw new Error('记录维度失败: 该上下文没有 settings 服务')
  const previousDim = readEmbeddingConfig(ctx).dim
  if (previousDim !== dim) await settings.update(EMBEDDING_NAMESPACE, { dim })
  return { previousDim, dim, rebuildImplied: previousDim !== 0 && previousDim !== dim }
}

/** The credential record key of the embedding key. */
export function embeddingCredentialKey(): CredentialKey {
  return credentialKey(CREDENTIAL_SCOPE, EMBEDDING_CREDENTIAL_ID)
}

/** The reference a configuration names, or null when it names none. */
export function embeddingCredentialRef(config: EmbeddingConfig): CredentialRef | null {
  const name = config.apiKeyEnv.trim()
  return name === '' ? null : credentialRef(name)
}

/** The key state a SURFACE may show (规划 §9.4-3: never a value). */
export interface KeyStatus {
  state: 'configured' | 'missing' | 'unresolved' | 'unreachable'
  /** Which mechanism supplies it — a name, never a value. */
  detail: string
  /** Whether the surface should offer a 「设置密钥」 action. */
  writable: boolean
}

/**
 * Describe the key WITHOUT reading it where that is possible.
 *
 * `credentials.describe` answers "configured, from which source, writable"
 * without touching the value, which is exactly what a status dot needs. The
 * store road falls back to `describeRecord` when no reference is named.
 * @param ctx - a context with `ctx.credentials`.
 * @param config - the resolved provider configuration.
 * @returns the status a page or a CLI line renders verbatim.
 */
export async function embeddingKeyStatus(ctx: Context, config: EmbeddingConfig = readEmbeddingConfig(ctx)): Promise<KeyStatus> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return { state: 'unreachable', detail: '本上下文没有 credentials 服务', writable: false }
  const ref = embeddingCredentialRef(config)
  if (ref !== null) {
    const info = await credentials.describe(ref)
    if (info.configured) return { state: 'configured', detail: `引用 ${String(ref)}(来源 ${info.source ?? '未知'})`, writable: info.writable }
    return { state: 'missing', detail: `引用 ${String(ref)} 未配置`, writable: info.writable }
  }
  // No reference named: the store road (dsh's CredentialKey space).
  const info = await credentials.describeRecord(embeddingCredentialKey())
  if (info.configured) return { state: 'configured', detail: `密钥库记录 ${CREDENTIAL_SCOPE}/${EMBEDDING_CREDENTIAL_ID}`, writable: info.writable }
  return { state: 'missing', detail: '未配置密钥(引用为空且密钥库无记录)', writable: true }
}

/**
 * Resolve the key value at the moment of use (不变量 11).
 *
 * Called immediately before every embedding request and never memoized: that is
 * what makes "改 key 后下一次嵌入即生效,不需重启宿主" true rather than
 * aspirational. The returned value is the ONLY secret this module ever produces,
 * and its only caller is the HTTP adapter.
 * @param ctx - a context with `ctx.credentials`.
 * @param config - the resolved provider configuration.
 * @returns the key, or null when none is configured (an endpoint may need none).
 * @throws when the reference is configured but cannot be resolved — a named
 *   reference that resolves to nothing is a failure, not an anonymous request.
 */
export async function resolveEmbeddingKey(ctx: Context, config: EmbeddingConfig): Promise<string | null> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return null
  const ref = embeddingCredentialRef(config)
  if (ref !== null) {
    const hit = await credentials.resolve(ref)
    const value = hit?.value ?? ''
    if (value === '') throw new Error(`嵌入密钥解析失败: 引用 ${String(ref)} 当前没有值(请在设置页或 clue kb embed-config key 写入)`)
    return value
  }
  const record = await credentials.readRecord(embeddingCredentialKey())
  if (record === undefined) return null
  if (record.kind === 'api-key') {
    const key = record.key ?? ''
    if (key !== '') return key
    // No key value: dsh reads this as "the owner confirmed ambient
    // authentication" (a Bedrock/Vertex-style chain, `env` naming its inputs). A
    // plain OpenAI-compatible `/embeddings` call cannot express that, so it is
    // reported instead of being sent with no credential at all.
    const ambient = Object.keys(record.env ?? {})
    if (ambient.length > 0) {
      throw new Error(`嵌入密钥解析失败: 记录声明了环境凭据(${ambient.join(', ')}),但 OpenAI 兼容端点需要显式密钥;请改用 apiKeyEnv 引用`)
    }
    return null
  }
  throw new Error(`嵌入密钥解析失败: 记录 ${CREDENTIAL_SCOPE}/${EMBEDDING_CREDENTIAL_ID} 不是 api-key 记录`)
}

/**
 * Store a key value (the ONE write path for the secret).
 *
 * With a reference named, the value goes under that reference through
 * `credentials.set` — which REJECTS when a read-only source (the live process
 * environment, a `.env` layer) currently shadows it, because a write that has no
 * effect is worse than a loud refusal. Without a reference, the value goes into
 * the credential store as an `api-key` record, so a user who never wanted to
 * name an environment variable is not forced to invent one.
 * @param ctx - a context with `ctx.credentials`.
 * @param value - the key value (never logged, never returned).
 * @param config - the resolved provider configuration.
 * @returns which mechanism stored it (a name, never a value).
 */
export async function storeEmbeddingKey(ctx: Context, value: string, config: EmbeddingConfig = readEmbeddingConfig(ctx)): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('写入密钥失败: 本上下文没有 credentials 服务')
  const trimmed = value.trim()
  if (trimmed === '') throw new Error('写入密钥失败: 值为空(留空不是"清除",清除请用 unsetEmbeddingKey)')
  if (/[\r\n]/.test(trimmed)) throw new Error('写入密钥失败: 值含换行(像是整行粘贴的 NAME=value,请只粘贴值本身)')
  const ref = embeddingCredentialRef(config)
  if (ref !== null) {
    await credentials.set(ref, trimmed)
    return `引用 ${String(ref)}`
  }
  await credentials.modifyRecord(embeddingCredentialKey(), async () => ({ kind: 'api-key', key: trimmed }))
  return `密钥库记录 ${CREDENTIAL_SCOPE}/${EMBEDDING_CREDENTIAL_ID}`
}

/**
 * Remove a stored key (idempotent; a no-op when nothing is stored).
 * @param ctx - a context with `ctx.credentials`.
 * @param config - the resolved provider configuration.
 * @returns which mechanism was cleared.
 */
export async function unsetEmbeddingKey(ctx: Context, config: EmbeddingConfig = readEmbeddingConfig(ctx)): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('清除密钥失败: 本上下文没有 credentials 服务')
  const ref = embeddingCredentialRef(config)
  if (ref !== null) {
    await credentials.unset(ref)
    return `引用 ${String(ref)}`
  }
  await credentials.deleteRecord(embeddingCredentialKey())
  return `密钥库记录 ${CREDENTIAL_SCOPE}/${EMBEDDING_CREDENTIAL_ID}`
}

/** The value-free summary every surface prints (规划 §9.4-3 / §9.8). */
export interface EmbeddingConfigSummary {
  enabled: boolean
  baseUrl: string
  /** The reference NAME, never a value. */
  apiKeyEnv: string
  model: string
  dim: number
  headers: Record<string, string>
  timeoutMs: number
  batchSize: number
  concurrency: number
  maxUnitsPerBuild: number
  quant: string
  key: KeyStatus
  /** The `embedderVersion` this configuration would stamp (empty when incomplete). */
  embedderVersion: string
}

/**
 * Summarize the configuration for a human, with no secret anywhere.
 * @param ctx - a context with `ctx.settings`/`ctx.credentials`.
 * @param currentVersion - the `embedderVersion` stamp in effect (for the report).
 * @returns the printable summary.
 */
export async function embeddingConfigSummary(ctx: Context, currentVersion?: string): Promise<EmbeddingConfigSummary> {
  const config = readEmbeddingConfig(ctx)
  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    apiKeyEnv: config.apiKeyEnv,
    model: config.model,
    dim: config.dim,
    headers: config.headers,
    timeoutMs: config.timeoutMs,
    batchSize: config.batchSize,
    concurrency: config.concurrency,
    maxUnitsPerBuild: config.maxUnitsPerBuild,
    quant: config.quant,
    key: await embeddingKeyStatus(ctx, config),
    embedderVersion: currentVersion ?? (config.model !== '' && config.dim > 0 ? embedderVersion({ modelId: config.model, dim: config.dim }) : ''),
  }
}

/**
 * Whether the configuration is complete enough to build an embedder.
 *
 * Incomplete is NOT an error state: it means "the vector layer is off and the
 * lexical path runs alone", which the retrieval labels honestly (不变量 5).
 * @param config - the resolved configuration.
 * @returns true when an embedder can be constructed.
 */
export function embeddingReady(config: EmbeddingConfig): boolean {
  return config.enabled && config.baseUrl.trim() !== '' && config.model.trim() !== '' && config.dim > 0
}

/** Why an incomplete configuration cannot be used (shown next to the switch). */
export function embeddingReadinessNote(config: EmbeddingConfig): string {
  if (!config.enabled) return '未启用 — 检索只走词法通道'
  if (config.baseUrl.trim() === '') return '缺 baseUrl'
  if (config.model.trim() === '') return '缺 model'
  if (config.dim <= 0) return '尚未「测试连接」实测维度'
  return '已就绪'
}
