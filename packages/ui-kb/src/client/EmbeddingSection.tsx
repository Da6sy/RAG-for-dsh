/**
 * The「知识检索与向量」page (V1, 规划 §9.5) — the third ClueHarness settings
 * section, and the only place a secret can be entered.
 *
 * The plan's page structure, in its order: 提供者 → 索引与成本 → 检索调优 →
 * 诊断. Four product rules from §9 are implemented here rather than described:
 *
 * 1. **The key is write-only.** The field is a password input that stores and
 *    then CLEARS itself; the page renders 已配置 / 未配置 / 解析失败 plus the
 *    reference name, and there is no read path that could show a value (§9.4-3).
 * 2. **A failed save names the field** (§9.2): the host answers with one entry
 *    per failing field, and each one renders under its own input — the
 *    "保存失败" that names nothing is the failure mode this prevents.
 * 3. **`dim` is not an input.** It is displayed read-only and written only by
 *    「测试连接」, because a hand-typed dimension poisons the version stamp and
 *    every cosine after it (§15.3).
 * 4. **Destructive actions confirm** (§9.4-5): rebuilding the vector layer,
 *    clearing the cache and clearing the key each ask first and state the
 *    consequence — the plan's "说明后果" is copy, not a modal for its own sake.
 *
 * Degradation is a first-class state, not an error: an unconfigured or
 * unmeasured provider renders the setup card with the honest reason
 * ("检索只走词法通道"), because that IS the current behavior of the product.
 *
 * @module @clue-harness/ui-kb/client/EmbeddingSection
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, DisclosureRow, Input, Pill, RiskConfirmation, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  describeKbError, kbApi,
  type ConnectionTestPayload, type EmbeddingCatalogPayload, type EmbeddingConfigPayload,
  type VectorIndexPayload,
} from './api.ts'

/**
 * One editable non-secret field on the provider card.
 *
 * `model` is NOT in this list any more: it is chosen from the picker below,
 * because a hand-typed model id together with a hand-typed base URL is exactly
 * how a 404 that looks like a broken endpoint happens.
 */
interface FieldSpec {
  key: 'baseUrl' | 'apiKeyEnv'
  label: string
  placeholder: string
  hint: string
}

const FIELDS: FieldSpec[] = [
  { key: 'baseUrl', label: 'Base URL', placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hint: '必填;适配器自己拼 /embeddings' },
  { key: 'apiKeyEnv', label: '密钥引用', placeholder: 'DASHSCOPE_API_KEY', hint: '环境变量名(引用,不是值);留空则走密钥库记录' },
]

/** The numeric knobs of the 索引与成本 block. */
const NUMBERS: Array<{ key: 'batchSize' | 'concurrency' | 'timeoutMs' | 'maxUnitsPerBuild'; label: string; hint: string }> = [
  { key: 'batchSize', label: '批量大小', hint: '1–256;每个请求合并多少条文本' },
  { key: 'concurrency', label: '并发', hint: '1–4;建索引时的并发请求数' },
  { key: 'timeoutMs', label: '超时(ms)', hint: '1000–120000' },
  { key: 'maxUnitsPerBuild', label: '单次预算', hint: '一次建索引最多嵌入多少条(超限即停并标注)' },
]

