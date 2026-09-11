/**
 * kb-web route tests (M3c).
 *
 * Layer split (house discipline): the HTTP transport is the external edge,
 * so these tests stub ONLY req/res and register-capture the route; every
 * behavior behind the handler runs on REAL KbStore instances over a temp
 * CLUE_HOME — state-machine effects, ledgers, and scoring are asserted from
 * store truth, not from response echoes. The real-composition boot proof
 * lives in apps/cli/test/web-boot.test.ts (the web surface's contract test).
 *
 * @module @clue-harness/kb-web/test
 */
import { test } from 'node:test'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  openGlobalStore,
  openProjectStore,
  syncWorkspaces,
  panelWorkspaces as kbPanel,
  queryKb,
  readWorkspaces as kbList,
  syncWorkspaces as kbSync,
  type KbStore,
} from '@clue-harness/kb'
import type { ClueKb } from '@clue-harness/kb-face'
import { API_PREFIX, apply } from '@clue-harness/kb-web'
import { FAVICON_SVG, faviconDataUri, identityScript, IDENTITY_TITLE } from '../src/identity.ts'

/** One captured route registration (the fake webServer's whole surface). */
interface CapturedRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** A response capture standing in for ServerResponse. */
interface ResCapture {
  statusCode: number
  body: string
  json(): unknown
}

/**
 * Build the stub pair and drive one request through the captured handler.
 * @param route - the registered prefix route.
 * @param method - HTTP method.
 * @param url - request URL (path + query) under the prefix.
 * @param body - raw POST body text (undefined = no body events).
 * @returns status code plus parsed JSON body.
 */
async function call(
  route: CapturedRoute, method: string, url: string, body?: string,
): Promise<ResCapture> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]) as unknown as IncomingMessage
  ;(req as { method?: string }).method = method
  ;(req as { url?: string }).url = url
  const res = {
    statusCode: 0,
    body: '',
    writeHead(status: number) { this.statusCode = status; return this },
    end(payload?: Buffer | string) {
      if (payload !== undefined) {
        this.body += Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)
      }
      return this
    },
    json() { return JSON.parse(this.body) },
  }
  await route.handler(req, res as unknown as ServerResponse)
  return res
}

/**
 * Mount kb-web over real stores with a fake transport context.
 * @param project - the opened project store.
 * @param global - the opened global store.
 * @param projectRoot - the anchor the fake ctx.kb reports.
 * @param config - plugin config override (e.g. a tiny body bound).
 * @param services - extra ctx.get-able services (llm / agentDefaultModel).
 * @returns the captured route table.
 */
function mount(
  project: KbStore, global: KbStore, projectRoot: string,
  config: Parameters<typeof apply>[1] = {},
  services: Record<string, unknown> = {},
): CapturedRoute[] & { injections: { event: string; listener: (table: unknown[]) => void }[] } {
  // The face's home is derived from the store path (<home>/kb/<key>) so the
  // fake stays honest without widening every call site: a route must never
  // write to a default home it does not control.
  const home = resolve(join(project.dir, '..', '..'))
  const hostRows = (): Array<{ id: string; path: string; title: string; sessionIds: readonly string[] }> => {
    const registry = services.workspaceRegistry as { list(): Array<{ id: string; path: string; title: string; sessionIds: readonly string[] }> } | undefined
    return registry?.list() ?? []
  }
  const kb: ClueKb = {
    projectRoot,
    home,
    stores: async () => ({ project, global }),
    // M9.1 surface: the panel addresses ANY workspace, so the fake answers for
    // any root too (route tests keep every tier in one temp home anyway).
    storesFor: async (root) => (root === projectRoot
      ? { project, global }
      : { project: await openProjectStore(root, home), global }),
    workspaces: async () => kbList(home),
    panelWorkspaces: async () => kbPanel(home),
    syncHostWorkspaces: async () => kbSync(hostRows().map((row) => ({ id: row.id, path: row.path, title: row.title })), home),
    hostWorkspaceForSession: async (sessionId) => {
      const host = hostRows().find((row) => row.sessionIds.includes(sessionId))
      return host === undefined ? null : { id: host.id, path: host.path, title: host.title }
    },
    query: (text, options) => queryKb(project, global, {
      text,
      limit: options?.limit ?? 8,
      includeExpired: options?.includeExpired ?? false,
    }),
    propose: async () => { throw new Error('unused in route tests') },
    signal: async () => { throw new Error('unused in route tests') },
    runLoop: async () => { throw new Error('unused in route tests') },
  }
  const routes: CapturedRoute[] = []
  const injections: { event: string; listener: (table: unknown[]) => void }[] = []
  const ctx = {
    kb,
    webServer: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    },
    effect: (fn: () => unknown) => { fn() },
    get: (name: string) => services[name],
    on: (event: string, listener: (table: unknown[]) => void) => {
      injections.push({ event, listener })
      return () => { /* listener rides the fake fiber */ }
    },
  } as unknown as Context
  apply(ctx, config)
  return Object.assign(routes, { injections })
}

