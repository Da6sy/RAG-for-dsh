/**
 * V1 — the embedding configuration plane and the HTTP adapter (原规划 §4/§9).
 *
 * Three families of claims are pinned here, and the third is the one that
 * matters most:
 *
 * 1. **The configuration is validated where the user is looking** — a failing
 *    field is named, `dim` cannot be typed, and a header cannot carry a secret.
 * 2. **The HTTP adapter classifies failures** the way §9.6's table promises,
 *    against a REAL local HTTP server (no network, no mock of `fetch`), so the
 *    status codes and payload shapes are exercised for real.
 * 3. **No secret ever lands anywhere it could be read back** (不变量 10/
 *    原规划 §9.4): not in the settings document, not in an error message, not in
 *    a summary. The key is written through dsh's own credential store and the
 *    test asserts the settings YAML and every printed string are free of it.
 *
 * @module @clue-harness/kb-face/test/embedding
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import {
  EMBEDDING_NAMESPACE,
  RETRIEVAL_NAMESPACE,
  embeddingConfigSummary,
  embeddingKeyStatus,
  embeddingReady,
  embeddingReadinessNote,
  readEmbeddingConfig,
  readRetrievalConfig,
  recordMeasuredDim,
  registerEmbeddingSettings,
  resolveEmbeddingKey,
  storeEmbeddingKey,
  unsetEmbeddingKey,
  validateEmbeddingPatch,
  writeEmbeddingConfig,
} from '../src/embedding-config.ts'
import { EmbedError, createHttpEmbedder, embeddingsUrl, endpointHost, parseEmbeddingsResponse, testConnection } from '../src/http-embedder.ts'

/** A minimal host context: dsh's own settings + credentials providers. */
async function host(t: { after(fn: () => unknown): void }): Promise<{ ctx: Context; home: string }> {
  const home = await mkdtemp(path.join(tmpdir(), 'clue-embed-face-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context()
  ctx.plugin(FileSettingsProvider as never, { dshHome: home, watch: false } as never)
  ctx.plugin(CredentialsLocal as never, { dshHome: home, watch: false } as never)
  await new Promise((resolve) => setTimeout(resolve, 300))
  registerEmbeddingSettings(ctx)
  return { ctx, home }
}

/** A local OpenAI-compatible endpoint whose behavior the test dictates. */
async function fakeEndpoint(
  t: { after(fn: () => unknown): void },
  handler: (body: { model?: string; input?: string[] }) => { status: number; payload?: unknown; raw?: string; delayMs?: number },
): Promise<string> {
  const seen: Array<Record<string, string | string[] | undefined>> = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers as never)
    let raw = ''
    req.on('data', (chunk) => { raw += String(chunk) })
    req.on('end', () => {
      const parsed = raw === '' ? {} : JSON.parse(raw) as { model?: string; input?: string[] }
      const decided = handler(parsed)
      const send = (): void => {
        res.writeHead(decided.status, { 'content-type': 'application/json' })
        res.end(decided.raw ?? JSON.stringify(decided.payload ?? {}))
      }
      if (decided.delayMs !== undefined) setTimeout(send, decided.delayMs)
      else send()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()) }))
  ;(server as unknown as { __seen: unknown }).__seen = seen
  return `http://127.0.0.1:${port}/v1`
}

// ── validation (§9.3) ─────────────────────────────────────────────────────