/** Format an instant compactly. */
function when(iso: string | null): string {
  if (iso === null || iso === '') return '(无)'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** The key state as a pill (§9.4-3: three states, never a value). */
function KeyPill({ status }: { status: EmbeddingConfigPayload['key'] }): JSX.Element {
  // dsh's own status vocabulary: a StateDot for the state, a Pill for the label.
  const dot = status.state === 'configured' ? 'done' : status.state === 'missing' ? 'warning' : 'error'
  const label = status.state === 'configured' ? '密钥已配置' : status.state === 'missing' ? '密钥未配置' : '密钥不可用'
  return (
    <span className="clue-field-inline" title={status.detail}>
      <StateDot state={dot} />
      <Pill>{label}</Pill>
    </span>
  )
}

/** One derived index's row. */
function IndexRow({ index }: { index: VectorIndexPayload }): JSX.Element {
  const notes: string[] = []
  if (index.stale) notes.push('版本过期 ⇒ 下次使用会重建')
  if (index.unreadable) notes.push('文件缺失/长度不符 ⇒ 会重建')
  if (index.missing > 0) notes.push(`partial:缺 ${index.missing} 条`)
  const state = notes.length === 0 ? 'ok' : 'warn'
  return (
    <div className="clue-row" style={{ cursor: 'default' }}>
      <span className="clue-field-inline"><StateDot state={state === 'ok' ? 'done' : 'warning'} /><Pill>{state === 'ok' ? '可用' : '需处理'}</Pill></span>
      <span className="clue-card-title">{index.tier === 'project' ? '项目库' : '全局库'} · {index.stem}</span>
      <span className="clue-dim">{index.count} 行 × {index.dim} 维 · 建于 {when(index.builtAt)}</span>
      {notes.length > 0 && <span className="clue-cite-annot">{notes.join(' · ')}</span>}
    </div>
  )
}

/**
 * Render the embedding settings page.
 * @returns the section.
 */
export function EmbeddingSection(): JSX.Element {
  const [data, setData] = useState<EmbeddingConfigPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * ONE draft per CARD (module), not per field: the page's rule is "一个模块一个保存",
   * so a card's fields are edited together and written by one revision-fenced patch.
   */
  const [providerDraft, setProviderDraft] = useState({ enabled: false, baseUrl: '', model: '', apiKeyEnv: '' })
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({})
  const [tuningDraft, setTuningDraft] = useState<{
    rerank: boolean
    ranklog: boolean
    llmRerank: boolean
    lexical: string
    vector: string
    weights: Record<string, string>
    /** D1: `bm25ish` 的尺度档位 —— `candidates`(旧) | `absolute`(新,A/B 通过后才翻默认)。 */
    lexicalNormalization: string
    /** D2: 语义尺度档位 + 标定上下界。 */
    semanticScale: string
    semanticFloor: string
    semanticCeil: string
    /** D3: 缺失值的语义档位。 */
    missingFeatureMode: string
    /** F4②: 词频口径(presence 是今天,count 是真词频)。 */
    termFrequency: string
    /** F4①: 标识符子词切分(默认关)。 */
    identifierSubtokens: boolean
    /** F2: 向量独有候选配额(0 = 不限)。 */
    maxVectorOnly: string
    /** F3: 通道权重的含义。 */
    channelWeightMode: string
  }>({
    rerank: true, ranklog: true, llmRerank: false, lexical: '1', vector: '1', weights: {},
    lexicalNormalization: 'auto', semanticScale: 'auto', semanticFloor: '0.3', semanticCeil: '0.8', missingFeatureMode: 'zero', termFrequency: 'presence', identifierSubtokens: false,
    maxVectorOnly: '0', channelWeightMode: 'fusion',
  })
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [keyInput, setKeyInput] = useState('')
  const [probe, setProbe] = useState<ConnectionTestPayload | null>(null)
  // V1 follow-up: the embedder picker's options (configured providers + built-ins).
  const [catalog, setCatalog] = useState<EmbeddingCatalogPayload | null>(null)
  const [selectedCandidate, setSelectedCandidate] = useState<string | null>(null)
  const [weightsOpen, setWeightsOpen] = useState(false)
  // D1/D2/D3: the scale switches live in their own disclosure so the card's top
  // row stays "the four things you actually flip day to day".
  const [scalesOpen, setScalesOpen] = useState(false)
  /** V1-UI: the pending destructive act (dsh's RiskConfirmation gates it). */
  const [risk, setRisk] = useState<{ kind: 'build' | 'cache' | 'key'; title: string; description: string; acknowledge: string; action: string } | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const payload = await kbApi.embedding()
      setData(payload)
      setProviderDraft({
        enabled: payload.config.enabled,
        baseUrl: payload.config.baseUrl,
        model: payload.config.model,
        apiKeyEnv: payload.config.apiKeyEnv,
      })
      setTuningDraft({
        rerank: payload.retrieval.rerank,
        ranklog: payload.retrieval.ranklog,
        llmRerank: payload.retrieval.llmRerank,
        lexical: String(payload.retrieval.channelWeights.lexical),
        vector: String(payload.retrieval.channelWeights.vector),
        weights: Object.fromEntries(Object.entries(payload.retrieval.featureWeights).map(([name, value]) => [name, String(value)])),
        lexicalNormalization: payload.retrieval.lexicalNormalization,
        semanticScale: payload.retrieval.semanticScale,
        semanticFloor: String(payload.retrieval.semanticFloor),
        semanticCeil: String(payload.retrieval.semanticCeil),
        missingFeatureMode: payload.retrieval.missingFeatureMode,
        termFrequency: payload.retrieval.termFrequency,
        identifierSubtokens: payload.retrieval.identifierSubtokens,
        maxVectorOnly: String(payload.retrieval.maxVectorOnly),
        channelWeightMode: payload.retrieval.channelWeightMode,
      })
      setBudgetDraft({
        batchSize: String(payload.config.batchSize),
        concurrency: String(payload.config.concurrency),
        timeoutMs: String(payload.config.timeoutMs),
        maxUnitsPerBuild: String(payload.config.maxUnitsPerBuild),
      })
      setError(null)
      // The catalog is a separate read: a failure to enumerate providers must
      // not blank the whole page (the manual fields still work).
      try {
        const options = await kbApi.embeddingCandidates()
        setCatalog(options)
        setSelectedCandidate(options.selected)
      } catch {
        setCatalog(null)
      }
    } catch (cause) {
      setError(describeKbError(cause))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  /** Run one mutation with the shared busy/notice/refresh discipline. */
  const act = useCallback(async (label: string, work: () => Promise<string | null>): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const message = await work()
      if (message !== null) setNotice(message)
      await load()
    } catch (cause) {
      setError(describeKbError(cause))
    } finally {
      setBusy(false)
      setRisk(null)
      setAcknowledged(false)
    }
  }, [load])

  /**
   * Save ONE card. The revision must come from the section being written: the
   * page writes provider fields into `clue-kb-embedding` and tuning fields into
   * `clue-kb-retrieval`, and dsh's revision fence is per section.
   */
  const save = useCallback(async (patch: Record<string, unknown>, section: 'embedding' | 'retrieval' = 'embedding'): Promise<void> => {
    await act('保存', async () => {
      const result = await kbApi.embeddingSet(patch, data?.revisions[section === 'retrieval' ? 'clue-kb-retrieval' : 'clue-kb-embedding'])
      if (!result.ok) {
        // The refusal NAMES the field (§9.2). It is rendered under its own
        // input, not as a page-level "保存失败".
        setFieldErrors(Object.fromEntries(result.errors.map((entry) => [entry.field, entry.message])))
        return null
      }
      setFieldErrors({})
      return '已保存。'
    })
  }, [act, data])

  /** Which candidate the stored configuration matches, if any. */
  const selectedGroup = catalog?.groups.find((group) => group.candidates.some((candidate) => candidate.id === selectedCandidate))
  const selectedCandidateNote = (() => {
    for (const group of catalog?.groups ?? []) {
      const hit = group.candidates.find((candidate) => candidate.id === selectedCandidate)
      if (hit === undefined) continue
      return `${hit.note ?? ''}${hit.note === undefined ? '' : ' · '}${group.keyDetail}`
    }
    return null
  })()

  /**
   * Apply one catalog entry: baseUrl + model + key reference travel TOGETHER.
   * They have to: a model id from provider A against provider B's address is a
   * 404 that reads like a broken endpoint, and a key reference from a third
   * place is a 401 that reads like a bad key.
   */
  const applyCandidate = useCallback(async (id: string): Promise<void> => {
    setSelectedCandidate(id === '' ? null : id)
    if (id === '') return
    for (const group of catalog?.groups ?? []) {
      const hit = group.candidates.find((candidate) => candidate.id === id)
      if (hit === undefined) continue
      if (!hit.usable) {
        setNotice(hit.note ?? '该来源不可用于向量层。')
        return
      }
      // The picker fills the CARD's draft (baseUrl + model + key reference
      // together, because a mismatched triple is a 404 that looks like a broken
      // endpoint); the card's 保存 is what writes it.
      setProviderDraft({ enabled: true, baseUrl: hit.baseUrl, model: hit.model, apiKeyEnv: hit.apiKeyEnv })
      setFieldErrors({})
      setNotice(`已填入 ${hit.model};点「保存」写入。`)
      return
    }
  }, [catalog])


  if (error !== null && data === null) {
    return (
      <div className="clue-sec">
        <div className="clue-empty">读取嵌入配置失败:{error}</div>
      </div>
    )
  }
  if (data === null) return <div className="clue-sec"><div className="clue-empty">载入中…</div></div>

  const { config, retrieval, vector } = data
  const totalRows = vector.indexes.reduce((sum, index) => sum + index.count, 0)
  /** Whether each card's draft differs from what is stored (enables its 保存). */
  const providerDirty = providerDraft.enabled !== config.enabled
    || providerDraft.baseUrl !== config.baseUrl
    || providerDraft.model !== config.model
    || providerDraft.apiKeyEnv !== config.apiKeyEnv
  const budgetDirty = ['batchSize', 'concurrency', 'timeoutMs', 'maxUnitsPerBuild'].some((key) => budgetDraft[key] !== undefined && Number(budgetDraft[key]) !== (config as unknown as Record<string, number>)[key])
  const tuningDirty = tuningDraft.rerank !== retrieval.rerank
    || tuningDraft.ranklog !== retrieval.ranklog
    || tuningDraft.llmRerank !== retrieval.llmRerank
    || Number(tuningDraft.lexical) !== retrieval.channelWeights.lexical
    || Number(tuningDraft.vector) !== retrieval.channelWeights.vector
    || Object.entries(tuningDraft.weights).some(([name, value]) => Number(value) !== retrieval.featureWeights[name])
    || tuningDraft.lexicalNormalization !== retrieval.lexicalNormalization
    || tuningDraft.semanticScale !== retrieval.semanticScale
    || Number(tuningDraft.semanticFloor) !== retrieval.semanticFloor
    || Number(tuningDraft.semanticCeil) !== retrieval.semanticCeil
    || tuningDraft.missingFeatureMode !== retrieval.missingFeatureMode
    || tuningDraft.termFrequency !== retrieval.termFrequency
    || tuningDraft.identifierSubtokens !== retrieval.identifierSubtokens
    || Number(tuningDraft.maxVectorOnly) !== retrieval.maxVectorOnly
    || tuningDraft.channelWeightMode !== retrieval.channelWeightMode

  const staleCount = vector.indexes.filter((index) => index.stale || index.unreadable).length

  return (
    <div className="clue-sec">
      <div className="clue-heading">
        <h2 className="clue-sec-title">知识检索与向量</h2>
        <p className="clue-sec-intro">
          词法与向量并联召回 → RRF 融合 → 确定性特征精排。向量层是派生索引(删了能重建);
          相似度只解释"为什么排这",状态才解释"能不能信"。
          {totalRows > 0 && <span className="clue-dim"> · 当前 {totalRows} 行向量</span>}
        </p>
      </div>

      {!data.available && (
        <div className="clue-notice">
          宿主没有挂载设置/凭据服务 ⇒ 本页只能读默认值,无法保存。用 <code>clue kb embed-config</code> 系列命令配置。
        </div>
      )}
      {notice !== null && <div className="clue-notice">{notice}</div>}
      {error !== null && <div className="clue-err">{error}</div>}

      {/* ── 提供者 ─────────────────────────────────────────────────────── */}
      <div className="clue-card">
        <div className="clue-card-head">
          <span className="clue-card-title">提供者</span>
          <KeyPill status={data.key} />
          <Pill>{data.note}</Pill>
          <span className="clue-spacer" />
          <label className="clue-field-inline">
            <span className="clue-field-label">启用</span>
            <input
              type="checkbox"
              checked={providerDraft.enabled}
              disabled={busy || !data.available}
              onChange={(event) => setProviderDraft((previous) => ({ ...previous, enabled: event.target.checked }))}
            />
          </label>
        </div>

        <div className="clue-field">
          <span className="clue-field-label">模型</span>
          <select
            className="clue-select"
            value={selectedCandidate ?? ''}
            disabled={busy || !data.available}
            onChange={(event) => { void applyCandidate(event.target.value) }}
          >
            <option value="">{config.model === '' ? '选择嵌入模型' : `当前: ${config.model}`}</option>
            {catalog?.groups.map((group) => (
              <optgroup key={group.route} label={`${group.label} · 密钥${group.keyState === 'configured' ? '已配置' : '未配置'}`}>
                {group.candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id} disabled={!candidate.usable}>
                    {candidate.label}{candidate.usable ? '' : '(不可用)'}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="clue-field">
          <span className="clue-field-label">Base URL</span>
          <Input
            className="clue-input"
            value={providerDraft.baseUrl}
            placeholder="https://…/v1"
            disabled={busy || !data.available}
            onChange={(event: { target: { value: string } }) => setProviderDraft((previous) => ({ ...previous, baseUrl: event.target.value }))}
          />
          {fieldErrors.baseUrl !== undefined && <span className="clue-err">{fieldErrors.baseUrl}</span>}
        </div>

        <div className="clue-field">
          <span className="clue-field-label">密钥引用</span>
          <Input
            className="clue-input"
            value={providerDraft.apiKeyEnv}
            placeholder="DASHSCOPE_API_KEY"
            disabled={busy || !data.available}
            onChange={(event: { target: { value: string } }) => setProviderDraft((previous) => ({ ...previous, apiKeyEnv: event.target.value }))}
          />
          <span className="clue-dim">环境变量名;留空走密钥库 · {data.key.detail}</span>
          {fieldErrors.apiKeyEnv !== undefined && <span className="clue-err">{fieldErrors.apiKeyEnv}</span>}
        </div>

        <div className="clue-field">
          <span className="clue-field-label">API Key</span>
          <div className="clue-field-inline" style={{ gap: 8 }}>
            <Input
              className="clue-input"
              type="password"
              value={keyInput}
              placeholder={data.key.state === 'configured' ? '已配置' : '粘贴密钥值'}
              disabled={busy || !data.available || !data.key.writable}
              onChange={(event: { target: { value: string } }) => setKeyInput(event.target.value)}
            />
            <Button
              disabled={busy || !data.available || keyInput.trim() === '' || !data.key.writable}
              onClick={() => {
                const value = keyInput
                void act('写入密钥', async () => {
                  const result = await kbApi.embeddingKey(value)
                  setKeyInput('')
                  return `已写入 ${result.stored}`
                })
              }}
            >
              设置密钥
            </Button>
            {data.key.state === 'configured' && data.key.writable && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setRisk({
                  kind: 'key',
                  title: '清除嵌入密钥',
                  description: '向量层与已建索引都保留,只是后续嵌入会因解析不到密钥而退回纯词法(并被如实标注)。要用回需重新写入密钥。',
                  acknowledge: '我明白后续嵌入会退回纯词法',
                  action: '清除密钥',
                })}
              >
                清除密钥
              </Button>
            )}
          </div>
        </div>

        <div className="clue-field">
          <span className="clue-field-label">维度 dim</span>
          <span className="clue-field-inline">
            <Pill>{config.dim > 0 ? `${config.dim}(实测)` : '未实测'}</Pill>
            <span className="clue-dim">由「测试连接」实测写入</span>
          </span>
        </div>

        {probe?.rebuildNotice !== undefined && <div className="clue-notice">{probe.rebuildNotice}</div>}
        {probe !== null && (
          <div className={probe.ok ? 'clue-dim' : 'clue-err'}>
            {probe.ok ? `${probe.dim} 维 · ${probe.latencyMs}ms · 模长 ${(probe.norm ?? 0).toFixed(4)}` : probe.message}
          </div>
        )}
        {fieldErrors['(整个 section)'] !== undefined && <div className="clue-err">{fieldErrors['(整个 section)']}</div>}

        <div className="clue-card-actions">
          <Button
            disabled={busy || !data.available}
            onClick={() => {
              void act('自动检测', async () => {
                const result = await kbApi.embeddingAuto(false)
                setProbe(null)
                return result.summary
              })
            }}
          >
            自动检测并启用
          </Button>
          <Button
            variant="outline"
            disabled={busy || !data.available}
            onClick={() => {
              void act('测试连接', async () => {
                const result = await kbApi.embeddingTest(true)
                setProbe(result)
                return null
              })
            }}
          >
            测试连接
          </Button>
          <span className="clue-spacer" />
          <Button
            variant="primary"
            disabled={busy || !data.available || !providerDirty}
            onClick={() => {
              void save({
                enabled: providerDraft.enabled,
                baseUrl: providerDraft.baseUrl,
                model: providerDraft.model,
                apiKeyEnv: providerDraft.apiKeyEnv,
              })
            }}
          >
            保存
          </Button>
        </div>
      </div>

      {/* ── 索引与成本 ─────────────────────────────────────────────────── */}
      <div className="clue-card">
        <div className="clue-card-head">
          <span className="clue-card-title">索引与成本</span>
          <span className="clue-dim">
            缓存 {vector.cachedVectors} · 索引 {vector.indexes.length} · 过期 {staleCount}
          </span>
        </div>
        <div className="clue-grid-2">
          {NUMBERS.map((field) => (
            <div key={field.key} className="clue-field">
              <span className="clue-field-label">{field.label}</span>
              <Input
                className="clue-input"
                value={budgetDraft[field.key] ?? ''}
                disabled={busy || !data.available}
                onChange={(event: { target: { value: string } }) => setBudgetDraft((previous) => ({ ...previous, [field.key]: event.target.value }))}
              />
              {fieldErrors[field.key] !== undefined && <span className="clue-err">{fieldErrors[field.key]}</span>}
            </div>
          ))}
        </div>
        <div className="clue-dim">量化 {config.quant}(int8 需评测通过)</div>

        <div className="clue-list">
          {vector.indexes.length === 0
            ? <div className="clue-empty">向量层尚未建立</div>
            : vector.indexes.map((index) => <IndexRow key={`${index.tier}:${index.stem}`} index={index} />)}
        </div>

        <div className="clue-card-actions">
          <span className="clue-spacer" />
          <Button
            variant="primary"
            disabled={busy || !data.available || !budgetDirty}
            onClick={() => {
              void save({
                batchSize: Number(budgetDraft.batchSize),
                concurrency: Number(budgetDraft.concurrency),
                timeoutMs: Number(budgetDraft.timeoutMs),
                maxUnitsPerBuild: Number(budgetDraft.maxUnitsPerBuild),
              })
            }}
          >
            保存
          </Button>
        </div>
      </div>

      {/* ── 检索调优 ───────────────────────────────────────────────────── */}
      <div className="clue-card">
        <div className="clue-card-head">
          <span className="clue-card-title">检索调优</span>
          <span className="clue-dim">融合 {retrieval.fusion} · k={retrieval.rrfK} · 召回 {retrieval.recallDepth} · 候选 {retrieval.rerankCandidates}</span>
        </div>
        <div className="clue-grid-2">
          <label className="clue-field-inline">
            <input
              type="checkbox"
              checked={tuningDraft.rerank}
              disabled={busy || !data.available}
              onChange={(event) => setTuningDraft((previous) => ({ ...previous, rerank: event.target.checked }))}
            />
            <span className="clue-field-label">精排</span>
          </label>
          <label className="clue-field-inline">
            <input
              type="checkbox"
              checked={tuningDraft.ranklog}
              disabled={busy || !data.available}
              onChange={(event) => setTuningDraft((previous) => ({ ...previous, ranklog: event.target.checked }))}
            />
            <span className="clue-field-label">ranklog</span>
          </label>
          <label className="clue-field-inline" title={`模型重排使用 ${catalog?.chat === null || catalog?.chat === undefined ? '(未读到默认对话模型)' : `${catalog.chat.provider}/${catalog.chat.model}`}`}>
            <input
              type="checkbox"
              checked={tuningDraft.llmRerank}
              disabled={busy || !data.available}
              onChange={(event) => setTuningDraft((previous) => ({ ...previous, llmRerank: event.target.checked }))}
            />
            <span className="clue-field-label">模型重排</span>
          </label>
        </div>
        <div className="clue-grid-2">
          <div className="clue-field">
            <span className="clue-field-label">词法权重</span>
            <Input
              className="clue-input"
              value={tuningDraft.lexical}
              disabled={busy || !data.available}
              onChange={(event: { target: { value: string } }) => setTuningDraft((previous) => ({ ...previous, lexical: event.target.value }))}
            />
          </div>
          <div className="clue-field" title="通道权重的含义：fusion = 进 RRF 融合分（精排开启时实测无效）；quota = 改为向量独有候选的召回配额">
            <span className="clue-field-label">通道权重含义</span>
            <select
              className="clue-input"
              value={tuningDraft.channelWeightMode}
              disabled={busy || !data.available}
              onChange={(event: { target: { value: string } }) => setTuningDraft((previous) => ({ ...previous, channelWeightMode: event.target.value }))}
            >
              <option value="fusion">fusion(进融合分,今天)</option>
              <option value="quota">quota(改成召回配额,可验证)</option>
            </select>
          </div>
          <div className="clue-field" title="0 = 不限；大于 0 时限制窗口内只被向量召回的候选条数">
            <span className="clue-field-label">向量独有配额</span>
            <Input
              className="clue-input"
              value={tuningDraft.maxVectorOnly}
              disabled={busy || !data.available}
              onChange={(event: { target: { value: string } }) => setTuningDraft((previous) => ({ ...previous, maxVectorOnly: event.target.value }))}
            />
          </div>
          <div className="clue-field">
            <span className="clue-field-label">语义权重</span>
            <Input
              className="clue-input"
              value={tuningDraft.vector}
              disabled={busy || !data.available}
              onChange={(event: { target: { value: string } }) => setTuningDraft((previous) => ({ ...previous, vector: event.target.value }))}
            />
          </div>
        </div>

        <DisclosureRow
          icon={null}
          title="特征权重"
          open={weightsOpen}
          expandable
          onToggle={() => setWeightsOpen((previous) => !previous)}
          expandOnRowClick
        >
          <div className="clue-disclosure-body">
            <div className="clue-grid-2">
              {Object.keys(retrieval.featureWeights).map((name) => (
                <div key={name} className="clue-field">
                  <span className="clue-field-label">{name}</span>
                  <Input
                    className="clue-input"
                    value={tuningDraft.weights[name] ?? ''}
                    disabled={busy || !data.available}
                    onChange={(event: { target: { value: string } }) => setTuningDraft((previous) => ({
                      ...previous,
                      weights: { ...previous.weights, [name]: event.target.value },
                    }))}
                  />
                </div>
              ))}
            </div>
          </div>
        </DisclosureRow>

        <DisclosureRow
          icon={null}
          title="量纲与名次"
          open={scalesOpen}
          expandable
          onToggle={() => setScalesOpen((previous) => !previous)}
          expandOnRowClick
        >
          <div className="clue-disclosure-body">
            <div className="clue-grid-2">
              <div className="clue-field">
                <span className="clue-field-label">词法尺度</span>
                <select
                  className="clue-input"
                  value={tuningDraft.lexicalNormalization}
                  disabled={busy || !data.available}
                  onChange={(event: { target: { value: string } }) => setTuningDraft((previous) => ({ ...previous, lexicalNormalization: event.target.value }))}
                >
                  <option value="auto">auto(混合走绝对尺度,纯词法维持旧档)</option>
                  <option value="candidates">candidates(按候选集最好的一条归一)</option>
                  <option value="absolute">absolute(按池内分位饱和,旧档不受影响)</option>
                </select>
              </div>
              <div className="clue-field">
                <span className="clue-field-label">语义尺度</span>
                <select
                  className="clue-input"
                  value={tuningDraft.semanticScale}
                  disabled={busy || !data.available}
                  onChange={(event: { target: { value: string } }) => setTuningDraft((previous) => ({ ...previous, semanticScale: event.target.value }))}
                >
                  <option value="auto">auto(混合走标定,纯词法维持旧档)</option>
                  <option value="raw">raw(原始余弦)</option>
                  <option value="calibrated">calibrated(按 floor/ceil 映射到 0–1)</option>
                </select>
              </div>
              <div className="clue-field">
                <span className="clue-field-label">缺失语义</span>
                <select
                  className="clue-input"
                  value={tuningDraft.missingFeatureMode}
                  disabled={busy || !data.available}
                  onChange={(event: { target: { value: string } }) => setTuningDraft((previous) => ({ ...previous, missingFeatureMode: event.target.value }))}
                >
                  <option value="zero">zero(没召回与低分同视)</option>
                  <option value="absent">absent(未参与,--explain 会写明)</option>
                </select>
              </div>
              <div className="clue-field">
                <span className="clue-field-label">词频口径</span>
                <select
                  className="clue-input"
                  value={tuningDraft.termFrequency}
                  disabled={busy || !data.available}
                  onChange={(event: { target: { value: string } }) => setTuningDraft((previous) => ({ ...previous, termFrequency: event.target.value }))}
                >
                  <option value="presence">presence(出现即一次,今天)</option>
                  <option value="count">count(真词频,长度口径同为总词数)</option>
                </select>
              </div>
              <label className="clue-field-inline" title="把 _process_and_sort 同时切成 process/and/sort 建索引;整串仍然可命中">
                <input
                  type="checkbox"
                  checked={tuningDraft.identifierSubtokens}
                  disabled={busy || !data.available}
                  onChange={(event) => setTuningDraft((previous) => ({ ...previous, identifierSubtokens: event.target.checked }))}
                />
                <span className="clue-field-label">标识符子词切分</span>
              </label>
              <div className="clue-field">
                <span className="clue-field-label">标定 floor / ceil</span>
                <span className="clue-field-inline" style={{ gap: 8 }}>
                  <Input
                    className="clue-input"
                    value={tuningDraft.semanticFloor}
                    disabled={busy || !data.available}
                    onChange={(event: { target: { value: string } }) => setTuningDraft((previous) => ({ ...previous, semanticFloor: event.target.value }))}
                  />
                  <Input
                    className="clue-input"
                    value={tuningDraft.semanticCeil}
                    disabled={busy || !data.available}
                    onChange={(event: { target: { value: string } }) => setTuningDraft((previous) => ({ ...previous, semanticCeil: event.target.value }))}
                  />
                </span>
              </div>
            </div>
          </div>
        </DisclosureRow>

        <div className="clue-dim">
          ranklog {vector.ranklog.rows} 行 / 有标注 {vector.ranklog.labeledRows}
        </div>

        <div className="clue-card-actions">
          <span className="clue-spacer" />
          <Button
            variant="primary"
            disabled={busy || !data.available || !tuningDirty}
            onClick={() => {
              const weights: Record<string, number> = {}
              for (const [name, value] of Object.entries(tuningDraft.weights)) {
                const parsed = Number(value)
                if (Number.isFinite(parsed)) weights[name] = parsed
              }
              void save({
                rerank: tuningDraft.rerank,
                ranklog: tuningDraft.ranklog,
                llmRerank: tuningDraft.llmRerank,
                channelWeights: { ...retrieval.channelWeights, lexical: Number(tuningDraft.lexical), vector: Number(tuningDraft.vector) },
                lexicalNormalization: tuningDraft.lexicalNormalization,
                semanticScale: tuningDraft.semanticScale,
                semanticFloor: Number(tuningDraft.semanticFloor),
                semanticCeil: Number(tuningDraft.semanticCeil),
                missingFeatureMode: tuningDraft.missingFeatureMode,
                termFrequency: tuningDraft.termFrequency,
                identifierSubtokens: tuningDraft.identifierSubtokens,
                maxVectorOnly: Number(tuningDraft.maxVectorOnly),
                channelWeightMode: tuningDraft.channelWeightMode,
                ...(Object.keys(weights).length > 0 ? { featureWeights: weights } : {}),
              }, 'retrieval')
            }}
          >
            保存
          </Button>
        </div>
      </div>

      {/* The one confirmation dialog for this page: dsh's RiskConfirmation
          (primary action stays disabled until the acknowledge box is checked). */}
      <RiskConfirmation
        open={risk !== null}
        title={risk?.title ?? ''}
        description={risk?.description ?? ''}
        acknowledgeLabel={risk?.acknowledge ?? ''}
        cancelLabel="取消"
        confirmLabel={risk?.action ?? '确认'}
        acknowledged={acknowledged}
        disabled={busy}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setRisk(null); setAcknowledged(false) }}
        onConfirm={() => {
          const pending = risk
          if (pending === null) return
          if (pending.kind === 'key') {
            void act('清除密钥', async () => {
              const result = await kbApi.embeddingKeyClear()
              return `已清除 ${result.cleared}`
            })
            return
          }
          if (pending.kind === 'cache') {
            void act('清空缓存', async () => {
              const result = await kbApi.embeddingClearCache(false)
              return `已清空 ${result.cleared.join(', ') || '(无)'}`
            })
            return
          }
          void act('重建向量层', async () => {
            const result = await kbApi.embeddingBuild({ only: 'entries', rebuild: true })
            return result.ok ? '向量层已重建' : (result.error ?? '重建失败')
          })
        }}
      />

      {/* ── 诊断 ───────────────────────────────────────────────────────── */}
      <div className="clue-card">
        <div className="clue-card-head">
          <span className="clue-card-title">诊断</span>
          <span className="clue-dim">每条都先问一次;都不会静默花钱</span>
        </div>
        <div className="clue-actions">
          <Button
            variant="outline"
            disabled={busy || !data.available || !data.ready}
            onClick={() => { void act('dry-run', async () => {
              const result = await kbApi.embeddingBuild({ dryRun: true, only: 'entries' })
              return result.ok ? `预估:${JSON.stringify((result.reports[0] as { plan?: unknown })?.plan ?? {})}` : (result.error ?? '失败')
            }) }}
          >
            预估重建(零调用)
          </Button>
          <Button
            disabled={busy || !data.available || !data.ready}
            onClick={() => setRisk({
              kind: 'build',
              title: '重建向量层',
              description: `会对本工作区的条目重新嵌入并按批计费(批量 ${config.batchSize}、并发 ${config.concurrency});缓存命中的部分不重复调用。想先看账用左侧「预估重建」。`,
              acknowledge: '我明白这一步会真实调用嵌入端点并产生费用',
              action: '开始重建',
            })}
          >
            重建向量层
          </Button>
          <Button
            variant="outline"
            disabled={busy || !data.available}
            onClick={() => setRisk({
              kind: 'cache',
              title: '清空嵌入缓存',
              description: '清掉当前 embedderVersion 的文本级缓存分区。向量索引不动,但下次建索引会对每一条重新调用端点(要花钱)。',
              acknowledge: '我明白下次建索引会重新调用端点',
              action: '清空缓存',
            })}
          >
            清空缓存
          </Button>
          <Button
            variant="outline"
            disabled={busy || !data.available}
            onClick={() => { void act('ranklog', async () => {
              const summary = await kbApi.embeddingRanklog()
              return `ranklog:${summary.rows} 行 / ${summary.queries} 查询 / 有标注 ${summary.labeledRows} 行`
            }) }}
          >
            导出 ranklog 摘要
          </Button>
        </div>
        <div className="clue-dim">
          设置文档 <code className="clue-mono">{data.documentPath ?? '(无)'}</code>
        </div>
      </div>
    </div>
  )
}