/** One isolated world: temp project root + CLUE_HOME, both stores opened. */
async function world(t: { after(fn: () => unknown): void }) {
  const root = await mkdtemp(join(tmpdir(), 'clue-kbweb-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectRoot = join(root, 'project')
  // The project tier opens over a REALPATH — the anchor must exist first.
  await mkdir(projectRoot, { recursive: true })
  const home = join(root, 'clue-home')
  const project = await openProjectStore(projectRoot, home)
  const global = await openGlobalStore(home)
  return { root, projectRoot, home, project, global }
}

test('route registration: one prefix route at the owned path, withdrawable', async (t) => {
  const { project, global, projectRoot } = await world(t)
  const routes = mount(project, global, projectRoot)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, API_PREFIX)
})

test('GET /status summarizes both tiers from store truth', async (t) => {
  const { project, global, projectRoot } = await world(t)
  await project.add({ kind: 'decision', title: '按钮必须进 Tab 顺序', text: '悬浮按钮要能被键盘聚焦' })
  await project.add({ kind: 'pitfall', title: 'strip-types 禁参数属性', text: 'constructor(private x) 会被原生剥离拒绝' })
  await global.add({ kind: 'fact', title: '全局事实', text: '跨项目通用' })
  const [route] = mount(project, global, projectRoot)

  const res = await call(route, 'GET', `${API_PREFIX}/status`)
  assert.equal(res.statusCode, 200)
  const status = res.json() as {
    projectRoot: string
    project: { tier: string; total: number; byStatus: Record<string, number>; pendingApprovals: number }
    global: { tier: string; total: number }
  }
  assert.equal(status.projectRoot, projectRoot)
  assert.equal(status.project.tier, 'project')
  assert.equal(status.project.total, 2)
  assert.equal(status.project.byStatus.candidate, 2)
  assert.equal(status.project.pendingApprovals, 0)
  assert.equal(status.global.total, 1)
})

test('approval flow: queue card merges the entry; approve promotes and signals', async (t) => {
  const { project, global, projectRoot } = await world(t)
  const entry = await project.add({ kind: 'decision', title: '证据门禁只拦可渲染轮次', text: '纯后端轮次不开浏览器' })
  await project.recordSignal(entry.id, 'human-confirm', '第一次人工确认')
  await project.recordSignal(entry.id, 'human-confirm', '第二次人工确认')
  const requested = await project.requestApproval(entry.id, 'promote', '测试排队', 10)
  const [route] = mount(project, global, projectRoot)

  // The queue card carries request + entry for one-shot rendering.
  const list = await call(route, 'GET', `${API_PREFIX}/approvals?scope=project`)
  assert.equal(list.statusCode, 200)
  const cards = (list.json() as { approvals: { request: { id: string }; entry: { id: string } | null }[] }).approvals
  assert.equal(cards.length, 1)
  assert.equal(cards[0].request.id, requested.id)
  assert.equal(cards[0].entry?.id, String(entry.id))

  // Approving promotes (state machine) AND records the human signal.
  const resolved = await call(route, 'POST', `${API_PREFIX}/approvals/resolve`, JSON.stringify({
    scope: 'project', requestId: requested.id, approved: true,
  }))
  assert.equal(resolved.statusCode, 200)
  const after = await project.get(entry.id)
  assert.equal(after?.status, 'trusted')

  // Resolving twice is a conflict, not a silent no-op.
  const twice = await call(route, 'POST', `${API_PREFIX}/approvals/resolve`, JSON.stringify({
    scope: 'project', requestId: requested.id, approved: true,
  }))
  assert.equal(twice.statusCode, 409)

  // Unknown request id is a 404 (pre-checked, not the store's bare throw).
  const missing = await call(route, 'POST', `${API_PREFIX}/approvals/resolve`, JSON.stringify({
    scope: 'project', requestId: 'nope', approved: true,
  }))
  assert.equal(missing.statusCode, 404)
})

test('GET /entries filters by status/kind/needsReview; q switches to retrieval', async (t) => {
  const { project, global, projectRoot } = await world(t)
  await project.add({ kind: 'decision', title: '目录约定', text: '组件放 src/client 下' })
  await project.add({ kind: 'pitfall', title: 'CSV 导出编码', text: '导出要带 BOM 头' })
  const [route] = mount(project, global, projectRoot)

  const all = await call(route, 'GET', `${API_PREFIX}/entries?scope=project`)
  assert.equal(((all.json() as { entries: unknown[] }).entries).length, 2)

  const pitfalls = await call(route, 'GET', `${API_PREFIX}/entries?scope=project&kind=pitfall`)
  const pitfallList = (pitfalls.json() as { entries: { kind: string }[] }).entries
  assert.equal(pitfallList.length, 1)
  assert.equal(pitfallList[0].kind, 'pitfall')

  const trusted = await call(route, 'GET', `${API_PREFIX}/entries?scope=project&status=trusted`)
  assert.equal(((trusted.json() as { entries: unknown[] }).entries).length, 0)

  // Retrieval mode: CJK bigram query hits, response carries matched fields.
  const found = await call(route, 'GET', `${API_PREFIX}/entries?scope=project&q=${encodeURIComponent('BOM 编码')}`)
  const hits = (found.json() as { entries: { entry: { title: string }; matched: string[] }[] }).entries
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].entry.title, 'CSV 导出编码')
  assert.ok(Array.isArray(hits[0].matched))

  // Invalid filter values fail loud with the legal vocabulary.
  const bad = await call(route, 'GET', `${API_PREFIX}/entries?scope=project&status=banana`)
  assert.equal(bad.statusCode, 400)
})