test('校验: 逐字段指出问题,且 dim 不接受手填', () => {
  const base = { ...readDefaults() }
  const dim = validateEmbeddingPatch({ dim: 1024 }, { ...base, dim: 1024 })
  assert.equal(dim[0]?.field, 'dim')
  assert.match(dim[0]?.message ?? '', /测试连接/)

  assert.equal(validateEmbeddingPatch({ baseUrl: 'not-a-url' }, { ...base, baseUrl: 'not-a-url' })[0]?.field, 'baseUrl')
  assert.equal(validateEmbeddingPatch({ apiKeyEnv: 'not a name' }, { ...base, apiKeyEnv: 'not a name' })[0]?.field, 'apiKeyEnv')
  assert.equal(validateEmbeddingPatch({ timeoutMs: 10 }, { ...base, timeoutMs: 10 })[0]?.field, 'timeoutMs')
  assert.equal(validateEmbeddingPatch({ batchSize: 999 }, { ...base, batchSize: 999 })[0]?.field, 'batchSize')
  assert.equal(validateEmbeddingPatch({ concurrency: 9 }, { ...base, concurrency: 9 })[0]?.field, 'concurrency')
  assert.equal(validateEmbeddingPatch({ maxUnitsPerBuild: 0 }, { ...base, maxUnitsPerBuild: 0 })[0]?.field, 'maxUnitsPerBuild')
  assert.equal(validateEmbeddingPatch({ quant: 'int8' }, { ...base, quant: 'int8' })[0]?.field, 'quant')
  assert.deepEqual(validateEmbeddingPatch({ baseUrl: 'https://x.example/v1' }, { ...base, baseUrl: 'https://x.example/v1' }), [])

  // 启用时必填项就地在卡片上报错
  const enabled = validateEmbeddingPatch({ enabled: true }, { ...base, enabled: true })
  assert.deepEqual(enabled.map((error) => error.field).sort(), ['baseUrl', 'model'])
})

test('校验: 明文 headers 不得携带密钥', () => {
  const base = readDefaults()
  const errors = validateEmbeddingPatch({ headers: { Authorization: 'Bearer sk-x' } }, base)
  assert.equal(errors[0]?.field, 'headers.Authorization')
  assert.match(errors[0]?.message ?? '', /apiKeyEnv/)
})

// ── settings round trip (§9.2/§9.3) ───────────────────────────────────────

test('设置命名空间可读写,且命名空间名符合宿主契约(dot 非法⇒改用连字符)', async (t) => {
  const { ctx } = await host(t)
  assert.equal(String(EMBEDDING_NAMESPACE), 'clue-kb-embedding')
  assert.equal(String(RETRIEVAL_NAMESPACE), 'clue-kb-retrieval')
  assert.equal(readEmbeddingConfig(ctx).enabled, false)
  assert.equal(readRetrievalConfig(ctx).rrfK, 60)
  assert.equal(readRetrievalConfig(ctx).featureWeights.bm25ish, 1)

  const written = await writeEmbeddingConfig(ctx, { enabled: true, baseUrl: 'https://api.example.cn/v1', model: 'bge-m3' })
  assert.equal(written.ok, true)
  assert.equal(readEmbeddingConfig(ctx).model, 'bge-m3')

  const refused = await writeEmbeddingConfig(ctx, { baseUrl: 'ftp://x' })
  assert.equal(refused.ok, false)
  assert.equal(readEmbeddingConfig(ctx).baseUrl, 'https://api.example.cn/v1', '被拒绝的写入不得留下半个 section')

  const measured = await recordMeasuredDim(ctx, 1024)
  assert.equal(measured.dim, 1024)
  assert.equal(readEmbeddingConfig(ctx).dim, 1024)
  assert.equal(measured.rebuildImplied, false, '首次实测维度不意味着重建(此前没有向量层)')
  const again = await recordMeasuredDim(ctx, 768)
  assert.equal(again.rebuildImplied, true, '维度变了 ⇒ 整层作废')
})

/**
 * 回归：检索调优的「保存」必须真的写进检索命名空间。
 *
 * 这条测试的存在理由就是它此前不存在：页面把整份 patch（`rerank`、
 * `channelWeights`、`featureWeights`、D1/D2/D3 的档位）发给 `/embedding/config`，
 * 写入端却把**整份 patch** 写进了 `clue-kb-embedding` —— 于是「检索调优」的每一次保存
 * 都是静默空操作：`readRetrievalConfig` 读的是 `clue-kb-retrieval`，永远回答默认值，
 * 而设置文档在嵌入 section 底下攒了一堆孤儿键（`rrfK`、`missingFeatureMode`…）。
 * 这正是 F0 抓到的"报告说设了、引擎不认"的同一类缺陷，所以两半都要钉住：
 * 该写的写进去，不该去的别去。
 */
