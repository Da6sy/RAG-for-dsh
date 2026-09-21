/**
 * The embedding configuration routes (V1, 规划 §9.5/§9.7 路径 B).
 *
 * §9.7 offered two ways to wire the settings page and marked the research item
 * that decides between them. This is **path B**, and the reason is a verified
 * contract fact rather than a preference: our browser bundle's externals are
 * exactly the dsh client baseline (react family, cordis, ui-slots,
 * ui-primitives, runtime — see `packages/ui-kb/build.mjs`), while dsh's own
 * Models page reaches settings/credentials through the client capability plane.
 * Path B keeps the page on the same-origin JSON channel every other ClueHarness
 * panel already uses, so it needs no new external, no Remote codegen, and no
 * assumption about which client faces a third-party section can inject.
 *
 * The security posture the plan demands is what makes this shape safe (§9.7):
 *
 * - **A secret travels one way only** — browser → host → `credentials`. No
 *   response body, in any branch, contains a key value: the read endpoints
 *   return the reference NAME and a status word, and the write endpoint returns
 *   where it stored it. There is no code path that could echo one back.
 * - **A write is field-validated before it persists**, and the refusal names
 *   the field (§9.3), because "保存失败" is not actionable.
 * - **Revision-fencing is passed through** to the settings seam, so a stale tab
 *   gets a conflict rather than silently overwriting (§9.2).
 * - **Nothing here rebuilds by accident**: the build route is explicit and
 *   prints its account first, and the doctor/status reads never write.
 *
 * @module @clue-harness/kb-web/embedding-routes
 */
import path from 'node:path'
import { readSignals, clearEmbedCache, countCachedVectors, embedderVersion as embedderVersionOf, readVectorIndex, vectorIndexStatuses, type KbStore, type VectorIndexStatus } from '@clue-harness/kb'
import { buildVectorIndex, planEmbed, summarizeRankLog, type Embedder } from '@clue-harness/rag'
import {
  embeddingKeyStatus,
  embeddingReadinessNote,
  embeddingReady,
  readEmbeddingConfig,
  readRetrievalConfig,
  recordMeasuredDim,
  registerEmbeddingSettings,
  resolveEmbeddingKey,
  storeEmbeddingKey,
  unsetEmbeddingKey,
  writeEmbeddingConfig,
} from '@clue-harness/kb-face/embedding'
import type { EmbeddingHost } from '@clue-harness/kb-face/embedding-host'
import { createHttpEmbedder, embeddingsUrl, endpointHost, testConnection } from '@clue-harness/kb-face/http-embedder'
import type { Context } from '@deepseek-ai/cordis'

/** What one route answers. */
export interface RouteAnswer {
  status: number
  payload: unknown
}

/** The face the routes read from (narrowed to what they use). */
export interface EmbeddingRoutesDeps {
  ctx: Context
  /** Resolve the addressed workspace's tier pair (the panel's dropdown). */
  storesFor: (workspace: string | null) => Promise<{ project: KbStore; global: KbStore }>
  /** The ClueHarness home (the shared embed cache lives under it). */
  home: string
}

/** The vector-layer facts one status payload carries (never a secret). */
interface VectorFacts {
  embedderVersion: string | null
  indexes: Array<VectorIndexStatus & { tier: string }>
  cachedVectors: number
  ranklog: Awaited<ReturnType<typeof summarizeRankLog>>
}

/**
 * Create the route handler.
 *
 * Returns null for any subpath this module does not own, so the caller can keep
 * dispatching to the rest of the KB API (one prefix, several owners).
 * @param deps - context, workspace resolution and home.
 * @returns a `(sub, method, url, body) => RouteAnswer | null` dispatcher.
 */