test('GET /entry merges window score and the entry-sliced signal ledger', async (t) => {
  const { project, global, projectRoot } = await world(t)
  const kept = await project.add({ kind: 'fact', title: '端口约定', text: 'clue web 默认 3090' })
  const other = await project.add({ kind: 'fact', title: '别的条目', text: '信号不应串台' })
  await project.recordSignal(kept.id, 'human-confirm', '人工确认')
  await project.recordSignal(other.id, 'evidence-pass', '证据通过')
  const [route] = mount(project, global, projectRoot)

  const res = await call(route, 'GET', `${API_PREFIX}/entry?scope=project&id=${encodeURIComponent(String(kept.id))}`)
  assert.equal(res.statusCode, 200)
  const detail = res.json() as {
    entry: { id: string }
    score: { score: number; counted: number }
    signals: { entryId: string; source: string }[]
  }
  assert.equal(detail.entry.id, String(kept.id))
  assert.equal(detail.score.counted, 1) // only THIS entry's signal counts
  assert.equal(detail.signals.length, 1)
  assert.equal(detail.signals[0].source, 'human')

  const missing = await call(route, 'GET', `${API_PREFIX}/entry?scope=project&id=nope`)
  assert.equal(missing.statusCode, 404)
})

test('reverify resolves the orthogonal flag raised by binding drift', async (t) => {
  const { project, global, projectRoot, root } = await world(t)
  // A bound file inside the project root; drift raises needs-review.
  await mkdir(projectRoot, { recursive: true })
  const bound = join(projectRoot, 'styles.css')
  await writeFile(bound, 'a { color: red }')
  const entry = await project.add({ kind: 'snippet', title: '主题色', text: '主色用红', bindings: ['styles.css'] })
  await writeFile(bound, 'a { color: blue }')
  await project.checkBindings(entry.id)
  assert.equal((await project.get(entry.id))?.needsReview, true)

  const [route] = mount(project, global, root)
  const res = await call(route, 'POST', `${API_PREFIX}/entry/reverify`, JSON.stringify({
    scope: 'project', id: String(entry.id), accept: true,
  }))
  assert.equal(res.statusCode, 200)
  const after = await project.get(entry.id)
  assert.equal(after?.needsReview, false)

  // Unknown entry is a 404, not the store's bare throw.
  const missing = await call(route, 'POST', `${API_PREFIX}/entry/reverify`, JSON.stringify({
    scope: 'project', id: 'nope', accept: true,
  }))
  assert.equal(missing.statusCode, 404)
})