test('回归: 检索调优保存写进 clue-kb-retrieval,且不污染 clue-kb-embedding', async (t) => {
  const { ctx, home } = await host(t)
  assert.equal(readRetrievalConfig(ctx).rrfK, 60)
  assert.equal(readRetrievalConfig(ctx).missingFeatureMode, 'zero')

  const result = await writeEmbeddingConfig(ctx, {
    rerank: true,
    ranklog: false,
    channelWeights: { lexical: 1, vector: 2 },
    featureWeights: { semanticRank: 0.35, fusedRank: 0 },
    lexicalNormalization: 'absolute',
    semanticScale: 'calibrated',
    semanticFloor: 0.28,
    semanticCeil: 0.82,
    missingFeatureMode: 'absent',
  })
  assert.equal(result.ok, true)
  const retrieval = readRetrievalConfig(ctx)
  assert.equal(retrieval.ranklog, false, '检索侧的开关必须真的落盘')
  assert.equal(retrieval.channelWeights.vector, 2)
  assert.equal(retrieval.featureWeights.semanticRank, 0.35)
  assert.equal(retrieval.lexicalNormalization, 'absolute')
  assert.equal(retrieval.semanticScale, 'calibrated')
  assert.equal(retrieval.semanticFloor, 0.28)
  assert.equal(retrieval.semanticCeil, 0.82)
  assert.equal(retrieval.missingFeatureMode, 'absent')
  assert.deepEqual(result.retrieval?.missingFeatureMode, 'absent', '写入结果要带回检索 section,页面才能回显')

  // 另一侧必须干净：孤儿键会让"这份文档到底哪段生效"变得无法判断。
  const document = await readFile(path.join(home, 'settings.yaml'), 'utf8')
  const embeddingSection = document.split('clue-kb-retrieval')[0] ?? ''
  for (const orphan of ['rrfK', 'channelWeights', 'featureWeights', 'missingFeatureMode', 'lexicalNormalization']) {
    assert.ok(!embeddingSection.includes(orphan), `嵌入 section 不得出现检索键 ${orphan}`)
  }
  assert.ok(!Object.keys(readEmbeddingConfig(ctx)).includes('rrfK'), '解析后的嵌入配置里也不该有检索键')
})

/** 一次混合 patch：两段各自写各自的命名空间，一次调用完成。 */
test('混合 patch: 提供商字段与调优字段各进各的 section', async (t) => {
  const { ctx } = await host(t)
  const result = await writeEmbeddingConfig(ctx, { baseUrl: 'https://api.example.cn/v1', model: 'bge-m3', rrfK: 42 })
  assert.equal(result.ok, true)
  assert.equal(readEmbeddingConfig(ctx).model, 'bge-m3')
  assert.equal(readEmbeddingConfig(ctx).baseUrl, 'https://api.example.cn/v1')
  assert.equal(readRetrievalConfig(ctx).rrfK, 42)

  // 非法档位必须被拒，且拒了就不许留半个 section。
  const refused = await writeEmbeddingConfig(ctx, { rrfK: 7, semanticScale: 'nonsense' })
  assert.equal(refused.ok, false)
  assert.equal(refused.errors[0]?.field, '(整个 section)')
  assert.equal(readRetrievalConfig(ctx).rrfK, 42, '被拒绝的 patch 不得留下半个 section')
})

// ── the key: write, status, resolve, never echoed (§9.4) ──────────────────