export function createEmbeddingRoutes(deps: EmbeddingRoutesDeps): (
  sub: string,
  method: string,
  url: URL,
  body: Record<string, unknown>,
) => Promise<RouteAnswer | null> {
  const { ctx } = deps
  // Register the namespaces here as well as in kb-face: the page must work in a
  // composition that mounts kb-web without the agent face, and the registration
  // is idempotent by namespace.
  registerEmbeddingSettings(ctx)

  /** Build a host-shaped adapter over the LIVE web context (no re-mounting). */
  const host: EmbeddingHost = {
    ctx,
    get dshHome() { return deps.home },
    documentPath: (ctx.get('settings') as unknown as { documentPath?: string } | undefined)?.documentPath,
    close: async () => {},
  }

  const embedderFor = (): Embedder | null => {
    const config = readEmbeddingConfig(ctx)
    if (!embeddingReady(config)) return null
    return createHttpEmbedder({
      getConfig: () => {
        const live = readEmbeddingConfig(ctx)
        return {
          baseUrl: live.baseUrl,
          model: live.model,
          dim: live.dim,
          headers: live.headers,
          timeoutMs: live.timeoutMs,
          batchSize: live.batchSize,
        }
      },
      resolveKey: () => resolveEmbeddingKey(ctx, readEmbeddingConfig(ctx)),
    })
  }

  /** The vector-layer facts for the addressed workspace. */
  const vectorFacts = async (root: string | null): Promise<VectorFacts> => {
    const stores = await deps.storesFor(root)
    const config = readEmbeddingConfig(ctx)
    const ready = embeddingReady(config)
    const version = ready ? embedderVersionOf({ modelId: config.model, dim: config.dim }) : null
    const indexes: Array<VectorIndexStatus & { tier: string }> = []
    for (const [tier, store] of [['project', stores.project], ['global', stores.global]] as const) {
      for (const row of await vectorIndexStatuses(store.dir, version)) indexes.push({ ...row, tier })
    }
    const ledger = await readSignals(path.join(stores.project.dir, 'signals.jsonl'))
    return {
      embedderVersion: version,
      indexes,
      cachedVectors: version === null ? 0 : await countCachedVectors(deps.home, version),
      ranklog: await summarizeRankLog(stores.project.dir, ledger),
    }
  }

  return async (sub, method, url, body) => {
    // ── the whole page's initial read ─────────────────────────────────────
    if (sub === '/embedding/config' && method === 'GET') {
      const workspace = url.searchParams.get('workspace')
      const config = readEmbeddingConfig(ctx)
      const ready = embeddingReady(config)
      const descriptors = (ctx.get('settings') as unknown as { describe?: () => Array<{ ns: string; revision: number }> } | undefined)?.describe?.() ?? []
      return {
        status: 200,
        payload: {
          config,
          retrieval: readRetrievalConfig(ctx),
          ready,
          note: embeddingReadinessNote(config),
          key: await embeddingKeyStatus(ctx, config),
          // The vault is reachable at all only when the host mounted both
          // services; the page renders a setup card otherwise (§9.5 姿态规则).
          available: ctx.get('settings') !== undefined && ctx.get('credentials') !== undefined,
          documentPath: host.documentPath ?? null,
          revisions: Object.fromEntries(descriptors.map((descriptor) => [descriptor.ns, descriptor.revision])),
          vector: await vectorFacts(workspace),
        },
      }
    }

    // ── the picker's catalog (V1 follow-up) ───────────────────────────────
    if (sub === '/embedding/candidates' && method === 'GET') {
      const { buildEmbeddingCatalog, matchCandidate } = await import('@clue-harness/kb-face/embedding-catalog')
      const catalog = await buildEmbeddingCatalog(ctx)
      const config = readEmbeddingConfig(ctx)
      return { status: 200, payload: { ...catalog, selected: matchCandidate(catalog, config) } }
    }

    // ── non-secret writes ─────────────────────────────────────────────────
    if (sub === '/embedding/config' && method === 'POST') {
      const patch = body.patch
      if (patch === null || typeof patch !== 'object') return { status: 400, payload: { error: 'patch 必须是对象' } }
      const revision = typeof body.revision === 'number' ? body.revision : undefined
      const result = await writeEmbeddingConfig(ctx, patch as Record<string, unknown>, revision)
      // The write splits the patch across two namespaces, so the answer carries
      // BOTH sections back (a tuning save must not report success while the
      // retrieval section still shows the old values).
      return {
        status: result.ok ? 200 : 400,
        payload: { ...result, retrieval: result.retrieval ?? readRetrievalConfig(ctx) },
      }
    }

    // ── the secret: one direction, no echo ────────────────────────────────
    if (sub === '/embedding/key' && method === 'POST') {
      const value = typeof body.value === 'string' ? body.value : ''
      if (value.trim() === '') return { status: 400, payload: { error: '密钥不能为空(清除请用「清除密钥」)' } }
      try {
        const where = await storeEmbeddingKey(ctx, value)
        // The answer carries the TARGET, never the value.
        return { status: 200, payload: { ok: true, stored: where, key: await embeddingKeyStatus(ctx) } }
      } catch (error) {
        return { status: 400, payload: { ok: false, error: error instanceof Error ? error.message : String(error) } }
      }
    }
    if (sub === '/embedding/key/clear' && method === 'POST') {
      const where = await unsetEmbeddingKey(ctx)
      return { status: 200, payload: { ok: true, cleared: where, key: await embeddingKeyStatus(ctx) } }
    }

    // ── the connection test (§9.6) ────────────────────────────────────────
    if (sub === '/embedding/test' && method === 'POST') {
      const workspace = typeof body.workspace === 'string' ? body.workspace : null
      const stores = await deps.storesFor(workspace)
      const stored = await readVectorIndex(stores.project.dir, { kind: 'entries' })
      const result = await testConnection({
        getConfig: () => {
          const live = readEmbeddingConfig(ctx)
          return {
            baseUrl: live.baseUrl,
            model: live.model,
            dim: live.dim,
            headers: live.headers,
            timeoutMs: live.timeoutMs,
            batchSize: live.batchSize,
          }
        },
        resolveKey: () => resolveEmbeddingKey(ctx, readEmbeddingConfig(ctx)),
      }, stored?.meta.dim ?? 0, stored?.meta.count ?? 0)
      let recorded: { previousDim: number; dim: number; rebuildImplied: boolean } | null = null
      if (result.ok && result.dim !== undefined && body.record === true) {
        recorded = await recordMeasuredDim(ctx, result.dim)
      }
      return { status: 200, payload: { ...result, recorded, endpoint: embeddingsUrl(readEmbeddingConfig(ctx).baseUrl), host: endpointHost(readEmbeddingConfig(ctx).baseUrl) } }
    }

    // ── zero-config detection (the「自动检测」button) ───────────────────────
    if (sub === '/embedding/auto' && method === 'POST') {
      const { autoDetectEmbedder } = await import('@clue-harness/kb-face/embedding-catalog')
      const result = await autoDetectEmbedder(ctx, { dryRun: body.dryRun === true })
      return { status: result.applied === null ? 409 : 200, payload: { ...result, config: readEmbeddingConfig(ctx), vector: await vectorFacts(null) } }
    }

    // ── index build (the 重建向量层 button) ────────────────────────────────
    if (sub === '/embedding/build' && method === 'POST') {
      const workspace = typeof body.workspace === 'string' ? body.workspace : null
      const stores = await deps.storesFor(workspace)
      const dryRun = body.dryRun === true
      const only = typeof body.only === 'string' ? body.only : 'entries'
      const embedder = embedderFor()
      if (embedder === null) {
        return { status: 409, payload: { ok: false, error: `嵌入未就绪(${embeddingReadinessNote(readEmbeddingConfig(ctx))}),无法建立向量层` } }
      }
      const config = readEmbeddingConfig(ctx)
      const targets: Array<{ kind: 'entries' } | { kind: 'chunks'; docId: string }> = []
      if (only === 'entries' || only === 'all') targets.push({ kind: 'entries' })
      if (only === 'chunks' || only === 'all') {
        for (const doc of await stores.project.listDocs()) targets.push({ kind: 'chunks', docId: String(doc.docId) })
      }
      const reports: unknown[] = []
      for (const target of targets) {
        const options = {
          home: deps.home,
          embedder,
          target,
          batchSize: config.batchSize,
          concurrency: config.concurrency,
          maxUnitsPerBuild: config.maxUnitsPerBuild,
          rebuild: body.rebuild === true,
        }
        if (dryRun) {
          reports.push({ target, plan: await planEmbed(stores.project, options) })
          continue
        }
        reports.push({ target, report: await buildVectorIndex(stores.project, options) })
      }
      return { status: 200, payload: { ok: true, dryRun, reports, vector: await vectorFacts(workspace) } }
    }

    // ── diagnostics (§9.5 诊断区; both need confirmation in the page) ──────
    if (sub === '/embedding/cache/clear' && method === 'POST') {
      const config = readEmbeddingConfig(ctx)
      const version = embeddingReady(config) ? embedderVersionOf({ modelId: config.model, dim: config.dim }) : undefined
      const cleared = await clearEmbedCache(deps.home, body.all === true ? undefined : version)
      return { status: 200, payload: { ok: true, cleared } }
    }
    if (sub === '/embedding/ranklog' && method === 'GET') {
      const workspace = url.searchParams.get('workspace')
      const stores = await deps.storesFor(workspace)
      const ledger = await readSignals(path.join(stores.project.dir, 'signals.jsonl'))
      return { status: 200, payload: await summarizeRankLog(stores.project.dir, ledger) }
    }

    return null
  }
}
