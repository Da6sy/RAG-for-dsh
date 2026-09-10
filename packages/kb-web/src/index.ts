/**
 * `@clue-harness/kb-web` — the web host face of the knowledge base (M3c).
 *
 * INTEGRATION layer (like spine and kb-face): imports dsh directly. It owns
 * one thing: a same-origin JSON API under `/api/clue-kb` registered on the
 * dsh `webServer` route table, so the browser UI (`@clue-harness/ui-kb`)
 * reads and mutates the KB without any new transport.
 *
 * CONTRACT VERIFICATION (M3c, why HTTP routes and not the Remote gateway):
 * dsh's Typert Remote plane is a BUILD-TIME codegen pipeline — `/remote`
 * descriptor artifacts are generated inside dsh's own host-phase build, the
 * client assembly mounts a FIXED capability set by value import, and it
 * "does not discover the Host's active Services or Remote definitions at
 * runtime" (dsh-api-remotes README). A published-package consumer has no
 * generation entry, so the sanctioned third-party channel is the webserver's
 * public route contract — the same `register({kind, path, handler})` face
 * dsh's own client-modules uses to serve `/plugins/<id>/client.js`.
 *
 * Route kinds (verified): 'exact' matches verbatim; 'prefix' p matches p and
 * p/<anything>; the path carries NO trailing slash. We own one prefix.
 *
 * Trust posture: the webserver binds loopback by default and the dsh trust
 * fence (webRuntime trustedHosts) governs LAN exposure for the whole origin;
 * this API adds no auth of its own, exactly like the dsh `/api` surface it
 * sits beside. Writes are the KB's own audited operations (every mutation
 * lands in the entries-history / signals / approvals ledgers).
 *
 * SECOND OWNERSHIP (identity.ts): the browser identity (tab title
 * "Clue Harness" + the network-mark favicon) is pushed onto the webserver's
 * index-injection table — the same sanctioned channel dsh's client-modules
 * uses for the boot manifest — because the published frontend bakes its own
 * title/favicon at build time and clue must not rebuild it.
 *
 * @module @clue-harness/kb-web
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls ctx.webServer (WebServer + WebRoute) into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls ctx.kb (ClueKb) into this program.
import type { ClueKb } from '@clue-harness/kb-face'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { identityScript } from './identity.ts'
import { KbEntryId, readSignals, type KbKind, type KbStatus, type KbStore } from '@clue-harness/kb'

/** The minimal llm face the polish route needs (one-shot prepareCall). */
interface PolishLlm {
  prepareCall(provider: string, model: string): Promise<{
    stream(options: { provider: string; model: string; messages: unknown[] }): AsyncIterable<{ type: string; text?: string }>
  }>
}

/** The minimal agent-default-model face (which route the polish uses). */
interface DefaultModel {
  provider: string
  model: string
}

/** Plugin name (stable id in fibers and diagnostics). */
export const name = 'clue-kb-web'

/** Services required before the routes mount. */
export const inject = ['kb', 'webServer']

/** The owned route prefix (no trailing slash — webserver contract). */
export const API_PREFIX = '/api/clue-kb'

/** Plugin configuration. */
export interface Config {
  /** Maximum accepted POST body size in bytes (default 64 KiB). */
  maxBodyBytes?: number
}

/** One approval queue item with its entry payload merged for card rendering. */
interface ApprovalCard {
  request: unknown
  entry: unknown
}