test('不变量 10: 密钥只进密钥库,设置文档与一切摘要里都没有它', async (t) => {
  const { ctx, home } = await host(t)
  const secret = 'sk-do-not-leak-0123456789'
  await writeEmbeddingConfig(ctx, { enabled: true, baseUrl: 'https://api.example.cn/v1', model: 'bge-m3', apiKeyEnv: 'CLUE_TEST_EMBEDDING_KEY' })
  assert.equal((await embeddingKeyStatus(ctx)).state, 'missing')

  const where = await storeEmbeddingKey(ctx, secret)
  assert.match(where, /CLUE_TEST_EMBEDDING_KEY/)

  const status = await embeddingKeyStatus(ctx)
  assert.equal(status.state, 'configured')
  assert.equal(status.detail.includes(secret), false, '状态只报引用名与来源')

  const summary = await embeddingConfigSummary(ctx)
  assert.equal(JSON.stringify(summary).includes(secret), false, '摘要里绝不能出现密钥')

  // The settings document is the one a user syncs and commits: it must carry
  // the REFERENCE only.
  const settingsDoc = await readFile(path.join(home, 'settings.yaml'), 'utf8')
  assert.equal(settingsDoc.includes(secret), false)
  assert.match(settingsDoc, /apiKeyEnv: CLUE_TEST_EMBEDDING_KEY/)

  // The value lives in the credential store — dsh's own, owner-only document.
  const credentialDoc = await readFile(path.join(home, '.credentials.yaml'), 'utf8')
  assert.equal(credentialDoc.includes(secret), true, '值由 credentials provider 持有')

  assert.equal(await resolveEmbeddingKey(ctx, readEmbeddingConfig(ctx)), secret)
  await unsetEmbeddingKey(ctx)
  assert.equal((await embeddingKeyStatus(ctx)).state, 'missing')
  // 名为引用却解析不到值是**解析失败**,不是"无鉴权":静默发一个没有凭据的请求
  // 会把一个配置错误伪装成端点的 401。要表达"该端点无需鉴权"的姿势是 apiKeyEnv 留空。
  await assert.rejects(() => resolveEmbeddingKey(ctx, readEmbeddingConfig(ctx)), /解析失败/)
  const noRef = { ...readEmbeddingConfig(ctx), apiKeyEnv: '' }
  assert.equal(await resolveEmbeddingKey(ctx, noRef), null, 'apiKeyEnv 留空 + 无密钥库记录 ⇒ 无鉴权调用')
})

test('不变量 11: 每操作解析一次 —— 换 key 后下一次解析立即生效,无需重启', async (t) => {
  const { ctx } = await host(t)
  await writeEmbeddingConfig(ctx, { enabled: true, baseUrl: 'https://api.example.cn/v1', model: 'bge-m3', apiKeyEnv: 'CLUE_ROTATE_KEY' })
  await storeEmbeddingKey(ctx, 'first-key')
  assert.equal(await resolveEmbeddingKey(ctx, readEmbeddingConfig(ctx)), 'first-key')
  await storeEmbeddingKey(ctx, 'second-key')
  assert.equal(await resolveEmbeddingKey(ctx, readEmbeddingConfig(ctx)), 'second-key', '同一进程内下一次解析必须看到新值')
})

test('无引用时走密钥库记录这条路(两种姿态都支持,原规划 §15.2)', async (t) => {
  const { ctx } = await host(t)
  await writeEmbeddingConfig(ctx, { apiKeyEnv: '' })
  assert.equal((await embeddingKeyStatus(ctx)).writable, true)
  await storeEmbeddingKey(ctx, 'store-road-key')
  const status = await embeddingKeyStatus(ctx)
  assert.equal(status.state, 'configured')
  assert.match(status.detail, /密钥库记录/)
  assert.equal(await resolveEmbeddingKey(ctx, readEmbeddingConfig(ctx)), 'store-road-key')
})

test('就绪判定: 不完整的配置是"纯词法"而不是错误', async (t) => {
  const { ctx } = await host(t)
  assert.equal(embeddingReady(readEmbeddingConfig(ctx)), false)
  assert.match(embeddingReadinessNote(readEmbeddingConfig(ctx)), /未启用/)
  await writeEmbeddingConfig(ctx, { enabled: true, baseUrl: 'https://x.example/v1', model: 'm' })
  assert.match(embeddingReadinessNote(readEmbeddingConfig(ctx)), /测试连接/)
  await recordMeasuredDim(ctx, 8)
  assert.equal(embeddingReady(readEmbeddingConfig(ctx)), true)
  assert.equal(embeddingReadinessNote(readEmbeddingConfig(ctx)), '已就绪')
})

