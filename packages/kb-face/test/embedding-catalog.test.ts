/**
 * The embedder picker's catalog (V1 follow-up).
 *
 * The page asks the host for its options, and the host must answer with three
 * values that AGREE (base URL, model id, key reference) plus an honest key
 * status per provider — because a mismatched triple is the failure this picker
 * exists to prevent, and because "the provider you configured" is only usable
 * if its key is resolvable right now.
 *
 * @module @clue-harness/kb-face/test/embedding-catalog
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { buildEmbeddingCatalog, matchCandidate } from '../src/embedding-catalog.ts'
import { registerEmbeddingSettings } from '../src/embedding-config.ts'

/** A host with dsh's settings + credentials providers, plus a pi-ai section. */
async function host(t: { after(fn: () => unknown): void }): Promise<Context> {
  const home = await mkdtemp(path.join(tmpdir(), 'clue-catalog-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  ctx.plugin(FileSettingsProvider as never, { dshHome: home, watch: false } as never)
  ctx.plugin(CredentialsLocal as never, { dshHome: home, watch: false } as never)
  await new Promise((resolve) => setTimeout(resolve, 300))
  registerEmbeddingSettings(ctx)
  return ctx
}

test('目录: 已配置的 provider 带真实 baseURL 与该 provider 的密钥状态', async (t) => {
  const ctx = await host(t)
  // The pi-ai namespace is registered by its own plugin in a real composition;
  // here we stand in for it so the merge logic is exercised.
  const settings = ctx.get('settings') as unknown as {
    register(ns: unknown, schema: unknown, options?: unknown): void
  }
  const { default: z } = await import('@deepseek-ai/schemastery')
  const { settingsNamespace } = await import('@deepseek-ai/dsh-settings')
  settings.register(settingsNamespace('llm-pi-ai'), z.object({
    providers: z.dict(z.object({ apiKeyEnv: z.string().default(''), baseURL: z.string().default(''), models: z.array(z.object({ id: z.string() })).default([]) })),
  }), { base: { providers: {} } })
  await (ctx.get('settings') as unknown as { update(ns: unknown, patch: object): Promise<void> })
    .update(settingsNamespace('llm-pi-ai'), { providers: {
      ark: { apiKeyEnv: 'ARK_API_KEY', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', models: [{ id: 'x' }] },
      qwenapi: { apiKeyEnv: 'QWENAPI_API_KEY', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [{ id: 'y' }] },
    } })

  const catalog = await buildEmbeddingCatalog(ctx)
  const ark = catalog.groups.find((group) => group.route === 'ark')
  const qwenapi = catalog.groups.find((group) => group.route === 'qwenapi')
  assert.ok(ark !== undefined && qwenapi !== undefined)
  assert.equal(ark.baseUrl, 'https://ark.cn-beijing.volces.com/api/coding/v3', 'baseURL 必须来自用户配置,不是我们编的')
  assert.equal(ark.apiKeyEnv, 'ARK_API_KEY')
  assert.ok(ark.candidates.some((candidate) => candidate.model.includes('doubao-embedding')))
  assert.ok(qwenapi.candidates.some((candidate) => candidate.model === 'text-embedding-v3'))
  // 密钥没配 ⇒ 明确标注,且 ready=false(页面上的点该是红的)
  assert.equal(ark.keyState, 'missing')
  assert.equal(ark.keyReady, false)
  assert.match(ark.keyDetail, /ARK_API_KEY/)
  assert.equal(ark.keyDetail.includes('sk-'), false, '状态里绝不能出现值')
})

test('目录: DeepSeek 作为"不可用"列出并写明证据(别再试一次)', async (t) => {
  const ctx = await host(t)
  const catalog = await buildEmbeddingCatalog(ctx)
  const deepseek = catalog.groups.find((group) => group.route === 'deepseek-official')
  assert.ok(deepseek !== undefined)
  assert.equal(deepseek.keyReady, false)
  assert.equal(deepseek.candidates[0]?.usable, false)
  assert.match(deepseek.candidates[0]?.note ?? '', /404/)
})

test('目录: 本地选项无需密钥,且总是可选', async (t) => {
  const ctx = await host(t)
  const catalog = await buildEmbeddingCatalog(ctx)
  const local = catalog.groups.find((group) => group.route === 'local')
  assert.ok(local !== undefined)
  assert.equal(local.keyReady, true)
  assert.equal(local.apiKeyEnv, '')
  assert.ok(local.candidates.every((candidate) => candidate.usable))
})

test('selected: 存的就是目录里的那一项时才回填选中态', async (t) => {
  const ctx = await host(t)
  const catalog = await buildEmbeddingCatalog(ctx)
  const local = catalog.groups.find((group) => group.route === 'local')?.candidates[0]
  assert.ok(local !== undefined)
  assert.equal(matchCandidate(catalog, { baseUrl: local.baseUrl, model: local.model }), local.id)
  assert.equal(matchCandidate(catalog, { baseUrl: local.baseUrl, model: 'not-in-catalog' }), null)
  assert.equal(matchCandidate(catalog, { baseUrl: 'https://elsewhere.example/v1', model: local.model }), null)
})
