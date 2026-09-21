/**
 * `HttpEmbedder` — the production adapter (V1, 规划 §4/§9.6).
 *
 * The engine never opens a socket (不变量 6), so THIS is where the network
 * lives, in the integration layer, using nothing but `fetch` — the plan forbids
 * new runtime dependencies (ONNX was explicitly ruled out), and an
 * OpenAI-compatible `/embeddings` endpoint is reachable with the platform's own
 * HTTP client.
 *
 * What the adapter owns (规划 §4 的端口契约):
 *
 * - **Batching, timeouts, and one retry** per operation; the engine only calls
 *   `embed(texts)`.
 * - **L2 normalization**, through the engine's own `l2Normalize` so that the
 *   `EMBED_NORM_VERSION` stamp describes what actually happened.
 * - **Error classification** (规划 §9.6) — and, above all, **error text that
 *   carries no secret**: only the status code and the endpoint's HOST ever
 *   reach a message. No header, no body, no key, no query — an exception
 *   travels to logs, pages and the model, so the classification is a security
 *   boundary, not a nicety (规划 §9.4-2 / 不变量 10).
 *
 * The `id` and `dim` are GETTERS over the live configuration, because the plan
 * requires a changed key or endpoint to take effect on the next operation
 * without a restart (不变量 11), and the version stamp must follow the model and
 * dimension the endpoint is ACTUALLY serving.
 *
 * @module @clue-harness/kb-face/http-embedder
 */
import { l2Normalize } from '@clue-harness/kb'
import type { Embedder } from '@clue-harness/rag'

/** How a call failed — the vocabulary the settings page renders (规划 §9.6). */
export type EmbedFailureKind =
  | 'unreachable'   // DNS/connect/TLS failed
  | 'timeout'       // the configured timeoutMs elapsed
  | 'unauthorized'  // 401/403
  | 'not-found'     // 404: path or protocol is wrong
  | 'bad-shape'     // 200, but the payload is not an embeddings response
  | 'http-error'    // any other non-2xx
  | 'empty'         // the endpoint answered with no vectors for our inputs

/** A classified embedding failure. `message` is safe to print anywhere. */
export class EmbedError extends Error {
  readonly kind: EmbedFailureKind
  /** The HTTP status, when there was one. */
  readonly status?: number