/** Per-tier summary counts for the status endpoint. */
interface TierStatus {
  tier: string
  total: number
  byStatus: Record<string, number>
  needsReview: number
  pendingApprovals: number
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024

/**
 * Send one JSON response and end it.
 * @param res - the server response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Read and parse a JSON request body within the byte bound.
 * @param req - the incoming request.
 * @param maxBytes - the acceptance bound.
 * @returns the parsed value.
 * @throws an error carrying `status` for the handler's catch to map.
 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > maxBytes) {
        reject(Object.assign(new Error('请求体超出大小限制'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Summarize one store tier for the status endpoint.
 * @param store - the opened tier store.
 * @returns counts by status plus review/approval backlog sizes.
 */
async function tierStatus(store: KbStore): Promise<TierStatus> {
  const entries = await store.list()
  const byStatus: Record<string, number> = {}
  let needsReview = 0
  for (const entry of entries) {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1
    if (entry.needsReview) needsReview += 1
  }
  const approvals = await store.listApprovals(true)
  return {
    tier: store.tier,
    total: entries.length,
    byStatus,
    needsReview,
    pendingApprovals: approvals.length,
  }
}

/**
 * Mount the KB web face.
 * @param ctx - the mounting context; `kb` and `webServer` are live.
 * @param config - route bounds (see {@link Config}).
 */
export function apply(ctx: Context, config: Config = {}): void {
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const kb: ClueKb = ctx.kb

  /**
   * Resolve the addressed tier store.
   * @param scope - 'project' (default) or 'global'.
   * @returns the store for that tier.
   */
  async function storeFor(scope: string | null): Promise<KbStore> {
    const stores = await kb.stores()
    if (scope === 'global') return stores.global
    if (scope === 'project' || scope === null) return stores.project
    throw Object.assign(new Error(`未知 scope "${scope}"(可选: project | global)`), { status: 400 })
  }

  /**
   * The whole API: one prefix handler dispatching method + subpath.
   * @param req - incoming request under the prefix.
   * @param res - response to settle in every branch.
   */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sub = url.pathname === API_PREFIX ? '/' : url.pathname.slice(API_PREFIX.length)
    const method = req.method ?? 'GET'
    try {
      // GET / — the API index (debug aid; keeps the bare prefix useful).
      if (sub === '/' && method === 'GET') {
        sendJson(res, 200, {
          api: 'clue-kb',
          endpoints: [
            'GET /status', 'GET /approvals?scope=', 'POST /approvals/resolve',
            'GET /entries?scope=&status=&kind=&needsReview=&q=', 'GET /entry?scope=&id=',
            'POST /entry/reverify', 'POST /sweep',
          ],
        })
        return
      }

      // GET /status — both tiers summarized (panel header + polling).
      if (sub === '/status' && method === 'GET') {
        const stores = await kb.stores()
        sendJson(res, 200, {
          projectRoot: kb.projectRoot,
          project: await tierStatus(stores.project),
          global: await tierStatus(stores.global),
        })
        return
      }

      // GET /approvals — the batched queue with entry payloads merged.
      if (sub === '/approvals' && method === 'GET') {
        const store = await storeFor(url.searchParams.get('scope'))
        const pendingOnly = url.searchParams.get('pending') !== 'all'
        const requests = await store.listApprovals(pendingOnly)
        const cards: ApprovalCard[] = []
        for (const request of requests) {
          cards.push({ request, entry: await store.get(request.entryId) })
        }
        sendJson(res, 200, { scope: store.tier, approvals: cards })
        return
      }

      // POST /approvals/resolve — one decision (approve/reject) on a request.
      if (sub === '/approvals/resolve' && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes) as {
          scope?: string; requestId?: string; approved?: boolean
        }
        if (typeof body.requestId !== 'string' || typeof body.approved !== 'boolean') {
          throw Object.assign(new Error('需要 requestId(string) 与 approved(boolean)'), { status: 400 })
        }
        const store = await storeFor(body.scope ?? null)
        // Pre-check for accurate statuses: the store throws bare Errors for
        // unknown/already-resolved requests, which would surface as 500.
        const existing = (await store.listApprovals(false)).find(item => item.id === body.requestId)
        if (existing === undefined) {
          throw Object.assign(new Error(`审批请求不存在 ${body.requestId}`), { status: 404 })
        }
        if (existing.resolvedAt !== null) {
          throw Object.assign(new Error(`请求 ${body.requestId} 已被处理(${existing.resolution})`), { status: 409 })
        }
        const result = await store.resolveApproval(body.requestId, body.approved)
        sendJson(res, 200, result)
        return
      }

      // GET /entries — filtered list, or retrieval-ranked when q is present.
      if (sub === '/entries' && method === 'GET') {
        const scope = url.searchParams.get('scope')
        const q = url.searchParams.get('q')
        if (q !== null && q.trim() !== '') {
          const hits = await kb.query(q, {
            limit: Number(url.searchParams.get('limit') ?? '50'),
            // Retrieval always includes expired hits WITH their annotations —
            // the UI shows the annotation and lets the status filter narrow.
            includeExpired: true,
          })
          const wanted = scope === 'global' ? 'global' : scope === 'project' ? 'project' : null
          sendJson(res, 200, {
            scope: wanted ?? 'project+global',
            entries: hits.filter(hit => wanted === null || hit.entry.tier === wanted).map(hit => ({
              entry: hit.entry, score: hit.score, matched: hit.matched,
            })),
          })
          return
        }
        const store = await storeFor(scope)
        const status = url.searchParams.get('status')
        const kind = url.searchParams.get('kind')
        const needsReview = url.searchParams.get('needsReview')
        const STATUSES: KbStatus[] = ['candidate', 'trusted', 'expired', 'discarded']
        const KINDS: KbKind[] = ['fact', 'decision', 'snippet', 'map', 'pitfall', 'asset']
        if (status !== null && !STATUSES.includes(status as KbStatus)) {
          throw Object.assign(new Error(`未知 status "${status}"(可选: ${STATUSES.join(' | ')})`), { status: 400 })
        }
        if (kind !== null && !KINDS.includes(kind as KbKind)) {
          throw Object.assign(new Error(`未知 kind "${kind}"(可选: ${KINDS.join(' | ')})`), { status: 400 })
        }
        const entries = await store.list({
          ...(status !== null ? { status: status as KbStatus } : {}),
          ...(kind !== null ? { kind: kind as KbKind } : {}),
          ...(needsReview === '1' ? { needsReview: true } : {}),
        })
        sendJson(res, 200, { scope: store.tier, entries })
        return
      }

      // GET /entry — one entry with its window score and full signal ledger.
      if (sub === '/entry' && method === 'GET') {
        const store = await storeFor(url.searchParams.get('scope'))
        const id = url.searchParams.get('id')
        if (id === null || id === '') {
          throw Object.assign(new Error('需要 id 查询参数'), { status: 400 })
        }
        const entry = await store.get(KbEntryId(id))
        if (entry === null) {
          throw Object.assign(new Error(`没有条目 "${id}"`), { status: 404 })
        }
        const score = await store.score(entry.id)
        // store.dir is public and signals.jsonl is the documented ledger name;
        // the read-only projection filters the shared ledger to this entry.
        const signals = (await readSignals(path.join(store.dir, 'signals.jsonl')))
          .filter(record => record.entryId === entry.id)
        sendJson(res, 200, { entry, score, signals })
        return
      }

      // POST /entry/reverify — resolve the orthogonal needs-review flag.
      if (sub === '/entry/reverify' && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes) as {
          scope?: string; id?: string; accept?: boolean
        }
        if (typeof body.id !== 'string' || typeof body.accept !== 'boolean') {
          throw Object.assign(new Error('需要 id(string) 与 accept(boolean)'), { status: 400 })
        }
        const store = await storeFor(body.scope ?? null)
        const existing = await store.get(KbEntryId(body.id))
        if (existing === null) {
          throw Object.assign(new Error(`没有条目 "${body.id}"`), { status: 404 })
        }
        const entry = await store.reverify(existing.id, body.accept)
        sendJson(res, 200, { entry })
        return
      }

