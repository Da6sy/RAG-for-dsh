/**
 * KbStore — the knowledge base over the filesystem (design doc §3.1/§3.3/§3.5).
 *
 * Layout (decision #6 RE-Revised M9: storage is CENTRAL, one tier per
 * WORKSPACE — the 集中式 layout; the M8 experiment of writing into the
 * workspace is retired together with its `.git/info/exclude` bookkeeping):
 *   <home>/kb/<workspace-key>/     one workspace's project tier
 *     meta.json                    format stamp + the ROOT anchor it belongs to
 *     entries/<id>.json            FACTS: one file per entry (source of truth)
 *     signals.jsonl                APPEND-ONLY weighted signal ledger
 *     approvals.json               the batched human-decision queue
 *     doubt.jsonl                  M6 doubt ledgers (evidence loop sidecar)
 *   <home>/kb/_global/             the global tier (cross-project by definition)
 *   <home>/workspaces.json         the roster: key ↔ root ↔ label + per-workspace
 *                                  settings (M9; ClueHarness's own list, never
 *                                  read from dsh's workspace service)
 *
 * The key is a pure function of the canonical root (`encodeSegment(root)`,
 * `-N` when two roots encode alike — decided by the meta.json anchor), so the
 * panel, the CLI and a session's gate all land on the same tier FROM A PATH
 * alone: the M8 accident this file used to prevent (对话与审批各读一本库) is
 * prevented by the derivation, not by where the bytes sit. What centralizing
 * buys: a workspace directory carries zero ClueHarness state, and no git
 * bookkeeping of ours ever touches it. What it costs: copying a project folder
 * no longer copies its memory — the knowledge lives in the home.
 * `clue kb migrate` imports the old in-workspace layout (it never overwrites).
 *
 * Concurrency (decision #13: same-process only for now): every operation is
 * read-compute-atomic-write; no in-memory cache, so two stores over the same
 * directory in one process stay coherent, and the write-behind/lock machinery
 * for cross-process (B2/B3) is a later, additive concern.
 *
 * The store OWENS persistence and orchestration; the state machine owns
 * legality; signals owns scoring. Three files, three jobs.
 *
 * @module @clue-harness/kb/store
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { atomicWriteJson, canonicalRoot, clueHome, readJsonOrNull, sha256File, workspaceKey } from '@clue-harness/util'
import {
  readWorkspaces,
  registerWorkspace,
  setRenderSurface,
  type RenderSurfaceSettings,
} from './workspaces.ts'
import {
  detectDrift,
  docExists,
  listDocs,
  readChunks,
  readDocRecord,
  readDocText,
  removeChunks,
  writeChunks,
  type DocDrift,
} from './docs.ts'
import {
  DEFAULT_KB_CONFIG,
  KB_FORMAT_VERSION,
  KbEntryId,
  REDLINE_PROPOSAL_RATIO,
  type ApprovalAction,
  type ApprovalRequest,
  type ChunkRecord,
  type DocAnchor,
  type DocRecord,
  type KbConfig,
  type KbDocId,
  type KbEntry,
  type KbKind,
  type KbMeta,
  type KbRedline,
  type KbStatus,
  type KbTier,
  type SourceBinding,
} from './types.ts'
import {
  applyTransition,
  clearNeedsReview,
  raiseNeedsReview,
  type TransitionTrigger,
} from './state-machine.ts'
import {
  appendSignal,
  buildSignal,
  discardThreshold,
  readSignals,
  windowScore,
  type SignalInput,
} from './signals.ts'
// The redline ratio lives with the retrieval semantics it changes (query.ts):
// one measurement, used by the store's threshold act and by the panel.
import { redlinedRatio } from './query.ts'
import type { SignalRecord } from './types.ts'

export interface KbStoreOptions {
  tier: KbTier
  /** Absolute or resolvable workspace root (required for tier 'project'). */
  projectRoot?: string
  /**
   * ClueHarness home — CENTRAL for everything: the global tier, the roster,
   * and (M9) the per-workspace project tiers. Default CLUE_HOME or ~/.clue;
   * tests/demos pass an isolated home.
   */
  home?: string
  config?: Partial<KbConfig>
}

/** What `add` accepts; the store stamps identity/status/provenance. */
export interface AddEntryInput {
  kind: KbKind
  title: string
  text: string
  tags?: string[]
  /** Project-relative paths to bind; hashed at add time. */
  bindings?: string[]
  note?: string
  createdBy?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/** One opened KB tier. */
export class KbStore {
  readonly dir: string
  readonly tier: KbTier
  readonly projectRoot: string | null
  /** The central workspace key this tier lives under (null for the global tier). */
  readonly key: string | null
  readonly config: KbConfig

  private constructor(
    dir: string,
    tier: KbTier,
    projectRoot: string | null,
    key: string | null,
    config: KbConfig,
  ) {
    this.dir = dir
    this.tier = tier
    this.projectRoot = projectRoot
    this.key = key
    this.config = config
  }

  /**
   * Open (creating on first use) one KB tier.
   *
   * Project tier: `<home>/kb/<workspace-key>` where the key derives from the
   * canonical root (see {@link workspaceKey}) — same path in, same tier out,
   * for a session gate, the CLI, or the settings panel. Two side effects keep
   * the roster honest: the meta.json anchor is written for a fresh tier (it is
   * what makes the key collision-safe), and the root is registered in
   * `<home>/workspaces.json` so "a project joins the list by being used"
   * holds. Nothing is ever written INTO the workspace.
   */
  static async open(options: KbStoreOptions): Promise<KbStore> {
    const home = options.home ?? clueHome()
    const config: KbConfig = { ...DEFAULT_KB_CONFIG, ...options.config, weights: { ...DEFAULT_KB_CONFIG.weights, ...(options.config?.weights ?? {}) } }
    let tierRoot: string | null = null
    let key: string | null = null
    let dir: string
    if (options.tier === 'global') {
      dir = path.join(home, 'kb', '_global')
    } else {
      if (options.projectRoot === undefined) throw new Error('KbStore.open: tier=project requires projectRoot')
      tierRoot = canonicalRoot(options.projectRoot)
      key = await workspaceKey(tierRoot, home)
      dir = path.join(home, 'kb', key)
    }
    const metaFile = path.join(dir, 'meta.json')
    if ((await readJsonOrNull<KbMeta>(metaFile)) === null) {
      const meta: KbMeta = {
        version: KB_FORMAT_VERSION,
        tier: options.tier,
        projectRoot: tierRoot ?? '',
        createdAt: new Date().toISOString(),
      }
      await atomicWriteJson(metaFile, meta)
    }
    if (tierRoot !== null && key !== null) await registerWorkspace(tierRoot, { home })
    return new KbStore(dir, options.tier, tierRoot, key, config)
  }

  // ---- paths ----
  private get entriesDir(): string { return path.join(this.dir, 'entries') }
  private entryFile(id: KbEntryId): string { return path.join(this.entriesDir, `${id}.json`) }
  private get signalsFile(): string { return path.join(this.dir, 'signals.jsonl') }
  private get approvalsFile(): string { return path.join(this.dir, 'approvals.json') }