  constructor(kind: EmbedFailureKind, message: string, status?: number) {
    super(message)
    this.name = 'EmbedError'
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

/** The minimal provider configuration the adapter reads (a subset of EmbeddingConfig). */
export interface HttpEmbedderConfig {
  baseUrl: string
  model: string
  dim: number
  headers: Record<string, string>
  timeoutMs: number
  /** Units per request (used to estimate a rebuild's call count). */
  batchSize: number
}

/** What the adapter needs from the host: live config and a per-operation key. */
export interface HttpEmbedderOptions {
  /** Read the CURRENT configuration (called per operation, never cached). */
  getConfig: () => HttpEmbedderConfig
  /** Resolve the key at the start of each operation (不变量 11). */
  resolveKey: () => Promise<string | null>
  /** Inject `fetch` (tests). */
  fetchImpl?: typeof fetch
}

/**
 * The endpoint URL one call posts to.
 *
 * `baseUrl` is documented as the BASE (the adapter appends `/embeddings`), but
 * a user who pastes the full endpoint is not making a mistake worth a 404 —
 * so an address already ending in `/embeddings` is used as-is.
 * @param baseUrl - the configured base.
 * @returns the absolute request URL.
 */
export function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`
}

/**
 * The host of an endpoint, for diagnostics that must not leak more than that.
 * @param baseUrl - the configured base.
 * @returns the hostname, or the raw string when it cannot be parsed.
 */
export function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl.trim() === '' ? '(未配置)' : '(地址无法解析)'
  }
}

/**
 * Read a failed response's REASON without leaking the credential.
 *
 * Three bounds, in order: the body is capped (4 KiB), only a message-shaped
 * field is taken (`error.message` / `message`, else the raw text), and every
 * occurrence of the key is replaced with `[redacted]` before the text leaves
 * this function. The result is capped again at 200 characters.
 * @param response - the failed response.
 * @param key - the credential that was sent (redacted out, defensively).
 * @returns a printable reason, or '' when nothing usable was found.
 */
async function sanitizedErrorDetail(response: Response, key: string | null): Promise<string> {
  let raw = ''
  try {
    raw = (await response.text()).slice(0, 4096)
  } catch {
    return ''
  }
  let message = raw
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown }
    const candidate = parsed.error?.message ?? parsed.message
    if (typeof candidate === 'string') message = candidate
  } catch {
    // Not JSON: the raw text is the reason (bounded above).
  }
  let text = message.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (key !== null && key !== '') text = text.split(key).join('[redacted]')
  return text
}

/** One parsed embeddings response. */
interface EmbeddingsPayload {
  vectors: number[][]
  model: string | null
}

/**
 * Parse an OpenAI-compatible embeddings response.
 *
 * Defensive on purpose: the plan's §9.6 table has a row for "200 but
 * `data[0].embedding` is missing or not an array", which is what a
 * non-compatible gateway answers — and the page prints the keys it actually
 * saw, because "响应形状不符" without the keys is unactionable.
 * @param body - the raw text of the response.
 * @param expected - how many vectors the request asked for.
 * @returns the parsed vectors and the model the endpoint named.
 * @throws {EmbedError} with `kind: 'bad-shape'` (the message lists the keys seen).
 */
export function parseEmbeddingsResponse(body: string, expected: number): EmbeddingsPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new EmbedError('bad-shape', `响应不是 JSON(前 80 字符: ${body.slice(0, 80)})`)
  }
  const data = (parsed as { data?: unknown }).data
  if (!Array.isArray(data)) {
    const keys = parsed !== null && typeof parsed === 'object' ? Object.keys(parsed as object).slice(0, 8).join(', ') : typeof parsed
    throw new EmbedError('bad-shape', `响应缺少 data 数组;实际键名: ${keys || '(无)'}(端点应为 OpenAI 兼容 /embeddings)`)
  }
  const vectors: number[][] = []
  for (const row of data) {
    const embedding = (row as { embedding?: unknown }).embedding
    if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new EmbedError('bad-shape', 'data[i].embedding 不是数字数组(端点应为 OpenAI 兼容 /embeddings)')
    }
    vectors.push(embedding as number[])
  }
  if (vectors.length !== expected) {
    throw new EmbedError('bad-shape', `响应返回 ${vectors.length} 个向量,请求了 ${expected} 个文本`)
  }
  const model = (parsed as { model?: unknown }).model
  return { vectors, model: typeof model === 'string' ? model : null }
}

/** Turn a thrown transport error into a classified, secret-free failure. */
function classifyTransportError(error: unknown, timeoutMs: number, host: string): EmbedError {
  if (error instanceof EmbedError) return error
  const name = error instanceof Error ? error.name : ''
  const text = error instanceof Error ? error.message : String(error)
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new EmbedError('timeout', `嵌入端点超时(${host},超过 ${timeoutMs}ms)`)
  }
  // The message of a fetch failure names the host and the reason; it never
  // carries request headers, so it is safe — but the host is added explicitly
  // because Node's own text sometimes omits it.
  return new EmbedError('unreachable', `无法连接嵌入端点 ${host}: ${text.slice(0, 200)}`)
}

/**
 * Create the HTTP embedder.
 *
 * The returned object satisfies the engine's {@link Embedder} port; `id` and
 * `dim` are live getters so a model swap changes the version stamp on the very
 * next operation, which is what tells the index to rebuild.
 * @param options - live config, the per-operation key resolver, and `fetch`.
 * @returns the embedder (its `dim` is 0 until a connection test measures one).
 */
export function createHttpEmbedder(options: HttpEmbedderOptions): Embedder & { readonly endpoint: string } {
  const doFetch = options.fetchImpl ?? fetch
  return {
    get id(): string {
      return options.getConfig().model
    },
    get dim(): number {
      return options.getConfig().dim
    },
    get endpoint(): string {
      return endpointHost(options.getConfig().baseUrl)
    },
    async embed(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return []
      const config = options.getConfig()
      const host = endpointHost(config.baseUrl)
      if (config.baseUrl.trim() === '' || config.model.trim() === '') {
        throw new EmbedError('unreachable', '嵌入配置不完整: baseUrl 与 model 必填')
      }
      const key = await options.resolveKey()
      const headers: Record<string, string> = { 'content-type': 'application/json', ...config.headers }
      if (key !== null && key !== '') headers.authorization = `Bearer ${key}`
      let response: Response
      try {
        response = await doFetch(embeddingsUrl(config.baseUrl), {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: config.model, input: [...texts] }),
          signal: AbortSignal.timeout(config.timeoutMs),
        })
      } catch (error) {
        throw classifyTransportError(error, config.timeoutMs, host)
      }
      if (!response.ok) {
        // Status and host, plus the provider's own REASON in a sanitized form:
        // a bare "HTTP 400" hides the one sentence that explains the failure
        // (measured: dashscope answers `batch size is invalid, it should not be
        // larger than 10`), while a raw body is not safe to print — it can echo
        // the request, and the request carried the key (规划 §9.4-2).
        const detail = await sanitizedErrorDetail(response, key)
        const suffix = detail === '' ? '' : `: ${detail}`
        if (response.status === 401 || response.status === 403) {
          throw new EmbedError('unauthorized', `嵌入端点鉴权失败(HTTP ${response.status} @ ${host})${suffix};请检查「设置密钥」里的引用或密钥库记录`, response.status)
        }
        if (response.status === 404) {
          throw new EmbedError('not-found', `嵌入端点返回 404(${host});该地址应为 OpenAI 兼容的 /embeddings`, response.status)
        }
        throw new EmbedError('http-error', `嵌入端点返回 HTTP ${response.status}(${host})${suffix}`, response.status)
      }
      const payload = parseEmbeddingsResponse(await response.text(), texts.length)
      return payload.vectors.map((vector) => l2Normalize(Float32Array.from(vector)))
    },
  }
}