test('POST /sweep runs maintenance and reports its four buckets', async (t) => {
  const { project, global, projectRoot } = await world(t)
  await project.add({ kind: 'fact', title: '待清扫', text: 'sweep 应报告空桶' })
  const [route] = mount(project, global, projectRoot)
  const res = await call(route, 'POST', `${API_PREFIX}/sweep`, JSON.stringify({ scope: 'project' }))
  assert.equal(res.statusCode, 200)
  const swept = res.json() as { scope: string; result: Record<string, unknown[]> }
  assert.equal(swept.scope, 'project')
  for (const bucket of ['expired', 'discarded', 'purged', 'promotions']) {
    assert.ok(Array.isArray(swept.result[bucket]), `sweep result missing ${bucket}`)
  }
})

test('transport discipline: 404 / 405 / 400 / 413 / 400-scope', async (t) => {
  const { project, global, projectRoot } = await world(t)
  const [route] = mount(project, global, projectRoot, { maxBodyBytes: 16 })

  assert.equal((await call(route, 'GET', `${API_PREFIX}/nope`)).statusCode, 404)
  assert.equal((await call(route, 'POST', `${API_PREFIX}/status`, '{}')).statusCode, 405)
  assert.equal((await call(route, 'POST', `${API_PREFIX}/sweep`, 'not-json')).statusCode, 400)
  assert.equal((await call(route, 'POST', `${API_PREFIX}/sweep`, 'x'.repeat(64))).statusCode, 413)
  assert.equal((await call(route, 'GET', `${API_PREFIX}/entries?scope=mars`)).statusCode, 400)

  // The bare prefix answers with the API index (a debug aid, not a 404).
  const index = await call(route, 'GET', API_PREFIX)
  assert.equal(index.statusCode, 200)
  assert.equal((index.json() as { api: string }).api, 'clue-kb')
})

/** A one-shot llm stub yielding a fixed rewrite (the polish route's whole need). */
function fakeLlm(polished: string) {
  const calls: { provider: string; model: string }[] = []
  return {
    calls,
    service: {
      prepareCall: async (provider: string, model: string) => {
        calls.push({ provider, model })
        return {
          async * stream() {
            yield { type: 'text-delta', text: polished.slice(0, 4) }
            yield { type: 'text-delta', text: polished.slice(4) }
            yield { type: 'finish' }
          },
        }
      },
    },
  }
}