  /** Resolve a binding's relative path against the project anchor. */
  bindingPath(binding: SourceBinding): string {
    if (this.projectRoot === null) throw new Error('kb: global-tier entries cannot resolve file bindings (no project anchor)')
    return path.resolve(this.projectRoot, binding.path)
  }

  // ---- facts CRUD ----

  /**
   * Add a new entry. It ALWAYS starts as candidate (the user's original
   * rule: 首次添加=候选), no exceptions — nothing enters trusted directly.
   */
  async add(input: AddEntryInput, at: string = new Date().toISOString()): Promise<KbEntry> {
    if (input.title.trim() === '' || input.text.trim() === '') {
      throw new Error('kb add: neither title nor text may be empty')
    }
    const id = KbEntryId(`k-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`)
    const bindings: SourceBinding[] = []
    for (const rel of input.bindings ?? []) {
      const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '')
      const abs = this.projectRoot === null
        ? (() => { throw new Error('kb add: global-tier entries cannot bind project files') })()
        : path.resolve(this.projectRoot, normalized)
      bindings.push({ path: normalized, contentHash: await sha256File(abs) })
    }
    const entry: KbEntry = {
      version: KB_FORMAT_VERSION,
      id,
      tier: this.tier,
      kind: input.kind,
      title: input.title.trim(),
      text: input.text,
      tags: [...new Set(input.tags ?? [])].sort(),
      bindings,
      provenance: {
        createdBy: input.createdBy ?? 'cli',
        createdAt: at,
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      status: 'candidate',
      needsReview: false,
      reviewReason: null,
      stats: { lastReferencedAt: null, referenceCount: 0 },
      history: [{ at, change: 'status', from: null, to: 'candidate', reason: 'created: 新知识一律从候选开始' }],
      discardedAt: null,
    }
    await atomicWriteJson(this.entryFile(id), entry)
    return entry
  }

  /** Load one entry; refuses foreign format versions (house style). */
  async get(id: KbEntryId): Promise<KbEntry | null> {
    const entry = await readJsonOrNull<KbEntry>(this.entryFile(id))
    if (entry === null) return null
    if (entry.version !== KB_FORMAT_VERSION) {
      throw new Error(`kb entry version mismatch: ${id} is v${String(entry.version)}, current v${KB_FORMAT_VERSION} — refused (no auto-migration)`)
    }
    return entry
  }

  /** List entries (deterministic order: createdAt desc, then id). */
  async list(filter: { status?: KbStatus; kind?: KbKind; needsReview?: boolean } = {}): Promise<KbEntry[]> {
    let names: string[]
    try {
      names = await readdir(this.entriesDir)
    } catch {
      return []
    }
    const entries: KbEntry[] = []
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const entry = await this.get(KbEntryId(name.slice(0, -'.json'.length)))
      if (entry === null) continue
      if (filter.status !== undefined && entry.status !== filter.status) continue
      if (filter.kind !== undefined && entry.kind !== filter.kind) continue
      if (filter.needsReview !== undefined && entry.needsReview !== filter.needsReview) continue
      entries.push(entry)
    }
    entries.sort((a, b) => b.provenance.createdAt.localeCompare(a.provenance.createdAt) || a.id.localeCompare(b.id))
    return entries
  }

  private async save(entry: KbEntry): Promise<KbEntry> {
    await atomicWriteJson(this.entryFile(entry.id), entry)
    return entry
  }

  // ---- lifecycle ----