      // POST /sweep — run maintenance (expire/discard/purge + promotion proposals).
      if (sub === '/sweep' && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes) as { scope?: string }
        const store = await storeFor(body.scope ?? null)
        sendJson(res, 200, { scope: store.tier, result: await store.sweep() })
        return
      }

      // POST /polish — the M6 "AI 润色泛化草稿" aid (M5 review decision):
      // one-shot llm call in the HOST layer (the kb-loop engine stays
      // model-free), returning a rewritten draft WITHOUT writing it — the
      // human adopts it explicitly through /entry/text, then approves.
      if (sub === '/polish' && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes) as { scope?: string; id?: string }
        if (typeof body.id !== 'string' || body.id === '') {
          throw Object.assign(new Error('需要 id(string)'), { status: 400 })
        }
        const store = await storeFor(body.scope ?? null)
        const entry = await store.get(KbEntryId(body.id))
        if (entry === null) {
          throw Object.assign(new Error(`没有条目 "${body.id}"`), { status: 404 })
        }
        // Optional services (house ctx.get discipline): compositions without
        // a model answer honestly instead of pend-dying at mount.
        const llm = ctx.get('llm') as PolishLlm | undefined
        const defaultModel = ctx.get('agentDefaultModel') as DefaultModel | undefined
        if (llm === undefined || defaultModel === undefined) {
          throw Object.assign(new Error('润色需要模型服务(llm/agentDefaultModel),当前组合没有'), { status: 503 })
        }
        const prepared = await llm.prepareCall(defaultModel.provider, defaultModel.model)
        const message = createUserMessage({
          content: [{
            type: 'text',
            text:
              '把下面的项目知识改写成跨项目通用规则:保留技术要点与适用条件,去掉项目专名、次数叙事和口语。'
              + '只输出改写后的正文,不要任何解释或前后缀。\n\n'
              + `标题: ${entry.title}\n正文: ${entry.text}`,
          }],
          source: { kind: 'user' },
        })
        let polished = ''
        for await (const chunk of prepared.stream({
          provider: defaultModel.provider,
          model: defaultModel.model,
          messages: [message],
        })) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') polished += chunk.text
        }
        polished = polished.trim()
        if (polished === '') {
          throw Object.assign(new Error('模型没有返回可用的改写文本'), { status: 502 })
        }
        sendJson(res, 200, {
          polished,
          provider: defaultModel.provider,
          model: defaultModel.model,
          original: entry.text,
        })
        return
      }

      // POST /entry/text — adopt an edited/polished body (audited history).
      if (sub === '/entry/text' && method === 'POST') {
        const body = await readJsonBody(req, maxBodyBytes) as { scope?: string; id?: string; text?: string; reason?: string }
        if (typeof body.id !== 'string' || typeof body.text !== 'string') {
          throw Object.assign(new Error('需要 id(string) 与 text(string)'), { status: 400 })
        }
        const store = await storeFor(body.scope ?? null)
        const existing = await store.get(KbEntryId(body.id))
        if (existing === null) {
          throw Object.assign(new Error(`没有条目 "${body.id}"`), { status: 404 })
        }
        const entry = await store.updateEntryText(
          existing.id,
          body.text,
          body.reason ?? '网页人工修订正文',
        )
        sendJson(res, 200, { entry })
        return
      }

      // Known subpath, wrong method → 405; anything else → 404.
      const known = ['/status', '/approvals', '/approvals/resolve', '/entries', '/entry', '/entry/reverify', '/sweep', '/polish', '/entry/text']
      sendJson(res, known.includes(sub) ? 405 : 404, { error: method === 'GET' || method === 'POST' ? '方法不匹配' : '未知端点', path: sub })
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status: unknown }).status)
        : NaN
      // Illegal state-machine transitions and unknown ids surface as store
      // throws; 4xx where tagged, otherwise an honest 500 with the message.
      sendJson(res, Number.isFinite(status) ? status : 500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Registration is an effect: the disposer rides the plugin fiber, so
  // unloading this plugin withdraws the whole API (house discipline).
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle }))

  // Browser identity (tab title + favicon): a head script row on the same
  // index-injection table dsh's own client-modules uses. Unloading this
  // plugin withdraws the row — the next index render is plain dsh again.
  ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'head', text: identityScript() })
  }), 'clue-kb-web: browser identity injection')
}