test('polish + entry/text: the M6 rewrite aid returns text, adoption writes with audit', async (t) => {
  const { project, global, projectRoot } = await world(t)
  const entry = await project.add({ kind: 'decision', title: '泛化草稿', text: '本项目按钮必须用 ds-button,评审踩过三次。' })
  const llm = fakeLlm('表单按钮应使用统一的设计系统组件。')
  const [route] = mount(project, global, projectRoot, {}, {
    llm: llm.service,
    agentDefaultModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })

  // The polish route calls the default model and RETURNS text, writing nothing.
  const polished = await call(route, 'POST', `${API_PREFIX}/polish`, JSON.stringify({ scope: 'project', id: String(entry.id) }))
  assert.equal(polished.statusCode, 200)
  const payload = polished.json() as { polished: string; original: string; provider: string }
  assert.equal(payload.polished, '表单按钮应使用统一的设计系统组件。')
  assert.equal(payload.original, entry.text)
  assert.equal(payload.provider, 'deepseek-official')
  assert.deepEqual(llm.calls, [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }])
  assert.equal((await project.get(entry.id))?.text, entry.text, '润色本身绝不写库')

  // Adoption is the explicit write, with the audit reason in history.
  const adopted = await call(route, 'POST', `${API_PREFIX}/entry/text`, JSON.stringify({
    scope: 'project', id: String(entry.id), text: payload.polished, reason: '审批中心采纳 AI 润色稿',
  }))
  assert.equal(adopted.statusCode, 200)
  const after = await project.get(entry.id)
  assert.equal(after?.text, '表单按钮应使用统一的设计系统组件。')
  assert.equal(after?.history[after.history.length - 1].change, 'textUpdated')

  // Without a model in the composition the route answers honestly (503).
  const [bare] = mount(project, global, projectRoot)
  const noModel = await call(bare, 'POST', `${API_PREFIX}/polish`, JSON.stringify({ scope: 'project', id: String(entry.id) }))
  assert.equal(noModel.statusCode, 503)

  // Missing entries keep the transport discipline; blank adoption bodies fail loud.
  assert.equal((await call(route, 'POST', `${API_PREFIX}/polish`, JSON.stringify({ scope: 'project', id: 'k-ghost' }))).statusCode, 404)
  const blank = await call(route, 'POST', `${API_PREFIX}/entry/text`, JSON.stringify({ scope: 'project', id: String(entry.id), text: '  ' }))
  assert.equal(blank.statusCode, 500)
  assert.ok((blank.json() as { error: string }).error.includes('正文不能为空白'))
})

test('browser identity: the index-injection row claims the tab title + network favicon', async (t) => {
  const { project, global, projectRoot } = await world(t)
  const routes = mount(project, global, projectRoot)
  const injector = routes.injections.find((entry) => entry.event === 'webserver/index-inject')
  assert.ok(injector, 'kb-web 必须订阅 index 注入表')

  const table: { kind: string; placement?: string; text?: string }[] = []
  injector.listener(table)
  assert.equal(table.length, 1)
  const [row] = table
  assert.equal(row.kind, 'script')
  assert.equal(row.placement, 'head')
  assert.ok(row.text?.includes('"Clue Harness"'), '脚本必须声明标签标题')
  assert.ok(row.text?.includes(faviconDataUri()), '脚本必须携带网络标 data URI')
  // Classic inline-script safety: an embedded closing-script sequence would
  // end the injected element early (the webserver row contract).
  assert.ok(!row.text?.includes('</scr'))

  // The favicon is the network mark, standalone-URL-encoded; the builder and
  // the emitted row agree.
  assert.ok(faviconDataUri().startsWith('data:image/svg+xml,%3Csvg'))
  assert.ok(FAVICON_SVG.includes('<circle') && FAVICON_SVG.includes('<path'))
  assert.equal(IDENTITY_TITLE, 'Clue Harness')
  assert.equal(row.text, identityScript())
})

// ── M9.1: the host workspace registry owns panel visibility ────────────────

test('GET /workspaces lists the HOST registry, not every path clue ever touched', async (t) => {
  const { home, projectRoot } = await world(t)
  const { mkdir, mkdtemp } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const sidebar = join(await mkdtemp(join(tmpdir(), 'clue-hostws-')), 'shop')
  await mkdir(sidebar, { recursive: true })
  // A CLI-touched path: real row in the side table, NOT a sidebar workspace.
  const { registerWorkspace } = await import('@clue-harness/kb')
  await registerWorkspace(projectRoot, { home })
  const registry = {
    list: () => [{ id: 'w1', path: sidebar, title: '我的商店', sessionIds: ['session-1'] }],
  }
  const [route] = mount(
    await openProjectStore(projectRoot, home), await openGlobalStore(home), projectRoot, {},
    { workspaceRegistry: registry },
  )
  const res = await call(route, 'GET', `${API_PREFIX}/workspaces`)
  const body = res.json() as { workspaces: Array<{ label: string; root: string }>; orphans: unknown[]; error?: string }
  if (res.statusCode !== 200) throw new Error(`路由回了 ${String(res.statusCode)}: ${body.error ?? res.body}`)
  assert.equal(body.workspaces.length, 1, '侧边栏有几个就列几个')
  assert.equal(body.workspaces[0].label, '我的商店', '标题镜像宿主的')
  assert.equal(body.orphans.length, 0)
})