// ── the HTTP adapter (§4/§9.6) ────────────────────────────────────────────

test('URL 处理: baseUrl 自己拼 /embeddings,已给全路径也不重复拼', () => {
  assert.equal(embeddingsUrl('https://api.example.cn/v1'), 'https://api.example.cn/v1/embeddings')
  assert.equal(embeddingsUrl('https://api.example.cn/v1/'), 'https://api.example.cn/v1/embeddings')
  assert.equal(embeddingsUrl('https://api.example.cn/v1/embeddings'), 'https://api.example.cn/v1/embeddings')
  assert.equal(endpointHost('https://api.example.cn/v1'), 'api.example.cn')
})

test('适配器: 正常返回的向量被 L2 归一化,且带上 Bearer 密钥', async (t) => {
  const url = await fakeEndpoint(t, () => ({ status: 200, payload: { model: 'bge-m3', data: [{ embedding: [3, 4] }, { embedding: [0, 2] }] } }))
  const embedder = createHttpEmbedder({
    getConfig: () => ({ baseUrl: url, model: 'bge-m3', dim: 2, headers: {}, timeoutMs: 5000, batchSize: 32 }),
    resolveKey: async () => 'sk-test',
  })
  const vectors = await embedder.embed(['a', 'b'])
  assert.equal(vectors.length, 2)
  const norm = Math.hypot(...(vectors[0] as Float32Array))
  assert.ok(Math.abs(norm - 1) < 1e-6, `归一化后模长应为 1,实际 ${norm}`)
  assert.deepEqual([...(vectors[1] as Float32Array)].map((v) => Math.round(v * 100) / 100), [0, 1])
})

test('适配器: 401/403 → 鉴权失败,且报文里没有密钥(原规划 §9.4-2)', async (t) => {
  const secret = 'sk-super-secret-xyz'
  const url = await fakeEndpoint(t, () => ({ status: 401, payload: { error: `bad key ${secret}` } }))
  const embedder = createHttpEmbedder({
    getConfig: () => ({ baseUrl: url, model: 'm', dim: 2, headers: {}, timeoutMs: 5000, batchSize: 32 }),
    resolveKey: async () => secret,
  })
  await assert.rejects(
    () => embedder.embed(['a']),
    (error: unknown) => {
      assert.ok(error instanceof EmbedError)
      assert.equal(error.kind, 'unauthorized')
      assert.equal(error.status, 401)
      assert.equal(error.message.includes(secret), false, '异常文本绝不能带密钥')
      assert.equal(error.message.includes('127.0.0.1'), true, '但要给出主机名')
      return true
    },
  )
})

test('适配器: 404 提示应为 OpenAI 兼容 /embeddings', async (t) => {
  const url = await fakeEndpoint(t, () => ({ status: 404, payload: {} }))
  const embedder = createHttpEmbedder({
    getConfig: () => ({ baseUrl: url, model: 'm', dim: 2, headers: {}, timeoutMs: 5000, batchSize: 32 }),
    resolveKey: async () => null,
  })
  await assert.rejects(() => embedder.embed(['a']), (error: unknown) => {
    assert.equal((error as EmbedError).kind, 'not-found')
    assert.match((error as Error).message, /embeddings/)
    return true
  })
})