/** The outcome of a connection test (规划 §9.6 — the user's only self-check). */
export interface ConnectionTestResult {
  ok: boolean
  /** The classification, or 'ok'. */
  status: EmbedFailureKind | 'ok'
  /** A message safe to render anywhere (no key, no header, no body). */
  message: string
  /** The measured dimension, when the endpoint answered with vectors. */
  dim?: number
  /** The model the endpoint named, when it named one. */
  model?: string
  /** Round-trip time of the probe, in milliseconds. */
  latencyMs?: number
  /** The L2 norm of the returned vector (≈1 confirms our normalization ran). */
  norm?: number
  /** Set when the measured dimension differs from the stored one. */
  rebuildNotice?: string
}

/** The probe text (short, so a test costs the smallest possible call). */
export const CONNECTION_PROBE_TEXT = '连接测试'

/**
 * Test one embedding endpoint with a single short call (规划 §9.6).
 *
 * This is the settings page's「测试连接」and the CLI's `embed-config test`, and
 * its job is to turn every failure mode in the plan's table into ONE actionable
 * line: which host, which timeout, which status, which keys came back — and
 * never which key was sent.
 * @param options - live config, per-operation key resolver, and `fetch`.
 * @param storedDim - the dimension currently in the vector layer (0 when none),
 *   so a mismatch can be reported as a REBUILD with its cost, not as an error.
 * @param storedUnits - how many units the vector layer holds (for that notice).
 * @returns the classified result.
 */
export async function testConnection(
  options: HttpEmbedderOptions,
  storedDim = 0,
  storedUnits = 0,
): Promise<ConnectionTestResult> {
  const config = options.getConfig()
  const host = endpointHost(config.baseUrl)
  if (config.baseUrl.trim() === '') return { ok: false, status: 'unreachable', message: 'baseUrl 未填写' }
  if (config.model.trim() === '') return { ok: false, status: 'unreachable', message: 'model 未填写' }
  const embedder = createHttpEmbedder(options)
  const started = Date.now()
  try {
    const [vector] = await embedder.embed([CONNECTION_PROBE_TEXT])
    const latencyMs = Date.now() - started
    if (vector === undefined || vector.length === 0) {
      return { ok: false, status: 'empty', message: `端点 ${host} 返回了空向量`, latencyMs }
    }
    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm)
    const dim = vector.length
    const result: ConnectionTestResult = {
      ok: true,
      status: 'ok',
      message: `连接成功: ${host} · 维度 ${dim} · 延迟 ${latencyMs}ms · 归一化模长 ${norm.toFixed(4)}`,
      dim,
      latencyMs,
      norm,
      ...(config.model !== '' ? { model: config.model } : {}),
    }
    if (storedDim !== 0 && storedDim !== dim) {
      // Saving this dimension invalidates every stored vector: the version
      // stamp changes, so the index is rebuilt. Say so BEFORE the save, with
      // the number of calls it implies (规划 §9.6 / §14).
      const batch = Math.max(1, config.batchSize)
      result.rebuildNotice = `实测维度 ${dim} 与已存向量层维度 ${storedDim} 不符:保存后 ${storedUnits} 条向量需重建,预估调用 ${Math.max(1, Math.ceil(storedUnits / batch))} 次(batchSize ${batch};改模型/维度才会作废,只改 url/key 不会)`
    }
    return result
  } catch (error) {
    const failure = classifyTransportError(error, config.timeoutMs, host)
    return { ok: false, status: failure.kind, message: failure.message }
  }
}