test('a workspace dropped from the registry surfaces as an orphan and is answerable', async (t) => {
  const { home, projectRoot } = await world(t)
  const { mkdir, mkdtemp } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const doomed = join(await mkdtemp(join(tmpdir(), 'clue-orphan-')), 'tmp-proj')
  await mkdir(doomed, { recursive: true })
  const store = await openProjectStore(doomed, home)
  await store.add({ kind: 'fact', title: '留下的', text: '正文' })
  let alive = true
  // The live-purge probe below must stay IN the registry too, or the next sync
  // legitimately orphans it and the assertions fight each other.
  const extra: Array<{ id: string; path: string; title: string; sessionIds: string[] }> = []
  const registry = { list: () => [...(alive ? [{ id: 'w1', path: doomed, title: '要移除的', sessionIds: [] }] : []), ...extra] }
  const [route] = mount(store, await openGlobalStore(home), projectRoot, {}, { workspaceRegistry: registry })

  assert.equal(((await call(route, 'GET', `${API_PREFIX}/workspaces`)).json().workspaces.length), 1)
  alive = false
  const dropped = (await call(route, 'GET', `${API_PREFIX}/workspaces`)).json() as {
    workspaces: unknown[]; orphans: Array<{ key: string; hostTitle: string }>
  }
  assert.equal(dropped.workspaces.length, 0, '侧边栏没了,面板也就不列它')
  assert.equal(dropped.orphans.length, 1, '但要以提问的形式出现')
  assert.equal(dropped.orphans[0].hostTitle, '要移除的')

  // Status codes carry meaning: unknown key is 404, a live workspace is 400.
  const unknown = await call(route, 'POST', `${API_PREFIX}/workspaces/purge`, JSON.stringify({ key: 'no-such-key' }))
  assert.equal(unknown.statusCode, 404, '不存在的 key 是 404')
  const liveSide = await mkdtemp(join(tmpdir(), 'clue-live-purge-'))
  extra.push({ id: 'w9', path: liveSide, title: '还活着', sessionIds: [] })
  const liveRoot = await realpath(liveSide)
  const liveKey = (await syncWorkspaces(registry.list(), home)).live.find((row) => row.root === liveRoot)?.key
  assert.ok(liveKey !== undefined, '探针工作区应已登记')
  const refused = await call(route, 'POST', `${API_PREFIX}/workspaces/purge`, JSON.stringify({ key: liveKey }))
  assert.equal(refused.statusCode, 400, '活着的工作区不能清退')

  const kept = await call(route, 'POST', `${API_PREFIX}/workspaces/keep`, JSON.stringify({ key: dropped.orphans[0].key }))
  assert.equal(kept.statusCode, 200)
  const after = (await call(route, 'GET', `${API_PREFIX}/workspaces`)).json() as { orphans: Array<{ key: string }> }
  assert.deepEqual(after.orphans.filter((row) => row.key === dropped.orphans[0].key).length, 0, '答过"保留"就不再问它')
  assert.equal((await store.list()).length, 1, '数据一根毫毛没动')
})

test('GET /workspace-for-session resolves the conversation workspace host-side', async (t) => {
  const { home, projectRoot } = await world(t)
  const { mkdir, mkdtemp } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const ws = join(await mkdtemp(join(tmpdir(), 'clue-sessionws-')), 'proj')
  await mkdir(ws, { recursive: true })
  const registry = { list: () => [{ id: 'w1', path: ws, title: '会话工作区', sessionIds: ['session-42'] }] }
  const [route] = mount(
    await openProjectStore(projectRoot, home), await openGlobalStore(home), projectRoot, {},
    { workspaceRegistry: registry },
  )
  const hit = (await call(route, 'GET', `${API_PREFIX}/workspace-for-session?sessionId=session-42`)).json() as
    { record: { root: string }; source: string }
  assert.equal(hit.source, 'registry')
  assert.equal(hit.record.root, await (await import('node:fs/promises')).realpath(ws))

  const miss = (await call(route, 'GET', `${API_PREFIX}/workspace-for-session?sessionId=ghost`)).json() as
    { source: string; root: string }
  assert.equal(miss.source, 'launch-anchor', '查不到就诚实回退到启动锚点')
  assert.equal(miss.root, projectRoot)
})