  /** Guarded status transition (legality lives in state-machine.ts). */
  async transition(id: KbEntryId, to: KbStatus, trigger: TransitionTrigger, reason: string, at?: string): Promise<KbEntry> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    return this.save(applyTransition(entry, to, trigger, reason, at))
  }

  /**
   * Re-hash the entry's bindings against the project anchor.
   * - drift or missing file → raise the orthogonal needs-review flag;
   * - all match and the flag was hash-caused → auto-clear (自动重验通过).
   * Global-tier entries and unbound entries are no-ops.
   */
  async checkBindings(id: KbEntryId, at: string = new Date().toISOString()): Promise<KbEntry> {
    let entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    if (entry.tier === 'global' || entry.bindings.length === 0) return entry
    for (const binding of entry.bindings) {
      const abs = this.bindingPath(binding)
      let currentHash: string
      try {
        currentHash = await sha256File(abs)
      } catch {
        entry = raiseNeedsReview(entry, `源文件不存在: ${binding.path}`, at)
        continue
      }
      if (currentHash !== binding.contentHash) {
        entry = raiseNeedsReview(entry, `源文件内容已变: ${binding.path}`, at)
      }
    }
    const hashCaused = entry.reviewReason !== null && entry.reviewReason.startsWith('源文件')
    const allMatch = await this.bindingsAllMatch(entry)
    if (entry.needsReview && hashCaused && allMatch) {
      entry = clearNeedsReview(entry, '自动重验通过: 绑定文件哈希与记录一致', at)
    }
    return this.save(entry)
  }

  private async bindingsAllMatch(entry: KbEntry): Promise<boolean> {
    for (const binding of entry.bindings) {
      try {
        if ((await sha256File(this.bindingPath(binding))) !== binding.contentHash) return false
      } catch {
        return false
      }
    }
    return true
  }

  /**
   * Manually raise the orthogonal needs-review flag (M5 failure propagation:
   * a GLOBAL entry that keeps failing attributed verification in projects
   * gets flagged here — binding-drift is not the only way knowledge goes
   * stale). Idempotent through raiseNeedsReview: the same reason twice is a
   * no-op, a different reason re-flags with fresh history.
   * @param id - the entry to flag.
   * @param reason - why review is needed (audit trail text).
   * @param at - ISO timestamp.
   * @returns the flagged entry.
   * @throws when the entry does not exist (fail loud, never guess).
   */
  async flagNeedsReview(id: KbEntryId, reason: string, at: string = new Date().toISOString()): Promise<KbEntry> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    return this.save(raiseNeedsReview(entry, reason, at))
  }

  /**
   * Human re-verification. `accept` rebinds: recorded hashes are updated to
   * the current content (the change is acknowledged as correct) and the flag
   * clears; without it, this is just a manual check that clears on match.
   */
  async reverify(id: KbEntryId, accept: boolean, at: string = new Date().toISOString()): Promise<KbEntry> {
    let entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    if (accept && entry.tier !== 'global') {
      const rebound: SourceBinding[] = []
      const previous = entry.bindings
      for (const binding of previous) {
        const abs = this.bindingPath(binding)
        try {
          rebound.push({ path: binding.path, contentHash: await sha256File(abs) })
        } catch {
          throw new Error(`kb reverify --accept: binding file does not exist: ${binding.path} (a vanished file cannot be accepted as the new basis)`)
        }
      }
      const changed = rebound.some((b, i) => b.contentHash !== previous[i].contentHash)
      entry = {
        ...entry,
        bindings: rebound,
        history: changed
          ? [...entry.history, { at, change: 'rebind' as const, from: entry.status, to: null, reason: '人工复核接受新内容: 绑定哈希已更新' }]
          : entry.history,
      }
    }
    entry = clearNeedsReview(entry, accept ? '人工复核通过(--accept)' : '人工重验: 绑定哈希一致', at)
    return this.save(entry)
  }

  /**
   * Replace an entry's WHOLE binding set, with the hash recomputed for each new
   * path (落地计划 §9: 12 条条目的 bindings 指向已删文档,而此前没有任何办法改绑).
   *
   * Why this method exists at all: `add` sets bindings once and `reverify
   * --accept` only re-hashes the paths already there — it even REFUSES when the
   * file is gone ("不能接受一个消失的文件为新基准"). So an entry anchored to a
   * document that has since been consolidated into another file was stuck: the
   * only way out was to add a duplicate entry, which is exactly the "double
   * truth" the binding mechanism exists to prevent.
   *
   * M6 discipline, unchanged: this is a HUMAN act with a recorded why. Every new
   * path must exist (fail loud — binding to a file that is not there would
   * manufacture drift on the next check), the change lands in `history` as
   * `rebind`, and `clearReview` is the caller's explicit decision to treat the
   * rebinding as the re-verification (otherwise a ⚑ stays where it was).
   * @param id - the entry to rebind.
   * @param paths - the new project-relative binding set (empty clears them).
   * @param reason - audit trail text (why the anchor moved).
   * @param options - `at` clock, and `clearReview` to also clear a ⚑.
   * @returns the updated entry.
   * @throws when the entry is missing, the tier is global, or a path has no file.
   */
  async setBindings(
    id: KbEntryId,
    paths: readonly string[],
    reason: string,
    options: { at?: string; clearReview?: boolean } = {},
  ): Promise<KbEntry> {
    const at = options.at ?? new Date().toISOString()
    let entry = await this.get(id)
    if (entry === null) throw new Error(`kb rebind: entry not found: ${id}`)
    if (entry.tier === 'global' && paths.length > 0) {
      throw new Error('kb rebind: global-tier entries cannot bind project files')
    }
    if (reason.trim() === '') throw new Error('kb rebind: a reason is required (the rebind enters the history)')
    const bindings: SourceBinding[] = []
    for (const rel of paths) {
      const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '')
      const abs = this.bindingPath({ path: normalized, contentHash: '' })
      try {
        bindings.push({ path: normalized, contentHash: await sha256File(abs) })
      } catch {
        throw new Error(`kb rebind: binding file does not exist: ${normalized} (check the path first, then rebind)`)
      }
    }
    const before = entry.bindings.map((binding) => binding.path).join(', ')
    const after = bindings.map((binding) => binding.path).join(', ')
    if (before === after) {
      // A no-op rebind still records the why: the human's judgement is the fact,
      // and "I checked and the anchor is right" is worth having in the ledger.
      entry = {
        ...entry,
        bindings,
        history: [...entry.history, { at, change: 'rebind' as const, from: entry.status, to: null, reason: `${reason}(绑定未变: ${after === '' ? '无' : after})` }],
      }
    } else {
      entry = {
        ...entry,
        bindings,
        history: [...entry.history, { at, change: 'rebind' as const, from: entry.status, to: null, reason: `${reason}(绑定: ${before === '' ? '无' : before} → ${after === '' ? '无' : after})` }],
      }
    }
    if (options.clearReview === true && entry.needsReview) {
      entry = clearNeedsReview(entry, `人工改绑视为重新核验: ${reason}`, at)
    }
    return this.save(entry)
  }

  /**
   * Replace an entry's text with an audited history event (M6: the approval
   * center's "AI 润色" adoption path — a human adopts a rewritten draft and
   * the ledger records that the body changed and why). Title/tags/status/
   * bindings are NOT this method's business; it changes exactly one field.
   * @param id - the entry to edit.
   * @param text - the new body text (non-blank).
   * @param reason - audit trail text (e.g. who/what produced the rewrite).
   * @param at - ISO timestamp.
   * @returns the updated entry.
   * @throws when the entry does not exist or the text is blank (fail loud).
   */
  async updateEntryText(id: KbEntryId, text: string, reason: string, at: string = new Date().toISOString()): Promise<KbEntry> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    if (text.trim() === '') throw new Error('kb: entry text must not be blank')
    if (text === entry.text) return entry // no-op edit: no history spam
    return this.save({
      ...entry,
      text,
      history: [...entry.history, { at, change: 'textUpdated' as const, from: entry.status, to: null, reason }],
    })
  }

  // ---- M9: the document layer (evidence) --------------------------------
  //
  // Every method below governs an ENTRY (mounting evidence, redlining it,
  // splitting it). The Document/Chunk side never gets status or signals —
  // 宪法 3: 证据不可治理. The snapshot bytes are read-only through docs.ts.

  /** Resolve a doc source path against the project anchor (drift detection). */
  docSourcePath(relative: string): string {
    if (this.projectRoot === null) throw new Error('kb: global-tier entries have no document layer (no project anchor)')
    return path.resolve(this.projectRoot, relative)
  }

  /**
   * Read one snapshot's record; refuses foreign formats like entries do.
   * @param docId - the snapshot id.
   * @returns the record, or null when the doc is unknown.
   */
  async getDoc(docId: KbDocId | string): Promise<DocRecord | null> {
    const record = await readDocRecord(this.dir, docId)
    if (record === null) return null
    if (record.version !== KB_FORMAT_VERSION) {
      throw new Error(`kb document version mismatch: ${String(docId)} is v${String(record.version)}, current v${KB_FORMAT_VERSION} — refused (no auto-migration)`)
    }
    return record
  }

  /** Read one snapshot's derived chunk ledger (empty when never built). */
  async getChunks(docId: KbDocId | string): Promise<ChunkRecord[]> {
    return readChunks(this.dir, docId)
  }

  /** Every snapshot this tier holds, newest first. */
  async listDocs(): Promise<DocRecord[]> {
    return listDocs(this.dir)
  }

  /** Whether the chunk ledger is absent or carries a foreign chunker stamp. */
  async chunksNeedRebuild(docId: KbDocId | string): Promise<boolean> {
    const rows = await readChunks(this.dir, docId)
    return rows.length === 0 || rows.some((row) => row.chunkerVersion !== this.config.chunkerVersion)
  }

  /**
   * Replace one doc's derived chunk ledger (the write half of "派生可重建").
   * Pure derivation: nothing about any Entry changes here.
   * @param docId - the snapshot id.
   * @param chunks - the freshly derived rows.
   */
  async saveChunks(docId: KbDocId | string, chunks: readonly ChunkRecord[]): Promise<void> {
    await writeChunks(this.dir, docId, chunks)
  }

  /**
   * Drop one doc's derived chunk ledger. Deleting it MUST change nothing but
   * the next rebuild's timing — that is the acceptance test for 宪法 2.
   * @param docId - the snapshot id.
   */
  async dropChunks(docId: KbDocId | string): Promise<void> {
    await removeChunks(this.dir, docId)
  }

  /**
   * Mount an existing snapshot on an entry (M9-1, `clue kb doc attach`).
   * Governance stays on the entry: this only records WHERE the evidence is.
   * @param id - the entry to mount evidence on.
   * @param docId - the snapshot to mount.
   * @param anchor - optional heading/lines anchor + quote.
   * @param at - ISO timestamp.
   * @returns the updated entry.
   * @throws when the entry or the snapshot does not exist (fail loud).
   */
  async attachDoc(id: KbEntryId, docId: KbDocId | string, anchor?: DocAnchor, at: string = new Date().toISOString()): Promise<KbEntry> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    if (!await docExists(this.dir, docId)) throw new Error(`kb: document snapshot not found: ${String(docId)} (import it with clue kb ingest first)`)
    const anchorWithQuote = anchor === undefined
      ? undefined
      : { ...anchor, quoteAnchor: anchor.quoteAnchor ?? '' }
    const doc = { docId: docId as KbDocId, ...(anchorWithQuote !== undefined ? { anchor: anchorWithQuote } : {}) }
    return this.save({
      ...entry,
      doc,
      history: [...entry.history, {
        at,
        change: 'rebind' as const,
        from: entry.status,
        to: null,
        reason: `挂载原文证据: ${String(docId)}${anchor?.lines !== undefined ? ` 行 ${anchor.lines[0]}-${anchor.lines[1]}` : ''}`,
      }],
    })
  }

  /**
   * Re-hash every mounted doc's SOURCE path and flag the entries that ride on
   * a drifted snapshot (M9-1/§4 漂移质疑).
   *
   * The snapshot is never rewritten and the entry's STATUS never changes —
   * only the orthogonal needs-review flag, exactly like binding drift. A
   * missing source file is drift too (the现场 evidence is gone).
   * @param id - the entry whose doc to check.
   * @param at - ISO timestamp.
   * @returns the (possibly flagged) entry.
   */
  async checkDocs(id: KbEntryId, at: string = new Date().toISOString()): Promise<KbEntry> {
    let entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    if (entry.tier === 'global' || entry.doc === undefined) return entry
    const record = await this.getDoc(entry.doc.docId)
    if (record === null) {
      return this.save(raiseNeedsReview(entry, `原文快照缺失: ${String(entry.doc.docId)}`, at))
    }
    const drift = await detectDrift(record, (relative) => this.docSourcePath(relative))
    if (drift !== null) {
      const label = drift.kind === 'missing' ? '原文文件不存在' : '原文已更新'
      entry = raiseNeedsReview(entry, `${label}: ${drift.sourcePath} (${drift.recordedHash})`, at)
    } else if (entry.needsReview && (entry.reviewReason ?? '').startsWith('原文')) {
      // The source is back in sync with the snapshot: auto-clear, the same
      // "自动重验通过" shape bindings have.
      entry = clearNeedsReview(entry, '自动重验通过: 原文哈希与快照记录一致', at)
    }
    return this.save(entry)
  }

  /**
   * Re-hash every entry's mounted docs in one pass (the sweep/report form).
   * @param at - ISO timestamp.
   * @returns the drift findings (also the entries that were flagged).
   */
  async checkAllDocs(at: string = new Date().toISOString()): Promise<DocDrift[]> {
    const findings: DocDrift[] = []
    if (this.projectRoot === null) return findings
    const seen = new Set<string>()
    for (const entry of await this.list()) {
      if (entry.doc === undefined) continue
      const before = entry.needsReview ? entry.reviewReason : null
      const after = await this.checkDocs(entry.id, at)
      if (!after.needsReview) continue
      if (before !== null && before === after.reviewReason) continue
      if (seen.has(String(entry.doc.docId))) continue
      seen.add(String(entry.doc.docId))
      const record = await this.getDoc(entry.doc.docId)
      if (record === null) continue
      const drift = await detectDrift(record, (relative) => this.docSourcePath(relative))
      if (drift !== null) findings.push(drift)
    }
    return findings
  }

  /**
   * Redline one character range of an entry's own text (M9-4/§5a) — the human
   * "即刻止血": the range leaves BOTH display and scoring, while the entry
   * keeps serving with everything else it says.
   *
   * The threshold act is a PROPOSAL, never an action: once redlines cover more
   * than {@link REDLINE_PROPOSAL_RATIO} of the text, a `redline-review` request
   * is queued for a human to decide split-or-discard (系统提议,人执行).
   * @param id - the entry to redline.
   * @param input - the character range, reason and actor.
   * @param at - ISO timestamp.
   * @returns the updated entry plus whether a review proposal was queued.
   */
  async redlineText(
    id: KbEntryId,
    input: { chars: [number, number]; reason: string; by?: string },
    at: string = new Date().toISOString(),
  ): Promise<{ entry: KbEntry; ratio: number; proposal: ApprovalRequest | null }> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    const [from, to] = input.chars
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      throw new Error(`kb redline: invalid char range ${from}-${to} (requires 1 ≤ from ≤ to)`)
    }
    const quoteAnchor = entry.text.slice(from - 1, from - 1 + 40).replace(/\s+/g, ' ').trim()
    const redline: KbRedline = {
      target: 'text',
      chars: [from, to],
      quoteAnchor,
      reason: input.reason,
      at,
      by: input.by ?? 'cli',
    }
    let next: KbEntry = {
      ...entry,
      redlines: [...(entry.redlines ?? []), redline],
      history: [...entry.history, {
        at,
        change: 'redline' as const,
        from: entry.status,
        to: null,
        reason: `划除 ${from}-${to}: ${input.reason}`,
      }],
    }
    next = await this.save(next)
    const ratio = redlinedRatio(next)
    let proposal: ApprovalRequest | null = null
    if (ratio > REDLINE_PROPOSAL_RATIO) {
      proposal = await this.requestApproval(
        next.id,
        'redline-review',
        `已划除 ${Math.round(ratio * 100)}%(> ${Math.round(REDLINE_PROPOSAL_RATIO * 100)}%),建议拆分或遗弃该条目`,
        0,
        at,
      )
    }
    return { entry: next, ratio, proposal }
  }

  /**
   * Redline a line range of the entry's MOUNTED DOCUMENT (M9-4/§5a). The
   * binding is to a concrete `docId`, never to a source path (invariant 2):
   * when the source produces a new snapshot the old redline stays on the old
   * doc and a human must re-anchor it.
   * @param id - the entry that owns the evidence.
   * @param input - the line range, reason and actor.
   * @param at - ISO timestamp.
   * @returns the updated entry plus its doc-redline ratio and any proposal.
   */
  async redlineDocLines(
    id: KbEntryId,
    input: { lines: [number, number]; reason: string; by?: string; headingPath?: string },
    at: string = new Date().toISOString(),
  ): Promise<{ entry: KbEntry; ratio: number; proposal: ApprovalRequest | null }> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    if (entry.doc === undefined) throw new Error(`kb redline: entry ${id} has no document layer; redline a text range with --chars instead`)
    const record = await this.getDoc(entry.doc.docId)
    if (record === null) throw new Error(`kb redline: document snapshot not found: ${String(entry.doc.docId)}`)
    const [from, to] = input.lines
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > record.lineCount) {
      throw new Error(`kb redline: invalid line range ${from}-${to} (the document has ${record.lineCount} lines)`)
    }
    const { readDocText } = await import('./docs.ts')
    const text = (await readDocText(this.dir, entry.doc.docId)) ?? ''
    const lines = text.split('\n')
    const quoteAnchor = (lines[from - 1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    const redline: KbRedline = {
      target: 'doc',
      docId: entry.doc.docId,
      lines: [from, to],
      quoteAnchor,
      ...(input.headingPath !== undefined ? { headingPath: input.headingPath } : {}),
      reason: input.reason,
      at,
      by: input.by ?? 'cli',
    }
    let next: KbEntry = {
      ...entry,
      redlines: [...(entry.redlines ?? []), redline],
      history: [...entry.history, {
        at,
        change: 'redline' as const,
        from: entry.status,
        to: null,
        reason: `划除原文 ${String(entry.doc.docId)} 行 ${from}-${to}: ${input.reason}`,
      }],
    }
    next = await this.save(next)
    // The ratio is measured against the snapshot's lines (the evidence the
    // redline actually removes), not against the entry's summary text.
    const removed = input.lines[1] - input.lines[0] + 1
    const ratio = record.lineCount === 0 ? 0 : removed / record.lineCount
    let proposal: ApprovalRequest | null = null
    if (ratio > REDLINE_PROPOSAL_RATIO) {
      proposal = await this.requestApproval(
        next.id,
        'redline-review',
        `原文已划除 ${Math.round(ratio * 100)}%(> ${Math.round(REDLINE_PROPOSAL_RATIO * 100)}%),建议拆分或遗弃该条目`,
        0,
        at,
      )
    }
    return { entry: next, ratio, proposal }
  }

  /**
   * Split one entry into successors (M9-4/§5b) — the 根治 for条目内对错.
   *
   * **Inheritance boundary (invariant 1)**: successors may reuse the SAME
   * `docId` evidence the old entry carried, but inherit NO governance —
   * `status` starts at candidate, `signals`/`approvals`/`redlines` are not
   * migrated (信号零随迁: otherwise a split would launder evidence failures).
   * @param id - the entry being split.
   * @param drafts - the successor bodies (kind/title/text/tags/anchor).
   * @param reason - audit trail text (lands in the old entry's history).
   * @param at - ISO timestamp.
   * @returns the superseded old entry plus the freshly created candidates.
   * @throws when the entry is missing, already superseded, or no draft was given.
   */
  async splitEntry(
    id: KbEntryId,
    drafts: ReadonlyArray<{ kind?: KbKind; title: string; text: string; tags?: string[]; anchor?: DocAnchor }>,
    reason: string,
    at: string = new Date().toISOString(),
  ): Promise<{ old: KbEntry; created: KbEntry[] }> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    if (entry.status === 'superseded') throw new Error(`kb split: entry ${id} was superseded by a split (superseded is a terminal state)`)
    if (drafts.length === 0) throw new Error('kb split: at least one new-entry draft is required')
    const created: KbEntry[] = []
    for (const draft of drafts) {
      const child = await this.add({
        kind: draft.kind ?? entry.kind,
        title: draft.title,
        text: draft.text,
        tags: draft.tags ?? entry.tags,
        createdBy: `split:${entry.id}`,
        note: `由 ${entry.id} 拆分而来(证据可继承,治理不继承)`,
      }, at)
      // Evidence reuse is explicit and human-made: same docId, a NEW anchor.
      const mounted = entry.doc !== undefined
        ? await this.attachDoc(child.id, entry.doc.docId, draft.anchor ?? entry.doc.anchor, at)
        : child
      created.push(mounted)
    }
    const old = await this.save({
      ...applyTransition(entry, 'superseded', 'split', `${reason} → [${created.map((c) => c.id).join(', ')}]`, at),
      splitInto: created.map((child) => child.id),
    })
    return { old, created }
  }

  // ---- signals & scoring ----

  /** Append one weighted signal to the ledger. */
  async recordSignal(id: KbEntryId, input: SignalInput, note = '', at?: string): Promise<SignalRecord> {
    if ((await this.get(id)) === null) throw new Error(`kb: entry not found: ${id}`)
    const record = buildSignal(id, input, note, this.config, at)
    await appendSignal(this.signalsFile, record)
    return record
  }

  /** Current sliding-window score for one entry. */
  async score(id: KbEntryId, now: Date = new Date()): Promise<ReturnType<typeof windowScore>> {
    return windowScore(await readSignals(this.signalsFile), id, now, this.config.windowDays)
  }

  /** Mark the entry as referenced (drives the expire timer; NOT a signal — see query.ts doctrine). */
  async touch(id: KbEntryId, at: string = new Date().toISOString()): Promise<KbEntry> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    return this.save({
      ...entry,
      stats: { lastReferencedAt: at, referenceCount: entry.stats.referenceCount + 1 },
    })
  }

  // ---- maintenance: expire / discard / purge / promotion suggestions ----

  /**
   * The periodic maintenance pass (M2: manual `clue kb sweep`; M3: a Cordis
   * job). Order matters: score-driven edges first, then idle expiry, then
   * the retention purge — so a purge never races a fresh transition.
   */
  async sweep(now: Date = new Date()): Promise<{ expired: KbEntryId[]; discarded: KbEntryId[]; purged: KbEntryId[]; promotions: ApprovalRequest[]; docDrift: DocDrift[] }> {
    const signals = await readSignals(this.signalsFile)
    const expired: KbEntryId[] = []
    const discarded: KbEntryId[] = []
    const purged: KbEntryId[] = []
    const at = now.toISOString()

    // M9-1: document drift rides the same maintenance pass as binding drift.
    // Flagging is idempotent; the snapshots are never rewritten.
    const docDrift = await this.checkAllDocs(at)

    for (const entry of await this.list()) {
      // M9-4: `superseded` is a TERMINAL, provenance-bearing state — it is
      // excluded from every sweep edge below (no score act, no idle expiry,
      // no retention purge). A discarded entry's knowledge may be forgotten;
      // a superseded entry's chain must stay readable forever.
      if (entry.status === 'superseded') continue
      // 1) strong-negative: user rejection / attributed evidence failure
      //    crossed the bound → discard WITHOUT a queue (entering discard is
      //    machine-driven; LEAVING it needs the human — the user's rule).
      if (entry.status === 'candidate' || entry.status === 'trusted' || entry.status === 'expired') {
        const { score } = windowScore(signals, entry.id, now, this.config.windowDays)
        if (score <= discardThreshold(this.config)) {
          await this.save(applyTransition(entry, 'discarded', 'strong-negative', `窗口分数 ${score} ≤ ${discardThreshold(this.config)}`, at))
          discarded.push(entry.id)
          continue
        }
      }
      // 2) idle expiry (both candidate and trusted have this exit — patch #1).
      if (entry.status === 'candidate' || entry.status === 'trusted') {
        const anchor = Date.parse(entry.stats.lastReferencedAt ?? entry.provenance.createdAt)
        if (!Number.isNaN(anchor) && now.getTime() - anchor > this.config.expireAfterDays * DAY_MS) {
          await this.save(applyTransition(entry, 'expired', 'expire-idle', `超过 ${this.config.expireAfterDays} 天未被引用`, at))
          expired.push(entry.id)
          continue
        }
      }
      // 3) retention purge (decision #11: 60 days, then gone; signals stay).
      if (entry.status === 'discarded' && entry.discardedAt !== null) {
        const discardedAt = Date.parse(entry.discardedAt)
        if (!Number.isNaN(discardedAt) && now.getTime() - discardedAt > this.config.discardRetentionDays * DAY_MS) {
          await rm(this.entryFile(entry.id), { force: true })
          purged.push(entry.id)
        }
      }
    }
    const promotions = await this.suggestPromotions(now, signals)
    return { expired, discarded, purged, promotions, docDrift }
  }

  /**
   * Turn score-eligible candidates into queued promote REQUESTS (never a
   * direct promotion). Suppressed while an equal pending request exists, or
   * a promotion was rejected inside the window ( ignored twice → quieter).
   */
  async suggestPromotions(now: Date = new Date(), signals?: SignalRecord[]): Promise<ApprovalRequest[]> {
    const ledger = signals ?? await readSignals(this.signalsFile)
    const approvals = (await readJsonOrNull<ApprovalRequest[]>(this.approvalsFile)) ?? []
    const created: ApprovalRequest[] = []
    for (const entry of await this.list({ status: 'candidate' })) {
      const { score } = windowScore(ledger, entry.id, now, this.config.windowDays)
      if (score < this.config.trustThreshold) continue
      const pending = approvals.some((a) => a.entryId === entry.id && a.action === 'promote' && a.resolvedAt === null)
      if (pending) continue
      const rejectedRecently = approvals.some((a) => {
        if (a.entryId !== entry.id || a.action !== 'promote' || a.resolution !== 'rejected' || a.resolvedAt === null) return false
        return now.getTime() - Date.parse(a.resolvedAt) < this.config.windowDays * DAY_MS
      })
      if (rejectedRecently) continue
      const request = await this.requestApproval(entry.id, 'promote', `窗口分数 ${score} ≥ ${this.config.trustThreshold}(多次成功引用)`, score, now.toISOString())
      created.push(request)
    }
    return created
  }

  // ---- the batched approval queue (decision #12) ----

  /** Queue one human decision; dedupes against an equal pending request. */
  async requestApproval(entryId: KbEntryId, action: ApprovalAction, reason: string, score: number, at: string = new Date().toISOString()): Promise<ApprovalRequest> {
    const approvals = (await readJsonOrNull<ApprovalRequest[]>(this.approvalsFile)) ?? []
    const existing = approvals.find((a) => a.entryId === entryId && a.action === action && a.resolvedAt === null)
    if (existing !== undefined) return existing
    const request: ApprovalRequest = {
      id: `a-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      entryId,
      action,
      reason,
      scoreAtRequest: score,
      createdAt: at,
      resolvedAt: null,
      resolution: null,
    }
    await atomicWriteJson(this.approvalsFile, [...approvals, request])
    return request
  }

  /** List the queue (pending first, oldest first — the batch-review order). */
  async listApprovals(pendingOnly = true): Promise<ApprovalRequest[]> {
    const approvals = (await readJsonOrNull<ApprovalRequest[]>(this.approvalsFile)) ?? []
    return approvals
      .filter((a) => !pendingOnly || a.resolvedAt === null)
      .sort((a, b) => (a.resolvedAt === null ? 0 : 1) - (b.resolvedAt === null ? 0 : 1) || a.createdAt.localeCompare(b.createdAt))
  }

  /**
   * Resolve one queued request. Approved promote/rescue/reactivate/discard
   * apply their transition; approving a promote ALSO records the human-confirm
   * signal (the approval IS the strongest positive). A rejected promote
   * records NO negative signal — declining to trust is not saying "wrong".
   */
  async resolveApproval(requestId: string, approved: boolean, at: string = new Date().toISOString()): Promise<{ request: ApprovalRequest; entry: KbEntry | null }> {
    const approvals = (await readJsonOrNull<ApprovalRequest[]>(this.approvalsFile)) ?? []
    const index = approvals.findIndex((a) => a.id === requestId)
    if (index === -1) throw new Error(`kb: approval request not found: ${requestId}`)
    const request = approvals[index]
    if (request.resolvedAt !== null) throw new Error(`kb: request ${requestId} is already resolved (${request.resolution})`)
    let entry: KbEntry | null = null
    if (approved) {
      if (request.action === 'promote') {
        entry = await this.transition(request.entryId, 'trusted', 'approve-promote', `人工批准提升(请求 ${requestId})`, at)
        await this.recordSignal(request.entryId, 'human-confirm', `批准提升为可信(${request.reason})`, at)
      } else if (request.action === 'discard') {
        entry = await this.transition(request.entryId, 'discarded', 'strong-negative', `人工批准遗弃(请求 ${requestId})`, at)
      } else if (request.action === 'rescue') {
        entry = await this.transition(request.entryId, 'candidate', 'rescue', `人工捞回(请求 ${requestId})`, at)
      } else if (request.action === 'reactivate') {
        entry = await this.transition(request.entryId, 'candidate', 'reactivate', `人工复核重新激活(请求 ${requestId})`, at)
      }
      // `redline-review` is ADVISORY by design (M9-4): the system proposes
      // "this entry is >40% redlined, consider split or discard" and the human
      // executes the act itself through `kb split` / `kb signal`+`kb sweep`.
      // Resolving it therefore changes no entry state — the queue is where the
      // suggestion lives, not an automation seam.
    }
    approvals[index] = { ...request, resolvedAt: at, resolution: approved ? 'approved' : 'rejected' }
    await atomicWriteJson(this.approvalsFile, approvals)
    return { request: approvals[index], entry }
  }

  /**
   * Promote a CANDIDATE to trusted as a HUMAN act — the panel's 提升 button and
   * `clue kb promote`.
   *
   * Why this exists next to the queue: `suggestPromotions` only queues a
   * request once the window score crosses `trustThreshold`, so the queue is an
   * EVIDENCE-driven inbox. It answers "the system thinks this might be worth
   * trusting" — it cannot answer "I already know this is right", and before
   * this method there was no verb anywhere that could (CLI only had
   * `approve <requestId>`): a human's own judgment, the strongest input the
   * layer has, was the one input with no entry point.
   *
   * Same discipline as redline/split (M9-4 人权入口): no tool and no route
   * exposes this to a model — models propose (`kb_propose`), humans dispose.
   * The act is audited twice: an `approve-promote` history event naming the
   * surface that did it, plus the `human-confirm` signal (the strongest
   * positive — exactly what approving a queued promote records, so the two
   * roads leave the same ledger shape).
   *
   * A pending promote request for the same entry is SETTLED as approved in the
   * same pass: otherwise the queue would keep showing a decision the human just
   * made, and a later `kb approve` of it would try `trusted → trusted` and
   * throw. Only `candidate` can be promoted — expired/discarded entries must
   * re-earn trust through their own edges (reactivate/rescue), never a shortcut.
   *
   * @param id - the entry to promote.
   * @param input - the human's why (`by` names the surface: web/cli).
   * @param at - ISO timestamp (injectable for tests).
   * @returns the trusted entry plus every request this act settled.
   * @throws when the entry is absent or not a candidate (fail loud, no coercion).
   */
  async promote(
    id: KbEntryId,
    input: { reason?: string; by?: string } = {},
    at: string = new Date().toISOString(),
  ): Promise<{ entry: KbEntry; requests: ApprovalRequest[] }> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    if (entry.status !== 'candidate') {
      const hint = entry.status === 'trusted'
        ? ' (it is already trusted)'
        : entry.status === 'expired'
          ? ' (an expired entry must reverify/reactivate back to candidate first, then promote)'
          : entry.status === 'discarded'
            ? ' (a discarded entry must be rescued to candidate first, then promote)'
            : ' (a superseded entry is history; promote its successor instead)'
      throw new Error(`kb promote: only candidates can be promoted to trusted, this entry is ${entry.status}${hint}`)
    }
    const by = input.by ?? 'cli'
    const why = (input.reason ?? '').trim()
    const trusted = await this.transition(
      entry.id,
      'trusted',
      'approve-promote',
      `人工提升为可信(${by})${why === '' ? '' : `: ${why}`}`,
      at,
    )
    await this.recordSignal(entry.id, 'human-confirm', `人工提升为可信(${by})`, at)
    const requests = await this.settleRequests(entry.id, 'promote', at)
    return { entry: trusted, requests }
  }

  /**
   * Retire an entry by HUMAN judgment (候选/可信 → 过期) — the panel's
   * 「不再成立（转入过期）」.
   *
   * Before this verb existed the panel's button with that label only CLEARED
   * the needs-review flag (and wrote the reason "绑定哈希一致", which was false
   * when the file had in fact drifted): the copy promised a state change the
   * code never performed. `expired` is the honest target — the entry stays
   * readable with its annotation and can be reactivated, while its use as a
   * write-basis needs approval. Discarding stays an evidence/queue decision.
   *
   * A reason is REQUIRED: "this no longer holds" is a governance verdict, and
   * the history line is the only place a later reader can learn why.
   *
   * @param id - the entry to retire.
   * @param input - the required why, plus the surface (`by`).
   * @param at - ISO timestamp (injectable for tests).
   * @returns the expired entry (with the review flag cleared).
   */
  async retire(
    id: KbEntryId,
    input: { reason?: string; by?: string } = {},
    at: string = new Date().toISOString(),
  ): Promise<{ entry: KbEntry; requests: ApprovalRequest[] }> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    if (entry.status !== 'candidate' && entry.status !== 'trusted') {
      throw new Error(`kb retire: only candidate/trusted entries can be retired by human decision, this entry is ${entry.status}`
        + (entry.status === 'superseded' ? ' (a superseded entry is history; act on its successor)' : ' (it is no longer in service)'))
    }
    const by = input.by ?? 'cli'
    const why = (input.reason ?? '').trim()
    if (why === '') throw new Error('kb retire: a reason is required (deciding "no longer holds" is a governance decision)')
    const retired = await this.transition(entry.id, 'expired', 'human-retire', `人工判定不再成立(${by}): ${why}`, at)
    // The verdict supersedes the drift flag: a retired entry cannot be
    // "possibly stale" — it is out of the write-basis by decision.
    // (clearNeedsReview returns the SAME instance when nothing was flagged,
    // so identity is the honest "did anything change" test.)
    const cleared = clearNeedsReview(retired, `人工判定不再成立: ${why}`, at)
    return { entry: cleared === retired ? retired : await this.save(cleared), requests: [] }
  }

  /**
   * Reactivate an EXPIRED entry back to candidate by HUMAN judgment — the
   * panel's 「重新激活」. Peer of `rescue` (discarded → candidate) and
   * `promote`: all three lifecycle verbs existed only as queue resolutions, so
   * a human looking at an expired entry had no way to bring it back without
   * first manufacturing an approval request.
   *
   * The needs-review flag is deliberately NOT cleared: it is a fact about the
   * bound files, and reactivating does not make a drifted file match again.
   *
   * @param id - the expired entry.
   * @param input - the optional why, plus the surface (`by`).
   * @param at - ISO timestamp.
   * @returns the candidate entry plus every request this act settled.
   */
  async reactivate(
    id: KbEntryId,
    input: { reason?: string; by?: string } = {},
    at: string = new Date().toISOString(),
  ): Promise<{ entry: KbEntry; requests: ApprovalRequest[] }> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    if (entry.status !== 'expired') {
      throw new Error(`kb reactivate: only expired entries can be reactivated, this entry is ${entry.status}`)
    }
    const by = input.by ?? 'cli'
    const why = (input.reason ?? '').trim()
    const revived = await this.transition(
      entry.id,
      'candidate',
      'reactivate',
      `人工重新激活(${by})${why === '' ? '' : `: ${why}`}`,
      at,
    )
    // Back to candidate: trust must be re-earned (the machine has no
    // expired → trusted edge at all).
    const requests = await this.settleRequests(entry.id, 'reactivate', at)
    return { entry: revived, requests }
  }

  /**
   * Rescue a DISCARDED entry back to candidate by HUMAN judgment — the panel's
   * 「捞回候选」. Returns to CANDIDATE, never straight to trusted: the entry
   * must re-earn trust (state-machine doc, patch #1).
   *
   * @param id - the discarded entry.
   * @param input - the optional why, plus the surface (`by`).
   * @param at - ISO timestamp.
   * @returns the candidate entry plus every request this act settled.
   */
  async rescue(
    id: KbEntryId,
    input: { reason?: string; by?: string } = {},
    at: string = new Date().toISOString(),
  ): Promise<{ entry: KbEntry; requests: ApprovalRequest[] }> {
    const entry = await this.get(id)
    if (entry === null) throw new Error(`kb: entry not found: ${id}`)
    if (entry.status !== 'discarded') {
      throw new Error(`kb rescue: only discarded entries can be rescued, this entry is ${entry.status}`)
    }
    const by = input.by ?? 'cli'
    const why = (input.reason ?? '').trim()
    const rescued = await this.transition(
      entry.id,
      'candidate',
      'rescue',
      `人工捞回候选(${by})${why === '' ? '' : `: ${why}`}`,
      at,
    )
    const requests = await this.settleRequests(entry.id, 'rescue', at)
    return { entry: rescued, requests }
  }

  /**
   * Mark every PENDING request of one action on one entry as settled by the
   * human act that just performed it: the queue must never keep displaying a
   * decision the human already made in the panel (and a later
   * `kb approve` of it would attempt an illegal same-state transition).
   * Requests of other actions are untouched.
   *
   * @param entryId - the entry the human just acted on.
   * @param action - which queued verb the act performed.
   * @param at - ISO timestamp.
   * @returns the requests this call settled.
   */
  private async settleRequests(entryId: KbEntryId, action: ApprovalAction, at: string): Promise<ApprovalRequest[]> {
    const approvals = (await readJsonOrNull<ApprovalRequest[]>(this.approvalsFile)) ?? []
    const settled: ApprovalRequest[] = []
    const next = approvals.map((request) => {
      if (request.entryId !== entryId || request.action !== action || request.resolvedAt !== null) return request
      const resolved: ApprovalRequest = { ...request, resolvedAt: at, resolution: 'approved' }
      settled.push(resolved)
      return resolved
    })
    if (settled.length > 0) await atomicWriteJson(this.approvalsFile, next)
    return settled
  }
}

/**
 * Convenience: open the global tier (stays central — cross-project by
 * definition).
 *
 * Discard bound (user decision, M5 review): the global tier uses the SAME
 * derived bound as projects (-trustThreshold = -20) — knowledge is not
 * killed faster for being global. Design §3.6's "全局更敏感" is realized
 * through FAILURE PROPAGATION instead (consecutive attributed failures flag
 * the entry 待复核 for every project to see — sensitivity as a review flag,
 * not as a faster execution). `config.discardThreshold` remains available
 * for a deployment that wants an explicit different bound.
 */
export function openGlobalStore(home?: string, config?: Partial<KbConfig>): Promise<KbStore> {
  return KbStore.open({ tier: 'global', home, config })
}

/** Convenience: open the PROJECT tier of one workspace (`<home>/kb/<key>`). */
export function openProjectStore(projectRoot: string, home?: string, config?: Partial<KbConfig>): Promise<KbStore> {
  return KbStore.open({ tier: 'project', projectRoot, home, config })
}

// ── central paths & the M9 import (from the M8 in-workspace layout) ─────────

/** The workspace-internal directory the M8 layout wrote into: `<root>/.clue`. */
export function legacyWorkspaceClueDir(projectRoot: string): string {
  return path.join(projectRoot, '.clue')
}

/** One migration outcome (the CLI prints this verbatim — it is the user's evidence). */
export interface MigrationEntry {
  /** The canonical workspace root the piece belongs to. */
  root: string
  /** Which kind of state moved. */
  kind: 'kb' | 'baselines' | 'surface' | 'leftover'
  from: string
  /** Absent when the piece was skipped. */
  to?: string
  moved: boolean
  reason: string
}

export interface MigrateOptions {
  /** ClueHarness home to migrate INTO (default CLUE_HOME/~/.clue). */
  home?: string
  /** Explicit roots to examine; the legacy roster file is always added. */
  roots?: readonly string[]
  /** Report only, move nothing. */
  dryRun?: boolean
}

/**
 * Import the M8 workspace-bound layout into central storage (decision #6
 * re-revision): for every known workspace, move `<root>/.clue/kb` to
 * `<home>/kb/<key>` and `<root>/.clue/render-baselines` to
 * `<home>/baselines/<key>`, and fold `<root>/.clue/render-surface.json` into
 * the workspace's roster record. Afterwards a workspace directory carries no
 * ClueHarness state at all.
 *
 * Discovery: explicit `roots` + the adopted roster + the legacy
 * `<home>/projects.json`. A non-empty destination is NEVER overwritten (skip +
 * reason — two machines migrated independently keep their own copy); an absent
 * workspace is simply nothing to do. The meta.json anchor travels with the
 * tier, which is what keeps the key walk honest.
 * @param options - home, explicit roots, dry run.
 * @returns per-workspace, per-piece outcomes.
 */
export async function migrateWorkspaceKbsToCentral(options: MigrateOptions = {}): Promise<MigrationEntry[]> {
  const home = options.home ?? clueHome()
  const report: MigrationEntry[] = []

  const candidates = new Set<string>()
  for (const root of options.roots ?? []) candidates.add(canonicalRoot(root))
  const legacy = await readJsonOrNull<{ projects?: Array<{ projectRoot?: unknown }> }>(path.join(home, 'projects.json'))
  for (const row of legacy?.projects ?? []) {
    if (typeof row.projectRoot === 'string' && row.projectRoot !== '') candidates.add(canonicalRoot(row.projectRoot))
  }
  for (const row of await readWorkspaces(home)) candidates.add(canonicalRoot(row.root))

  for (const root of [...candidates].sort()) {
    const clueDir = legacyWorkspaceClueDir(root)
    const key = await workspaceKey(root, home)
    const kbFrom = path.join(clueDir, 'kb')
    const kbTo = path.join(home, 'kb', key)
    const baselinesFrom = path.join(clueDir, 'render-baselines')
    const baselinesTo = path.join(home, 'baselines', key)
    const surfaceFrom = path.join(clueDir, 'render-surface.json')

    const hasKb = (await stat(path.join(kbFrom, 'entries')).catch(() => null)) !== null
    const hasBaselines = (await stat(baselinesFrom).catch(() => null)) !== null
    const hasSurface = (await stat(surfaceFrom).catch(() => null)) !== null
    if (!hasKb && !hasBaselines && !hasSurface) continue

    if (hasKb) {
      const occupied = (await readdir(kbTo).catch(() => null)) !== null
      if (occupied) {
        report.push({ root, kind: 'kb', from: kbFrom, to: kbTo, moved: false, reason: 'central store already exists — not overwritten (merge manually)' })
      } else if (options.dryRun === true) {
        report.push({ root, kind: 'kb', from: kbFrom, to: kbTo, moved: false, reason: 'dry-run: would move into the central store' })
      } else {
        await moveDir(kbFrom, kbTo)
        await registerWorkspace(root, { home, source: 'migrate' })
        report.push({ root, kind: 'kb', from: kbFrom, to: kbTo, moved: true, reason: 'moved into the central store' })
      }
    }
    if (hasBaselines) {
      const occupied = (await readdir(baselinesTo).catch(() => null)) !== null
      if (occupied) {
        report.push({ root, kind: 'baselines', from: baselinesFrom, to: baselinesTo, moved: false, reason: 'central baselines directory already exists — not overwritten' })
      } else if (options.dryRun === true) {
        report.push({ root, kind: 'baselines', from: baselinesFrom, to: baselinesTo, moved: false, reason: 'dry-run: would move into the central baselines directory' })
      } else {
        await moveDir(baselinesFrom, baselinesTo)
        report.push({ root, kind: 'baselines', from: baselinesFrom, to: baselinesTo, moved: true, reason: 'render baselines moved into the central directory' })
      }
    }
    if (hasSurface) {
      const target = `${key} @ workspaces.json`
      if (options.dryRun === true) {
        report.push({ root, kind: 'surface', from: surfaceFrom, to: target, moved: false, reason: 'dry-run: would write into the roster' })
      } else {
        const custom = await readJsonOrNull<Partial<RenderSurfaceSettings>>(surfaceFrom)
        const settings: RenderSurfaceSettings = {
          ...(Array.isArray(custom?.extensions) ? { extensions: custom.extensions.map(String) } : {}),
          ...(Array.isArray(custom?.pathPrefixes) ? { pathPrefixes: custom.pathPrefixes.map(String) } : {}),
        }
        if (settings.extensions === undefined && settings.pathPrefixes === undefined) {
          report.push({ root, kind: 'surface', from: surfaceFrom, to: target, moved: false, reason: 'the file holds no valid array — left in place for a human to handle' })
        } else {
          await setRenderSurface(key, settings, home)
          await rm(surfaceFrom, { force: true })
          report.push({ root, kind: 'surface', from: surfaceFrom, to: target, moved: true, reason: 'render surface config merged into the workspace record' })
        }
      }
    }
    if (options.dryRun !== true) {
      const leftovers = await readdir(clueDir).catch(() => null)
      if (leftovers !== null && leftovers.length === 0) {
        await rm(clueDir, { recursive: true, force: true })
      } else if (leftovers !== null) {
        report.push({ root, kind: 'leftover', from: clueDir, moved: false, reason: `.clue/ still holds other content (${leftovers.join(', ')}), not deleted` })
      }
    }
  }
  return report
}

/** Move a directory, falling back to copy+delete across devices. */
async function moveDir(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch {
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}