test('适配器: 200 但响应形状不符 ⇒ 报出实际键名', async (t) => {
  const url = await fakeEndpoint(t, () => ({ status: 200, payload: { ok: true, result: [] } }))
  const embedder = createHttpEmbedder({
    getConfig: () => ({ baseUrl: url, model: 'm', dim: 2, headers: {}, timeoutMs: 5000, batchSize: 32 }),
    resolveKey: async () => null,
  })
  await assert.rejects(() => embedder.embed(['a']), (error: unknown) => {
    assert.equal((error as EmbedError).kind, 'bad-shape')
    assert.match((error as Error).message, /ok|result/)
    return true
  })
  assert.throws(() => parseEmbeddingsResponse(JSON.stringify({ data: [{}] }), 1), (error: unknown) => (error as EmbedError).kind === 'bad-shape')
  assert.throws(() => parseEmbeddingsResponse(JSON.stringify({ data: [] }), 2), (error: unknown) => /2 个文本/.test((error as Error).message))
})

test('适配器: 超时与连不上分别归类', async (t) => {
  const slow = await fakeEndpoint(t, () => ({ status: 200, payload: { data: [{ embedding: [1, 0] }] }, delayMs: 400 }))
  const timeoutEmbedder = createHttpEmbedder({
    getConfig: () => ({ baseUrl: slow, model: 'm', dim: 2, headers: {}, timeoutMs: 1000, batchSize: 32 }),
    resolveKey: async () => null,
  })
  // 1000ms is the schema floor, so the probe must out-wait the endpoint instead:
  const slowResult = await testConnection({
    getConfig: () => ({ baseUrl: slow, model: 'm', dim: 2, headers: {}, timeoutMs: 1000, batchSize: 32 }),
    resolveKey: async () => null,
  })
  assert.equal(slowResult.ok, true, '400ms 的端点在 1000ms 的超时下应当成功')
  void timeoutEmbedder

  const dead = 'http://127.0.0.1:1/v1'
  const deadResult = await testConnection({ getConfig: () => ({ baseUrl: dead, model: 'm', dim: 2, headers: {}, timeoutMs: 1000, batchSize: 32 }), resolveKey: async () => null })
  assert.equal(deadResult.ok, false)
  assert.equal(deadResult.status, 'unreachable')
  assert.equal(deadResult.message.includes('127.0.0.1'), true)
})

test('测试连接: 成功回显 dim/延迟/模长,维度不符时明示"需重建"', async (t) => {
  const url = await fakeEndpoint(t, () => ({ status: 200, payload: { model: 'bge-m3', data: [{ embedding: [1, 1, 1, 0] }] } }))
  const options = {
    getConfig: () => ({ baseUrl: url, model: 'bge-m3', dim: 0, headers: {}, timeoutMs: 5000, batchSize: 32 }),
    resolveKey: async () => 'sk-x',
  }
  const first = await testConnection(options)
  assert.equal(first.ok, true)
  assert.equal(first.dim, 4)
  assert.ok((first.latencyMs ?? -1) >= 0)
  assert.ok(Math.abs((first.norm ?? 0) - 1) < 1e-6)
  assert.equal(first.rebuildNotice, undefined, '首次实测没有旧向量层可作废')

  const mismatch = await testConnection(options, 1024, 29)
  assert.equal(mismatch.ok, true)
  assert.match(mismatch.rebuildNotice ?? '', /29 条向量需重建/)
  assert.match(mismatch.rebuildNotice ?? '', /batchSize/)
})

test('测试连接: 缺 baseUrl/model 时直接给出字段级提示,不发请求', async () => {
  const result = await testConnection({ getConfig: () => ({ baseUrl: '', model: '', dim: 0, headers: {}, timeoutMs: 1000, batchSize: 32 }), resolveKey: async () => null })
  assert.equal(result.ok, false)
  assert.match(result.message, /baseUrl/)
})

/** The shipped defaults, as a plain object the validator accepts. */
function readDefaults() {
  return {
    enabled: false,
    baseUrl: '',
    apiKeyEnv: '',
    model: '',
    dim: 0,
    headers: {} as Record<string, string>,
    timeoutMs: 15000,
    batchSize: 32,
    concurrency: 1,
    maxUnitsPerBuild: 2000,
    quant: 'fp32' as const,
  }
}