test('routes never touch the DEFAULT home — every engine call carries the configured one', async (t) => {
  // The regression this pins: a route that forgets to pass `home` silently
  // reads and WRITES ~/.clue (the real user's home) even though the face was
  // configured elsewhere. Left unchecked it shows up as "another project's
  // knowledge base appears in my panel", and it is invisible until someone's
  // home directory has state in it. So: point HOME at an empty directory,
  // clear CLUE_HOME, drive every home-sensitive route, and assert that nothing
  // was ever created under the default home.
  const savedHome = process.env.HOME
  const savedClue = process.env.CLUE_HOME
  const fakeUser = await mkdtemp(join(tmpdir(), 'clue-fake-user-'))
  process.env.HOME = fakeUser
  delete process.env.CLUE_HOME
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedClue !== undefined) process.env.CLUE_HOME = savedClue
    return rm(fakeUser, { recursive: true, force: true })
  })

  const { home, projectRoot, project, global } = await world(t)
  const doomed = join(await mkdtemp(join(tmpdir(), 'clue-leak-probe-')), 'proj')
  await mkdir(doomed, { recursive: true })
  let alive = true
  const registry = {
    list: () => (alive ? [{ id: 'w1', path: doomed, title: '泄漏探针', sessionIds: ['s1'] }] : []),
  }
  const [route] = mount(project, global, projectRoot, {}, { workspaceRegistry: registry })

  const first = (await call(route, 'GET', `${API_PREFIX}/workspaces`)).json() as { workspaces: Array<{ key: string }> }
  assert.equal(first.workspaces.length, 1, '先让同步把行写进配置好的 home')
  alive = false
  const dropped = (await call(route, 'GET', `${API_PREFIX}/workspaces`)).json() as { orphans: Array<{ key: string }> }
  const orphan = dropped.orphans[0]
  assert.ok(orphan !== undefined)
  // Every route that resolves a workspace or answers the orphan question:
  // each one is a place a missing `home` argument would leak.
  const probes: Array<[string, string, string?]> = [
    ['POST', `${API_PREFIX}/workspaces/keep`, JSON.stringify({ key: orphan.key })],
    ['POST', `${API_PREFIX}/workspaces/purge-all`, '{}'],
    ['GET', `${API_PREFIX}/workspace-for-session?sessionId=s1`],
    ['GET', `${API_PREFIX}/workspace-for-session?sessionId=nobody`],
    ['GET', `${API_PREFIX}/status?workspace=${orphan.key}`],
    ['POST', `${API_PREFIX}/workspaces/add`, JSON.stringify({ root: projectRoot, label: '探针' })],
    ['POST', `${API_PREFIX}/workspaces/rename`, JSON.stringify({ key: orphan.key, label: '改名探针' })],
    ['POST', `${API_PREFIX}/workspaces/remove`, JSON.stringify({ key: orphan.key })],
    ['GET', `${API_PREFIX}/workspaces?stats=1`],
  ]
  const failures: string[] = []
  // Sequential ON PURPOSE: the side table is documented read-compute-atomic
  // write with no cross-process lock, so a concurrent storm legitimately loses
  // rows. That is a known limit, not what this test is about — it checks the
  // HOME each call writes to, one at a time.
  for (const [method, url, body] of probes) {
    const r = await call(route, method, url, body)
    if (r.statusCode !== 200) failures.push(`${method} ${url.split(API_PREFIX)[1]} → ${String(r.statusCode)} ${r.body.slice(0, 120)}`)
  }
  assert.deepEqual(failures, [], '路由自身要都成功')

  assert.equal(
    await readdir(join(fakeUser, '.clue')).catch(() => null), null,
    '默认家目录下绝不能出现 .clue(有就是某条路由漏传了 home)',
  )
  // And the configured home did receive the writes — the routes are not no-oping.
  assert.ok((await readdir(join(home, 'kb'))).length >= 1, '配置 home 里应当真的落了东西')
})
