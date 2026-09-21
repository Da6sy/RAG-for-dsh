/**
 * M3c contract test — the web surface's keyless acceptance proof.
 *
 * Boots the REAL clue web composition (dsh-base + dsh-web-app bundles +
 * clue.web.patch.yml, the exact stack `clue web` runs) over isolated
 * DSH_HOME/CLUE_HOME, on an OS-assigned port, and probes it over real HTTP:
 *
 *   1. the tree activates end to end (fail-loud boot audit: every roster row
 *      found its services — the web shell's dependency closure IS complete
 *      under the clue overlay);
 *   2. the shell serves: GET / answers the built dsh frontend index with the
 *      boot manifest injected (window.__DSH_BOOT__ — the browser half's
 *      whole world);
 *   3. our client plugin is IN the graph: its declaration was scanned, its
 *      built bundle is served at /plugins/<id>/client.js, byte-wrapped for
 *      the module loader;
 *   4. the KB API is live on the same origin and sees the SEEDED store —
 *      proof that kb-face (host services) + kb-web (routes) + the kb engine
 *      (durable ledgers) compose in the web tree exactly as in the CLI tree.
 *
 * Self-skip (M2 gate discipline): without the built ui-kb bundle the plugin
 * scan would fail the boot, so the test skips with the build instruction
 * instead of faking green — `npm run build:ui` turns it into a real run.
 *
 * @module @clue-harness/cli/test/web-boot
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientBundle = fileURLToPath(new URL('../../../packages/ui-kb/lib/client.js', import.meta.url))

test('M3c contract: the real web composition boots, serves the shell, our bundle, and the KB API', { timeout: 180_000 }, async (t) => {
  if (!existsSync(clientBundle)) {
    t.skip('ui-kb 浏览器 bundle 未构建 — 先跑 `npm run build:ui`(产物就绪后本测试自动转真跑)')
    return
  }

  // Isolation BEFORE any dsh-app-boot import (the module pins the home path
  // at load time — the M0 contract test's lesson, same discipline here).
  // runWeb ASSIGNS DSH_HOME from CLUE_HOST_HOME — that is the isolation door.
  const workdir = await mkdtemp(join(tmpdir(), 'clue-webboot-'))
  const savedCwd = process.cwd()
  const savedHome = process.env.DSH_HOME
  const savedClueHost = process.env.CLUE_HOST_HOME
  const savedClueHome = process.env.CLUE_HOME
  process.chdir(workdir)
  process.env.CLUE_HOST_HOME = join(workdir, '.dsh-home')
  process.env.DSH_HOME = join(workdir, '.dsh-home')
  process.env.CLUE_HOME = join(workdir, '.clue-home')
  t.after(async () => {
    process.chdir(savedCwd)
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    if (savedClueHost === undefined) delete process.env.CLUE_HOST_HOME
    else process.env.CLUE_HOST_HOME = savedClueHost
    if (savedClueHome === undefined) delete process.env.CLUE_HOME
    else process.env.CLUE_HOME = savedClueHome
    await rm(workdir, { recursive: true, force: true })
  })

  // Seed the project KB BEFORE boot: kb-face anchors at the process cwd, so
  // the store the web tree opens is exactly this one (same CLUE_HOME).
  const { openProjectStore } = await import('@clue-harness/kb')
  const seedStore = await openProjectStore(workdir, process.env.CLUE_HOME)
  const seeded = await seedStore.add({
    kind: 'decision',
    title: 'web 面组合走 bundle patch',
    text: 'clue web = dsh-base + dsh-web-app + clue 覆盖层,不手工重建 roster',
    tags: ['composition'],
    createdBy: 'test:web-boot',
  })

  const { runWeb } = await import('../src/web.ts')
  const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot')
  const web = await runWeb({
    environment: loadLayeredEnv('clue'),
    port: 0, // OS-assigned: parallel-safe, and proves the port getter path
    manageSignals: false,
    // web-startup parses the inner args for the browser-open switch; a test
    // must never pop a browser (on WSL it would launch the Windows one).
    args: ['--no-open'],
  })
  t.after(() => web.shutdown(0))
  assert.ok(web.port > 0, 'webserver did not report a bound port')
  const origin = `http://127.0.0.1:${web.port}`

  // (2) The shell: the built dsh frontend index, boot manifest injected.
  const index = await fetch(`${origin}/`)
  assert.equal(index.status, 200)
  const html = await index.text()
  assert.ok(html.includes('__DSH_BOOT__'), 'index.html carries no boot manifest injection')
  assert.ok(html.includes('"Clue Harness"'), 'index.html misses the clue tab-title identity script')

  // (3) Our client plugin is in the boot graph and its bundle is served.
  const bundle = await fetch(`${origin}/plugins/@clue-harness/ui-kb/client.js`)
  assert.equal(bundle.status, 200, 'ui-kb client bundle not served')
  const bundleText = await bundle.text()
  assert.ok(bundleText.startsWith('window.__ModuleLoader__.load('), 'bundle lost its module-loader wrapper')
  assert.ok(bundleText.includes('"@clue-harness/ui-kb"'), 'bundle carries the wrong module id')

  // (4) The KB API on the same origin, over the SEEDED durable store.
  const status = await fetch(`${origin}/api/clue-kb/status`)
  assert.equal(status.status, 200)
  const statusPayload = await status.json() as { project: { total: number; byStatus: Record<string, number> } }
  assert.ok(statusPayload.project.total >= 1, 'seeded entry missing from the web tree\'s store')
  assert.ok(statusPayload.project.byStatus.candidate >= 1)

  const entries = await fetch(`${origin}/api/clue-kb/entries?scope=project`)
  assert.equal(entries.status, 200)
  const entriesPayload = await entries.json() as { entries: { id: string; title: string }[] }
  const found = entriesPayload.entries.find(entry => entry.id === String(seeded.id))
  assert.ok(found, 'the seeded decision is not listed through the web API')
  assert.equal(found.title, 'web 面组合走 bundle patch')

  // (5) V1: the embedding plane's routes (规划 §9.5/§9.7 路径 B). The page's
  // whole API is exercised here over real HTTP, including the two rules that
  // matter most: a secret travels one way only, and a bad field is named.
  const embedding = await fetch(`${origin}/api/clue-kb/embedding/config?workspace=`)
  assert.equal(embedding.status, 200)
  const embeddingPayload = await embedding.json() as {
    available: boolean
    config: { enabled: boolean; dim: number }
    key: { state: string; detail: string }
    ready: boolean
    vector: { indexes: unknown[] }
  }
  assert.equal(embeddingPayload.available, true, 'web 组合里没有挂载 settings/credentials 服务')
  assert.equal(embeddingPayload.ready, false, '默认未配置 ⇒ 未就绪(纯词法)')
  assert.equal(embeddingPayload.key.state, 'missing')

  // A field-level refusal, not a generic failure.
  const badWrite = await fetch(`${origin}/api/clue-kb/embedding/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { dim: 1024 } }),
  })
  assert.equal(badWrite.status, 400)
  const badPayload = await badWrite.json() as { errors: { field: string }[] }
  assert.equal(badPayload.errors[0]?.field, 'dim', 'dim 必须被拒绝并指名')

  const goodWrite = await fetch(`${origin}/api/clue-kb/embedding/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { enabled: true, baseUrl: 'https://api.example.cn/v1', model: 'bge-m3', apiKeyEnv: 'CLUE_WEB_TEST_KEY' } }),
  })
  assert.equal(goodWrite.status, 200)

  const secret = 'sk-web-boot-secret-987654'
  const keyWrite = await fetch(`${origin}/api/clue-kb/embedding/key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: secret }),
  })
  assert.equal(keyWrite.status, 200)
  const keyPayload = await keyWrite.json() as { stored: string; key: { state: string } }
  assert.equal(keyPayload.key.state, 'configured')
  assert.equal(JSON.stringify(keyPayload).includes(secret), false, '写入响应绝不能回显密钥')

  const afterKey = await fetch(`${origin}/api/clue-kb/embedding/config?workspace=`)
  const afterPayload = await afterKey.text()
  assert.equal(afterPayload.includes(secret), false, '读取接口也绝不能回显密钥')
  assert.ok(afterPayload.includes('CLUE_WEB_TEST_KEY'), '但必须给出引用名')

  // The key lives in the credential store, NOT in our own knowledge tree.
  const { readFile: readText } = await import('node:fs/promises')
  const settingsDoc = await readText(join(workdir, '.dsh-home', 'settings.yaml'), 'utf8')
  assert.equal(settingsDoc.includes(secret), false)
  assert.ok(settingsDoc.includes('CLUE_WEB_TEST_KEY'))

  // (6) V4: the「向量 N 段」badge's data source. The route must answer the
  // field even with no vector layer built (null), so the panel can render
  // 待建 instead of guessing — and reading it must never build anything.
  const docs = await fetch(`${origin}/api/clue-kb/doc?scope=project`)
  assert.equal(docs.status, 200)
  const docsPayload = await docs.json() as { docs: Array<{ docId: string; vector?: unknown }> }
  if (docsPayload.docs.length > 0) {
    assert.ok('vector' in (docsPayload.docs[0] ?? {}), '/doc 列表必须带 vector 字段(徽章的数据源)')
    assert.equal(docsPayload.docs[0]?.vector, null, '没有向量层时必须是 null,不是缺字段')
  }

  // (7) V1 follow-up: the embedder picker's catalog is served by the host, and
  // in the REAL web composition the pi-ai namespace IS registered — so the
  // user's configured providers appear with their own base URLs.
  const candidates = await fetch(`${origin}/api/clue-kb/embedding/candidates`)
  assert.equal(candidates.status, 200)
  const candidatePayload = await candidates.json() as {
    groups: Array<{ route: string; baseUrl: string; keyState: string; candidates: Array<{ model: string; usable: boolean }> }>
    notices: string[]
    selected: string | null
  }
  assert.ok(candidatePayload.groups.length > 0, '目录不能是空的')
  assert.ok(candidatePayload.groups.some((group) => group.route === 'deepseek-official' && group.candidates[0]?.usable === false), 'DeepSeek 必须作为"不可用"出现')
  assert.ok(candidatePayload.groups.some((group) => group.route === 'local' && group.keyState === 'configured'), '本地选项必须总是可用')

  // Bounded shutdown settles the handle (the bin's exit path).
  await web.shutdown(0)
  assert.equal(await web.done, 0)
})
